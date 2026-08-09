// Wires the renderer <-> main bridge: connection CRUD, secrets, and SSH session
// lifecycle. SSH events are pushed to the focused window via webContents.send.
import {
  app,
  ipcMain,
  clipboard,
  dialog,
  nativeTheme,
  shell,
  BrowserWindow,
  Notification,
  type WebContents
} from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  AgentHostScan,
  ClaudeHookStatus,
  ClaudeStatusLineStatus,
  ClaudeTmuxPassthroughStatus,
  Connection,
  ConnectionDraft,
  ServerStats,
  SettingsPatch,
  SftpList,
  StageResult,
  TmuxIntent,
  TmuxSession,
  TunnelDef,
  Workspace,
  WorktreeScan
} from '../shared/types'
import { connectionStore } from './store/connections'
import { draftStore } from './store/drafts'
import { secrets } from './store/secrets'
import { settingsStore } from './store/settings'
import { tunnelsStore } from './store/tunnels'
import { workspaceStore } from './store/workspace'
import { SshManager, isPermanentScanFailure } from './ssh/manager'
import {
  CLAUDE_SETTINGS_PATH,
  TMUX_CONF_PATH,
  planHooks,
  planStatusLine,
  planTmuxPassthrough
} from './claudeHooks'
import { agentScanScript, parseAgentScan } from '../shared/agents'
import { SEP, shQuote, shWrap } from '../shared/shell'
import type { WorktreeInspect, WorktreeStart } from '../shared/worktrees'
import {
  MAX_BRANCHES,
  MAX_INSPECT,
  MAX_WORKTREES,
  WORKTREE_DIR,
  parseWorktreeInspect,
  parseWorktreeScan,
  parseWorktreeWrite,
  refNameError,
  worktreeInspectScript,
  worktreeAddScript,
  worktreeListScript,
  worktreeNameError,
  worktreeRemoveScript
} from '../shared/worktrees'

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

/**
 * Read `key=value` probe output. Split on the *first* `=` only, so a value may
 * contain one; last line wins, so a probe that retries a key overrides it.
 *
 * One implementation, used by every probe: two would drift, and the difference
 * would show up as a field that silently reads empty on one panel.
 */
function kv(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return map
}

