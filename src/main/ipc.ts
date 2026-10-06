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
import { spawn } from 'node:child_process'
import { mkdir, rm, stat, writeFile, readFile, readdir, rename, chmod } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type {
  AgentHostScan,
  ClaudeHookStatus,
  ClaudeStatusLineStatus,
  ClaudeSyncBulkOp,
  ClaudeSyncCategory,
  ClaudeSyncDiff,
  ClaudeSyncManifest,
  ClaudeSyncOp,
  ClaudeSyncOpResult,
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
import { promptHistoryStore } from './store/promptHistory'
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
import {
  CLAUDE_MD_RELPATH,
  KEYBINDINGS_RELPATH,
  MARKETPLACES_RELPATH,
  MCP_SERVERS_PSEUDO_RELPATH,
  SETTINGS_RELPATH,
  SYNC_DIR_CATEGORIES,
  diffState,
  extractMcpServers,
  isExecutableMode,
  planMcpServersMerge,
  planSettingsMerge
} from './claudeSync'
import { agentScanScript, parseAgentScan } from '../shared/agents'
import { SEP, shQuote, shWrap } from '../shared/shell'
import {
  PROJECT_SLUG_MAX,
  projectSlug,
  type ReaderChunk,
  type ReaderSession
} from '../shared/claudeTranscript'
import type {
  ChatAnswer,
  ChatKeysResult,
  ChatCommandInfo,
  ChatMode,
  ChatScreenInfo,
  ChatSession,
  ChatStreamData,
  ChatStreamEnd,
  ChatTarget,
  WorkflowAgent
} from '../shared/chatProtocol'
import {
  CHAT_LIST_SCRIPT,
  PANE_RE,
  isUuid,
  parseChatSessions
} from '../shared/claudeSessions'
import {
  DIALOG_FOOTER,
  EFFORT_LEVELS,
  INTERRUPT,
  KEY,
  MARK,
  MODE_FOOTER,
  MODE_MAX_PRESSES,
  inputHasDraft,
  parseDialogText,
  parseFooter,
  parsePrompt,
  promptHasOption
} from '../shared/tuiKeys'
import { claudeResumeSessionName, claudeScript, claudeSessionName } from '../shared/claude'
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
    const win = getWindow()
    // A destroyed BrowserWindow throws on property access (even `.webContents`),
    // not just returns undefined — an SSH socket event arriving after the window
    // closes (e.g. during quit) would otherwise crash the main process here.
    if (!win || win.isDestroyed()) return
    const wc: WebContents = win.webContents
    if (!wc.isDestroyed()) wc.send(channel, ...args)
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

  // ---- composer prompt history (persisted, never cleared, capped at 1000) ----
  ipcMain.handle('promptHistory:all', () => promptHistoryStore.all())
  ipcMain.handle('promptHistory:add', (_e, text: string) => promptHistoryStore.add(text))

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

  // ---- Claude config sync (computer ⇄ server) ----
  // Bidirectional sync of the global `~/.claude` config (plus the `mcpServers`
  // subtree of `~/.claude.json`, one level up) between this machine and a
  // remote. Same bracketed-SFTP-session shape as withClaudeSettings above; the
  // merge/diff logic itself lives in claudeSync.ts.

  const localClaudeHome = join(homedir(), '.claude')

  const localReadFile = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return null
    }
  }

  const localWriteFile = async (path: string, content: string, executable: boolean): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, content, 'utf-8')
    await chmod(tmp, executable ? 0o755 : 0o644)
    await rename(tmp, path)
  }

  // Marketplace clones under plugins/marketplaces can carry a full `.git`
  // object database or a populated `node_modules` — neither is config to
  // sync, and walking into them file-by-file is the single biggest cost in a
  // scan. Skip them everywhere, not just under plugins.
  const SYNC_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])

  // Bounded-concurrency map: runs `fn` over `items` with at most `limit` in
  // flight. SFTP over ssh2 pipelines requests fine, but an unbounded
  // Promise.all across a wide tree (thousands of dir entries) risks
  // overwhelming the channel window — this caps it while still getting the
  // bulk of the parallelism win over a fully serial walk.
  async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
    return results
  }

  interface LocalTreeEntry {
    relPath: string
    size: number
    executable: boolean
  }

  const walkLocalDir = async (root: string, relDir = ''): Promise<LocalTreeEntry[]> => {
    const dirPath = relDir ? join(root, relDir) : root
    let items: Dirent[]
    try {
      items = await readdir(dirPath, { withFileTypes: true, encoding: 'utf-8' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return []
    }
    const results = await mapConcurrent(items, 8, async (it): Promise<LocalTreeEntry[]> => {
      const rel = relDir ? `${relDir}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (SYNC_EXCLUDED_DIRS.has(it.name)) return []
        return walkLocalDir(root, rel)
      } else if (it.isFile()) {
        const st = await stat(join(root, rel))
        return [{ relPath: rel, size: st.size, executable: (st.mode & 0o111) !== 0 }]
      }
      return []
    })
    return results.flat()
  }

  interface RemoteTreeEntry {
    relPath: string
    size: number
    mode: number
  }

  const walkRemoteDir = async (
    connectionId: string,
    absRoot: string,
    relDir = ''
  ): Promise<RemoteTreeEntry[]> => {
    const dirPath = relDir ? rjoin(absRoot, relDir) : absRoot
    let list: SftpList
    try {
      list = await ssh.sftpList(connectionId, dirPath)
    } catch (e) {
      if ((e as { code?: number }).code !== 2) throw e
      return []
    }
    const results = await mapConcurrent(list.entries, 8, async (entry): Promise<RemoteTreeEntry[]> => {
      if (entry.isSymlink) return []
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (SYNC_EXCLUDED_DIRS.has(entry.name)) return []
        return walkRemoteDir(connectionId, absRoot, rel)
      } else if (entry.type === 'file') {
        return [{ relPath: rel, size: entry.size, mode: entry.mode }]
      }
      return []
    })
    return results.flat()
  }

  const remoteReadFile = async (connectionId: string, path: string): Promise<string | null> => {
    try {
      return (await ssh.sftpReadFile(connectionId, path)).content
    } catch (e) {
      if ((e as { code?: number }).code !== 2) throw e
      return null
    }
  }

  const WHOLE_FILE_RELPATHS = new Set([
    CLAUDE_MD_RELPATH,
    SETTINGS_RELPATH,
    KEYBINDINGS_RELPATH,
    MARKETPLACES_RELPATH
  ])

  const withClaudeHome = async <T,>(
    connectionId: string,
    password: string | undefined,
    fn: (remoteHomeRoot: string, remoteHome: string) => Promise<T>
  ): Promise<T> => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    let opened = false
    try {
      await ssh.openSftp(connectionId, connection, passwordFor(connectionId, password), undefined, 30000)
      opened = true
      const remoteHomeRoot = await ssh.sftpRealpath(connectionId, '.')
      return await fn(remoteHomeRoot, rjoin(remoteHomeRoot, '.claude'))
    } finally {
      if (opened) ssh.closeSftp(connectionId)
    }
  }

  ipcMain.handle(
    'claude-sync:scan',
    async (_e, args: { connectionId: string; password?: string }): Promise<ClaudeSyncManifest> =>
      withClaudeHome(args.connectionId, args.password, async (remoteHomeRoot, remoteHome) => {
        const entries: ClaudeSyncManifest['entries'] = []

        const wholeFileEntries = await Promise.all(
          [CLAUDE_MD_RELPATH, SETTINGS_RELPATH, KEYBINDINGS_RELPATH, MARKETPLACES_RELPATH].map(async (relPath) => {
            const category: ClaudeSyncCategory =
              relPath === CLAUDE_MD_RELPATH ? 'claudeMd' : relPath === MARKETPLACES_RELPATH ? 'plugins' : 'settings'
            const [localRaw, remoteRaw] = await Promise.all([
              localReadFile(join(localClaudeHome, relPath)),
              remoteReadFile(args.connectionId, rjoin(remoteHome, relPath))
            ])
            return {
              category,
              relPath,
              state: diffState(localRaw, remoteRaw),
              localSize: localRaw === null ? null : Buffer.byteLength(localRaw, 'utf-8'),
              remoteSize: remoteRaw === null ? null : Buffer.byteLength(remoteRaw, 'utf-8'),
              executable: false
            }
          })
        )
        entries.push(...wholeFileEntries)

        const [localClaudeJson, remoteClaudeJson] = await Promise.all([
          localReadFile(join(homedir(), '.claude.json')),
          remoteReadFile(args.connectionId, rjoin(remoteHomeRoot, '.claude.json'))
        ])
        const localServers = extractMcpServers(localClaudeJson)
        const remoteServers = extractMcpServers(remoteClaudeJson)
        entries.push({
          category: 'mcpServers',
          relPath: MCP_SERVERS_PSEUDO_RELPATH,
          state: diffState(localServers, remoteServers),
          localSize: localServers === null ? null : Buffer.byteLength(localServers, 'utf-8'),
          remoteSize: remoteServers === null ? null : Buffer.byteLength(remoteServers, 'utf-8'),
          executable: false
        })

        await Promise.all(
          SYNC_DIR_CATEGORIES.map(async ({ category, relDir }) => {
            const [localFiles, remoteFiles] = await Promise.all([
              walkLocalDir(join(localClaudeHome, relDir)),
              walkRemoteDir(args.connectionId, rjoin(remoteHome, relDir))
            ])
            const localByRel = new Map(localFiles.map((f) => [f.relPath, f]))
            const remoteByRel = new Map(remoteFiles.map((f) => [f.relPath, f]))
            const allRel = [...new Set([...localByRel.keys(), ...remoteByRel.keys()])]
            const dirEntries = await mapConcurrent(allRel, 8, async (rel) => {
              const l = localByRel.get(rel)
              const r = remoteByRel.get(rel)
              let state: ClaudeSyncManifest['entries'][number]['state']
              if (l && r) {
                // Different sizes already prove the content differs — skip
                // the two full-file reads and their SFTP round trips.
                if (l.size !== r.size) {
                  state = 'differ'
                } else {
                  const [lc, rc] = await Promise.all([
                    localReadFile(join(localClaudeHome, relDir, rel)),
                    remoteReadFile(args.connectionId, rjoin(rjoin(remoteHome, relDir), rel))
                  ])
                  state = diffState(lc, rc)
                }
              } else {
                state = l ? 'local-only' : 'remote-only'
              }
              return {
                category,
                relPath: `${relDir}/${rel}`,
                state,
                localSize: l ? l.size : null,
                remoteSize: r ? r.size : null,
                executable: l ? l.executable : r ? isExecutableMode(r.mode) : false
              }
            })
            entries.push(...dirEntries)
          })
        )

        return { localHome: localClaudeHome, remoteHome, entries }
      })
  )

  ipcMain.handle(
    'claude-sync:read-file',
    async (
      _e,
      args: { connectionId: string; password?: string; category: ClaudeSyncCategory; relPath: string }
    ): Promise<ClaudeSyncDiff> =>
      withClaudeHome(args.connectionId, args.password, async (remoteHomeRoot, remoteHome) => {
        if (args.category === 'mcpServers') {
          const local = extractMcpServers(await localReadFile(join(homedir(), '.claude.json')))
          const remote = extractMcpServers(
            await remoteReadFile(args.connectionId, rjoin(remoteHomeRoot, '.claude.json'))
          )
          return { local, remote }
        }
        const local = await localReadFile(join(localClaudeHome, args.relPath))
        const remote = await remoteReadFile(args.connectionId, rjoin(remoteHome, args.relPath))
        return { local, remote }
      })
  )

  const applyClaudeSyncOp = async (
    connectionId: string,
    op: ClaudeSyncOp,
    remoteHomeRoot: string,
    remoteHome: string
  ): Promise<void> => {
    if (op.category === 'mcpServers') {
      const localPath = join(homedir(), '.claude.json')
      const remotePath = rjoin(remoteHomeRoot, '.claude.json')
      const localRaw = await localReadFile(localPath)
      const remoteRaw = await remoteReadFile(connectionId, remotePath)
      if (op.direction === 'push') {
        await ssh.sftpWriteFileAtomic(connectionId, remotePath, planMcpServersMerge(localRaw, remoteRaw), 0o600)
      } else {
        await localWriteFile(localPath, planMcpServersMerge(remoteRaw, localRaw), false)
      }
      return
    }

    if (op.relPath === SETTINGS_RELPATH) {
      const localPath = join(localClaudeHome, SETTINGS_RELPATH)
      const remotePath = rjoin(remoteHome, SETTINGS_RELPATH)
      const localRaw = await localReadFile(localPath)
      const remoteRaw = await remoteReadFile(connectionId, remotePath)
      if (op.direction === 'push') {
        await ssh.sftpEnsureDir(connectionId, dirname(remotePath), 0o700)
        await ssh.sftpWriteFileAtomic(connectionId, remotePath, planSettingsMerge(localRaw, remoteRaw), 0o600)
      } else {
        await localWriteFile(localPath, planSettingsMerge(remoteRaw, localRaw), false)
      }
      return
    }

    if (WHOLE_FILE_RELPATHS.has(op.relPath)) {
      const localPath = join(localClaudeHome, op.relPath)
      const remotePath = rjoin(remoteHome, op.relPath)
      if (op.direction === 'push') {
        const content = await localReadFile(localPath)
        if (content === null) throw new Error('Local file no longer exists')
        await ssh.sftpEnsureDir(connectionId, dirname(remotePath), 0o700)
        await ssh.sftpWriteFileAtomic(connectionId, remotePath, content, 0o600)
      } else {
        const content = await remoteReadFile(connectionId, remotePath)
        if (content === null) throw new Error('Remote file no longer exists')
        await localWriteFile(localPath, content, false)
      }
      return
    }

    // Directory-tree categories: relPath already carries the dir prefix, e.g. "skills/foo/SKILL.md".
    const localPath = join(localClaudeHome, op.relPath)
    const remotePath = rjoin(remoteHome, op.relPath)
    if (op.direction === 'push') {
      const content = await localReadFile(localPath)
      if (content === null) throw new Error('Local file no longer exists')
      const st = await stat(localPath)
      await ssh.sftpEnsureDir(connectionId, dirname(remotePath), 0o755)
      await ssh.sftpWriteFileAtomic(connectionId, remotePath, content, (st.mode & 0o111) !== 0 ? 0o755 : 0o644)
    } else {
      const content = await remoteReadFile(connectionId, remotePath)
      if (content === null) throw new Error('Remote file no longer exists')
      const list = await ssh.sftpList(connectionId, dirname(remotePath))
      const meta = list.entries.find((e) => e.path === remotePath)
      await localWriteFile(localPath, content, meta ? isExecutableMode(meta.mode) : false)
    }
  }

  ipcMain.handle(
    'claude-sync:apply',
    async (
      _e,
      args: { connectionId: string; password?: string; ops: ClaudeSyncOp[] }
    ): Promise<ClaudeSyncOpResult[]> =>
      withClaudeHome(args.connectionId, args.password, async (remoteHomeRoot, remoteHome) => {
        const results: ClaudeSyncOpResult[] = []
        for (const op of args.ops) {
          try {
            await applyClaudeSyncOp(args.connectionId, op, remoteHomeRoot, remoteHome)
            results.push({ ...op, ok: true })
          } catch (e) {
            results.push({ ...op, ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
        return results
      })
  )

  /**
   * `relDir` must be exactly one of SYNC_DIR_CATEGORIES' own roots for the
   * given category, or a subpath under it — never a sibling, never `..`. The
   * scan handler only ever names paths of this shape, but this value crosses
   * the IPC boundary from the renderer, so it's re-validated here rather than
   * trusted.
   */
  function validateBulkRelDir(category: ClaudeSyncCategory, relDir: string): string {
    const catDef = SYNC_DIR_CATEGORIES.find((c) => c.category === category)
    if (!catDef) throw new Error(`"${category}" has no directory tree to bulk-transfer`)
    if (relDir !== catDef.relDir && !relDir.startsWith(`${catDef.relDir}/`)) {
      throw new Error('relDir is not inside its category root')
    }
    if (relDir.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error('relDir contains an invalid path segment')
    }
    return relDir
  }

  /** Run a local command with no shell, capturing stdout; optionally feed it stdin. */
  const runLocal = (cmd: string, cmdArgs: string[], input?: Buffer): Promise<Buffer> =>
    new Promise((res, reject) => {
      const child = spawn(cmd, cmdArgs)
      const chunks: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) res(Buffer.concat(chunks))
        else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`))
      })
      child.stdin.end(input)
    })

  const localTarCreate = (root: string, relDir: string): Promise<Buffer> =>
    runLocal('tar', ['-czf', '-', '-C', root, '--', relDir])

  const localTarExtract = async (root: string, data: Buffer): Promise<void> => {
    await runLocal('tar', ['-xzf', '-', '-C', root], data)
  }

  /**
   * Push or pull a whole subtree in one shot — tar over the existing pooled
   * exec connection instead of one SFTP round trip per file. For a folder
   * with hundreds or thousands of entries (a marketplace clone, say) this is
   * the difference between one command and a slow per-file loop.
   *
   * Both directions are non-destructive overlays, same as the granular
   * per-file apply: tar only creates/overwrites paths present in the
   * archive, it never deletes anything the destination has that the source
   * doesn't.
   */
  ipcMain.handle(
    'claude-sync:bulk',
    async (_e, args: { connectionId: string; password?: string; op: ClaudeSyncBulkOp }): Promise<void> => {
      const relDir = validateBulkRelDir(args.op.category, args.op.relDir)
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const password = passwordFor(args.connectionId, args.password)

      if (args.op.direction === 'push') {
        const archive = await localTarCreate(localClaudeHome, relDir)
        await ssh.execBytes(args.connectionId, connection, {
          command: shWrap('mkdir -p "$HOME/.claude" && tar -xzf - -C "$HOME/.claude"'),
          password,
          input: archive,
          timeoutMs: 30000,
          deadlineMs: 300000,
          // The extract itself prints nothing to stdout; this just guards
          // against a misbehaving remote shell.
          maxBytes: 1024 * 1024
        })
      } else {
        const res = await ssh.execBytes(args.connectionId, connection, {
          command: shWrap(`tar -czf - -C "$HOME/.claude" -- ${shQuote(relDir)}`),
          password,
          timeoutMs: 30000,
          deadlineMs: 300000,
          // Generous: this is the archive itself, which can be sizable for a
          // marketplace clone.
          maxBytes: 512 * 1024 * 1024
        })
        if (res.code !== 0) throw new Error(res.stderr.trim() || `remote tar exited with code ${res.code}`)
        await localTarExtract(localClaudeHome, res.stdout)
      }
    }
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

  // ---- Reader (Claude Code transcripts, read off the remote) ----

  /** The most one read pulls from a transcript — also how far back a first load looks. */
  const READER_CHUNK_MAX = 4 * 1024 * 1024
  const READER_SESSIONS_MAX = 50

  /**
   * Run one script on the connection's pooled client, raw bytes, exit code kept.
   *
   * Unlike gitExec the exit code is the caller's to read: a missing transcript
   * directory is an empty answer here, not an error.
   */
  const readerExec = async (
    connectionId: string,
    password: string | undefined,
    script: string,
    maxBytes: number,
    deadlineMs = 15000
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string }> => {
    const connection = connectionStore.get(connectionId)
    if (!connection) throw new Error('Connection not found')
    return ssh.execBytes(connectionId, connection, {
      command: shWrap(script),
      password: passwordFor(connectionId, password),
      timeoutMs: 15000,
      deadlineMs,
      maxBytes
    })
  }

  /**
   * Transcripts on the server, newest first.
   *
   * With `dir`, only that project's folder; without, every project's. Sorting and
   * the cap happen here, not on the server: `stat` is the only portable way to
   * get mtimes, and `ls -t` would tie the order to a locale and to filenames
   * that are never printable.
   */
  ipcMain.handle(
    'reader:sessions',
    async (
      _e,
      args: { connectionId: string; password?: string; dir?: string }
    ): Promise<ReaderSession[]> => {
      // `find -exec {} +` rather than a glob into `stat "$@"`: every project's
      // transcripts at once can be more paths than ARG_MAX allows.
      let roots = '"$HOME"/.claude/projects -mindepth 2 -maxdepth 2'
      if (args.dir) {
        const slug = projectSlug(args.dir)
        // Claude Code cuts a long slug and appends a hash we can't reproduce, so
        // such a project is matched by its prefix.
        const folder =
          slug.length > PROJECT_SLUG_MAX ? `${shQuote(slug.slice(0, PROJECT_SLUG_MAX))}-*` : shQuote(slug)
        roots = `"$HOME"/.claude/projects/${folder} -mindepth 1 -maxdepth 1`
      }
      const find = `find ${roots} -type f -name '*.jsonl' -exec stat`
      // GNU and BSD stat disagree on every flag; probe which one this host has.
      const script =
        `if stat -c %Y / >/dev/null 2>&1; then ${find} -c '%Y %s %n' {} +; ` +
        `else ${find} -f '%m %z %N' {} +; fi 2>/dev/null${SEP}exit 0`
      // A line is a path plus two numbers; 4 MiB is thousands of transcripts.
      const res = await readerExec(args.connectionId, args.password, script, 4 * 1024 * 1024)
      const out: ReaderSession[] = []
      for (const line of res.stdout.toString('utf-8').split('\n')) {
        const m = /^(\d+) (\d+) (\/.*\.jsonl)$/.exec(line)
        if (m) out.push({ mtime: Number(m[1]), size: Number(m[2]), path: m[3] })
      }
      return out.sort((a, b) => b.mtime - a.mtime).slice(0, READER_SESSIONS_MAX)
    }
  )

  /**
   * Read a transcript from a byte offset, whole lines only.
   *
   * The script prints `<size> <start>` and a newline, then the bytes. Offsets are
   * bytes because the file is appended to while it is read: a character offset
   * would drift on the first multi-byte character, and Persian is all of them.
   */
  ipcMain.handle(
    'reader:read',
    async (
      _e,
      args: { connectionId: string; password?: string; path: string; offset: number; tail?: boolean }
    ): Promise<ReaderChunk> => {
      // Only what Claude Code writes is readable: this is a transcript reader,
      // not a way for the renderer to cat any file the SSH user can open.
      if (
        !args.path.startsWith('/') ||
        !args.path.endsWith('.jsonl') ||
        !args.path.includes('/.claude/projects/') ||
        args.path.split('/').includes('..')
      ) {
        throw new Error('Not a Claude Code transcript path')
      }
      const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
      const script =
        `f=${shQuote(args.path)}${SEP}` +
        // The renderer-side check above can't know the remote $HOME.
        `case "$f" in "$HOME"/.claude/projects/*) ;; *) exit 4;; esac${SEP}` +
        `[ -f "$f" ] || exit 3${SEP}` +
        `sz=$(( $(wc -c < "$f") ))${SEP}` +
        (args.tail
          ? `o=$(( sz - ${READER_CHUNK_MAX} ))${SEP}[ "$o" -lt 0 ] && o=0${SEP}`
          : // A file that shrank (rewritten, compacted) is read again from the top.
            `o=${offset}${SEP}[ "$o" -gt "$sz" ] && o=0${SEP}`) +
        `echo "$sz $o"${SEP}tail -c +$(( o + 1 )) "$f" | head -c ${READER_CHUNK_MAX}`
      // A first load pulls up to 4 MiB, which needs longer than a list on a slow link.
      const res = await readerExec(args.connectionId, args.password, script, READER_CHUNK_MAX + 1024, 90000)
      const nl = res.stdout.indexOf(0x0a)
      const header = nl < 0 ? null : /^(\d+) (\d+)$/.exec(res.stdout.subarray(0, nl).toString('latin1'))
      if (!header) {
        throw new Error(
          res.code === 3
            ? 'Transcript no longer exists'
            : res.code === 4
              ? 'Not a Claude Code transcript path'
              : res.stderr.trim() || 'Failed to read transcript'
        )
      }
      const size = Number(header[1])
      let start = Number(header[2])
      let body = res.stdout.subarray(nl + 1)
      if (args.tail && start > 0) {
        // Started mid-file, so the first line is most likely a fragment.
        const cut = body.indexOf(0x0a)
        const drop = cut < 0 ? body.length : cut + 1
        start += drop
        body = body.subarray(drop)
      }
      const last = body.lastIndexOf(0x0a)
      if (last < 0) {
        // No complete line. Normally a line still being written, left for the
        // next read. But a full chunk with no newline is one line bigger than
        // the cap — skip it, or every later read would stall on the same bytes.
        return { size, text: '', next: body.length >= READER_CHUNK_MAX ? start + body.length : start }
      }
      const whole = body.subarray(0, last + 1)
      return { size, text: whole.toString('utf-8'), next: start + whole.length }
    }
  )

  /** The directory a tmux session's active pane is in, or null if it can't be told. */
  ipcMain.handle(
    'reader:tmuxDir',
    async (
      _e,
      args: { connectionId: string; password?: string; session: string }
    ): Promise<string | null> => {
      // Names tmux would parse as more than a session can't be targeted exactly.
      if (/[:.]/.test(args.session) || args.session.startsWith('$')) return null
      // `=` makes the match exact (tmux otherwise takes a name prefix), and the
      // trailing `:` makes it a session — a bare `=name` resolves to no pane.
      const script = `tmux display -p -t ${shQuote('=' + args.session + ':')} '#{pane_current_path}'`
      const res = await readerExec(args.connectionId, args.password, script, 65536)
      const dir = res.stdout.toString('utf-8').trim()
      return res.code === 0 && dir ? dir : null
    }
  )

  // ---- Chat (a second view of the Claude Code TUI running in tmux on the host) ----
  //
  // Nothing here runs Claude for the chat. It reads what Claude Code itself writes
  // (the status files in ~/.claude/sessions and the session transcript) and types
  // into the tmux pane the Claude is in. See shared/chatProtocol.ts, shared/tuiKeys.ts
  // and shared/claudeSessions.ts.

  const chatExec = (
    t: ChatTarget,
    script: string,
    opts?: { input?: Buffer; maxBytes?: number; deadlineMs?: number }
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string }> => {
    const connection = connectionStore.get(t.connectionId)
    if (!connection) throw new Error('Connection not found')
    return ssh.execBytes(t.connectionId, connection, {
      command: shWrap(script),
      password: passwordFor(t.connectionId, t.password),
      timeoutMs: 15000,
      deadlineMs: opts?.deadlineMs ?? 30000,
      maxBytes: opts?.maxBytes ?? 1_000_000,
      input: opts?.input
    })
  }

  const chatWait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Longest first load of a transcript — the same 4 MiB the Reader looks back. */
  const CHAT_TAIL_MAX = 4 * 1024 * 1024

  const chatSessionsOf = async (t: ChatTarget): Promise<ChatSession[]> => {
    const res = await chatExec(t, CHAT_LIST_SCRIPT, { maxBytes: 8 * 1024 * 1024 })
    return parseChatSessions(res.stdout.toString('utf-8'))
  }

  /** Every live Claude on the host, newest first. */
  ipcMain.handle('chat:list', (_e, t: ChatTarget): Promise<ChatSession[]> => chatSessionsOf(t))

  /** One session, or null when no live Claude has that id (it ended). */
  ipcMain.handle('chat:status', async (_e, args: ChatTarget & { sessionId: string }): Promise<ChatSession | null> => {
    if (!isUuid(args.sessionId)) throw new Error('Invalid session id')
    return (await chatSessionsOf(args)).find((s) => s.sessionId === args.sessionId) ?? null
  })

  // ---- live streams of a transcript ----

  const chatStreams = new Map<string, { close(): void; wc: WebContents }>()
  const chatWatched = new WeakSet<WebContents>()
  /** Longest transcript line we'll buffer while waiting for its newline. */
  const CHAT_LINE_MAX = 32 * 1024 * 1024
  /** Most records one batch carries, however fast they arrive. */
  const CHAT_BATCH_MAX = 1000

  ipcMain.handle(
    'chat:stream',
    async (
      e,
      args: ChatTarget & { sessionId: string; offset: number }
    ): Promise<{ streamId: string; start: number }> => {
      if (!isUuid(args.sessionId)) throw new Error('Invalid session id')
      const connection = connectionStore.get(args.connectionId)
      if (!connection) throw new Error('Connection not found')
      const offset = Number.isFinite(args.offset) ? Math.min(Math.floor(args.offset), Number.MAX_SAFE_INTEGER) : -1

      // Find the file, and where to start in it: the offset asked for, or — on a
      // first open (negative), or one past the end of a file that shrank — the
      // last 4 MiB from the next whole line, like reader:read.
      const locate =
        `f=$(ls -t "$HOME"/.claude/projects/*/${args.sessionId}.jsonl 2>/dev/null | head -n 1)${SEP}` +
        `[ -n "$f" ] || exit 3${SEP}sz=$(wc -c < "$f" | tr -d ' ')${SEP}o=${offset}${SEP}` +
        `if [ "$o" -lt 0 ] || [ "$o" -gt "$sz" ]; then o=$(( sz - ${CHAT_TAIL_MAX} )); [ "$o" -lt 0 ] && o=0; ` +
        `if [ "$o" -gt 0 ]; then l=$(tail -c +"$o" "$f" | head -n 1 | wc -c | tr -d ' '); o=$(( o - 1 + l )); fi; fi${SEP}` +
        `echo "$o"${SEP}echo "$f"`
      const found = await chatExec(args, locate)
      if (found.code === 3) throw new Error('Transcript not found')
      const [startLine, path] = found.stdout.toString('utf-8').split('\n')
      const start = /^\d+$/.test(startLine ?? '') ? Number(startLine) : NaN
      if (!Number.isFinite(start) || !path?.startsWith('/') || !path.endsWith(`/${args.sessionId}.jsonl`)) {
        throw new Error(found.stderr.trim() || 'Transcript not found')
      }

      const wc = e.sender
      const streamId = 's' + randomBytes(6).toString('hex')
      const emit = (channel: string, payload: ChatStreamData | ChatStreamEnd): void => {
        if (!wc.isDestroyed()) wc.send(channel, payload)
      }

      // Whole lines only: `next` is the byte offset after the last one handed
      // over, so a reconnect resumes exactly where this left off. A bad line is
      // skipped but still counted, or the offset would stall on it forever.
      let pending: Buffer = Buffer.alloc(0)
      let next = start
      let records: unknown[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      const flush = (): void => {
        if (timer) clearTimeout(timer)
        timer = undefined
        if (records.length === 0) return
        const batch = records
        records = []
        emit('chat:data', { streamId, records: batch, next })
      }
      let handle: { close(): void } | undefined
      let forced: string | undefined
      let ended = false
      const onData = (d: Buffer): void => {
        pending = pending.length ? Buffer.concat([pending, d]) : d
        const last = pending.lastIndexOf(0x0a)
        if (last < 0) {
          if (pending.length > CHAT_LINE_MAX) {
            pending = Buffer.alloc(0)
            forced = 'A transcript line was too large to read'
            handle?.close()
          }
          return
        }
        const whole = pending.subarray(0, last + 1)
        pending = Buffer.from(pending.subarray(last + 1))
        let from = 0
        for (let i = whole.indexOf(0x0a); i >= 0; i = whole.indexOf(0x0a, from)) {
          const line = whole.subarray(from, i)
          from = i + 1
          next += line.length + 1
          if (line.length === 0) continue
          try {
            const rec: unknown = JSON.parse(line.toString('utf-8'))
            if (rec && typeof rec === 'object') records.push(rec)
          } catch {
            /* a torn or foreign line */
          }
          if (records.length >= CHAT_BATCH_MAX) flush()
        }
        if (records.length && !timer) timer = setTimeout(flush, 50)
      }
      // Follows the file. Reading stdin is what ties the tail's life to the
      // channel: when we close the channel (or the link drops) stdin hits EOF and
      // the tail is killed, instead of lingering until the next write finds its
      // pipe broken. The loop watches both ways: a tail that dies on its own must
      // end the channel too, or the stream goes silent and is never reopened.
      // stdin goes through fd 3 because a background job's stdin is otherwise
      // /dev/null. `kill -0` catches a tail that never started.
      const script =
        `f=${shQuote(path)}${SEP}` +
        `tail -c +${start + 1} -F "$f" 2>/dev/null & t=$!${SEP}sleep 0.2${SEP}` +
        `kill -0 $t 2>/dev/null || exit 4${SEP}exec 3<&0${SEP}cat <&3 >/dev/null & c=$!${SEP}` +
        `while kill -0 $t 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 1; done${SEP}` +
        `if kill -0 $t 2>/dev/null; then kill $t $c 2>/dev/null; exit 0; fi${SEP}kill $c 2>/dev/null${SEP}exit 5`
      handle = await ssh.execStream(
        args.connectionId,
        connection,
        { command: shWrap(script), password: passwordFor(args.connectionId, args.password), timeoutMs: 15000 },
        onData,
        (err) => {
          ended = true
          flush()
          chatStreams.delete(streamId)
          const error = forced ?? err?.message
          emit('chat:end', { streamId, ...(error ? { error } : {}) })
        }
      )
      // The stream may have ended, or the window gone, while the channel was opening.
      if (ended || wc.isDestroyed()) {
        handle.close()
        throw new Error('Closed')
      }
      chatStreams.set(streamId, { close: () => handle?.close(), wc })
      if (!chatWatched.has(wc)) {
        chatWatched.add(wc)
        const closeAll = (): void => {
          for (const s of [...chatStreams.values()]) if (s.wc === wc) s.close()
        }
        wc.once('destroyed', closeAll)
        // A reload keeps the webContents but drops every listener in the page.
        wc.on('did-start-navigation', (d) => {
          if (d.isMainFrame && !d.isSameDocument) closeAll()
        })
      }
      return { streamId, start }
    }
  )

  ipcMain.handle('chat:unstream', (_e, args: { streamId: string }): void => {
    chatStreams.get(args.streamId)?.close()
  })

  // ---- typing into the pane ----

  /** A failure of one step, carrying what the handler answers with. */
  class ChatKeysError extends Error {
    constructor(readonly result: Extract<ChatKeysResult, { ok: false }>) {
      super(result.message ?? result.reason)
    }
  }
  const chatFail = (reason: 'draft' | 'screen' | 'no-pane' | 'error', message?: string): ChatKeysError =>
    new ChatKeysError({ ok: false, reason, ...(message ? { message } : {}) })

  const chatPaneOf = (v: unknown): string => {
    if (typeof v !== 'string' || !PANE_RE.test(v)) throw new Error('Invalid pane')
    return v
  }

  // Key actions on one pane go out one at a time: two clicks interleaving their
  // keys would answer one prompt with half of another's.
  const chatKeyQueue = new Map<string, Promise<unknown>>()
  const chatKeys = (t: ChatTarget, pane: string, run: () => Promise<void>): Promise<ChatKeysResult> => {
    const key = `${t.connectionId}\0${pane}`
    const go = async (): Promise<ChatKeysResult> => {
      try {
        await run()
        return { ok: true }
      } catch (err) {
        if (err instanceof ChatKeysError) return err.result
        return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
    const next = (chatKeyQueue.get(key) ?? Promise.resolve()).then(go)
    chatKeyQueue.set(key, next)
    void next.then(() => {
      if (chatKeyQueue.get(key) === next) chatKeyQueue.delete(key)
    })
    return next
  }

  /** One tmux script on the host; a pane or server that is gone is `no-pane`. */
  const chatTmux = async (t: ChatTarget, script: string, input?: Buffer): Promise<string> => {
    const res = await chatExec(t, script, { input, maxBytes: 1024 * 1024 })
    if (res.code !== 0) {
      const why = res.stderr.trim()
      if (/can't find|no server running|error connecting|no current/i.test(why)) throw chatFail('no-pane', why)
      throw chatFail('error', why || 'tmux failed')
    }
    return res.stdout.toString('utf-8')
  }

  const chatScreen = (t: ChatTarget, pane: string, escapes = false): Promise<string> =>
    chatTmux(t, `tmux capture-pane ${escapes ? '-e ' : ''}-p -t ${pane}`)

  /** Typing a prompt or command while a dialog is up would answer it: Enter picks the highlighted option. */
  const chatRefuseDialog = async (t: ChatTarget, pane: string): Promise<void> => {
    const screen = await chatScreen(t, pane)
    if ([MARK.question, MARK.plan, MARK.permission, MARK.review].some((m) => screen.includes(m))) throw chatFail('screen')
  }

  /** A command or Shift+Tab also lands in the /model picker, /usage or /status: anything with the dialog footer. */
  const chatRefuseAnyDialog = async (t: ChatTarget, pane: string): Promise<void> => {
    await chatRefuseDialog(t, pane)
    if ((await chatScreen(t, pane)).includes(DIALOG_FOOTER)) throw chatFail('screen')
  }

  const chatRefuseDraft = async (t: ChatTarget, pane: string): Promise<void> => {
    if (inputHasDraft(await chatScreen(t, pane, true))) throw chatFail('draft')
  }

  /** Literal characters (a digit, or the text of a command) typed into the pane. */
  const chatLiteral = (t: ChatTarget, pane: string, ...texts: string[]): Promise<string> =>
    chatTmux(t, texts.map((s) => `tmux send-keys -t ${pane} -l ${shQuote(s)}`).join(SEP))

  /** Named keys (Enter, Escape, Tab). */
  const chatNamed = (t: ChatTarget, pane: string, ...keys: string[]): Promise<string> =>
    chatTmux(t, `tmux send-keys -t ${pane} ${keys.join(' ')}`)

  /**
   * Text into the pane through a tmux buffer, read from stdin so it is never part
   * of a shell command. Bracketed (`-p`) when it is a prompt, so newlines do not
   * submit; plain for a free-text answer. Enter follows after the settle.
   */
  const chatPaste = (t: ChatTarget, pane: string, text: string, bracketed: boolean, enter: boolean): Promise<string> => {
    if (!text.trim()) throw chatFail('error', 'Nothing to send')
    if (text.includes('\0')) throw chatFail('error', 'The text holds a null character')
    const buf = 'csm' + randomBytes(6).toString('hex')
    const script =
      `tmux load-buffer -b ${buf} - || exit 1${SEP}` +
      `tmux paste-buffer ${bracketed ? '-p ' : ''}-d -b ${buf} -t ${pane} || { tmux delete-buffer -b ${buf} 2>/dev/null; exit 1; }` +
      (enter ? `${SEP}sleep 0.3 2>/dev/null || sleep 1${SEP}tmux send-keys -t ${pane} ${KEY.enter}` : '')
    return chatTmux(t, script, Buffer.from(text, 'utf-8'))
  }

  ipcMain.handle('chat:send', (_e, args: ChatTarget & { pane: string; text: string }): Promise<ChatKeysResult> => {
    const pane = chatPaneOf(args.pane)
    return chatKeys(args, pane, async () => {
      if (typeof args.text !== 'string') throw chatFail('error', 'Nothing to send')
      await chatRefuseDialog(args, pane)
      await chatRefuseDraft(args, pane)
      await chatPaste(args, pane, args.text, true, true)
    })
  })

  ipcMain.handle('chat:interrupt', (_e, args: ChatTarget & { pane: string }): Promise<ChatKeysResult> => {
    const pane = chatPaneOf(args.pane)
    return chatKeys(args, pane, async () => {
      await chatNamed(args, pane, INTERRUPT)
    })
  })

  ipcMain.handle('chat:model', (_e, args: ChatTarget & { pane: string; model: string }): Promise<ChatKeysResult> => {
    const pane = chatPaneOf(args.pane)
    return chatKeys(args, pane, async () => {
      if (typeof args.model !== 'string' || !/^[A-Za-z0-9._\-\[\]]+$/.test(args.model)) {
        throw chatFail('error', 'Invalid model')
      }
      await chatRefuseDialog(args, pane)
      await chatRefuseDraft(args, pane)
      await chatLiteral(args, pane, `/model ${args.model}`)
      await chatNamed(args, pane, KEY.enter)
      await chatWait(1000)
      // A cached conversation asks first; the answer is the first option.
      if ((await chatScreen(args, pane)).includes(MARK.modelConfirm)) await chatLiteral(args, pane, '1')
    })
  })

  /** The dialog on screen and the footer under the input box, from one capture. */
  ipcMain.handle('chat:prompt', async (_e, args: ChatTarget & { pane: string }): Promise<ChatScreenInfo> => {
    const pane = chatPaneOf(args.pane)
    const screen = await chatScreen(args, pane)
    return { prompt: parsePrompt(screen), footer: parseFooter(screen) }
  })

  /** Shift+Tab until the footer's mode line names `mode`. */
  ipcMain.handle('chat:mode', (_e, args: ChatTarget & { pane: string; mode: ChatMode }): Promise<ChatKeysResult> => {
    const pane = chatPaneOf(args.pane)
    return chatKeys(args, pane, async () => {
      if (typeof args.mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODE_FOOTER, args.mode)) {
        throw chatFail('error', 'Invalid mode')
      }
      // Shift+Tab inside a dialog moves its selection; only press it on the plain screen.
      await chatRefuseAnyDialog(args, pane)
      let start: string | undefined
      for (let presses = 0; ; presses++) {
        const footer = parseFooter(await chatScreen(args, pane))
        if (footer?.mode === args.mode) return
        if (presses === 0) start = footer?.mode
        // Back at the first mode after a full cycle: this Claude does not offer that one.
        else if (footer?.mode === start) throw chatFail('error', 'This Claude does not offer that mode')
        // No mode line to read, or the cycle has not reached it (this Claude may not allow that mode).
        if (!footer?.mode || presses >= MODE_MAX_PRESSES) throw chatFail('screen')
        await chatNamed(args, pane, KEY.shiftTab)
        await chatWait(800)
      }
    })
  })

  // ---- slash commands ----

  const COMMAND_NAME_RE = /^[A-Za-z0-9._:-]+$/
  const COMMAND_SOURCE_CAP = 1500

  /** A cwd the commands script may look under: absolute, one line, no `..`. */
  const chatCwdOf = (v: unknown): string => {
    if (typeof v !== 'string' || !v.startsWith('/') || /[\0\n\r]/.test(v) || v.split('/').includes('..')) throw new Error('Invalid working directory')
    return v.replace(/\/+$/, '') || '/'
  }

  /** `description:` out of a SKILL.md / command file's frontmatter, else its first line of text. */
  const commandDescription = (body: string): string => {
    const lines = body.replace(/\r/g, '').split('\n')
    let i = 0
    let found: string | undefined
    if (lines[0]?.trim() === '---') {
      for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
        const m = /^description\s*:\s*(.*)$/.exec(lines[i])
        if (!m) continue
        let v = m[1].trim()
        // A block scalar (`>` or `|`) keeps its text on the indented lines below.
        if (/^[>|][+-]?$/.test(v)) {
          const parts: string[] = []
          for (let k = i + 1; k < lines.length && /^\s+\S/.test(lines[k]); k++) parts.push(lines[k].trim())
          v = parts.join(' ')
        }
        found = v.replace(/^(["'])([\s\S]*)\1$/, '$2')
        break
      }
      const text = found?.replace(/\s+/g, ' ').trim()
      if (text) return text.slice(0, 200)
      i++ // past the closing ---
    }
    for (; i < lines.length; i++) {
      const l = lines[i].trim()
      if (l && l !== '---') return l.replace(/^#+\s*/, '').slice(0, 200)
    }
    return ''
  }

  const COMMAND_SOURCES: ReadonlySet<string> = new Set<ChatCommandInfo['source']>(['skill', 'command', 'project-skill', 'project-command'])

  /** Skills and commands under ~/.claude and <cwd>/.claude: one exec, read in full by the host, parsed here. */
  const chatCommandsOf = async (t: ChatTarget, cwdIn: unknown): Promise<ChatCommandInfo[]> => {
    const cwd = chatCwdOf(cwdIn)
    const emit =
      `emit() { src=$1; d=$2; shift 2; for f in "$@"; do [ -f "$f" ] || continue; ` +
      `printf '\\001%s\\002%s\\002\\n' "$src" "\${f#"$d"/}"; head -n 40 "$f" | head -c ${COMMAND_SOURCE_CAP}; printf '\\n'; done; }`
    const script =
      `${emit}${SEP}C=${shQuote(cwd)}${SEP}` +
      `emit skill "$HOME/.claude/skills" "$HOME"/.claude/skills/*/SKILL.md${SEP}` +
      `emit command "$HOME/.claude/commands" "$HOME"/.claude/commands/*.md "$HOME"/.claude/commands/*/*.md${SEP}` +
      `emit project-skill "$C/.claude/skills" "$C"/.claude/skills/*/SKILL.md${SEP}` +
      `emit project-command "$C/.claude/commands" "$C"/.claude/commands/*.md "$C"/.claude/commands/*/*.md${SEP}true`
    const res = await chatExec(t, script, { maxBytes: 4 * 1024 * 1024 })
    const out: ChatCommandInfo[] = []
    for (const part of res.stdout.toString('utf-8').split('\x01').slice(1)) {
      const m = /^([a-z-]+)\x02([^\x02\n]*)\x02\n([\s\S]*)$/.exec(part)
      if (!m || !COMMAND_SOURCES.has(m[1])) continue
      const source = m[1] as ChatCommandInfo['source']
      const rel = m[2]
      // A skill is its folder's name; a command is its file's name, whatever folder it is in (commands/a/b.md -> b).
      const name = source.endsWith('skill') ? rel.split('/')[0] : rel.replace(/\.md$/, '').split('/').pop()!
      if (!COMMAND_NAME_RE.test(name)) continue
      out.push({ name, description: commandDescription(m[3]), source })
    }
    return out
  }

  ipcMain.handle('chat:commands', (_e, args: ChatTarget & { cwd: string }): Promise<ChatCommandInfo[]> => chatCommandsOf(args, args.cwd))

  /**
   * A slash command typed into the pane. Only what the chat offers: /compact (with
   * optional instructions), /clear, /context, /usage, /effort <level>, and a skill or
   * command the host lists for `cwd`. /usage opens a dialog: its text is read off the
   * screen, then it is closed with Escape, and the text comes back for the chat to show.
   */
  ipcMain.handle(
    'chat:command',
    async (_e, args: ChatTarget & { pane: string; command: string; cwd?: string }): Promise<ChatKeysResult & { text?: string }> => {
      const pane = chatPaneOf(args.pane)
      let text: string | undefined
      const res = await chatKeys(args, pane, async () => {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (!command.startsWith('/') || command.length > 4000 || /[\0\r\n]/.test(command)) throw chatFail('error', 'Invalid command')
        const [name, ...rest] = command.slice(1).split(/\s+/)
        const tail = rest.join(' ')
        let dialog = false
        if (name === 'compact') {
          // Trailing text is instructions for the summary.
        } else if (name === 'clear' || name === 'context') {
          if (tail) throw chatFail('error', 'Invalid command')
        } else if (name === 'usage') {
          if (tail) throw chatFail('error', 'Invalid command')
          dialog = true
        } else if (name === 'effort') {
          if (!(EFFORT_LEVELS as readonly string[]).includes(tail)) throw chatFail('error', 'Invalid effort level')
        } else {
          if (!COMMAND_NAME_RE.test(name) || !(await chatCommandsOf(args, args.cwd)).some((c) => c.name === name)) {
            throw chatFail('error', 'Unknown command')
          }
        }
        await chatRefuseAnyDialog(args, pane)
        await chatRefuseDraft(args, pane)
        await chatLiteral(args, pane, `/${name}${tail ? ' ' + tail : ''}`)
        await chatNamed(args, pane, KEY.enter)
        if (!dialog) return
        await chatWait(2500)
        let body = parseDialogText(await chatScreen(args, pane))
        if (!body) {
          await chatWait(1500)
          body = parseDialogText(await chatScreen(args, pane))
        }
        // Escape only closes a dialog that is there: on the plain screen it would interrupt a turn.
        if (!body) {
          // A slow render may still open it; leave nothing open for the next command to type into.
          if ((await chatScreen(args, pane)).includes(DIALOG_FOOTER)) await chatNamed(args, pane, KEY.escape)
          throw chatFail('screen', `${DIALOG_FOOTER} was not on screen`)
        }
        await chatNamed(args, pane, KEY.escape)
        text = body
      })
      return res.ok && text !== undefined ? { ...res, text } : res
    }
  )

  // ---- running workflows ----

  /** The workflow directory the journal lives in: absolute, no `..`, under ~/.claude/projects, named wf_*. */
  const WORKFLOW_DIR_RE = /\/subagents\/workflows\/wf_[A-Za-z0-9_-]+$/
  const JOURNAL_CAP = 700_000
  // A result line holds the agent's whole output; only the start of each line is read.
  const JOURNAL_LINE_CAP = 1500
  const JOURNAL_META_CAP = 2000
  const PREVIEW_CAP = 200

  const parseJournal = (raw: string): WorkflowAgent[] => {
    const [journal, ...metas] = raw.split('\x01')
    const agents = new Map<string, WorkflowAgent>()
    const get = (id: string): WorkflowAgent => {
      let a = agents.get(id)
      if (!a) {
        a = { agentId: id, label: id, state: 'running' }
        agents.set(id, a)
      }
      return a
    }
    const meta = new Map<string, { agentType?: string; description?: string; phase?: string }>()
    for (const m of metas) {
      const hit = /^agent-([A-Za-z0-9_-]+)\.meta\.json\x02([\s\S]*)$/.exec(m)
      if (!hit) continue
      try {
        const j = JSON.parse(hit[2]) as Record<string, unknown>
        meta.set(hit[1], {
          agentType: typeof j.agentType === 'string' ? j.agentType : undefined,
          description: typeof j.description === 'string' ? j.description : undefined,
          phase: typeof j.workflowPhase === 'string' || typeof j.workflowPhase === 'number' ? String(j.workflowPhase) : undefined
        })
      } catch {
        /* a torn meta file */
      }
    }
    const labelled = new Set<string>()
    for (const line of journal.split('\n')) {
      if (!line.startsWith('{')) continue
      let j: Record<string, unknown>
      try {
        j = JSON.parse(line) as Record<string, unknown>
      } catch {
        // The line cap cut it: read what is left of it with regexes.
        const type = /"type"\s*:\s*"(started|result)"/.exec(line)?.[1]
        const agentId = /"agentId"\s*:\s*"([^"]+)"/.exec(line)?.[1]
        if (!type || !agentId) continue
        j = { type, agentId }
        const unq = (s: string): string => {
          try {
            return JSON.parse(`"${s}"`) as string
          } catch {
            return s
          }
        }
        const label = /"label"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
        const phase = /"phase"\s*:\s*"?([^",}]+)/.exec(line)?.[1]
        const result = /"result"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line)?.[1]
        if (label) j.label = unq(label)
        if (phase) j.phase = phase
        if (type === 'result') j.result = result ? unq(result.replace(/\\$/, '')) : ''
      }
      const id = typeof j.agentId === 'string' ? j.agentId : ''
      if (!id) continue
      if (j.type === 'started') {
        const a = get(id)
        if (typeof j.label === 'string' && j.label) {
          a.label = j.label
          labelled.add(id)
        }
        if (typeof j.phase === 'string' || typeof j.phase === 'number') a.phase = String(j.phase)
      } else if (j.type === 'result') {
        const a = get(id)
        a.state = 'done'
        const r = typeof j.result === 'string' ? j.result : j.result === undefined ? '' : JSON.stringify(j.result)
        const preview = r.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CAP)
        if (preview) a.preview = preview
      }
    }
    for (const a of agents.values()) {
      const m = meta.get(a.agentId)
      if (!m) continue
      if (m.agentType) a.agentType = m.agentType
      if (!labelled.has(a.agentId) && m.description) a.label = m.description
      if (!a.phase && m.phase) a.phase = m.phase
    }
    return [...agents.values()]
  }

  /** The agents of one workflow, from its journal.jsonl and agent-*.meta.json, read in one exec. */
  ipcMain.handle('chat:journal', async (_e, args: ChatTarget & { dir: string }): Promise<WorkflowAgent[]> => {
    const dir = args.dir
    if (
      typeof dir !== 'string' ||
      !dir.startsWith('/') ||
      /[\0\r\n]/.test(dir) ||
      dir.split('/').some((seg) => seg === '..' || seg === '.') ||
      !WORKFLOW_DIR_RE.test(dir)
    ) {
      throw new Error('Invalid workflow directory')
    }
    const script =
      `d=${shQuote(dir)}${SEP}case "$d" in "$HOME"/.claude/projects/*) ;; *) exit 4;; esac${SEP}` +
      `cd "$d" 2>/dev/null && [ -f journal.jsonl ] || exit 3${SEP}` +
      `cut -c1-${JOURNAL_LINE_CAP} journal.jsonl | head -c ${JOURNAL_CAP}${SEP}printf '\\n'${SEP}` +
      `for f in agent-*.meta.json; do [ -f "$f" ] || continue; printf '\\001%s\\002' "$f"; head -c ${JOURNAL_META_CAP} "$f"; printf '\\n'; done`
    const res = await chatExec(args, script, { maxBytes: 1_100_000 })
    if (res.code === 3) return []
    if (res.code === 4) throw new Error('Invalid workflow directory')
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'Failed to read the workflow journal')
    return parseJournal(res.stdout.toString('utf-8'))
  })

  ipcMain.handle('chat:answer', (_e, args: ChatTarget & { pane: string; answer: ChatAnswer }): Promise<ChatKeysResult> => {
    const pane = chatPaneOf(args.pane)
    const answer = args.answer
    return chatKeys(args, pane, async () => {
      const prompt = parsePrompt(await chatScreen(args, pane))
      if (answer?.kind === 'option') {
        if (typeof answer.digit !== 'string' || typeof answer.label !== 'string') throw chatFail('error', 'Invalid answer')
        // The card may be out of date: the option on screen must be the one it showed.
        if (!prompt || !promptHasOption(prompt, answer.digit, answer.label)) throw chatFail('screen')
        const text = typeof answer.text === 'string' ? answer.text : ''
        const opt = prompt.options.find((o) => o.digit === answer.digit)
        if (opt?.freeText && !text.trim()) throw chatFail('error', 'Nothing to send')
        await chatLiteral(args, pane, answer.digit)
        if (text.trim()) {
          await chatWait(300)
          await chatPaste(args, pane, text, false, true)
        }
      } else if (answer?.kind === 'tab') {
        if (!prompt?.canTab) throw chatFail('screen')
        await chatNamed(args, pane, KEY.tab)
      } else {
        throw chatFail('error', 'Invalid answer')
      }
    })
  })

  // ---- starting Claude ----

  /**
   * Start the user's real Claude in a new, detached tmux session and wait for its
   * status file. The script is claudeScript() — the one an agent tab runs, so the
   * binary, the user's own `claude` wrapper and `--resume` behave the same — in a
   * session named like an agent tab's. Not `new -A -d`: with a session already
   * there, `-A -d` attaches and detaches the user's own terminal. A session that
   * exists is left alone instead, and the Claude in it is what gets found.
   */
  const chatLaunch = async (
    t: ChatTarget,
    cwdIn: unknown,
    resume?: string
  ): Promise<{ sessionId: string; pane: string; tmuxSession: string }> => {
    let cwd = typeof cwdIn === 'string' ? cwdIn.trim() : ''
    if (!cwd || /[\0\n]/.test(cwd)) throw new Error('Choose a working directory')
    if (cwd === '~' || cwd.startsWith('~/')) {
      const home = (await chatExec(t, 'printf %s "$HOME"')).stdout.toString('utf-8')
      if (!home.startsWith('/')) throw new Error('Could not find the home directory on the host')
      cwd = home.replace(/\/+$/, '') + cwd.slice(1)
    }
    if (!cwd.startsWith('/')) throw new Error('The working directory must be an absolute path')
    const session = resume ? claudeResumeSessionName(resume, cwd) : claudeSessionName(cwd)
    const run = shWrap(claudeScript(cwd, connectionStore.get(t.connectionId)?.claudePath, resume))
    const script =
      `command -v tmux >/dev/null 2>&1 || { echo 'tmux is not installed on this host' >&2; exit 127; }${SEP}` +
      // This exec is not a login or interactive shell, and a running tmux server hands a
      // new session its own old environment, so claude (often in ~/.npm-global/bin,
      // added by ~/.bashrc) would not be on PATH. Take PATH from an interactive bash,
      // as an agent tab typed into a terminal would have it. Set through env, not
      // `tmux new -e`: on the user's host the pane's shell resets a PATH given that way.
      `P=$(bash -ic 'printf "\\n__P__%s" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__P__//p' | tail -n 1)${SEP}` +
      `[ -n "$P" ] || P=$PATH${SEP}` +
      `tmux has-session -t ${shQuote('=' + session)} 2>/dev/null || tmux new -d -s ${shQuote(session)} env "PATH=$P" /bin/sh -c ${shQuote(run)}`
    const res = await chatExec(t, script, { deadlineMs: 45000 })
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'Failed to start Claude in tmux')
    for (let i = 0; i < 30; i++) {
      await chatWait(1000)
      const hit = (await chatSessionsOf(t)).find((s) => s.tmux?.session === session)
      if (hit?.tmux) return { sessionId: hit.sessionId, pane: hit.tmux.pane, tmuxSession: session }
      // A folder Claude has not been told to trust holds it at a prompt before it
      // writes any status file; only the user should answer that one.
      if (i % 3 === 2) {
        const res = await chatExec(t, `tmux capture-pane -p -t ${shQuote('=' + session + ':')}`)
        if (res.stdout.toString('utf-8').includes(MARK.trust)) {
          throw new Error(`Claude asks whether you trust ${cwd}. Answer it in the terminal (tmux session ${session}), then open the chat from Summary.`)
        }
      }
    }
    throw new Error(`Claude did not start in tmux session ${session} within 30 s. It may be waiting in that session.`)
  }

  ipcMain.handle('chat:new', (_e, args: ChatTarget & { cwd: string }) => chatLaunch(args, args.cwd))

  ipcMain.handle('chat:resume', (_e, args: ChatTarget & { sessionId: string; cwd: string }) => {
    if (!isUuid(args.sessionId)) throw new Error('Invalid session id')
    return chatLaunch(args, args.cwd, args.sessionId)
  })

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
