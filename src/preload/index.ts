import { contextBridge, ipcRenderer, clipboard, webUtils } from 'electron'
import type {
  AgentHostScan,
  AppSettings,
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
  HostKeyPrompt,
  ServerStats,
  SessionStatus,
  SettingsPatch,
  SftpList,
  SftpReadResult,
  StageResult,
  TmuxControlState,
  TmuxIntent,
  TmuxSession,
  TransferProgress,
  TunnelDef,
  TunnelStatus,
  Workspace,
  WorktreeScan
} from '../shared/types'
import type { WorktreeInspect, WorktreeStart } from '../shared/worktrees'
import type { ReaderChunk, ReaderSession } from '../shared/claudeTranscript'
import type {
  ChatCommand,
  ChatStartArgs,
  ChatStreamData,
  ChatStreamEnd,
  ChatSummary
} from '../shared/chatProtocol'

export interface ConnectArgs {
  sessionId: string
  connectionId: string
  cols: number
  rows: number
  retries: number
  password?: string
  passphrase?: string
  /** Run this command in a PTY instead of a login shell (e.g. tmux attach). */
  command?: string
  /** Parse the stream as a tmux control-mode (`tmux -CC`) protocol channel. */
  control?: boolean
  /**
   * Set when `command` attaches to a tmux session. It lets the main process
   * reattach the session by itself after a drop, without re-running a command
   * that would create the session had it been killed meanwhile.
   */
  tmux?: TmuxIntent
}

