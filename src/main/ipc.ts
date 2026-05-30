// Wires the renderer <-> main bridge: connection CRUD, secrets, and SSH session
// lifecycle. SSH events are pushed to the focused window via webContents.send.
import { ipcMain, dialog, shell, BrowserWindow, type WebContents } from 'electron'
import { basename } from 'node:path'
import type {
  ConnectionDraft,
  ServerStats,
  SettingsPatch,
  SftpList,
  TmuxSession,
  TunnelDef,
  Workspace
} from '../shared/types'
import { connectionStore } from './store/connections'
import { secrets } from './store/secrets'
import { settingsStore } from './store/settings'
import { tunnelsStore } from './store/tunnels'
import { workspaceStore } from './store/workspace'
import { SshManager } from './ssh/manager'

// tmux list-sessions with a parseable format (pipe-delimited; tab isn't honored
// inside tmux format strings).
const TMUX_LIST = `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`

/** Single-quote a value for safe interpolation into a remote shell command. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// One-shot host vitals probe. Emits `key=value` lines; everything degrades
// gracefully (missing tools just yield empty fields). Linux-oriented.
const PROBE = [
  `echo "host=$(hostname 2>/dev/null)"`,
  `echo "os=$( (. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME") || uname -s 2>/dev/null )"`,
  `echo "kernel=$(uname -r 2>/dev/null)"`,
  `echo "arch=$(uname -m 2>/dev/null)"`,
  `echo "uptime=$(uptime -p 2>/dev/null | sed 's/^up //')"`,
  `echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`,
  `echo "cpus=$(nproc 2>/dev/null)"`,
  `echo "cpu=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"`,
  `echo "memtotal=$(awk '/^MemTotal/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "memavail=$(awk '/^MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "disk=$(df -h -P / 2>/dev/null | awk 'NR==2{print $2"|"$3"|"$5}')"`,
  `echo "users=$(who 2>/dev/null | wc -l | tr -d ' ')"`
].join('\n')

function parseProbe(text: string): ServerStats {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const num = (k: string): number | undefined => {
    const v = map.get(k)
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (k: string): string | undefined => {
    const v = map.get(k)?.trim()
    return v ? v : undefined
  }

  const stats: ServerStats = {
    hostname: str('host'),
    os: str('os'),
    kernel: str('kernel'),
    arch: str('arch'),
    uptime: str('uptime'),
    cpus: num('cpus'),
    cpuModel: str('cpu'),
    users: num('users')
  }

  const load = str('load')
  if (load) {
    const parts = load.split(/\s+/).map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      stats.load = [parts[0], parts[1], parts[2]]
    }
  }

  const memTotal = num('memtotal')
  const memAvail = num('memavail')
  if (memTotal !== undefined) {
    stats.memTotalKb = memTotal
    if (memAvail !== undefined) stats.memUsedKb = Math.max(0, memTotal - memAvail)
  }

  const disk = str('disk')
  if (disk) {
    const [size, used, pct] = disk.split('|')
    if (size) stats.diskSize = size
    if (used) stats.diskUsed = used
    const p = pct ? Number(pct.replace('%', '')) : NaN
    if (Number.isFinite(p)) stats.diskPct = p
  }

  return stats
}

function parseTmux(text: string): TmuxSession[] {
  if (/no server running|no sessions|error connecting/i.test(text)) return []
  const out: TmuxSession[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length >= 3 && parts[0]) {
      out.push({
        // session_attached is a client COUNT, not a 0/1 flag — a session with
        // two attached clients reports '2', so test for any client, not just '1'.
        name: parts[0],
        windows: parseInt(parts[1], 10) || 0,
        attached: (parseInt(parts[2], 10) || 0) > 0
      })
    }
  }
  return out
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const ssh = new SshManager()

  const send = (channel: string, ...args: unknown[]): void => {
    const wc: WebContents | undefined = getWindow()?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
  }

  ssh.on('status', (sessionId, status) => send('ssh:status', sessionId, status))
  ssh.on('data', (sessionId, data) => send('ssh:data', sessionId, data))
  ssh.on('hostkey', (prompt) => send('ssh:hostkey', prompt))
  ssh.on('sftp-progress', (p) => send('sftp:progress', p))
  ssh.on('tunnel-status', (s) => send('tunnel:status', s))

  // Resolve the effective password for a connection (explicit arg, else stored secret).
  const passwordFor = (connectionId: string, explicit?: string): string | undefined => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    return explicit ?? (connection.authMethod === 'password' ? secrets.get(connection.id) ?? undefined : undefined)
  }

  // ---- connections ----
  ipcMain.handle('conn:list', () => connectionStore.list())
  ipcMain.handle('conn:upsert', (_e, draft: ConnectionDraft) => {
    const conn = connectionStore.upsert(draft)
    if (draft.authMethod === 'password' && draft.password) {
      secrets.set(conn.id, draft.password)
    }
    return conn
  })
  ipcMain.handle('conn:remove', (_e, id: string) => {
    ssh.stopTunnelsForConnection(id)
    tunnelsStore.remove(id)
    connectionStore.remove(id)
    secrets.clear(id)
  })
  ipcMain.on('conn:set-last-sftp-path', (_e, id: string, path: string) =>
    connectionStore.setLastSftpPath(id, path)
  )
  ipcMain.handle('secrets:available', () => secrets.available())
  ipcMain.handle('secrets:has', (_e, id: string) => secrets.get(id) !== null)

  // ---- settings (persisted to userData/settings.json) ----
  ipcMain.handle('settings:get', () => settingsStore.getAll())
  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => settingsStore.update(patch))

  ipcMain.handle('workspace:get', () => workspaceStore.get())
  ipcMain.on('workspace:set', (_e, ws: Workspace) => workspaceStore.set(ws))

  // ---- port forwarding / tunnels ----
  ipcMain.handle('tunnel:list', (_e, connectionId: string) => tunnelsStore.get(connectionId))
  ipcMain.handle('tunnel:save', (_e, args: { connectionId: string; defs: TunnelDef[] }) =>
    tunnelsStore.set(args.connectionId, args.defs)
  )
  ipcMain.handle('tunnel:statuses', () => ssh.tunnelStatuses())
  ipcMain.handle(
    'tunnel:start',
    (_e, args: { connectionId: string; defId: string; password?: string }) => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const def = tunnelsStore.get(args.connectionId).find((d) => d.id === args.defId)
      if (!def) throw new Error('Tunnel not found')
      ssh.startTunnel(
        args.connectionId,
        def,
        connection,
        passwordFor(args.connectionId, args.password),
        undefined,
        30000
      )
      return true
    }
  )
  ipcMain.on('tunnel:stop', (_e, defId: string) => ssh.stopTunnel(defId))

  // ---- ssh sessions ----
  ipcMain.handle(
    'ssh:connect',
    (
      _e,
      args: {
        sessionId: string
        connectionId: string
        cols: number
        rows: number
        retries: number
        password?: string
        passphrase?: string
        command?: string
      }
    ) => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password =
        args.password ?? (connection.authMethod === 'password' ? secrets.get(connection.id) ?? undefined : undefined)
      // fire-and-forget; progress arrives via 'ssh:status' events
      void ssh.connect({
        sessionId: args.sessionId,
        connection,
        password,
        passphrase: args.passphrase,
        cols: args.cols,
        rows: args.rows,
        retries: args.retries,
        command: args.command
      })
      return true
    }
  )

  ipcMain.handle(
    'ssh:tmux-list',
    async (_e, args: { connectionId: string; password?: string }): Promise<TmuxSession[]> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password =
        args.password ?? (connection.authMethod === 'password' ? secrets.get(connection.id) ?? undefined : undefined)
      const res = await ssh.exec(connection, { command: TMUX_LIST, password, timeoutMs: 15000 })
      return parseTmux(res.stdout + '\n' + res.stderr)
    }
  )
  ipcMain.handle(
    'ssh:tmux-kill',
    async (_e, args: { connectionId: string; password?: string; name: string }): Promise<void> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password = passwordFor(args.connectionId, args.password)
      const res = await ssh.exec(connection, {
        command: `tmux kill-session -t ${shQuote(args.name)}`,
        password,
        timeoutMs: 15000
      })
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'Failed to kill session')
    }
  )
  ipcMain.handle(
    'ssh:tmux-rename',
    async (
      _e,
      args: { connectionId: string; password?: string; from: string; to: string }
    ): Promise<void> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password = passwordFor(args.connectionId, args.password)
      const res = await ssh.exec(connection, {
        command: `tmux rename-session -t ${shQuote(args.from)} ${shQuote(args.to)}`,
        password,
        timeoutMs: 15000
      })
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'Failed to rename session')
    }
  )
  ipcMain.handle(
    'ssh:probe',
    async (_e, args: { connectionId: string; password?: string }): Promise<ServerStats> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password =
        args.password ?? (connection.authMethod === 'password' ? secrets.get(connection.id) ?? undefined : undefined)
      const started = Date.now()
      const res = await ssh.exec(connection, { command: PROBE, password, timeoutMs: 15000 })
      const stats = parseProbe(res.stdout)
      stats.probeMs = Date.now() - started
      return stats
    }
  )
  // ---- SFTP file manager (one shared channel per connection) ----
  ipcMain.handle('sftp:open', async (_e, args: { connectionId: string; password?: string }) => {
    const connection = connectionStore.get(args.connectionId)
    if (!connection) throw new Error('Connection not found')
    await ssh.openSftp(args.connectionId, connection, passwordFor(args.connectionId, args.password), undefined, 30000)
    return true
  })
  ipcMain.handle('sftp:list', (_e, args: { connectionId: string; path: string }): Promise<SftpList> =>
    ssh.sftpList(args.connectionId, args.path)
  )
  ipcMain.handle('sftp:realpath', (_e, args: { connectionId: string; path: string }) =>
    ssh.sftpRealpath(args.connectionId, args.path)
  )
  ipcMain.handle('sftp:mkdir', (_e, args: { connectionId: string; path: string }) =>
    ssh.sftpMkdir(args.connectionId, args.path)
  )
  ipcMain.handle('sftp:rename', (_e, args: { connectionId: string; from: string; to: string }) =>
    ssh.sftpRename(args.connectionId, args.from, args.to)
  )
  ipcMain.handle('sftp:chmod', (_e, args: { connectionId: string; path: string; mode: number }) =>
    ssh.sftpChmod(args.connectionId, args.path, args.mode)
  )
  ipcMain.handle('sftp:delete', (_e, args: { connectionId: string; path: string; isDir: boolean }) =>
    ssh.sftpDelete(args.connectionId, args.path, args.isDir)
  )
  ipcMain.handle('sftp:readFile', (_e, args: { connectionId: string; path: string }) =>
    ssh.sftpReadFile(args.connectionId, args.path)
  )
  ipcMain.handle('sftp:writeFile', (_e, args: { connectionId: string; path: string; content: string }) =>
    ssh.sftpWriteFile(args.connectionId, args.path, args.content)
  )

  // Download: pick a local destination, then stream with progress.
  ipcMain.handle(
    'sftp:download',
    async (_e, args: { connectionId: string; remotePath: string; name: string; transferId: string }) => {
      const win = getWindow()
      const res = await dialog.showSaveDialog(win!, { title: 'Save file', defaultPath: args.name })
      if (res.canceled || !res.filePath) return { canceled: true }
      await ssh.sftpDownload(args.connectionId, args.remotePath, res.filePath, args.transferId, args.name)
      return { canceled: false }
    }
  )

  // Upload via a file picker — returns the chosen paths' basenames for the UI.
  ipcMain.handle(
    'sftp:uploadPick',
    async (_e, args: { connectionId: string; remoteDir: string; transferId: string }) => {
      const win = getWindow()
      const res = await dialog.showOpenDialog(win!, {
        title: 'Upload files',
        properties: ['openFile', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return { canceled: true }
      for (const local of res.filePaths) {
        const name = basename(local)
        const remote = args.remoteDir.endsWith('/') ? args.remoteDir + name : `${args.remoteDir}/${name}`
        await ssh.sftpUpload(args.connectionId, local, remote, `${args.transferId}:${name}`, name)
      }
      return { canceled: false, count: res.filePaths.length }
    }
  )

  // Upload from OS drag-and-drop (renderer supplies absolute paths).
  ipcMain.handle(
    'sftp:uploadPaths',
    async (_e, args: { connectionId: string; remoteDir: string; paths: string[]; transferId: string }) => {
      for (const local of args.paths) {
        const name = basename(local)
        const remote = args.remoteDir.endsWith('/') ? args.remoteDir + name : `${args.remoteDir}/${name}`
        await ssh.sftpUpload(args.connectionId, local, remote, `${args.transferId}:${name}`, name)
      }
      return { count: args.paths.length }
    }
  )

  ipcMain.on('sftp:close', (_e, connectionId: string) => ssh.closeSftp(connectionId))

  ipcMain.on('ssh:input', (_e, sessionId: string, data: string) => ssh.write(sessionId, data))
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ssh.resize(sessionId, cols, rows)
  )
  ipcMain.on('ssh:close', (_e, sessionId: string) => ssh.close(sessionId))
  ipcMain.on('ssh:hostkey-response', (_e, requestId: string, accept: boolean) =>
    ssh.resolveHostKey(requestId, accept)
  )

  // ---- misc ----
  // Only ever open http(s) links externally — never arbitrary schemes.
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // ---- window controls (custom title bar) ----
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    const w = getWindow()
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.handle('window:is-maximized', () => getWindow()?.isMaximized() ?? false)

  // ---- menu actions ----
  ipcMain.handle('menu:edit', (_e, action: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    getWindow()?.webContents[action]?.()
  })
  ipcMain.handle('menu:view', (_e, action: string) => {
    const w = getWindow()
    if (!w) return
    const wc = w.webContents
    if (action === 'zoomIn') wc.setZoomLevel(wc.getZoomLevel() + 0.5)
    else if (action === 'zoomOut') wc.setZoomLevel(wc.getZoomLevel() - 0.5)
    else if (action === 'zoomReset') wc.setZoomLevel(0)
    else if (action === 'fullscreen') w.setFullScreen(!w.isFullScreen())
    else if (action === 'devtools') wc.toggleDevTools()
  })

  ipcMain.handle('dialog:pickKey', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select private key',
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })
}
