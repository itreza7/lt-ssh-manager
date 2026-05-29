import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Connection,
  ConnectionDraft,
  HostKeyPrompt,
  PersistedTab,
  SessionStatus,
  Workspace
} from '../../shared/types'
import { DEFAULTS, type AppSettings, type SettingsPatch } from './lib/terminalSettings'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { SettingsPage } from './components/SettingsPage'
import { ConnectionDialog } from './components/ConnectionDialog'
import { HostKeyDialog } from './components/HostKeyDialog'
import { PasswordPrompt } from './components/PasswordPrompt'
import { TerminalView } from './components/TerminalView'
import { FileManager } from './components/FileManager'
import { EditorView } from './components/EditorView'
import { TunnelManager } from './components/TunnelManager'
import { tmuxAttachCommand, tmuxSessionName } from './lib/tmux'

const SETTINGS_TAB_ID = 'settings'

interface DashboardTab {
  kind: 'dashboard'
  id: string
  connectionId: string
}

interface SessionTab {
  kind: 'session'
  id: string // sessionId
  connectionId: string
  title: string
  status: SessionStatus
  password?: string
  command?: string
}

interface SettingsTab {
  kind: 'settings'
  id: typeof SETTINGS_TAB_ID
}

interface SftpTab {
  kind: 'sftp'
  id: string // sftpId
  connectionId: string
  title: string
  password?: string
  initialPath?: string
}

interface EditorTab {
  kind: 'editor'
  id: string // `edit:${connectionId}:${path}`
  connectionId: string
  path: string
  name: string
  title: string
  password?: string
}

interface TunnelTab {
  kind: 'tunnels'
  id: string // `tun:${connectionId}`
  connectionId: string
  title: string
  password?: string
}

type Tab = DashboardTab | SessionTab | SettingsTab | SftpTab | EditorTab | TunnelTab

interface PwRequest {
  title: string
  label: string
  resolve: (value: string | null) => void
}

const dashId = (connectionId: string): string => `dash:${connectionId}`
const tunId = (connectionId: string): string => `tun:${connectionId}`

// Strip a live tab down to what's safe + sufficient to recreate it later.
// Passwords and volatile session ids/status are intentionally omitted.
function serializeTab(t: Tab): PersistedTab {
  switch (t.kind) {
    case 'dashboard':
      return { kind: 'dashboard', connectionId: t.connectionId }
    case 'session':
      return { kind: 'session', connectionId: t.connectionId, title: t.title, command: t.command }
    case 'settings':
      return { kind: 'settings' }
    case 'sftp':
      return { kind: 'sftp', connectionId: t.connectionId, title: t.title, initialPath: t.initialPath }
    case 'editor':
      return { kind: 'editor', connectionId: t.connectionId, path: t.path, name: t.name }
    case 'tunnels':
      return { kind: 'tunnels', connectionId: t.connectionId, title: t.title }
  }
}