const api = {
  // connections
  listConnections: (): Promise<Connection[]> => ipcRenderer.invoke('conn:list'),
  upsertConnection: (draft: ConnectionDraft): Promise<Connection> =>
    ipcRenderer.invoke('conn:upsert', draft),
  removeConnection: (id: string): Promise<void> => ipcRenderer.invoke('conn:remove', id),
  setLastSftpPath: (id: string, path: string): void =>
    ipcRenderer.send('conn:set-last-sftp-path', id, path),
  secretsAvailable: (): Promise<boolean> => ipcRenderer.invoke('secrets:available'),
  hasSecret: (id: string): Promise<boolean> => ipcRenderer.invoke('secrets:has', id),
  pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickKey'),

  // prompt composer drafts (local autosave, independent of the SSH connection)
  draftsAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('drafts:all'),
  draftsSet: (key: string, value: string): Promise<void> => ipcRenderer.invoke('drafts:set', key, value),
  promptHistoryAll: (): Promise<string[]> => ipcRenderer.invoke('promptHistory:all'),
  promptHistoryAdd: (text: string): Promise<string[]> => ipcRenderer.invoke('promptHistory:add', text),

  // settings (persisted on disk in the app's user folder)
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),

  // workspace (open tabs, restored on next launch)
  getWorkspace: (): Promise<Workspace> => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (ws: Workspace): void => ipcRenderer.send('workspace:set', ws),

  // port forwarding / tunnels
  tunnelList: (connectionId: string): Promise<TunnelDef[]> =>
    ipcRenderer.invoke('tunnel:list', connectionId),
  tunnelSave: (connectionId: string, defs: TunnelDef[]): Promise<TunnelDef[]> =>
    ipcRenderer.invoke('tunnel:save', { connectionId, defs }),
  tunnelStatuses: (): Promise<TunnelStatus[]> => ipcRenderer.invoke('tunnel:statuses'),
  tunnelStart: (args: { connectionId: string; defId: string; password?: string }): Promise<boolean> =>
    ipcRenderer.invoke('tunnel:start', args),
  tunnelStop: (defId: string): void => ipcRenderer.send('tunnel:stop', defId),
  onTunnelStatus: (cb: (status: TunnelStatus) => void): (() => void) => {
    const h = (_e: unknown, status: TunnelStatus): void => cb(status)
    ipcRenderer.on('tunnel:status', h)
    return () => ipcRenderer.removeListener('tunnel:status', h)
  },

  // tmux
  tmuxList: (args: { connectionId: string; password?: string }): Promise<TmuxSession[]> =>
    ipcRenderer.invoke('ssh:tmux-list', args),
  tmuxKill: (args: { connectionId: string; password?: string; name: string }): Promise<void> =>
    ipcRenderer.invoke('ssh:tmux-kill', args),
  tmuxRename: (args: {
    connectionId: string
    password?: string
    from: string
    to: string
  }): Promise<void> => ipcRenderer.invoke('ssh:tmux-rename', args),

  // Agent Inbox — every configured host in one sweep. Takes no password: hosts
  // it cannot reach without prompting are reported as skipped, never prompted
  // for. See the 'agents:scan' handler.
  // `retryFailed` is the Refresh button: it clears the sweep's memory of hosts
  // that refused it, which a timed poll deliberately does not.
  agentsScan: (retryFailed?: boolean): Promise<AgentHostScan[]> =>
    ipcRenderer.invoke('agents:scan', { retryFailed }),

  // host vitals probe
  probeServer: (args: { connectionId: string; password?: string }): Promise<ServerStats> =>
    ipcRenderer.invoke('ssh:probe', args),

  // SFTP file manager (keyed by connectionId — one shared channel per connection)
  sftpOpen: (args: { connectionId: string; password?: string }): Promise<boolean> =>
    ipcRenderer.invoke('sftp:open', args),
  sftpList: (args: { connectionId: string; path: string }): Promise<SftpList> =>
    ipcRenderer.invoke('sftp:list', args),
  sftpRealpath: (args: { connectionId: string; path: string }): Promise<string> =>
    ipcRenderer.invoke('sftp:realpath', args),
  sftpMkdir: (args: { connectionId: string; path: string }): Promise<void> =>
    ipcRenderer.invoke('sftp:mkdir', args),
  sftpRename: (args: { connectionId: string; from: string; to: string }): Promise<void> =>
    ipcRenderer.invoke('sftp:rename', args),
  sftpChmod: (args: { connectionId: string; path: string; mode: number }): Promise<void> =>
    ipcRenderer.invoke('sftp:chmod', args),
  sftpDelete: (args: { connectionId: string; path: string; isDir: boolean }): Promise<void> =>
    ipcRenderer.invoke('sftp:delete', args),
  sftpReadFile: (args: { connectionId: string; path: string }): Promise<SftpReadResult> =>
    ipcRenderer.invoke('sftp:readFile', args),
  sftpWriteFile: (args: { connectionId: string; path: string; content: string }): Promise<void> =>
    ipcRenderer.invoke('sftp:writeFile', args),
  sftpDownload: (args: {
    connectionId: string
    remotePath: string
    name: string
    transferId: string
  }): Promise<{ canceled: boolean }> => ipcRenderer.invoke('sftp:download', args),
  sftpUploadPick: (args: {
    connectionId: string
    remoteDir: string
    transferId: string
  }): Promise<{ canceled: boolean; count?: number }> => ipcRenderer.invoke('sftp:uploadPick', args),
  sftpUploadPaths: (args: {
    connectionId: string
    remoteDir: string
    paths: string[]
    transferId: string
  }): Promise<{ count: number }> => ipcRenderer.invoke('sftp:uploadPaths', args),
  /**
   * Stage files on the host for a terminal to refer to. Picks the destination
   * itself (a private per-drop directory under the remote home) and opens and
   * closes its own SFTP channel, so it works from a tab that has none.
   */
  sftpUploadTo: (args: {
    connectionId: string
    password?: string
    paths: string[]
    transferId: string
  }): Promise<StageResult> => ipcRenderer.invoke('sftp:upload-to', args),
  sftpClose: (connectionId: string): void => ipcRenderer.send('sftp:close', connectionId),
  // Electron 33 removed File.path; resolve a dropped File's absolute path here.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  onSftpProgress: (cb: (p: TransferProgress) => void): (() => void) => {
    const h = (_e: unknown, p: TransferProgress): void => cb(p)
    ipcRenderer.on('sftp:progress', h)
    return () => ipcRenderer.removeListener('sftp:progress', h)
  },

  // clipboard + links
  clipboardWrite: (text: string): void => clipboard.writeText(text),
  clipboardRead: (): string => clipboard.readText(),
  /**
   * Write the clipboard's image to a local PNG and return its path, or null when
   * there isn't one. Done in main: a NativeImage can't cross the bridge, and the
   * renderer never needs to hold the bytes.
   */
  clipboardImageToTemp: (): Promise<string | null> => ipcRenderer.invoke('clipboard:imageToTemp'),
  /**
   * Local paths for whatever files are on the clipboard (a Finder/Explorer
   * copy) — empty when there are none. See clipboard:filesToPaths for why this
   * can only ever see the first file of a multi-selection on some platforms.
   */
  clipboardFilesToPaths: (): Promise<string[]> => ipcRenderer.invoke('clipboard:filesToPaths'),
  openExternal: (url: string): void => void ipcRenderer.invoke('app:openExternal', url),

  // window controls (custom title bar)
  winMinimize: (): void => ipcRenderer.send('window:minimize'),
  winToggleMaximize: (): void => ipcRenderer.send('window:toggle-maximize'),
  winClose: (): void => ipcRenderer.send('window:close'),
  winIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const h = (_e: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('window:maximized', h)
    return () => ipcRenderer.removeListener('window:maximized', h)
  },
  winIsFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    const h = (_e: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('window:fullscreen', h)
    return () => ipcRenderer.removeListener('window:fullscreen', h)
  },

  // menu actions
  editAction: (action: 'cut' | 'copy' | 'paste' | 'selectAll'): void =>
    void ipcRenderer.invoke('menu:edit', action),
  viewAction: (action: string): void => void ipcRenderer.invoke('menu:view', action),

  // ssh session lifecycle
  connect: (args: ConnectArgs): Promise<boolean> => ipcRenderer.invoke('ssh:connect', args),
  sendInput: (sessionId: string, data: string): void =>
    ipcRenderer.send('ssh:input', sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send('ssh:resize', sessionId, cols, rows),
  closeSession: (sessionId: string): void => ipcRenderer.send('ssh:close', sessionId),
  /** Give up on the automatic reattach ladder and show the manual overlay. */
  stopReattach: (sessionId: string): void => ipcRenderer.send('ssh:stop-reattach', sessionId),
  respondHostKey: (requestId: string, accept: boolean): void =>
    ipcRenderer.send('ssh:hostkey-response', requestId, accept),

  // tmux control mode (tmux -CC): one stream multiplexes many panes/windows
  tmuxSendKeys: (sessionId: string, paneId: string, data: string): void =>
    ipcRenderer.send('tmux:send-keys', sessionId, paneId, data),
  tmuxSelectWindow: (sessionId: string, windowId: string): void =>
    ipcRenderer.send('tmux:select-window', sessionId, windowId),
  tmuxSelectPane: (sessionId: string, paneId: string): void =>
    ipcRenderer.send('tmux:select-pane', sessionId, paneId),
  tmuxNewWindow: (sessionId: string): void => ipcRenderer.send('tmux:new-window', sessionId),
  tmuxSplit: (sessionId: string, paneId: string, direction: 'columns' | 'rows'): void =>
    ipcRenderer.send('tmux:split', sessionId, paneId, direction),
  tmuxKillPane: (sessionId: string, paneId: string): void =>
    ipcRenderer.send('tmux:kill-pane', sessionId, paneId),
  onTmuxOutput: (cb: (sessionId: string, paneId: string, data: Uint8Array) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string, paneId: string, data: Uint8Array): void =>
      cb(sessionId, paneId, data)
    ipcRenderer.on('tmux:output', h)
    return () => ipcRenderer.removeListener('tmux:output', h)
  },
  onTmuxWindows: (cb: (sessionId: string, state: TmuxControlState) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string, state: TmuxControlState): void => cb(sessionId, state)
    ipcRenderer.on('tmux:windows', h)
    return () => ipcRenderer.removeListener('tmux:windows', h)
  },

  // events (return an unsubscribe fn)
  onStatus: (cb: (sessionId: string, status: SessionStatus) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string, status: SessionStatus): void => cb(sessionId, status)
    ipcRenderer.on('ssh:status', h)
    return () => ipcRenderer.removeListener('ssh:status', h)
  },
  // Raw bytes, coalesced in main. xterm decodes UTF-8 itself and carries partial
  // sequences across writes, so never turn these into strings on the way through.
  onData: (cb: (sessionId: string, data: Uint8Array) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string, data: Uint8Array): void => cb(sessionId, data)
    ipcRenderer.on('ssh:data', h)
    return () => ipcRenderer.removeListener('ssh:data', h)
  },
  onHostKey: (cb: (prompt: HostKeyPrompt) => void): (() => void) => {
    const h = (_e: unknown, prompt: HostKeyPrompt): void => cb(prompt)
    ipcRenderer.on('ssh:hostkey', h)
    return () => ipcRenderer.removeListener('ssh:hostkey', h)
  },
  onNewConnection: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:new-connection', h)
    return () => ipcRenderer.removeListener('menu:new-connection', h)
  },
  onOpenSettings: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:open-settings', h)
    return () => ipcRenderer.removeListener('menu:open-settings', h)
  },
  onCommandPalette: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:command-palette', h)
    return () => ipcRenderer.removeListener('menu:command-palette', h)
  },
  onCloseTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:close-tab', h)
    return () => ipcRenderer.removeListener('menu:close-tab', h)
  },
  onPrevTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:prev-tab', h)
    return () => ipcRenderer.removeListener('menu:prev-tab', h)
  },
  onNextTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:next-tab', h)
    return () => ipcRenderer.removeListener('menu:next-tab', h)
  },
  onGotoTab: (cb: (index: number) => void): (() => void) => {
    const h = (_e: unknown, index: number): void => cb(index)
    ipcRenderer.on('menu:goto-tab', h)
    return () => ipcRenderer.removeListener('menu:goto-tab', h)
  },

  // agent attention
  agentNotify: (leafId: string, title: string, body: string): void =>
    ipcRenderer.send('agent:notify', leafId, title, body),
  agentBadge: (count: number): void => ipcRenderer.send('agent:badge', count),
  onAgentFocus: (cb: (leafId: string) => void): (() => void) => {
    const h = (_e: unknown, leafId: string): void => cb(leafId)
    ipcRenderer.on('agent:focus', h)
    return () => ipcRenderer.removeListener('agent:focus', h)
  },

  // Claude Code notification hook on a remote host
  claudeHookStatus: (args: {
    connectionId: string
    password?: string
  }): Promise<ClaudeHookStatus> => ipcRenderer.invoke('claude:hook-status', args),
  claudeHookApply: (args: {
    connectionId: string
    password?: string
    action: 'install' | 'uninstall'
  }): Promise<ClaudeHookStatus> => ipcRenderer.invoke('claude:hook-apply', args),

  // Claude Code status-line hook on a remote host
  claudeStatusLineStatus: (args: {
    connectionId: string
    password?: string
  }): Promise<ClaudeStatusLineStatus> => ipcRenderer.invoke('claude:statusline-status', args),
  claudeStatusLineApply: (args: {
    connectionId: string
    password?: string
    action: 'install' | 'uninstall'
  }): Promise<ClaudeStatusLineStatus> => ipcRenderer.invoke('claude:statusline-apply', args),

  // tmux `allow-passthrough`, required under tmux for the Notification hook above
  // (the status line has no such dependency; see claudeStatusLineStatus)
  claudeTmuxPassthroughStatus: (args: {
    connectionId: string
    password?: string
  }): Promise<ClaudeTmuxPassthroughStatus> => ipcRenderer.invoke('claude:tmux-passthrough-status', args),
  claudeTmuxPassthroughApply: (args: {
    connectionId: string
    password?: string
    action: 'install' | 'uninstall'
  }): Promise<ClaudeTmuxPassthroughStatus> => ipcRenderer.invoke('claude:tmux-passthrough-apply', args),

  /** The git worktrees of the repo containing `dir`, plus its branches. */
  gitWorktrees: (args: {
    connectionId: string
    dir: string
    password?: string
  }): Promise<WorktreeScan> => ipcRenderer.invoke('git:worktrees', args),

  /** Create a worktree under the repo's `.claude/worktrees`. Resolves to its path. */
  gitWorktreeAdd: (args: {
    connectionId: string
    repoRoot: string
    name: string
    start: WorktreeStart
    password?: string
  }): Promise<{ path: string }> => ipcRenderer.invoke('git:worktreeAdd', args),

  /**
   * Remove a worktree. Never forced — git refuses a locked or dirty one, and the
   * main process never builds the flag that would override that.
   */
  gitWorktreeRemove: (args: {
    connectionId: string
    repoRoot: string
    path: string
    password?: string
  }): Promise<void> => ipcRenderer.invoke('git:worktreeRemove', args),
  gitWorktreeInspect: (args: {
    connectionId: string
    path: string
    password?: string
  }): Promise<WorktreeInspect> => ipcRenderer.invoke('git:worktreeInspect', args),

  /**
   * Claude Code transcripts on the server, newest first (max 50). With `dir`,
   * only that project's; without, every project's.
   */
  readerSessions: (args: {
    connectionId: string
    password?: string
    dir?: string
  }): Promise<ReaderSession[]> => ipcRenderer.invoke('reader:sessions', args),

  /**
   * Whole lines of a transcript from byte `offset`. `tail` is the first load:
   * only the last 4 MiB. Pass the result's `next` back as the next `offset`.
   */
  readerRead: (args: {
    connectionId: string
    password?: string
    path: string
    offset: number
    tail?: boolean
  }): Promise<ReaderChunk> => ipcRenderer.invoke('reader:read', args),

  /** The directory a tmux session's active pane is in, or null. */
  readerTmuxDir: (args: {
    connectionId: string
    password?: string
    session: string
  }): Promise<string | null> => ipcRenderer.invoke('reader:tmuxDir', args),

  // Chat: Claude Code driven by a relay that keeps running in tmux on the host,
  // so a turn survives the laptop sleeping or the network dropping. Every call
  // rejects with a readable message; `chatId` is the `c` + 12 hex id chatStart returns.

  /**
   * Upload the relay if the host lacks this version, start a chat in `cwd`
   * (`~` allowed) and return its id. `resume` continues a Claude session id.
   */
  chatStart: (args: ChatStartArgs): Promise<{ chatId: string }> =>
    ipcRenderer.invoke('chat:start', args),

  /** Append one command (user message, interrupt, answer, stop…) to the chat's inbox. */
  chatSend: (args: {
    connectionId: string
    password?: string
    chatId: string
    cmd: ChatCommand
  }): Promise<void> => ipcRenderer.invoke('chat:send', args),

  /**
   * Follow events.jsonl from byte `offset` (0 = replay everything). Results come
   * through onChatData / onChatEnd tagged with the returned streamId. After an
   * end with an error, open a new stream at the last `next` seen.
   */
  chatStream: (args: {
    connectionId: string
    password?: string
    chatId: string
    offset: number
  }): Promise<{ streamId: string }> => ipcRenderer.invoke('chat:stream', args),

  /** Stop following. onChatEnd then fires for that stream without an error. */
  chatUnstream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('chat:unstream', args),

  /** Every chat on the host, newest first, with whether its relay is running. */
  chatList: (args: { connectionId: string; password?: string }): Promise<ChatSummary[]> =>
    ipcRenderer.invoke('chat:list', args),

  /** Ask the relay to stop; its tmux session is killed if it is still there 5 s later. */
  chatStop: (args: { connectionId: string; password?: string; chatId: string }): Promise<void> =>
    ipcRenderer.invoke('chat:stop', args),

  /** Start the relay again, resuming the last Claude session. No-op while it is running. */
  chatRestart: (args: { connectionId: string; password?: string; chatId: string }): Promise<void> =>
    ipcRenderer.invoke('chat:restart', args),

  /** Whole events from a stream, batched (at most every 50 ms); `next` is the byte offset after them. */
  onChatData: (cb: (data: ChatStreamData) => void): (() => void) => {
    const h = (_e: unknown, data: ChatStreamData): void => cb(data)
    ipcRenderer.on('chat:data', h)
    return () => ipcRenderer.removeListener('chat:data', h)
  },

  /** A stream ended: closed on request (no `error`), or dropped (connection lost, chat gone). */
  onChatEnd: (cb: (end: ChatStreamEnd) => void): (() => void) => {
    const h = (_e: unknown, end: ChatStreamEnd): void => cb(end)
    ipcRenderer.on('chat:end', h)
    return () => ipcRenderer.removeListener('chat:end', h)
  },

  // Global Claude config sync (~/.claude, plus ~/.claude.json's mcpServers) between
  // this computer and a remote host
  claudeSyncScan: (args: {
    connectionId: string
    password?: string
  }): Promise<ClaudeSyncManifest> => ipcRenderer.invoke('claude-sync:scan', args),
  claudeSyncReadFile: (args: {
    connectionId: string
    password?: string
    category: ClaudeSyncCategory
    relPath: string
  }): Promise<ClaudeSyncDiff> => ipcRenderer.invoke('claude-sync:read-file', args),
  claudeSyncApply: (args: {
    connectionId: string
    password?: string
    ops: ClaudeSyncOp[]
  }): Promise<ClaudeSyncOpResult[]> => ipcRenderer.invoke('claude-sync:apply', args),
  claudeSyncBulk: (args: {
    connectionId: string
    password?: string
    op: ClaudeSyncBulkOp
  }): Promise<void> => ipcRenderer.invoke('claude-sync:bulk', args)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
