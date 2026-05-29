// Types shared between the main and renderer processes.

export type AuthMethod = 'key' | 'password' | 'agent'

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  notes?: string
  /** Directory the SFTP file manager opens to by default (blank = home). */
  sftpPath?: string
  /** Last directory browsed in the file manager; restored on reopen. */
  lastSftpPath?: string
  /** Wrap interactive sessions in tmux (create-or-attach) so drops reattach. */
  tmux?: boolean
  /** tmux session name to create/attach when tmux is on (blank = connection name). */
  tmuxSession?: string
  /** Detach other clients on attach so this window drives the pane size. */
  tmuxDetachOthers?: boolean
}

/** A draft connection from the dialog; password is handled out-of-band. */
export interface ConnectionDraft extends Omit<Connection, 'id'> {
  id?: string
  password?: string
}

export interface SessionMeta {
  sessionId: string
  connectionId: string
  title: string
}

export interface TmuxSession {
  name: string
  windows: number
  attached: boolean
}

/** Emitted to the renderer when an unknown/changed host key needs a decision. */
export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  keyType: string
  fingerprint: string // SHA256:base64
  changed: boolean // true = key differs from a previously stored one (danger)
}

// ---- SFTP file manager ----

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface SftpEntry {
  name: string
  path: string // full remote path
  type: SftpEntryType
  size: number // bytes
  mtime: number // ms since epoch
  mode: number // raw permission bits
  permissions: string // e.g. "rwxr-xr-x"
  isSymlink: boolean
  /** For symlinks, the resolved target's kind (undefined if dangling). */
  target?: 'file' | 'directory' | 'other'
}

export interface SftpList {
  path: string // canonical (realpath-resolved) directory that was listed
  entries: SftpEntry[]
}

export interface SftpReadResult {
  content: string
  /** True when the file is too large to edit safely — open it view-only. */
  readOnly: boolean
}

/** Progress for a single upload/download, pushed on the `sftp:progress` channel. */
export interface TransferProgress {
  transferId: string
  kind: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  done: boolean
  error?: string
}

/** A snapshot of a remote host's vitals, gathered by a one-shot SSH probe. */
export interface ServerStats {
  hostname?: string
  os?: string
  kernel?: string
  arch?: string
  uptime?: string
  load?: [number, number, number] // 1 / 5 / 15-minute averages
  cpus?: number
  cpuModel?: string
  memTotalKb?: number
  memUsedKb?: number
  diskSize?: string // human-readable, e.g. "40G"
  diskUsed?: string // human-readable, e.g. "12G"
  diskPct?: number // 0–100, usage of /
  users?: number // logged-in users
  probeMs?: number // round-trip wall time of the probe
}

export type CursorStyle = 'block' | 'bar' | 'underline'

export interface TerminalSettings {
  fontFamily: string // id from the renderer's font list (see lib/terminalSettings)
  fontSize: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
}

export interface EditorSettings {
  fontFamily: string // id from the renderer's font list (shared with terminal)
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
  lineNumbers: boolean
  /** Open markdown files in rendered preview by default. */
  markdownPreview: boolean
}

export interface AppSettings {
  terminal: TerminalSettings
  editor: EditorSettings
  connectRetries: number
  /** Whether the connections sidebar is collapsed to its narrow rail. */
  sidebarCollapsed: boolean
}

/** A partial update to settings (terminal/editor fields may be partial). */
export interface SettingsPatch {
  terminal?: Partial<TerminalSettings>
  editor?: Partial<EditorSettings>
  connectRetries?: number
  sidebarCollapsed?: boolean
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'jetbrains',
  fontSize: 13,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 1000
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: 'jetbrains',
  fontSize: 13,
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  lineNumbers: true,
  markdownPreview: true
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  connectRetries: 4,
  sidebarCollapsed: false
}

// ---- Port forwarding / tunnels ----

export type TunnelType = 'local' | 'remote' | 'dynamic'

/** A persisted tunnel definition, stored per-connection. No secrets involved. */
export interface TunnelDef {
  id: string
  type: TunnelType
  /** Optional friendly name shown in the list. */
  label?: string
  /** Listening side: local host for local/dynamic; the remote host for remote. */
  bindAddr: string
  bindPort: number
  /** Forward target (local & remote types). Ignored for dynamic SOCKS proxies. */
  dstHost?: string
  dstPort?: number
}

export type TunnelState = 'starting' | 'active' | 'error' | 'stopped'

/** Live runtime state of a tunnel, pushed on the `tunnel:status` channel. */
export interface TunnelStatus {
  defId: string
  connectionId: string
  state: TunnelState
  /** Set when state is 'error'. */
  error?: string
  /** Currently open forwarded connections through this tunnel. */
  conns: number
}

// ---- Persisted workspace (open tabs, restored on next launch) ----

/** A tab serialized to disk. No passwords or live session ids are stored. */
export interface PersistedTab {
  kind: 'dashboard' | 'session' | 'settings' | 'sftp' | 'editor' | 'tunnels'
  connectionId?: string
  title?: string
  command?: string // session: the command to run (e.g. tmux attach)
  initialPath?: string // sftp: directory to open
  path?: string // editor: remote file path
  name?: string // editor: file name
}

export interface Workspace {
  tabs: PersistedTab[]
  active: number // index into tabs, or -1 for none
}

export const EMPTY_WORKSPACE: Workspace = { tabs: [], active: -1 }

export type SessionStatus =
  | { kind: 'connecting'; attempt: number; retries: number }
  | { kind: 'retrying'; attempt: number; retries: number; delayMs: number; error: string }
  | { kind: 'ready' }
  | { kind: 'closed'; code: number | null }
  | { kind: 'error'; message: string; permanent: boolean }
