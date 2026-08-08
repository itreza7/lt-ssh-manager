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
  /**
   * Absolute path to the `claude` binary, for the hosts where the resolver ladder
   * cannot find it — typically a version-manager shim (nvm, asdf, mise, bun) that
   * lives on a PATH only a login shell knows. Re-validated with `[ -x ]` on every
   * use, so a path orphaned by an upgrade falls back to the ladder instead of
   * dead-ending. Blank on almost every connection; see shared/claude.ts.
   */
  claudePath?: string
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
  /**
   * Use tmux *control mode* (`tmux -CC`) instead of a drawn tmux screen: tmux
   * streams pane output as a protocol and the app renders each pane as its own
   * terminal — giving native scrollback + native copy with no tmux mouse mode.
   * Only meaningful when `tmux` is on. See main/ssh/tmuxControl.ts.
   */
  tmuxControl?: boolean
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

/**
 * One tmux session on one host, as the Agent Inbox understands it.
 *
 * Built by shared/agents.ts, which is also where the derivation of `agent` and
 * of a session's working/waiting/idle status is explained.
 */
export interface AgentSession {
  /**
   * Which saved connection this session was found on. Stamped by the IPC
   * handler right after a scan returns — parseAgentScan() itself is a
   * host-agnostic pure function and never sees a connection id.
   */
  connectionId: string
  /** tmux session name, exactly as tmux spells it — this is what attach targets. */
  session: string
  /** Working directory of the active window's active pane; '' if tmux gave none. */
  dir: string
  /** `pane_current_command` of that pane — 'claude', 'bash', 'vim', … */
  command: string
  /** Someone (possibly this app) has a client attached. */
  attached: boolean
  /** Seconds since the session last produced output, on the SERVER's clock. */
  idleSeconds: number | null
  /**
   * The SERVER-clock instant (epoch seconds) the session last produced output —
   * the same fact `idleSeconds` measures, as an absolute point in time rather
   * than an age, so a row does not need to be re-diffed against a fresh clock
   * to compare two sessions across polls. Null exactly when `idleSeconds` is.
   */
  lastActiveAt: number | null
  /**
   * A window in this session rang the bell and no client has looked since. tmux
   * clears the flag when a client views the window, so this means "unread"
   * rather than "rang at some point".
   */
  wantsAttention: boolean
  /** This session looks like a Claude Code agent. */
  agent: boolean
}

/** What one host contributed to an agent scan. */
export interface AgentHostScan {
  connectionId: string
  /** Connection name, so the renderer can label rows without a second lookup. */
  name: string
  sessions: AgentSession[]
  /**
   * Why this host contributed nothing. A host that is simply not running tmux is
   * not an error — it reports no sessions and no error.
   */
  error?: string
  /**
   * True when the host was never contacted at all — no password stored, or a
   * refusal the sweep has latched and won't repeat. The reason travels in
   * `error`; this only distinguishes "we didn't try" from "we tried and it
   * failed", which is why the panel counts the two separately.
   */
  skipped?: boolean
}

/**
 * One saved Claude Code transcript on one host — something that can be resumed.
 *
 * Built by shared/resume.ts, which is where the layout it is read out of, and the
 * reason every field is nullable, are explained. The short version: half of these
 * sessions have no title, and a field the far side could not establish is left null
 * rather than filled in with a plausible-looking default.
 */