function statusDot(status: SessionStatus): string {
  switch (status.kind) {
    case 'ready':
      return 'bg-emerald-400'
    case 'connecting':
    case 'retrying':
      return 'bg-amber-400 animate-pulse'
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-white/30'
  }
}

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [secretsAvailable, setSecretsAvailable] = useState(true)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULTS)

  const [dialogConn, setDialogConn] = useState<Connection | null | undefined>(undefined) // undefined = closed
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)
  const [pwRequest, setPwRequest] = useState<PwRequest | null>(null)

  // Workspace persistence: don't save until the previous session is restored,
  // so the empty initial state never clobbers the saved tabs on disk.
  const restoredRef = useRef(false)
  const lastSavedRef = useRef('')

  // Tab drag-to-reorder state.
  const dragTabId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const selectedConnId = activeTab && 'connectionId' in activeTab ? activeTab.connectionId : null

  const refresh = async (): Promise<void> => setConnections(await window.api.listConnections())
  const nameOf = (id: string): string => connections.find((c) => c.id === id)?.name ?? 'Connection'

  // Settings persisted on disk by the main process (the app's user folder).
  useEffect(() => {
    void window.api.getSettings().then(setAppSettings)
  }, [])
  const updateSettings = useCallback((patch: SettingsPatch): void => {
    setAppSettings((s) => {
      const next: AppSettings = {
        ...s,
        ...patch,
        terminal: { ...s.terminal, ...(patch.terminal ?? {}) },
        editor: { ...s.editor, ...(patch.editor ?? {}) }
      }
      void window.api.updateSettings(patch)
      return next
    })
  }, [])
  const toggleSidebar = useCallback((): void => {
    setAppSettings((s) => {
      const next = { ...s, sidebarCollapsed: !s.sidebarCollapsed }
      void window.api.updateSettings({ sidebarCollapsed: next.sidebarCollapsed })
      return next
    })
  }, [])
  const resetSettings = useCallback((): void => {
    setAppSettings(DEFAULTS)
    void window.api.updateSettings({
      terminal: DEFAULTS.terminal,
      editor: DEFAULTS.editor,
      connectRetries: DEFAULTS.connectRetries,
      sidebarCollapsed: DEFAULTS.sidebarCollapsed
    })
  }, [])

  const openSettings = useCallback((): void => {
    setTabs((t) =>
      t.some((x) => x.id === SETTINGS_TAB_ID) ? t : [...t, { kind: 'settings', id: SETTINGS_TAB_ID }]
    )
    setActiveTabId(SETTINGS_TAB_ID)
  }, [])

  useEffect(() => {
    void (async () => {
      const conns = await window.api.listConnections()
      setConnections(conns)
      void window.api.secretsAvailable().then(setSecretsAvailable)
      try {
        const ws = await window.api.getWorkspace()
        await restoreWorkspace(ws, conns)
      } finally {
        restoredRef.current = true // from here on, tab changes are persisted
      }
    })()
    const offHostKey = window.api.onHostKey((prompt) => setHostKey(prompt))
    const offNew = window.api.onNewConnection(() => setDialogConn(null))
    const offSettings = window.api.onOpenSettings(() => openSettings())
    return () => {
      offHostKey()
      offNew()
      offSettings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSettings])

  // Persist the open tabs whenever they change (after the initial restore).
  useEffect(() => {
    if (!restoredRef.current) return
    const ws: Workspace = {
      tabs: tabs.map(serializeTab),
      active: activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1
    }
    const json = JSON.stringify(ws)
    if (json === lastSavedRef.current) return // status flips etc. don't change the snapshot
    lastSavedRef.current = json
    window.api.setWorkspace(ws)
  }, [tabs, activeTabId])

  const askPassword = (title: string, label: string): Promise<string | null> =>
    new Promise((resolve) => setPwRequest({ title, label, resolve }))

  // Click in the sidebar -> open (or focus) the connection's dashboard tab.
  const selectConnection = (connectionId: string): void => {
    const id = dashId(connectionId)
    setTabs((t) => (t.some((x) => x.id === id) ? t : [...t, { kind: 'dashboard', id, connectionId }]))
    setActiveTabId(id)
  }

  const resolvePassword = async (conn: Connection): Promise<string | null | undefined> => {
    if (conn.authMethod !== 'password') return undefined
    if (await window.api.hasSecret(conn.id)) return undefined
    return askPassword('Password', `Password for ${conn.username}@${conn.host}`)
  }

  // Rebuild last session's tabs. Tabs whose connection was deleted are dropped;
  // sessions get fresh ids and reconnect (tmux re-attaches if still alive); a
  // missing file just surfaces the editor's own error state. Passwords are
  // resolved once per connection (no prompt for key auth or saved secrets).
  const restoreWorkspace = async (ws: Workspace, conns: Connection[]): Promise<void> => {
    const byId = new Map(conns.map((c) => [c.id, c]))
    const pwCache = new Map<string, string | null | undefined>()
    const getPw = async (conn: Connection): Promise<string | null | undefined> => {
      if (pwCache.has(conn.id)) return pwCache.get(conn.id)
      const pw = await resolvePassword(conn)
      pwCache.set(conn.id, pw) // cache null too, so a cancelled prompt isn't re-asked
      return pw
    }

    const built: Tab[] = []
    let activeId: string | null = null
    const has = (id: string): boolean => built.some((b) => b.id === id)

    for (let i = 0; i < ws.tabs.length; i++) {
      const pt = ws.tabs[i]
      const makeActive = i === ws.active

      if (pt.kind === 'settings') {
        if (!has(SETTINGS_TAB_ID)) built.push({ kind: 'settings', id: SETTINGS_TAB_ID })
        if (makeActive) activeId = SETTINGS_TAB_ID
        continue
      }

      const conn = pt.connectionId ? byId.get(pt.connectionId) : undefined
      if (!conn) continue // connection deleted -> drop the tab

      if (pt.kind === 'dashboard') {
        const id = dashId(conn.id)
        if (!has(id)) built.push({ kind: 'dashboard', id, connectionId: conn.id })
        if (makeActive) activeId = id
      } else if (pt.kind === 'session') {
        const pw = await getPw(conn)
        if (pw === null) continue // cancelled prompt
        const id = crypto.randomUUID()
        built.push({
          kind: 'session',
          id,
          connectionId: conn.id,
          title: pt.title ?? conn.name,
          status: { kind: 'connecting', attempt: 1, retries: appSettings.connectRetries },
          password: pw ?? undefined,
          command: pt.command
        })
        if (makeActive) activeId = id
      } else if (pt.kind === 'sftp') {
        const pw = await getPw(conn)
        if (pw === null) continue
        const id = crypto.randomUUID()
        built.push({
          kind: 'sftp',
          id,
          connectionId: conn.id,
          title: pt.title ?? `${conn.name} · files`,
          password: pw ?? undefined,
          initialPath: pt.initialPath ?? (conn.lastSftpPath || conn.sftpPath)
        })
        if (makeActive) activeId = id
      } else if (pt.kind === 'tunnels') {
        const pw = await getPw(conn)
        if (pw === null) continue
        const id = tunId(conn.id)
        if (!has(id))
          built.push({
            kind: 'tunnels',
            id,
            connectionId: conn.id,
            title: pt.title ?? `${conn.name} · tunnels`,
            password: pw ?? undefined
          })
        if (makeActive) activeId = id
      } else if (pt.kind === 'editor') {
        if (!pt.path || !pt.name) continue
        const pw = await getPw(conn)
        if (pw === null) continue
        const id = `edit:${conn.id}:${pt.path}`
        if (!has(id))
          built.push({
            kind: 'editor',
            id,
            connectionId: conn.id,
            path: pt.path,
            name: pt.name,
            title: pt.name,
            password: pw ?? undefined
          })
        if (makeActive) activeId = id
      }
    }

    if (built.length) {
      setTabs(built)
      setActiveTabId(activeId ?? built[built.length - 1].id)
    }
  }

  // Open a console/tmux session as a NEW tab — the dashboard tab stays open.
  // With no explicit command, a tmux-enabled connection opens straight into its
  // persistent session (create-or-attach); otherwise it's a plain login shell.
  const openSession = async (
    conn: Connection,
    opts?: { command?: string; title?: string }
  ): Promise<void> => {
    const password = await resolvePassword(conn)
    if (password === null) return // user cancelled the prompt
    let { command, title } = opts ?? {}
    if (!command && conn.tmux) {
      const session = tmuxSessionName(conn.tmuxSession || conn.name)
      command = tmuxAttachCommand(session, !!conn.tmuxDetachOthers)
      title = title ?? `${conn.name} · ${session}`
    }
    const sessionId = crypto.randomUUID()
    setTabs((t) => [
      ...t,
      {
        kind: 'session',
        id: sessionId,
        connectionId: conn.id,
        title: title ?? conn.name,
        status: { kind: 'connecting', attempt: 1, retries: appSettings.connectRetries },
        password: password ?? undefined,
        command
      }
    ])
    setActiveTabId(sessionId)
  }

  // Open a remote file manager (SFTP) as a NEW tab.
  const openSftp = async (conn: Connection): Promise<void> => {
    const password = await resolvePassword(conn)
    if (password === null) return // user cancelled the prompt
    const sftpId = crypto.randomUUID()
    setTabs((t) => [
      ...t,
      {
        kind: 'sftp',
        id: sftpId,
        connectionId: conn.id,
        title: `${conn.name} · files`,
        password: password ?? undefined,
        initialPath: conn.lastSftpPath || conn.sftpPath
      }
    ])
    setActiveTabId(sftpId)
  }

  // Open the port-forwarding manager for a connection as a NEW tab (or focus it).
  const openTunnels = async (conn: Connection): Promise<void> => {
    const id = tunId(conn.id)
    if (tabs.some((t) => t.id === id)) {
      setActiveTabId(id)
      return
    }
    const password = await resolvePassword(conn)
    if (password === null) return // user cancelled the prompt
    setTabs((t) => [
      ...t,
      {
        kind: 'tunnels',
        id,
        connectionId: conn.id,
        title: `${conn.name} · tunnels`,
        password: password ?? undefined
      }
    ])
    setActiveTabId(id)
  }

  // Remember the last browsed directory for a connection (disk + live state).
  const rememberSftpPath = (connectionId: string, path: string): void => {
    window.api.setLastSftpPath(connectionId, path)
    setConnections((cs) => cs.map((c) => (c.id === connectionId ? { ...c, lastSftpPath: path } : c)))
  }

  // Keep each SFTP tab's path current so the workspace restores to that dir.
  const updateSftpTabPath = (id: string, path: string): void => {
    setTabs((t) => t.map((x) => (x.kind === 'sftp' && x.id === id ? { ...x, initialPath: path } : x)))
  }

  // Open a remote file in its own editor tab (dedicated SFTP channel).
  const openFile = (connectionId: string, password: string | undefined, path: string, name: string): void => {
    const id = `edit:${connectionId}:${path}`
    setTabs((t) =>
      t.some((x) => x.id === id)
        ? t
        : [
            ...t,
            {
              kind: 'editor',
              id,
              connectionId,
              path,
              name,
              title: name,
              password
            }
          ]
    )
    setActiveTabId(id)
  }

  const fetchTmuxFor = (conn: Connection) => async () => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required to list sessions.')
    return window.api.tmuxList({ connectionId: conn.id, password: password ?? undefined })
  }

  const fetchStatsFor = (conn: Connection) => async () => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required to read host vitals.')
    return window.api.probeServer({ connectionId: conn.id, password: password ?? undefined })
  }

  // Attach (or create) a tmux session in a new terminal tab. `new -A` means a
  // session that died between listing and clicking won't error — it's recreated.
  const attachTmux = (conn: Connection, name: string): void => {
    void openSession(conn, {
      command: tmuxAttachCommand(name, !!conn.tmuxDetachOthers),
      title: `${conn.name} · ${name}`
    })
  }

  // Kill / rename run as one-shot commands; the Dashboard refreshes its list after.
  const killTmux = (conn: Connection) => async (name: string): Promise<void> => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required.')
    await window.api.tmuxKill({ connectionId: conn.id, password: password ?? undefined, name })
  }
  const renameTmux = (conn: Connection) => async (from: string, to: string): Promise<void> => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required.')
    await window.api.tmuxRename({
      connectionId: conn.id,
      password: password ?? undefined,
      from,
      to: tmuxSessionName(to)
    })
  }

  const closeTab = (id: string): void => {
    const tab = tabs.find((t) => t.id === id)
    if (tab?.kind === 'session') window.api.closeSession(tab.id)
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (activeTabId === id) {
      setActiveTabId(next.length ? next[Math.max(0, idx - 1)].id : null)
    }
  }

  // Reorder tabs by dropping the dragged tab onto another. The tabs-change
  // effect persists the new order to the workspace automatically.
  const moveTab = (fromId: string, toId: string): void => {
    if (fromId === toId) return
    setTabs((t) => {
      const from = t.findIndex((x) => x.id === fromId)
      const to = t.findIndex((x) => x.id === toId)
      if (from < 0 || to < 0) return t
      const next = t.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const onStatus = (sessionId: string, status: SessionStatus): void => {
    setTabs((t) =>
      t.map((x) => (x.kind === 'session' && x.id === sessionId ? { ...x, status } : x))
    )
  }

  const saveConnection = async (draft: ConnectionDraft): Promise<void> => {
    await window.api.upsertConnection(draft)
    setDialogConn(undefined)
    await refresh()
  }

  const deleteConnection = async (conn: Connection): Promise<void> => {
    if (!confirm(`Delete connection “${conn.name}”?`)) return
    await window.api.removeConnection(conn.id)
    closeTab(dashId(conn.id))
    closeTab(tunId(conn.id))
    await refresh()
  }

  const dashboardTabs = tabs.filter((t): t is DashboardTab => t.kind === 'dashboard')
  const sessionTabs = tabs.filter((t): t is SessionTab => t.kind === 'session')

  return (
    <div className="flex h-full w-full flex-col">
      <TitleBar onNewConnection={() => setDialogConn(null)} onOpenSettings={openSettings} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          connections={connections}
          selectedId={selectedConnId}
          onSelect={selectConnection}
          onAdd={() => setDialogConn(null)}
          onEdit={(c) => setDialogConn(c)}
          onDelete={deleteConnection}
          collapsed={appSettings.sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
        />

        <div className="flex min-w-0 flex-1 flex-col">
        {/* tab bar */}
        {tabs.length > 0 && (
          <div className="flex h-10 shrink-0 items-stretch gap-1 border-b border-line bg-surface/60 px-2 pt-1.5">
            {tabs.map((tab) => {
              const active = activeTabId === tab.id
              return (
                <div
                  key={tab.id}
                  draggable
                  onClick={() => setActiveTabId(tab.id)}
                  onDragStart={(e) => {
                    dragTabId.current = tab.id
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', tab.id)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragTabId.current && dragTabId.current !== tab.id) setDragOverId(tab.id)
                  }}
                  onDragLeave={() => setDragOverId((id) => (id === tab.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = dragTabId.current
                    if (from) moveTab(from, tab.id)
                    dragTabId.current = null
                    setDragOverId(null)
                  }}
                  onDragEnd={() => {
                    dragTabId.current = null
                    setDragOverId(null)
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-3 text-sm transition-colors ${
                    dragOverId === tab.id ? 'ring-2 ring-inset ring-signal/70' : ''
                  } ${
                    active
                      ? 'border-line bg-ink text-fg'
                      : 'border-transparent text-muted hover:bg-elevated/40 hover:text-fg/90'
                  }`}
                >
                  {tab.kind === 'dashboard' ? (
                    <span className={active ? 'text-signal' : 'text-faint'}>▦</span>
                  ) : tab.kind === 'settings' ? (
                    <span className={active ? 'text-signal' : 'text-faint'}>⚙</span>
                  ) : tab.kind === 'sftp' ? (
                    <span className={active ? 'text-amber' : 'text-faint'}>▸▸</span>
                  ) : tab.kind === 'tunnels' ? (
                    <span className={active ? 'text-signal' : 'text-faint'}>⇄</span>
                  ) : tab.kind === 'editor' ? (
                    <span className={active ? 'text-signal' : 'text-faint'}>✎</span>
                  ) : (
                    <span className={`h-2 w-2 rounded-full ${statusDot(tab.status)}`} />
                  )}
                  <span className="max-w-[260px] truncate font-mono text-[12px]">
                    {tab.kind === 'dashboard'
                      ? nameOf(tab.connectionId)
                      : tab.kind === 'settings'
                        ? 'Settings'
                        : tab.title}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                    className="text-faint opacity-60 transition-opacity hover:text-fg group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* main content */}
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-signal/10 ring-1 ring-signal/25">
                <span className="h-2.5 w-2.5 rounded-full bg-signal dot-glow text-signal" />
              </div>
              <p className="text-sm text-muted">Select a connection to open its dashboard.</p>
              <p className="eyebrow">no active session</p>
            </div>
          )}

          {/* dashboards stay mounted so vitals don't re-fetch on every tab switch */}
          {dashboardTabs.map((tab) => {
            const conn = connections.find((c) => c.id === tab.connectionId)
            if (!conn) return null
            return (
              <div
                key={tab.id}
                className="absolute inset-0 overflow-hidden"
                style={{ visibility: activeTabId === tab.id ? 'visible' : 'hidden' }}
              >
                <Dashboard
                  connection={conn}
                  openSessions={sessionTabs.filter((t) => t.connectionId === conn.id).length}
                  onOpenTerminal={() => void openSession(conn)}
                  onOpenFiles={() => void openSftp(conn)}
                  onOpenTunnels={() => void openTunnels(conn)}
                  onEdit={() => setDialogConn(conn)}
                  fetchTmux={fetchTmuxFor(conn)}
                  fetchStats={fetchStatsFor(conn)}
                  onAttach={(name) => attachTmux(conn, name)}
                  onNewSession={(name) => attachTmux(conn, name)}
                  onKillSession={killTmux(conn)}
                  onRenameSession={renameTmux(conn)}
                />
              </div>
            )
          })}

          {activeTab?.kind === 'settings' && (
            <SettingsPage settings={appSettings} onChange={updateSettings} onReset={resetSettings} />
          )}

          {/* terminals stay mounted so sessions persist; only the active one shows */}
          {sessionTabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0 overflow-hidden border-t border-line bg-ink p-3"
              style={{ visibility: activeTabId === tab.id ? 'visible' : 'hidden' }}
            >
              <TerminalView
                sessionId={tab.id}
                connectionId={tab.connectionId}
                active={activeTabId === tab.id}
                password={tab.password}
                command={tab.command}
                retries={appSettings.connectRetries}
                settings={appSettings.terminal}
                onStatus={onStatus}
              />
            </div>
          ))}

          {/* file managers stay mounted so the SFTP channel + transfers persist */}
          {tabs
            .filter((t): t is SftpTab => t.kind === 'sftp')
            .map((tab) => (
              <div
                key={tab.id}
                className="absolute inset-0 overflow-hidden border-t border-line"
                style={{ visibility: activeTabId === tab.id ? 'visible' : 'hidden' }}
              >
                <FileManager
                  connectionId={tab.connectionId}
                  password={tab.password}
                  initialPath={tab.initialPath}
                  active={activeTabId === tab.id}
                  onOpenFile={(path, name) => openFile(tab.connectionId, tab.password, path, name)}
                  onCwdChange={(path) => {
                    rememberSftpPath(tab.connectionId, path)
                    updateSftpTabPath(tab.id, path)
                  }}
                />
              </div>
            ))}

          {/* editor tabs stay mounted so unsaved edits survive tab switches */}
          {tabs
            .filter((t): t is EditorTab => t.kind === 'editor')
            .map((tab) => (
              <div
                key={tab.id}
                className="absolute inset-0 overflow-hidden border-t border-line"
                style={{ visibility: activeTabId === tab.id ? 'visible' : 'hidden' }}
              >
                <EditorView
                  connectionId={tab.connectionId}
                  password={tab.password}
                  path={tab.path}
                  name={tab.name}
                  active={activeTabId === tab.id}
                  settings={appSettings.editor}
                />
              </div>
            ))}

          {/* tunnel managers stay mounted so live tunnel state survives tab switches */}
          {tabs
            .filter((t): t is TunnelTab => t.kind === 'tunnels')
            .map((tab) => (
              <div
                key={tab.id}
                className="absolute inset-0 overflow-hidden border-t border-line"
                style={{ visibility: activeTabId === tab.id ? 'visible' : 'hidden' }}
              >
                <TunnelManager
                  connectionId={tab.connectionId}
                  connectionName={nameOf(tab.connectionId)}
                  password={tab.password}
                  active={activeTabId === tab.id}
                />
              </div>
            ))}
        </div>
      </div>
      </div>

      {dialogConn !== undefined && (
        <ConnectionDialog
          initial={dialogConn}
          secretsAvailable={secretsAvailable}
          onCancel={() => setDialogConn(undefined)}
          onSave={saveConnection}
        />
      )}

      {hostKey && (
        <HostKeyDialog
          prompt={hostKey}
          onRespond={(accept) => {
            window.api.respondHostKey(hostKey.requestId, accept)
            setHostKey(null)
          }}
        />
      )}

      {pwRequest && (
        <PasswordPrompt
          title={pwRequest.title}
          label={pwRequest.label}
          onSubmit={(value) => {
            pwRequest.resolve(value)
            setPwRequest(null)
          }}
        />
      )}
    </div>
  )
}