function parseProbe(text: string): ServerStats {
  const map = kv(text)
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

  /**
   * Hosts whose last Agent Inbox scan failed in a way that repeating cannot fix —
   * a rejected credential, a name that doesn't resolve, a refused host key.
   *
   * This exists because the inbox's sweep is the app's only *repeating* dialer.
   * Everything else connects when the user asks; the inbox re-asks every ten
   * seconds for as long as the panel is open, and with no memory of a refusal it
   * would open a fresh TCP connection and fail authentication six times a minute,
   * indefinitely, against a server that has already said no. That is precisely
   * the traffic fail2ban exists to ban — and the ban would take the user's
   * terminals, tunnels and file manager down with it, from a panel they left open
   * in the background.
   *
   * Latched rather than backed off, because none of these heal on their own: they
   * heal when the user changes something. So it clears on the events that mean
   * they did — editing the connection or its password, removing it, or pressing
   * Refresh, which is the user saying "try again" in as many words. A host in
   * here still gets its row in the panel; it just doesn't get dialed.
   */
  const scanBlocked = new Map<string, string>()

  // ---- connections ----
  ipcMain.handle('conn:list', () => connectionStore.list())
  ipcMain.handle('conn:upsert', (_e, draft: ConnectionDraft) => {
    const conn = connectionStore.upsert(draft)
    if (draft.authMethod === 'password' && draft.password) {
      secrets.set(conn.id, draft.password)
    }
    // Whatever the inbox's sweep gave up on for this host, the user has just
    // edited the thing it would have given up over.
    scanBlocked.delete(conn.id)
    return conn
  })
  ipcMain.handle('conn:remove', (_e, id: string) => {
    ssh.stopTunnelsForConnection(id)
    tunnelsStore.remove(id)
    connectionStore.remove(id)
    secrets.clear(id)
    scanBlocked.delete(id)
  })
  ipcMain.on('conn:set-last-sftp-path', (_e, id: string, path: string) =>
    connectionStore.setLastSftpPath(id, path)
  )
  ipcMain.handle('secrets:available', () => secrets.available())
  ipcMain.handle('secrets:has', (_e, id: string) => secrets.get(id) !== null)

  // ---- prompt composer drafts (local autosave — survives disconnects, restarts, crashes) ----
  ipcMain.handle('drafts:all', () => draftStore.all())
  ipcMain.handle('drafts:set', (_e, key: string, value: string) => draftStore.set(key, value))

  // ---- settings (persisted to userData/settings.json) ----
  ipcMain.handle('settings:get', () => settingsStore.getAll())
  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => {
    const updated = settingsStore.update(patch)
    if (patch.theme) nativeTheme.themeSource = patch.theme
    return updated
  })

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
      const password = passwordFor(args.connectionId, args.password)
      const res = await ssh.exec(args.connectionId, connection, {
        command: TMUX_LIST,
        password,
        timeoutMs: 15000
      })
      return parseTmux(res.stdout + '\n' + res.stderr)
    }
  )
  ipcMain.handle(
    'ssh:tmux-kill',
    async (_e, args: { connectionId: string; password?: string; name: string }): Promise<void> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password = passwordFor(args.connectionId, args.password)
      const res = await ssh.exec(args.connectionId, connection, {
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
      const res = await ssh.exec(args.connectionId, connection, {
        command: `tmux rename-session -t ${shQuote(args.from)} ${shQuote(args.to)}`,
        password,
        timeoutMs: 15000
      })
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'Failed to rename session')
    }
  )
  /**
   * Agent Inbox: ask every configured host what tmux sessions it is running.
   *
   * Fans out rather than iterating — the hosts are independent, and a serial
   * sweep would make the panel's latency the *sum* of every host's, including
   * hosts that are down. One host's failure is that host's row, never the
   * scan's: this settles all of them and reports per host. The fan-out is capped
   * because it is unbounded in the user's host count and the work is DNS: every
   * dial goes to `getaddrinfo` on libuv's four-thread pool, so a handful of
   * unresolvable VPN-only names would otherwise stall unrelated main-process work
   * — including the `fs` writes that persist settings — on every single poll.
   *
   * Three deliberate refusals, all about not doing damage on the user's behalf:
   *
   * - A password connection with no stored secret is **skipped, not attempted**.
   *   There is nothing to authenticate with, so the connect could only fail —
   *   and a sweep that fires a doomed auth at every such host on every refresh is
   *   how an app gets its user banned by fail2ban. Prompting instead is worse: it
   *   would raise a password dialog for hosts the user never asked to open.
   * - A host that has already refused us is not dialed again until the user
   *   changes something (see `scanBlocked`).
   * - `unattended` refuses an unknown host key rather than prompting, so one
   *   refresh cannot raise a stack of verification dialogs.
   */
  const SCAN_FANOUT = 6

  ipcMain.handle(
    'agents:scan',
    async (_e, args?: { retryFailed?: boolean }): Promise<AgentHostScan[]> => {
      if (args?.retryFailed) scanBlocked.clear()
      const command = shWrap(agentScanScript())
      const connections = connectionStore.list()
      const out: AgentHostScan[] = new Array(connections.length)
      let next = 0

      const scanOne = async (connection: Connection): Promise<AgentHostScan> => {
        const base = { connectionId: connection.id, name: connection.name, sessions: [] }
        const password = passwordFor(connection.id)
        if (connection.authMethod === 'password' && !password) {
          return { ...base, skipped: true, error: 'No saved password' }
        }
        const blocked = scanBlocked.get(connection.id)
        if (blocked) return { ...base, skipped: true, error: blocked }
        try {
          const res = await ssh.exec(connection.id, connection, {
            command,
            password,
            timeoutMs: 12000,
            deadlineMs: 10000,
            unattended: true
          })
          // parseAgentScan is host-agnostic and never sees a connection id;
          // stamped on here, once, right where the scan is attributed to a host.
          const sessions = parseAgentScan(res.stdout).sessions.map((s) => ({
            ...s,
            connectionId: connection.id
          }))
          return { ...base, sessions }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          if (isPermanentScanFailure(e)) scanBlocked.set(connection.id, message)
          return { ...base, error: message }
        }
      }

      const worker = async (): Promise<void> => {
        for (let i = next++; i < connections.length; i = next++) {
          out[i] = await scanOne(connections[i])
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(SCAN_FANOUT, connections.length) }, worker)
      )
      return out
    }
  )

  ipcMain.handle(
    'ssh:probe',
    async (_e, args: { connectionId: string; password?: string }): Promise<ServerStats> => {
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password = passwordFor(args.connectionId, args.password)
      const started = Date.now()
      const res = await ssh.exec(args.connectionId, connection, {
        command: PROBE,
        password,
        timeoutMs: 15000
      })
      const stats = parseProbe(res.stdout)
      // Now that the connection is pooled this is the command's round trip on a
      // warm link, not a handshake plus a command. It reads lower than it used
      // to and is the more honest latency number for what the card claims.
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

  // Read file references off the OS clipboard — files copied in Finder/Explorer,
  // not a screenshot's bitmap (that's clipboard:imageToTemp above, a different
  // clipboard slot entirely). Which format the OS actually populates is
  // platform-specific, and Electron's clipboard API exposes raw formats rather
  // than decoding them, so this tries the formats known to carry a file list, in
  // the order they're most likely to be present. `text/uri-list` is the only one
  // that reliably carries more than one path; a single-item pasteboard type like
  // `public.file-url`/`FileNameW` is a known-narrower fallback, not a bug in this
  // handler — multi-select copies on macOS/Windows only round-trip their first
  // file through Electron's clipboard API at all.
  ipcMain.handle('clipboard:filesToPaths', async (): Promise<string[]> => {
    const raw =
      (clipboard.has('text/uri-list') && clipboard.read('text/uri-list')) ||
      (clipboard.has('public.file-url') && clipboard.read('public.file-url')) ||
      (process.platform === 'win32' && clipboard.has('FileNameW') && clipboard.read('FileNameW')) ||
      ''
    const paths: string[] = []
    for (const line of raw.split(/[\r\n]+/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      try {
        const p = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed
        if (existsSync(p)) paths.push(p)
      } catch {
        // Not a valid file URL — skip it rather than staging garbage.
      }
    }
    return paths
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

  // ---- Claude Code status line on the remote ----
  // Same read-modify-write shape as the hook handlers above, for the
  // `statusLine` setting instead of the `hooks.Notification` array.
  ipcMain.handle(
    'claude:statusline-status',
    async (_e, args: { connectionId: string; password?: string }): Promise<ClaudeStatusLineStatus> =>
      withClaudeSettings(args.connectionId, args.password, async (path, raw) => {
        const install = planStatusLine(raw, 'install')
        const uninstall = planStatusLine(raw, 'uninstall')
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
    'claude:statusline-apply',
    async (
      _e,
      args: { connectionId: string; password?: string; action: 'install' | 'uninstall' }
    ): Promise<ClaudeStatusLineStatus> =>
      withClaudeSettings(args.connectionId, args.password, async (path, raw) => {
        // Re-planned from a fresh read rather than trusting the preview the user
        // approved: the file may have moved under us, and the alternative is
        // writing back a document that no longer reflects what's on the server.
        const plan = planStatusLine(raw, args.action)
        if (plan.after !== plan.before) {
          await ssh.sftpEnsureDir(args.connectionId, dirname(path), 0o700)
          await ssh.sftpWriteFileAtomic(args.connectionId, path, plan.after, 0o600)
        }
        const after = planStatusLine(plan.after, 'install')
        return {
          path,
          before: plan.after,
          install: after.after,
          uninstall: planStatusLine(plan.after, 'uninstall').after,
          installed: after.installed,
          present: after.present
        }
      })
  )

  // ---- tmux allow-passthrough, for the Notification hook above ----
  // Read `~/.tmux.conf` (plain text, not JSON — see withClaudeSettings above for
  // why a missing file still has to read as present-but-empty rather than an
  // error), work out what installing or removing our passthrough line would do,
  // and write it back. Same bracketed-SFTP-channel shape as withClaudeSettings.
  const withTmuxConf = async <T,>(
    connectionId: string,
    password: string | undefined,
    fn: (path: string, raw: string | null) => Promise<T>
  ): Promise<T> => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    let opened = false
    try {
      await ssh.openSftp(connectionId, connection, passwordFor(connectionId, password), undefined, 30000)
      opened = true
      const home = await ssh.sftpRealpath(connectionId, '.')
      const path = rjoin(home, TMUX_CONF_PATH)
      let raw: string | null = null
      try {
        raw = (await ssh.sftpReadFile(connectionId, path)).content
      } catch (e) {
        if ((e as { code?: number }).code !== 2) throw e
      }
      return await fn(path, raw)
    } finally {
      if (opened) ssh.closeSftp(connectionId)
    }
  }

  ipcMain.handle(
    'claude:tmux-passthrough-status',
    async (_e, args: { connectionId: string; password?: string }): Promise<ClaudeTmuxPassthroughStatus> =>
      withTmuxConf(args.connectionId, args.password, async (path, raw) => {
        const install = planTmuxPassthrough(raw, 'install')
        const uninstall = planTmuxPassthrough(raw, 'uninstall')
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
    'claude:tmux-passthrough-apply',
    async (
      _e,
      args: { connectionId: string; password?: string; action: 'install' | 'uninstall' }
    ): Promise<ClaudeTmuxPassthroughStatus> =>
      withTmuxConf(args.connectionId, args.password, async (path, raw) => {
        const plan = planTmuxPassthrough(raw, args.action)
        if (plan.after !== plan.before) {
          await ssh.sftpEnsureDir(args.connectionId, dirname(path), 0o700)
          await ssh.sftpWriteFileAtomic(args.connectionId, path, plan.after, 0o600)
        }
        // Best-effort: also flip the option on whatever tmux server is already
        // running, so a session that predates this write does not have to wait
        // for a server restart to pick up ~/.tmux.conf. Only on install — never
        // the reverse. We can only honestly take back what we can prove is ours,
        // and that is the persisted line, not the live value: the user may well
        // have set allow-passthrough themselves at the live server, independent
        // of this file, and uninstall must not silently take that away from
        // them. Silent no-op if tmux is missing or no server is up.
        if (args.action === 'install') {
          const connection = connectionStore.get(args.connectionId)
          if (connection) {
            await ssh
              .exec(args.connectionId, connection, {
                command: shWrap(
                  'command -v tmux >/dev/null 2>&1 && tmux set -g allow-passthrough all >/dev/null 2>&1; true'
                ),
                password: passwordFor(args.connectionId, args.password),
                timeoutMs: 8000,
                deadlineMs: 15000
              })
              .catch(() => {})
          }
        }
        const after = planTmuxPassthrough(plan.after, 'install')
        return {
          path,
          before: plan.after,
          install: after.after,
          uninstall: planTmuxPassthrough(plan.after, 'uninstall').after,
          installed: after.installed,
          present: after.present
        }
      })
  )

  // ---- git ----

  /**
   * Run one git command on the connection's pooled client.
   *
   * The ref-counted pool means a connection whose file manager is already open
   * pays nothing for this, and one whose isn't keeps the connection warm for the
   * grace period. Raw bytes, because a worktree listing carries paths that are
   * bytes on the server, not necessarily valid UTF-8.
   */
  const gitExec = async (
    connectionId: string,
    password: string | undefined,
    script: string,
    maxBytes: number,
    // 30s suits a read: every other caller here asks git a question and gets an
    // answer back off the disk it already has. `worktree add` is the exception —
    // it writes a full checkout of the tree, and on a large repo that is minutes,
    // not seconds. Timing it out at 30s would not stop the checkout, only orphan
    // it: the app would report failure over a worktree that then finishes.
    deadlineMs = 30000
  ): Promise<Buffer> => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    const res = await ssh.execBytes(connectionId, connection, {
      command: shWrap(script),
      password: passwordFor(connectionId, password),
      timeoutMs: deadlineMs,
      deadlineMs,
      maxBytes
    })
    return res.stdout
  }

  /** What the git scripts' `err=` values mean, in words a panel can show. */
  const GIT_ERRORS: Record<string, string> = {
    nodir: 'That directory no longer exists on the server.',
    nogit: 'git is not installed on this server.',
    norepo: 'That directory is not inside a git repository.'
  }

  /**
   * Worktree launcher: the git worktrees of the repo containing `dir`.
   *
   * Read-only, and attended — unlike the Agent Inbox sweep this runs because the
   * user opened one host's panel, so a key-verification prompt here is expected
   * rather than a surprise, and there is no repeating dialler to rate-limit.
   */
  ipcMain.handle(
    'git:worktrees',
    async (_e, args: { connectionId: string; dir: string; password?: string }): Promise<WorktreeScan> => {
      if (!args.dir.startsWith('/')) throw new Error('Directory must be an absolute path')
      const out = await gitExec(
        args.connectionId,
        args.password,
        worktreeListScript(args.dir),
        // A worktree record is a path plus a few short attributes; 4 KB each is
        // generous, and the branch header is capped separately by MAX_BRANCHES.
        MAX_WORKTREES * 4096 + MAX_BRANCHES * 256 + 65536
      )
      const scan = parseWorktreeScan(out.toString('utf-8'))
      // parseWorktreeScan is host-agnostic and never sees a connection id;
      // stamped on here, once, right where the scan is attributed to a host.
      return {
        ...scan,
        worktrees: scan.worktrees
          .slice(0, MAX_WORKTREES)
          .map((w) => ({ ...w, connectionId: args.connectionId }))
      }
    }
  )

  /**
   * Create a worktree under the repo's `.claude/worktrees`.
   *
   * Every argument is re-validated here even though the renderer validated them
   * too. The renderer is not what holds the SSH connection, and a name reaching
   * git as an option is not a rendering bug.
   */
  ipcMain.handle(
    'git:worktreeAdd',
    async (
      _e,
      args: {
        connectionId: string
        repoRoot: string
        name: string
        start: WorktreeStart
        password?: string
      }
    ): Promise<{ path: string }> => {
      if (!args.repoRoot.startsWith('/')) throw new Error('Repository root must be an absolute path')
      const nameErr = worktreeNameError(args.name)
      if (nameErr) throw new Error(nameErr)
      const start = args.start
      if (start?.kind !== 'new' && start?.kind !== 'existing') throw new Error('Invalid start point')
      const branchErr = refNameError(start.branch)
      if (branchErr) throw new Error(branchErr)
      if (start.kind === 'new') {
        const fromErr = refNameError(start.from, 'start point')
        if (fromErr) throw new Error(fromErr)
      }
      const out = await gitExec(
        args.connectionId,
        args.password,
        worktreeAddScript(args.repoRoot, args.name, start),
        65536,
        // Checking out a large tree is minutes of real work, not a query.
        10 * 60 * 1000
      )
      const res = parseWorktreeWrite(out.toString('utf-8'))
      if (!res.ok) throw new Error(res.error ?? 'Could not create the worktree.')
      return { path: res.path ?? `${args.repoRoot}/${WORKTREE_DIR}/${args.name}` }
    }
  )

  /**
   * Remove a worktree — and only ever the unforced `git worktree remove`.
   *
   * The renderer refuses to offer this for a locked worktree, but that is the
   * courtesy, not the guarantee. The guarantee is that no `--force` is ever
   * built, so git itself is the thing standing between a click and an agent's
   * uncommitted work. See shared/worktrees.ts.
   */
  ipcMain.handle(
    'git:worktreeRemove',
    async (
      _e,
      args: { connectionId: string; repoRoot: string; path: string; password?: string }
    ): Promise<void> => {
      if (!args.repoRoot.startsWith('/')) throw new Error('Repository root must be an absolute path')
      if (!args.path.startsWith('/')) throw new Error('Worktree path must be an absolute path')
      if (args.path === args.repoRoot) throw new Error('That is the repository itself, not a worktree')
      const out = await gitExec(
        args.connectionId,
        args.password,
        worktreeRemoveScript(args.repoRoot, args.path),
        65536
      )
      const res = parseWorktreeWrite(out.toString('utf-8'))
      if (!res.ok) throw new Error(res.error ?? 'Could not remove the worktree.')
    }
  )

  // Read-only, and the removal confirm will not open without it: git deletes a
  // worktree's ignored files without ever refusing, so this is the only thing
  // that can tell the user their `.env` is included in that button.
  ipcMain.handle(
    'git:worktreeInspect',
    async (
      _e,
      args: { connectionId: string; path: string; password?: string }
    ): Promise<WorktreeInspect> => {
      if (!args.path.startsWith('/')) throw new Error('Worktree path must be an absolute path')
      const out = await gitExec(
        args.connectionId,
        args.password,
        worktreeInspectScript(args.path),
        MAX_INSPECT * 4096 + 65536
      )
      return parseWorktreeInspect(out.toString('utf-8'))
    }
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