export interface ResumeSession {
  /**
   * Which saved connection this transcript lives on. Stamped by the IPC
   * handler right after a scan returns — parseResumeScan() itself is a
   * host-agnostic pure function and never sees a connection id.
   */
  connectionId: string
  /** The transcript's filename stem, which is the id `--resume` takes. */
  id: string
  /**
   * Absolute working directory the session ran in, or null when the transcript
   * records none. Not decorative: `--resume` only finds an id under the project
   * directory belonging to the cwd it starts in, so a row without this cannot be
   * resumed at all.
   */
  dir: string | null
  /**
   * Whether `dir` is still a directory on the host. Three states, and the third is
   * the point: `null` means the scan did not check — no cwd was recorded, or the
   * value still carries a JSON escape and testing the escaped text would report a
   * directory that is really there as missing. "Could not check" must never render
   * as "it is gone", so the panel disables the button on `false` alone.
   */
  dirExists: boolean | null
  /**
   * The path came back through a UTF-8 decode that replaced bytes it could not read,
   * so the string here is not the path on disk. Resuming is refused rather than
   * attempted: `cd` against a rewritten path can only fail, and it would fail inside
   * a terminal tab that had already opened instead of on the row that knew.
   */
  dirLossy: boolean
  /** Seconds since the transcript was last written, on the SERVER's clock. */
  ageSeconds: number | null
  /**
   * The SERVER-clock instant (epoch seconds) the transcript was last written —
   * the same fact `ageSeconds` measures, as an absolute point in time rather
   * than an age. Null exactly when `ageSeconds` is.
   */
  lastWrittenAt: number | null
  /**
   * Size of the transcript in bytes, or null where `stat` could not say.
   *
   * Here because a third of a real host's newest sixty had no label at all: pressing
   * `/clear` starts a fresh transcript holding nothing but a caveat record and the
   * command that produced it, so there is no title and no prompt to show. Those rows
   * are still real and still resumable, so they are not filtered out — "small" is not
   * the same fact as "empty", and guessing which is which would hide live work.
   *
   * What this measures, measured rather than assumed: a transcript's floor is 50-70 KB
   * of hook and system boilerplate whatever it contains, so size tells a substantial
   * conversation (megabytes) from a session that never went anywhere (tens of KB). It
   * does NOT distinguish a `/clear` husk from a one-shot `claude -p` run — both sit in
   * that same floor. That is the honest limit of it, and it is still the one number on
   * the row that says whether resuming is worth the click.
   */
  sizeBytes: number | null
  /** A name the user set with `/title` — the strongest label there is. */
  customTitle: string | null
  /** Claude's own summary. Present in roughly half of all sessions. */
  aiTitle: string | null
  /** The last thing the user typed. A weak label, but often the only one. */
  lastPrompt: string | null
}

/** What one host contributed to a resume scan. Mirrors AgentHostScan. */
export interface ResumeHostScan {
  connectionId: string
  name: string
  sessions: ResumeSession[]
  /**
   * Transcripts found on the host, which may exceed `sessions.length`: only one
   * page is described. The panel shows both numbers, because a list that stops
   * at sixty without saying so reads as "that is all there is".
   */
  total: number
  /**
   * The script printed its end marker, so this list is the whole page it meant to
   * send. False means the remote shell died mid-stream — the exec RESOLVES with
   * whatever stdout had arrived when the channel closed, which is the one path
   * where a truncated list would otherwise be presented as a complete short one.
   */
  complete: boolean
  /** The host has no transcript directory — Claude Code has never run there. */
  empty?: boolean
  /**
   * `projects/` exists and holds entries, but nothing under it could be listed —
   * permissions, or a listing too large for the shell. Distinct from `empty` and
   * from `total: 0`, both of which claim "there is nothing here".
   */
  listFailed?: boolean
  error?: string
  skipped?: boolean
}

/** One entry of `git worktree list --porcelain` on a remote host. */
export interface RemoteWorktree {
  /**
   * Which saved connection this worktree lives on. Stamped by the IPC handler
   * right after a scan returns — parseWorktreeScan() itself is a host-agnostic
   * pure function and never sees a connection id.
   */
  connectionId: string
  /** Absolute path on the host. */
  path: string
  /** Commit it is on. Empty only when git declined to say. */
  head: string
  /** Short branch name, or null when detached (or when git said neither). */
  branch: string | null
  bare: boolean
  detached: boolean
  /**
   * Lock reason when locked, `''` when locked with no reason given, null when
   * unlocked. Three states, not two: "locked, reason unknown" is not "unlocked".
   */
  locked: string | null
  /** Prune reason when git considers the worktree prunable, else null. */
  prunable: string | null
}

