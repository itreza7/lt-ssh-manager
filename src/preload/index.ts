import { contextBridge, ipcRenderer, clipboard, webUtils } from 'electron'
import type {
  AppSettings,
  Connection,
  ConnectionDraft,
  HostKeyPrompt,
  ServerStats,
  SessionStatus,
  SettingsPatch,
  SftpList,
  SftpReadResult,
  TmuxControlState,
  TmuxSession,
  TransferProgress,
  TunnelDef,
  TunnelStatus,
  Workspace
} from '../shared/types'

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
  onData: (cb: (sessionId: string, data: string) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string, data: string): void => cb(sessionId, data)
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
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
