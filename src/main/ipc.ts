// Wires the renderer <-> main bridge: connection CRUD, secrets, and SSH session
// lifecycle. SSH events are pushed to the focused window via webContents.send.
import {
  app,
  ipcMain,
  clipboard,
  dialog,
  shell,
  BrowserWindow,
  Notification,
  type WebContents
} from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type {
  ClaudeHookStatus,
  ConnectionDraft,
  ServerStats,
  SettingsPatch,
  SftpList,
  StageResult,
  TmuxIntent,
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
import { CLAUDE_SETTINGS_PATH, planHooks } from './claudeHooks'

// Native macOS fullscreen leaves a black bar above a frameless window and pushes
// it into a separate Space; simple fullscreen covers the whole screen in place.
// Other platforms use native fullscreen.
export function toggleFullScreen(w: BrowserWindow): void {
  if (process.platform === 'darwin') w.setSimpleFullScreen(!w.isSimpleFullScreen())
  else w.setFullScreen(!w.isFullScreen())
}

// tmux list-sessions with a parseable format (pipe-delimited; tab isn't honored
// inside tmux format strings).
const TMUX_LIST = `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`

/** Single-quote a value for safe interpolation into a remote shell command. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// ---- staged uploads (drop a file on a terminal) ----

/**
 * Where staged files land, under the SSH account's home directory.
 *
 * Home, not /tmp: on a shared host /tmp is world-writable, so another user can
 * pre-create the directory we're about to use and read whatever gets dropped
 * into it. The per-user temp dirs ($TMPDIR, $XDG_RUNTIME_DIR) aren't reachable
 * over SFTP without a shell to expand them, and XDG_RUNTIME_DIR is destroyed at
 * the user's last logout — which would delete files out from under a running
 * agent. Home is readable, stable, and already the user's own space.
 */
const STAGE_DIR = '.lt-ssh-manager/uploads'
/** Staging directories and the files in them are the dropping user's business only. */
const STAGE_DIR_MODE = 0o700
const STAGE_FILE_MODE = 0o600
/** Largest file we'll stage. Anything bigger is a file-manager job, not a drop. */
const MAX_STAGE_BYTES = 512 * 1024 * 1024

/** Local scratch directory for clipboard images we materialize ourselves. */
const pasteDir = (): string => join(app.getPath('temp'), 'lt-ssh-manager')

/**
 * Drop the clipboard images we materialized for this batch. The remote has them
 * now, or never will — either way our scratch copies shouldn't outlive the drop,
 * including when the batch dies before the upload loop runs at all. Never fatal:
 * a scratch file we couldn't remove is no reason to fail a drop that worked.
 */
async function discardScratch(paths: string[]): Promise<void> {
  const scratch = resolve(pasteDir())
  for (const p of paths) {
    if (dirname(resolve(p)) === scratch) await rm(p, { force: true }).catch(() => undefined)
  }
}

/** Join two remote path segments (always `/`, never the host OS's separator). */
const rjoin = (a: string, b: string): string => (a.endsWith('/') ? a + b : `${a}/${b}`)

/**
 * The name a file is staged under.
 *
 * The name ends up typed at the user's cursor, so it is restricted to characters
 * that need no quoting at all — that way it is safe no matter what the terminal
 * does with it, and it stays readable. (Only this segment is ours to pick; the
 * directory prefix is whatever the server reports as home.) Control
 * characters are the ones that actually bite: xterm rewrites a `\n` into the CR
 * that submits the line, and no amount of shell quoting prevents that.
 */
function stageName(local: string): string {
  const safe = basename(local)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[-.]+/, '_') // no leading dash (reads as a flag) and no dotfiles
    .slice(0, 96)
  return safe && safe !== '_' ? safe : 'file'
}

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
  ssh.on('tmux-output', (sessionId, paneId, data) => send('tmux:output', sessionId, paneId, data))
  ssh.on('tmux-windows', (sessionId, state) => send('tmux:windows', sessionId, state))
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
        control?: boolean
        tmux?: TmuxIntent
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
        command: args.command,
        control: args.control,
        tmux: args.tmux
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

  // Stage local files on the host so a terminal can point at them: upload into a
  // private per-drop directory under the user's home, then hand back absolute
  // remote paths. This is drop-to-upload's whole main-side story.
  //
  // Unlike the file-manager uploads above, this brackets the SFTP channel
  // itself. Those free-ride on an open Files tab; a terminal tab has none, and
  // `sftpOf` throws outright when the pool is empty. The `opened` flag is the
  // load-bearing part: closing after a *failed* open would decrement a
  // reference some other tab is holding and yank the channel out from under it.
  ipcMain.handle(
    'sftp:upload-to',
    async (
      _e,
      args: { connectionId: string; password?: string; paths: string[]; transferId: string }
    ): Promise<StageResult> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')

      const files: StageResult['files'] = []
      const errors: StageResult['errors'] = []
      let opened = false
      try {
        await ssh.openSftp(
          args.connectionId,
          connection,
          passwordFor(args.connectionId, args.password),
          undefined,
          30000
        )
        opened = true

        // A fresh directory per drop, so the same name dropped twice — or two
        // files that slug to the same name — never overwrite each other.
        const dir = rjoin(
          rjoin(await ssh.sftpRealpath(args.connectionId, '.'), STAGE_DIR),
          randomBytes(6).toString('hex')
        )
        await ssh.sftpEnsureDir(args.connectionId, dir, STAGE_DIR_MODE)

        const taken = new Set<string>()
        for (const local of args.paths) {
          const label = basename(local)
          // Reserve the `.part` scratch name alongside the final one. A batch
          // holding both `report` and `report.part` would otherwise have the
          // second file's upload land on the first one's already-staged bytes,
          // and its cleanup delete a file the user was told had arrived.
          let name = stageName(local)
          for (let i = 2; taken.has(name) || taken.has(`${name}.part`); i++) {
            name = `${i}_${stageName(local)}`
          }
          taken.add(name).add(`${name}.part`)
          const remote = rjoin(dir, name)
          const part = `${remote}.part`
          try {
            const st = await stat(local)
            if (st.isDirectory()) {
              throw new Error('Folders have to go through the Files tab.')
            }
            if (!st.isFile()) throw new Error('Not a regular file.')
            if (st.size > MAX_STAGE_BYTES) {
              throw new Error(
                `Larger than the ${MAX_STAGE_BYTES / 1024 / 1024} MB drop limit — use the Files tab.`
              )
            }
            // Upload under a `.part` name and rename once it lands. A path is
            // only ever injected after all the bytes are there, so a command run
            // against it can't read a half-written file — `fastPut` leaves the
            // truncated remainder behind when it fails.
            await ssh.sftpUpload(
              args.connectionId,
              local,
              part,
              `${args.transferId}:${name}`,
              label,
              STAGE_FILE_MODE
            )
            await ssh.sftpRename(args.connectionId, part, remote)
            files.push({ name: label, path: remote })
          } catch (e) {
            errors.push({ name: label, error: e instanceof Error ? e.message : String(e) })
            await ssh.sftpDelete(args.connectionId, part, false).catch(() => undefined)
          }
        }
      } finally {
        if (opened) ssh.closeSftp(args.connectionId)
        await discardScratch(args.paths)
      }
      return { files, errors }
    }
  )

  // Write the clipboard's image to a local PNG and return its path, for the
  // caller to stage like any dropped file. In main on purpose: a NativeImage
  // can't cross the context bridge, and pushing raw image bytes through the
  // renderer just to hand them back would copy them through a process that has
  // no reason to hold them. Null when the clipboard has no image — the usual case.
  ipcMain.handle('clipboard:imageToTemp', async (): Promise<string | null> => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const dir = pasteDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `paste-${randomBytes(6).toString('hex')}.png`)
    await writeFile(file, img.toPNG(), { mode: 0o600 })
    return file
  })

  ipcMain.on('sftp:close', (_e, connectionId: string) => ssh.closeSftp(connectionId))

  ipcMain.on('ssh:input', (_e, sessionId: string, data: string) => ssh.write(sessionId, data))
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ssh.resize(sessionId, cols, rows)
  )
  ipcMain.on('ssh:close', (_e, sessionId: string) => ssh.close(sessionId))
  ipcMain.on('ssh:stop-reattach', (_e, sessionId: string) => ssh.stopReattach(sessionId))

  // ---- tmux control mode (tmux -CC) ----
  ipcMain.on('tmux:send-keys', (_e, sessionId: string, paneId: string, data: string) =>
    ssh.tmuxSendKeys(sessionId, paneId, data)
  )
  ipcMain.on('tmux:select-window', (_e, sessionId: string, windowId: string) =>
    ssh.tmuxSelectWindow(sessionId, windowId)
  )
  ipcMain.on('tmux:select-pane', (_e, sessionId: string, paneId: string) =>
    ssh.tmuxSelectPane(sessionId, paneId)
  )
  ipcMain.on('tmux:new-window', (_e, sessionId: string) => ssh.tmuxNewWindow(sessionId))
  ipcMain.on('tmux:split', (_e, sessionId: string, paneId: string, direction: 'columns' | 'rows') =>
    ssh.tmuxSplitPane(sessionId, paneId, direction)
  )
  ipcMain.on('tmux:kill-pane', (_e, sessionId: string, paneId: string) =>
    ssh.tmuxKillPane(sessionId, paneId)
  )
  ipcMain.on('ssh:hostkey-response', (_e, requestId: string, accept: boolean) =>
    ssh.resolveHostKey(requestId, accept)
  )

  // ---- agent attention ----
  // One live Notification per leaf, so a session that signals twice replaces its
  // own banner instead of stacking. Electron has no notification tag or replace
  // key; re-showing the same instance is the only collapse there is.
  const notices = new Map<string, Notification>()

  ipcMain.on('agent:notify', (_e, leafId: string, title: string, body: string) => {
    if (!Notification.isSupported()) return
    const w = getWindow()
    if (w && !w.isDestroyed() && w.isFocused()) return // the renderer already showed it

    notices.get(leafId)?.close()
    const n = new Notification({ title: title || 'Claude Code', body, silent: false })
    n.on('click', () => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      // Raising the window is not the same as becoming the frontmost app when
      // something else owns the foreground, which is exactly the situation a
      // notification click starts from.
      app.focus({ steal: true })
      send('agent:focus', leafId)
    })
    n.on('close', () => {
      if (notices.get(leafId) === n) notices.delete(leafId)
    })
    notices.set(leafId, n)
    n.show()
  })

  // The renderer owns the truth about which leaves are waiting, so it pushes the
  // count rather than main trying to keep a parallel tally.
  ipcMain.on('agent:badge', (_e, count: number) => {
    if (process.platform === 'win32') return // no count badge; the taskbar wants an overlay icon
    app.setBadgeCount(Math.max(0, Math.trunc(count)))
  })

  // ---- Claude Code hooks on the remote ----
  // Read `~/.claude/settings.json`, work out what installing or removing our
  // Notification hook would do, and (for apply) write it back atomically.
  //
  // The merge happens here rather than in the renderer for two reasons: a
  // missing file has to read as `{}`, and the SFTP status code that says
  // "missing" rather than "unreadable" is a number on the ssh2 error that does
  // not survive ipcMain's error serialization. Like `sftp:upload-to`, this
  // brackets its own SFTP channel — a Dashboard has no Files tab behind it.
  const withClaudeSettings = async <T,>(
    connectionId: string,
    password: string | undefined,
    fn: (home: string, raw: string | null) => Promise<T>
  ): Promise<T> => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    let opened = false
    try {
      await ssh.openSftp(connectionId, connection, passwordFor(connectionId, password), undefined, 30000)
      opened = true
      const home = await ssh.sftpRealpath(connectionId, '.')
      const path = rjoin(home, CLAUDE_SETTINGS_PATH)
      let raw: string | null = null
      try {
        raw = (await ssh.sftpReadFile(connectionId, path)).content
      } catch (e) {
        // SFTP status 2 is NO_SUCH_FILE. A server that has never run Claude Code
        // has no settings file, and that is a normal starting state, not an
        // error — anything else (permissions, a directory, a dead link) is real.
        if ((e as { code?: number }).code !== 2) throw e
      }
      return await fn(path, raw)
    } finally {
      if (opened) ssh.closeSftp(connectionId)
    }
  }

  ipcMain.handle(
    'claude:hook-status',
    async (_e, args: { connectionId: string; password?: string }): Promise<ClaudeHookStatus> =>
      withClaudeSettings(args.connectionId, args.password, async (path, raw) => {
        const install = planHooks(raw, 'install')
        const uninstall = planHooks(raw, 'uninstall')
        return {
          path,
          before: install.before,
          install: install.after,
          uninstall: uninstall.after,
          installed: install.installed,
          present: install.present
        }
      })
  )

  ipcMain.handle(
    'claude:hook-apply',
    async (
      _e,
      args: { connectionId: string; password?: string; action: 'install' | 'uninstall' }
    ): Promise<ClaudeHookStatus> =>
      withClaudeSettings(args.connectionId, args.password, async (path, raw) => {
        // Re-planned from a fresh read rather than trusting the preview the user
        // approved: the file may have moved under us, and the alternative is
        // writing back a document that no longer reflects what's on the server.
        const plan = planHooks(raw, args.action)
        if (plan.after !== plan.before) {
          await ssh.sftpEnsureDir(args.connectionId, dirname(path), 0o700)
          await ssh.sftpWriteFileAtomic(args.connectionId, path, plan.after, 0o600)
        }
        const after = planHooks(plan.after, 'install')
        return {
          path,
          before: plan.after,
          install: after.after,
          uninstall: planHooks(plan.after, 'uninstall').after,
          installed: after.installed,
          present: after.present
        }
      })
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
  ipcMain.handle('window:is-fullscreen', () => getWindow()?.isFullScreen() ?? false)

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
    else if (action === 'fullscreen') toggleFullScreen(w)
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