/** The worktrees of one repository, as one scan. */
export interface WorktreeScan {
  /** Repository root, or null when `dir` wasn't in a repository. */
  root: string | null
  /**
   * Local branch names, most recently committed first, capped at MAX_BRANCHES.
   *
   * Carried by the same scan because the create form needs both halves at once —
   * which branches exist, and which of them a worktree already holds — and a
   * second round trip to learn the second half is a second dial.
   */
  branches: string[]
  /** `git rev-parse --git-common-dir`, which identifies the shared repo. */
  common: string | null
  worktrees: RemoteWorktree[]
  /** Why the scan produced nothing. Absent on success, including "none yet". */
  error?: string
}

/**
 * What a tmux-backed tab is attached to, kept structured rather than inferred
 * from the command string. The main process needs it to build an *attach-only*
 * command when a dropped session is reattached automatically — see
 * shared/tmux.ts and the reattach ladder in main/ssh/manager.ts.
 */
export interface TmuxIntent {
  /** The session name exactly as it must reach tmux (already sanitized if typed). */
  session: string
  /** Control mode (`tmux -CC`) rather than a drawn tmux screen. */
  control: boolean
  /** `-D`: detach other clients on the initial create-or-attach. */
  detachOthers: boolean
}

// ---- tmux control mode (tmux -CC) ----
// The main process parses tmux's control protocol and pushes a structured view
// of windows/panes to the renderer, which draws each pane as its own terminal.

/** One pane's cell geometry within its window, parsed from tmux's layout string. */
export interface TmuxPaneRect {
  /** tmux pane id, e.g. "%3". */
  paneId: string
  /** Cell offsets/extents within the window grid. */
  x: number
  y: number
  w: number
  h: number
}

/** A tmux window and its panes, as seen by a control-mode client. */
export interface TmuxWindowInfo {
  /** tmux window id, e.g. "@1". */
  windowId: string
  name: string
  active: boolean
  /** Window grid size in cells (root of the layout). */
  cols: number
  rows: number
  /** The window's panes, positioned in the cell grid. */
  panes: TmuxPaneRect[]
  /** The active pane id within this window, if known. */
  activePane?: string
}

/** Snapshot of a control-mode session's structure, pushed on `tmux:windows`. */
export interface TmuxControlState {
  windows: TmuxWindowInfo[]
  /** id of the active window, if any. */
  activeWindow?: string
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

/**
 * Result of staging local files onto a host for a terminal to refer to
 * (`sftp:upload-to`). Per-file, because a batch that half-succeeds should still
 * hand back the paths that made it rather than throwing the lot away.
 */
export interface StagedUpload {
  /** The original local basename, for the UI to name. */
  name: string
  /**
   * The absolute remote path, for typing at the cursor. Only the last segment is
   * ours — the directory prefix is the home the server reported, so on a host
   * whose home has a space in it this is not a single shell word.
   */
  path: string
}

export interface StageResult {
  files: StagedUpload[]
  /** One entry per file that didn't make it; the rest still did. */
  errors: { name: string; error: string }[]
}

/**
 * The state of our Claude Code notification hook on one server, plus both
 * candidate outcomes so the UI can show the exact change before it happens.
 * Everything here is already pretty-printed JSON — the diff is a text diff.
 */
export interface ClaudeHookStatus {
  /** Absolute remote path of the settings file, resolved from the server's home. */
  path: string
  /** The file as it stands. `{}` when the server has none yet. */
  before: string
  /** What installing would write. Equal to `before` when it's already current. */
  install: string
  /** What removing would write. Equal to `before` when nothing of ours is there. */
  uninstall: string
  /** Our hook is present and up to date. */
  installed: boolean
  /** Some hook of ours is present — possibly an older command that needs updating. */
  present: boolean
}

/**
 * What the Claude Code CLI looks like on one server, as of the last probe.
 *
 * Every field is nullable or optional on purpose: a probe that reaches the host
 * but cannot answer a question reports "unknown", never a guess. A `false` here
 * means the remote shell actually said so. That distinction is load-bearing,
 * because the card turns these into advice — install this, sign in — and advice
 * is worse than useless when it is wrong about a working install.
 *
 * Nothing in this shape can carry a secret. `credsFile` is the result of a bare
 * `[ -f ]`, and `loggedIn`/`authMethod` are the only two scalars taken from
 * `claude auth status --json`; the account email, org id and org name are
 * dropped inside the remote shell, so they never reach stdout, IPC, or a log.
 */
export interface ClaudeRuntime {
  /**
   * The remote `$HOME`, absolute, as the probe saw it. Not cosmetic: a dashboard
   * launch hashes this path into the tmux session name, and hashing a guessed
   * `~` would name a different session than a file-browser launch on the very
   * same directory — two agents in one home, which is the failure the whole
   * path-derived naming scheme exists to prevent. Undefined hides that button.
   */
  home?: string
  /** Absolute path to the resolved binary, or null when no rung of the ladder matched. */
  path: string | null
  /**
   * Semver only, taken from the `<semver> (Claude Code)` line. Null when the
   * output did not match that exact shape — a shell wrapper or some future
   * banner must read as "unknown version", not as a version we invented.
   */
  version: string | null
  /** Tri-state: null means `auth status` gave no parsable answer, not signed out. */
  loggedIn: boolean | null
  /** e.g. "claude.ai". Charset-clamped on both sides; undefined when unrecognized. */
  authMethod?: string
  /** Presence of `$CLAUDE_CONFIG_DIR/.credentials.json`. Existence only, never contents. */
  credsFile: boolean
  /** Round-trip in ms. Diagnostic only. */
  probeMs?: number
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

/**
 * What Shift+Enter sends. xterm gives it the same plain CR as Enter, so a CLI
 * that wants a newline *within* a prompt — Claude Code and other terminal
 * agents — can't tell the two apart and submits early. Terminals that support
 * this disagree on the encoding, so it's a choice:
 * - `newline`: LF (0x0a), i.e. what Ctrl+J sends. Works with no remote setup and
 *   is read as a line break by such tools; a plain shell accepts it exactly like
 *   Enter, so it's safe everywhere. The default.
 * - `escape-cr`: ESC CR, what iTerm2/VS Code emit once configured. Pick it if
 *   the remote program expects that encoding specifically.
 * - `submit`: don't intercept — Shift+Enter submits, as it did before 0.3.0.
 */
export type ShiftEnterMode = 'newline' | 'escape-cr' | 'submit'

export interface TerminalSettings {
  fontFamily: string // id from the renderer's font list (see lib/terminalSettings)
  fontSize: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /**
   * Terminal height multiplier (1 = off). When >1 the live grid is rendered this
   * many times taller than the visible pane, and the overflow scrolls with a
   * native scrollbar/wheel — a purely client-side way to scroll long output
   * (notably under tmux, whose alt-screen xterm's own scrollback can't reach)
   * without enabling tmux mouse mode. Applies to sessions opened/resized after
   * it changes.
   */
  overscroll: number
  /** How Shift+Enter is encoded — see ShiftEnterMode. */
  shiftEnter: ShiftEnterMode
  /**
   * Let a session's tab take the window title the remote sets (OSC 0/2) while
   * one is set, instead of always showing the connection name. Shells report the
   * working directory or running command that way, and a terminal agent reports
   * what it's working on — which is what you want to read off a background tab.
   */
  liveTitles: boolean
  /** How loudly to report an attention signal from a session — see AgentAlerts. */
  agentAlerts: AgentAlerts
}

/**
 * What happens when a program in a session says it needs a human (see
 * lib/xtermAgentSignal for what it listens to):
 * - `dot`: an amber dot on the tab, and nothing else. The default — it's the
 *   part that says *which* session wants you, and it costs no attention until
 *   you happen to look at the tab strip.
 * - `notify`: the dot, plus an OS notification and a dock badge while the window
 *   is in the background. Clicking the notification opens that tab.
 * - `off`: ignore them.
 *
 * Dot-only by default because an agent that asks a question every few minutes
 * would otherwise be a notification every few minutes, and the ones that matter
 * would be indistinguishable from the ones that don't.
 */
export type AgentAlerts = 'off' | 'dot' | 'notify'

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
  /**
   * Schema version of the saved settings file. Not user-facing — it exists so a
   * changed default can be applied to an install that already has a file, and
   * only once. See the migration in main/store/settings.ts.
   */
  version: number
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
  // Off by default: a blinking cursor drives a full WebGL redraw + compositor
  // frame twice a second forever, which is the single largest source of idle
  // battery draw in the app. Turn it back on in Settings if you prefer it.
  cursorBlink: false,
  scrollback: 1000,
  overscroll: 1,
  // Newline rather than submit: it costs a plain shell nothing (which accepts LF
  // as Enter) and it's what lets a terminal agent take a multi-line prompt.
  shiftEnter: 'newline',
  liveTitles: true,
  agentAlerts: 'dot'
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

/**
 * Bump when a changed default should also reach installs that already have a
 * settings file, and add the step to migrate() in main/store/settings.ts.
 */
export const SETTINGS_VERSION = 1

export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  connectRetries: 4,
  sidebarCollapsed: false,
  version: SETTINGS_VERSION
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

/**
 * A tab serialized to disk. No passwords or live session ids are stored.
 *
 * A workspace written by an older version may name a `kind` that no longer
 * exists — `'review'`, dropped after 0.10.0. Restore matches kinds one by one and
 * skips what it does not recognise, so such a tab simply does not come back.
 */
export interface PersistedTab {
  kind:
    | 'dashboard'
    | 'session'
    | 'settings'
    | 'sftp'
    | 'editor'
    | 'tunnels'
    | 'tmux'
    | 'worktrees'
    | 'inbox'
  connectionId?: string
  title?: string
  command?: string // session/tmux: the command to run (e.g. tmux attach / tmux -CC)
  /**
   * session/tmux: what the tab is attached to. Written since 0.2.4; tabs saved
   * before that carry only `command`, which parseTmuxIntent() recovers this from.
   */
  tmux?: TmuxIntent
  initialPath?: string // sftp: directory to open; worktrees: a directory inside the repo
  path?: string // editor: remote file path
  name?: string // editor: file name
}

/** Which way a split screen is divided. */
export type SplitDirection = 'columns' | 'rows'

/**
 * A serialized tab-bar view: a single pane is a normal tab, 2–3 panes is a
 * split that lives as its own tab. Pane entries index into `Workspace.tabs`
 * (-1 = an empty pane). Restored best-effort: panes whose tab is gone are dropped.
 */
export interface PersistedView {
  direction: SplitDirection
  panes: number[]
  sizes: number[] // fractions, same length as panes
  focused: number // index of the focused pane
}

export interface Workspace {
  tabs: PersistedTab[]
  active: number // index into tabs of the focused leaf, or -1 for none
  /** The tab-bar arrangement (one entry per visible tab; splits are multi-pane). */
  views?: PersistedView[]
  activeView?: number // index into views of the active tab
}

export const EMPTY_WORKSPACE: Workspace = { tabs: [], active: -1 }

/**
 * Why a session ended, when we can tell. Drives the wording of the overlay and,
 * more importantly, whether reattaching automatically could ever help:
 * `detached`/`exited`/`gone` are all final, `unreachable` is not.
 */
export type CloseReason =
  /** The user detached (C-b d, `detach-client`) — the tmux session is still alive. */
  | 'detached'
  /** The command/shell ran to completion. */
  | 'exited'
  /** The remote tmux session (or its server) is gone; reattaching cannot bring it back. */
  | 'gone'
  /** The link died and the ladder gave up or was stopped; the session may still exist. */
  | 'unreachable'

export type SessionStatus =
  | { kind: 'connecting'; attempt: number; retries: number }
  | { kind: 'retrying'; attempt: number; retries: number; delayMs: number; error: string }
  | { kind: 'ready' }
  /**
   * A tmux-backed session dropped and is being reattached without asking. The
   * previous screen stays on-screen; the renderer shows a banner, not the
   * blocking overlay. See the reattach ladder in main/ssh/manager.ts.
   */
  | { kind: 'reattaching'; attempt: number; delayMs: number; error: string }
  | { kind: 'closed'; code: number | null; reason?: CloseReason; detail?: string }
  | { kind: 'error'; message: string; permanent: boolean }
