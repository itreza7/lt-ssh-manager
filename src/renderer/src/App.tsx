import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  ClaudeHookStatus,
  ClaudeStatusLineStatus,
  ClaudeTmuxPassthroughStatus,
  Connection,
  ConnectionDraft,
  HostKeyPrompt,
  PersistedTab,
  SessionStatus,
  SplitDirection,
  TmuxIntent,
  Workspace
} from '../../shared/types'
import { DEFAULTS, type AppSettings, type SettingsPatch } from './lib/terminalSettings'
import { MenuBar } from './components/MenuBar'
import { WindowControls } from './components/WindowControls'
import { SummaryView } from './components/SummaryView'
import { SettingsPage } from './components/SettingsPage'
import { CommandPalette } from './components/CommandPalette'
import { ConnectionDialog } from './components/ConnectionDialog'
import { HostKeyDialog } from './components/HostKeyDialog'
import { PasswordPrompt } from './components/PasswordPrompt'
import { TerminalView } from './components/TerminalView'
import { TmuxControlView } from './components/TmuxControlView'
import { FileManager } from './components/FileManager'
import { EditorView } from './components/EditorView'
import { WorktreeView } from './components/WorktreeView'
import { TunnelManager } from './components/TunnelManager'
import { SplitControls } from './components/SplitControls'
import { PaneDividers } from './components/PaneDividers'
import { PaneTools } from './components/PaneTools'
import { PanePicker } from './components/PanePicker'
import { parseTmuxIntent, tmuxCreateCommand, tmuxSessionName } from './lib/tmux'
import { claudeSessionName, claudeTabCommand } from './lib/claude'
import type { AgentSignal } from './lib/xtermAgentSignal'
import { COMPOSE_ACCEL, type ComposerHandle } from './lib/xtermAttach'
import { TERMINAL_BG } from './lib/xtermSetup'
import { useAgentSessions } from './hooks/useAgentSessions'
import { isMac } from './lib/platform'

const SETTINGS_TAB_ID = 'settings'
const SUMMARY_TAB_ID = 'summary'

/**
 * The active connection's live status — identity, vitals, tmux sessions, and
 * the new-agent form. Always present and always first, since only one
 * connection is ever active now; unlike Settings there is nothing to open
 * lazily, so this never needs its own opener the way openSettings does.
 */
interface SummaryTab {
  kind: 'summary'
  id: typeof SUMMARY_TAB_ID
}

interface SessionTab {
  kind: 'session'
  id: string // sessionId
  /** Stable across a reconnect *and* a restart — see PersistedTab.tabKey. */
  tabKey: string
  connectionId: string
  title: string
  /**
   * Window title the remote is currently reporting (OSC 0/2). Display-only and
   * deliberately *not* serialized: `title` is what the user/connection named the
   * tab, so a restored tab never comes back labelled with whatever happened to
   * be running last session.
   */
  liveTitle?: string
  status: SessionStatus
  password?: string
  command?: string
  /** Set when `command` attaches to tmux — lets the main process reattach on a drop. */
  tmux?: TmuxIntent
}

/** A tmux control-mode (`tmux -CC`) session — one stream, many panes/windows. */
interface ControlTab {
  kind: 'tmux'
  id: string // sessionId
  /** Stable across a reconnect *and* a restart — see PersistedTab.tabKey. */
  tabKey: string
  connectionId: string
  title: string
  status: SessionStatus
  password?: string
  command?: string
  tmux?: TmuxIntent
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

/** The git worktrees of one remote repository. */
interface WorktreeTab {
  kind: 'worktrees'
  id: string // `wt:${connectionId}:${dir}`
  connectionId: string
  /** Any directory inside the repo — the pane resolves the root from it. */
  dir: string
  title: string
  password?: string
}

// A "leaf" — one unit of content. Leaves live inside views (see below).
export type Tab =
  | SummaryTab
  | SessionTab
  | ControlTab
  | SettingsTab
  | SftpTab
  | EditorTab
  | TunnelTab
  | WorktreeTab

/**
 * A tab-bar entry. A view with one pane is an ordinary tab; a view with 2–3
 * panes is a split that is *itself* a tab — the joined leaves are no longer
 * shown as separate tabs. `panes` holds the leaf id per pane (null = an empty
 * pane awaiting a tab); `focused` is the pane that takes keyboard input. Each
 * leaf belongs to exactly one view.
 */
interface View {
  id: string // `view:${uuid}`
  direction: SplitDirection
  panes: (string | null)[]
  sizes: number[] // fractions, same length as panes, summing to 1
  focused: number
}

const makeView = (
  panes: (string | null)[],
  direction: SplitDirection = 'columns',
  sizes?: number[],
  focused = 0
): View => ({
  id: `view:${crypto.randomUUID()}`,
  direction,
  panes,
  sizes: sizes && sizes.length === panes.length ? sizes : panes.map(() => 1 / panes.length),
  focused: Math.min(Math.max(0, focused), Math.max(0, panes.length - 1))
})

// Drop a removed pane (by index) from a view, renormalizing sizes; returns null
// if the view no longer holds any real leaf (caller should drop it).
const shrinkView = (v: View, paneIndex: number): View | null => {
  const panes = v.panes.filter((_, i) => i !== paneIndex)
  if (!panes.some((p) => p !== null)) return null
  let focused = v.focused
  if (paneIndex < focused) focused -= 1
  focused = Math.max(0, Math.min(focused, panes.length - 1))
  const kept = v.sizes.filter((_, i) => i !== paneIndex)
  const sum = kept.reduce((a, b) => a + b, 0)
  const sizes = sum > 0 ? kept.map((s) => s / sum) : panes.map(() => 1 / panes.length)
  return { ...v, panes, sizes, focused }
}

interface PwRequest {
  title: string
  label: string
  resolve: (value: string | null) => void
}

const tunId = (connectionId: string): string => `tun:${connectionId}`

// Strip a live tab down to what's safe + sufficient to recreate it later.
// Passwords and volatile session ids/status are intentionally omitted.
function serializeTab(t: Tab): PersistedTab {
  switch (t.kind) {
    case 'summary':
      return { kind: 'summary' }
    case 'session':
      return {
        kind: 'session',
        connectionId: t.connectionId,
        title: t.title,
        command: t.command,
        tmux: t.tmux,
        tabKey: t.tabKey
      }
    case 'tmux':
      return {
        kind: 'tmux',
        connectionId: t.connectionId,
        title: t.title,
        command: t.command,
        tmux: t.tmux,
        tabKey: t.tabKey
      }
    case 'settings':
      return { kind: 'settings' }
    case 'sftp':
      return { kind: 'sftp', connectionId: t.connectionId, title: t.title, initialPath: t.initialPath }
    case 'editor':
      return { kind: 'editor', connectionId: t.connectionId, path: t.path, name: t.name }
    case 'tunnels':
      return { kind: 'tunnels', connectionId: t.connectionId, title: t.title }
    case 'worktrees':
      return {
        kind: 'worktrees',
        connectionId: t.connectionId,
        title: t.title,
        initialPath: t.dir
      }
  }
}

// A tmux tab's drafts are stored as one JSON blob per pane under the tab's
// single tabKey (see TmuxControlView's persist effect) — parse it back out,
// falling back to empty on missing/corrupt data.
function parseTmuxDrafts(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function statusDot(status: SessionStatus): string {
  switch (status.kind) {
    case 'ready':
      return 'bg-emerald-400'
    case 'connecting':
    case 'retrying':
      return 'bg-amber-400 animate-pulse'
    // Reconnecting on its own: distinct from the first-dial amber so a glance at a
    // background tab tells you it dropped and is coming back by itself.
    case 'reattaching':
      return 'bg-sky-400 animate-pulse'
    case 'error':
      return 'bg-red-500'
    case 'closed':
      // A session that can't be brought back reads as an error, not as idle.
      return status.reason === 'gone' ? 'bg-red-500/60' : 'bg-white/30'
    default:
      return 'bg-white/30'
  }
}

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  // Summary is always open, always first — seeded synchronously rather than
  // lazily opened, so there is never a frame with zero tabs.
  const [initialView] = useState(() => makeView([SUMMARY_TAB_ID]))
  const [tabs, setTabs] = useState<Tab[]>(() => [{ kind: 'summary', id: SUMMARY_TAB_ID }])
  const [views, setViews] = useState<View[]>(() => [initialView])
  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialView.id)
  // The one connection Summary/new-tab actions target — see the comment where
  // it's read, further down, for why this is explicit state rather than derived.
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [secretsAvailable, setSecretsAvailable] = useState(true)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULTS)
  // Prompt composer drafts, local-autosave keyed by tabKey — see PersistedTab.tabKey.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const [dialogConn, setDialogConn] = useState<Connection | null | undefined>(undefined) // undefined = closed
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)
  const [pwRequest, setPwRequest] = useState<PwRequest | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Workspace persistence: don't save until the previous session is restored,
  // so the empty initial state never clobbers the saved tabs on disk.
  const restoredRef = useRef(false)
  const lastSavedRef = useRef('')

  // Tab drag-to-reorder state (operates on views).
  const dragViewId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // The split container, so dividers can translate pointer travel into fractions.
  const contentRef = useRef<HTMLDivElement>(null)

  // One composer handle per session/tmux tab, so the header's toggle button can
  // reach whichever pane is focused without owning any drafting state itself.
  const composerRefs = useRef(new Map<string, ComposerHandle>())
  // Mirrors each handle's `isOpen` into render-visible state — the map above is
  // a ref precisely so touching it doesn't cause a render, but the toggle
  // button's own color does need one. useImperativeHandle re-invokes this
  // callback with a fresh handle whenever a pane's composer opens or closes.
  const [composerOpen, setComposerOpen] = useState<Record<string, boolean>>({})
  // useImperativeHandle's effect keys off the `ref` prop's own identity as well
  // as its deps, so a `ref={setComposerRef(id)}` that mints a new closure every
  // render makes it re-fire on every render — which, now that it calls setState,
  // becomes an infinite loop. Cache one stable callback per id instead.
  const composerRefCallbacks = useRef(new Map<string, (h: ComposerHandle | null) => void>())
  const setComposerRef = useCallback((id: string) => {
    let cb = composerRefCallbacks.current.get(id)
    if (!cb) {
      cb = (h: ComposerHandle | null): void => {
        if (h) composerRefs.current.set(id, h)
        else composerRefs.current.delete(id)
        setComposerOpen((m) => {
          const next = h?.isOpen ?? false
          return m[id] === next ? m : { ...m, [id]: next }
        })
      }
      composerRefCallbacks.current.set(id, cb)
    }
    return cb
  }, [])

  // Derived view state. The active view is the tab on screen; the focused pane's
  // leaf is the app's notion of the "active" tab (sidebar + keyboard follow it).
  // Fall back to the last view if activeViewId briefly lags (e.g. just after the
  // active tab was closed) so the screen never blanks for a frame — the
  // activeViewId effect below then re-syncs the state.
  const activeView = views.find((v) => v.id === activeViewId) ?? views[views.length - 1] ?? null
  const isSplit = (activeView?.panes.length ?? 0) > 1
  const activeTabId = activeView ? activeView.panes[activeView.focused] ?? null : null
  const onScreen = (id: string): boolean => activeView?.panes.includes(id) ?? false

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const selectedConnId = activeTab && 'connectionId' in activeTab ? activeTab.connectionId : null

  // The one connection Summary/new-tab actions target — set explicitly by
  // selectConnection rather than derived from open tabs, since Summary must
  // show a connection's identity even with none of its other tabs open.

  // --- agent attention -------------------------------------------------------
  // Leaves that have rung since you last looked at them. Deliberately not
  // persisted with the workspace: an alert you never saw before quitting is not
  // one worth restoring three days later.
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set())
  const [winFocused, setWinFocused] = useState(() => document.hasFocus())
  const [fullScreen, setFullScreen] = useState(false)
  const shownLeaves = activeView?.panes.filter((p): p is string => p !== null) ?? []
  const attnRef = useRef({ alerts: appSettings.terminal.agentAlerts, visible: new Set(shownLeaves) })
  attnRef.current = {
    alerts: appSettings.terminal.agentAlerts,
    visible: new Set(shownLeaves)
  }
  const viewsRef = useRef(views)
  viewsRef.current = views

  const refresh = async (): Promise<void> => setConnections(await window.api.listConnections())
  const nameOf = (id: string): string => connections.find((c) => c.id === id)?.name ?? 'Connection'

  // --- view / pane helpers ---------------------------------------------------

  const leafLabel = (t: Tab): string =>
    t.kind === 'summary'
      ? 'Summary'
      : t.kind === 'settings'
        ? 'Settings'
        : t.kind === 'session' && appSettings.terminal.liveTitles && t.liveTitle
          ? t.liveTitle
          : t.title

  const leafIcon = (t: Tab, lit: boolean): ReactNode => {
    const c = lit ? 'text-accent' : 'text-faint'
    if (t.kind === 'summary') return <span className={c}>◎</span>
    if (t.kind === 'settings') return <span className={c}>⚙</span>
    if (t.kind === 'sftp') return <span className={lit ? 'text-amber' : 'text-faint'}>▸▸</span>
    if (t.kind === 'tunnels') return <span className={c}>⇄</span>
    if (t.kind === 'editor') return <span className={c}>✎</span>
    if (t.kind === 'worktrees') return <span className={c}>⑂</span>
    return <span className={`h-2 w-2 rounded-full ${statusDot(t.status)}`} />
  }

  // Show a leaf: focus the view that already holds it, else open it as a new
  // single-pane view (a normal tab).
  //
  // Reads views through the ref rather than the render closure. The singleton
  // openers — openSettings, openSummary — are useCallback([]), because the menu
  // bridge registers them once and needs a stable identity, so they capture the
  // *first* render's showLeaf, whose `views` is still the initial empty array.
  // Through that closure the lookup below never found the existing view and fell
  // through to appending a new one, so a second click on Settings opened a second
  // Settings tab, and a third opened a third. The ref is assigned during render,
  // so every other caller sees exactly what it saw before.
  const showLeaf = (id: string): void => {
    const v = viewsRef.current.find((x) => x.panes.includes(id))
    if (v) {
      const pi = v.panes.indexOf(id)
      if (pi !== v.focused) setViews((vs) => vs.map((x) => (x.id === v.id ? { ...x, focused: pi } : x)))
      setActiveViewId(v.id)
      return
    }
    const nv = makeView([id])
    setViews((vs) => [...vs, nv])
    setActiveViewId(nv.id)
  }

  // Click a pane to focus it.
  const focusPane = (index: number): void => {
    const id = activeView?.id
    setViews((vs) =>
      vs.map((v) => (v.id === id && index >= 0 && index < v.panes.length ? { ...v, focused: index } : v))
    )
  }

  // Turn the active tab into a split (or re-split it): keep current panes, add
  // empty panes for new slots, and return any dropped pane's leaf to the bar.
  const applySplit = (direction: SplitDirection, count: number): void => {
    const id = activeView?.id
    setViews((vs) => {
      const out: View[] = []
      for (const v of vs) {
        if (v.id !== id) {
          out.push(v)
          continue
        }
        if (direction === v.direction && count === v.panes.length) {
          out.push(v)
          continue
        }
        const dropped = v.panes.slice(count).filter((p): p is string => !!p)
        const panes = v.panes.slice(0, count)
        while (panes.length < count) panes.push(null)
        const sizes = count === v.panes.length ? v.sizes : Array.from({ length: count }, () => 1 / count)
        out.push({ ...v, direction, panes, sizes, focused: Math.min(v.focused, count - 1) })
        for (const id of dropped) out.push(makeView([id])) // dropped panes become normal tabs again
      }
      return out
    })
  }

  // Collapse the active split back into separate tabs (the "join → un-join").
  const ungroup = (): void => {
    const v = activeView
    if (!v || v.panes.length <= 1) return
    const leaves = v.panes.filter((p): p is string => !!p)
    const newViews = leaves.map((id) => makeView([id]))
    const focusedLeaf = v.panes[v.focused] ?? leaves[0] ?? null
    const activeNew = newViews.find((nv) => nv.panes[0] === focusedLeaf) ?? newViews[0] ?? null
    setViews((vs) => vs.flatMap((x) => (x.id === v.id ? newViews : [x])))
    setActiveViewId(activeNew?.id ?? null)
  }

  // Join `leafId` into pane `paneIndex` of `targetViewId`: it moves out of its
  // current view (which shrinks / disappears) — so it stops being its own tab.
  const fillPane = (targetViewId: string, paneIndex: number, leafId: string): void => {
    setViews((vs) => {
      const out: View[] = []
      for (const v of vs) {
        if (v.id === targetViewId) {
          const panes = v.panes.slice()
          panes[paneIndex] = leafId
          out.push({ ...v, panes, focused: paneIndex })
        } else if (v.panes.includes(leafId)) {
          const sv = shrinkView(v, v.panes.indexOf(leafId))
          if (sv) out.push(sv)
        } else {
          out.push(v)
        }
      }
      return out
    })
    setActiveViewId(targetViewId)
  }

  // Swap two panes' positions within a view (content, size, and — if it was one
  // of them — the focus all move together, so the focused pane stays focused).
  const swapPanes = (viewId: string, i: number, j: number): void => {
    setViews((vs) =>
      vs.map((v) => {
        if (v.id !== viewId || i === j) return v
        if (i < 0 || j < 0 || i >= v.panes.length || j >= v.panes.length) return v
        const panes = v.panes.slice()
        ;[panes[i], panes[j]] = [panes[j], panes[i]]
        const sizes = v.sizes.slice()
        ;[sizes[i], sizes[j]] = [sizes[j], sizes[i]]
        const focused = v.focused === i ? j : v.focused === j ? i : v.focused
        return { ...v, panes, sizes, focused }
      })
    )
  }

  // Detach a pane back into its own tab (full screen).
  const detachPane = (viewId: string, paneIndex: number): void => {
    const v = views.find((x) => x.id === viewId)
    const leaf = v?.panes[paneIndex] ?? null
    const detached = leaf ? makeView([leaf]) : null
    setViews((vs) =>
      vs.flatMap((x) => {
        if (x.id !== viewId) return [x]
        const sv = shrinkView(x, paneIndex)
        return [sv, detached].filter((y): y is View => !!y)
      })
    )
    if (detached) setActiveViewId(detached.id)
  }

  // Close a pane: an empty pane is just dropped; a filled one closes its leaf.
  const closePaneLeaf = (viewId: string, paneIndex: number): void => {
    const v = views.find((x) => x.id === viewId)
    const leaf = v?.panes[paneIndex] ?? null
    if (leaf) {
      removeTabs([leaf]) // destroys the leaf; the view shrinks/dissolves in step
      return
    }
    setViews((vs) =>
      vs.flatMap((x) => {
        if (x.id !== viewId) return [x]
        const sv = shrinkView(x, paneIndex)
        return sv ? [sv] : []
      })
    )
  }

  // Geometry for pane i of the active view along its split axis (cross axis fills).
  const paneRect = (i: number): CSSProperties => {
    const sizes = activeView?.sizes ?? [1]
    const offset = sizes.slice(0, i).reduce((a, b) => a + b, 0)
    const size = sizes[i] ?? 1
    const pct = (n: number): string => `${(n * 100).toFixed(4)}%`
    return (activeView?.direction ?? 'columns') === 'columns'
      ? { left: pct(offset), width: pct(size), top: 0, bottom: 0 }
      : { top: pct(offset), height: pct(size), left: 0, right: 0 }
  }

  // Last on-screen pane rect per leaf, so a leaf that returns to an unchanged
  // layout comes back at the geometry it left rather than full-bleed (it still
  // refits on reveal; a leaf returning to a differently-sized pane gets the new
  // rect). Only used to seed the rect — a parked leaf isn't laid out at all.
  const lastRectRef = useRef<Record<string, CSSProperties>>({})

  // Absolute-position style for a mounted leaf's wrapper: into its pane when the
  // active view shows it, else parked (kept mounted so live state survives).
  //
  // A leaf that HAS been laid out before is parked with `display: none`: xterm
  // pauses its render service off an IntersectionObserver, which reports a
  // merely-invisible element as still intersecting, so a `visibility: hidden`
  // terminal keeps painting and submitting compositor frames nobody can see.
  //
  // A leaf that has NEVER been laid out is parked with `visibility: hidden`
  // instead, because `display: none` gives it no layout box at all — and a
  // terminal mounting into a zero-size box measures no grid, so it would open its
  // PTY at xterm's construction defaults. tmux sizes a window to its smallest
  // attached client, so one such tab can clamp (or with `-D`, steal) a session the
  // user is actively looking at in another tab. It costs nothing to keep it laid
  // out until it has been shown once: a terminal only repaints when output
  // arrives, and the render-pause win applies from the first switch away onward.
  const wrapperStyle = (id: string): CSSProperties => {
    const i = activeView ? activeView.panes.indexOf(id) : -1
    if (i < 0) {
      const last = lastRectRef.current[id]
      return last
        ? { position: 'absolute', display: 'none', ...last }
        : { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, visibility: 'hidden' }
    }
    const rect = paneRect(i)
    lastRectRef.current[id] = rect
    return { position: 'absolute', visibility: 'visible', ...rect }
  }

  // Pane outline (+ hover group for in-pane tools): brighter for the focused pane.
  const paneRing = (id: string): string => {
    if (!isSplit) return ''
    const ring = id === activeTabId ? 'ring-2 ring-inset ring-accent/60' : 'ring-1 ring-inset ring-line/70'
    return `group/pane ${ring}`
  }

  const paneProps = (id: string): { style: CSSProperties; onMouseDown: () => void } => ({
    style: wrapperStyle(id),
    onMouseDown: () => focusPane(activeView ? activeView.panes.indexOf(id) : -1)
  })

  // In-pane move / detach / close controls, only for a leaf shown in a split.
  const paneTools = (id: string): ReactNode => {
    if (!isSplit || !activeView || !onScreen(id)) return null
    const i = activeView.panes.indexOf(id)
    return (
      <PaneTools
        direction={activeView.direction}
        canMovePrev={i > 0}
        canMoveNext={i < activeView.panes.length - 1}
        onMovePrev={() => swapPanes(activeView.id, i, i - 1)}
        onMoveNext={() => swapPanes(activeView.id, i, i + 1)}
        onDetach={() => detachPane(activeView.id, i)}
        onClose={() => closePaneLeaf(activeView.id, i)}
      />
    )
  }

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
  const resetSettings = useCallback((): void => {
    setAppSettings(DEFAULTS)
    void window.api.updateSettings({
      terminal: DEFAULTS.terminal,
      editor: DEFAULTS.editor,
      connectRetries: DEFAULTS.connectRetries,
      theme: DEFAULTS.theme
    })
  }, [])

  const openSettings = useCallback((): void => {
    setTabs((t) =>
      t.some((x) => x.id === SETTINGS_TAB_ID) ? t : [...t, { kind: 'settings', id: SETTINGS_TAB_ID }]
    )
    showLeaf(SETTINGS_TAB_ID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openSummary = useCallback((): void => {
    showLeaf(SUMMARY_TAB_ID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Summary is always mounted, so the live-agent poll just always runs — no
  // more "has the inbox ever been opened" gate to thread through.
  const {
    hosts: agentHosts,
    error: agentScanError,
    scanning: agentScanning,
    rescan: rescanAgents
  } = useAgentSessions(true)

  useEffect(() => {
    void (async () => {
      const conns = await window.api.listConnections()
      setConnections(conns)
      void window.api.secretsAvailable().then(setSecretsAvailable)
      try {
        // Load persisted drafts before restoring tabs so TerminalView/TmuxControlView
        // seed their initial state from disk on first mount instead of starting blank.
        setDrafts(await window.api.draftsAll())
        const ws = await window.api.getWorkspace()
        await restoreWorkspace(ws, conns)
      } finally {
        restoredRef.current = true // from here on, tab changes are persisted
      }
    })()
    const offHostKey = window.api.onHostKey((prompt) => setHostKey(prompt))
    const offNew = window.api.onNewConnection(() => setDialogConn(null))
    const offSettings = window.api.onOpenSettings(() => openSettings())
    const offPalette = window.api.onCommandPalette(() => setPaletteOpen(true))
    return () => {
      offHostKey()
      offNew()
      offSettings()
      offPalette()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSettings])

  // Keep the active view valid: if it was closed, fall back to the last tab.
  useEffect(() => {
    if (activeViewId && views.some((v) => v.id === activeViewId)) return
    setActiveViewId(views.length ? views[views.length - 1].id : null)
  }, [views, activeViewId])

  // macOS tab shortcuts (⌘W, ⇧⌘[, ⇧⌘], ⌘1-9 — see menu.ts). Re-subscribed
  // whenever views/activeViewId change so each handler closes over the current
  // tab list instead of the one from mount.
  useEffect(() => {
    const offClose = window.api.onCloseTab(() => {
      const id = activeView?.id ?? activeViewId
      // No tab left to close (or none ever opened) — fall back to the window
      // itself, same as ⇧⌘W, rather than swallowing the chord.
      if (id) closeView(id)
      else void window.api.winClose()
    })
    const offPrev = window.api.onPrevTab(() => {
      if (!views.length) return
      const idx = views.findIndex((v) => v.id === activeViewId)
      const next = views[(idx <= 0 ? views.length : idx) - 1] ?? views[views.length - 1]
      setActiveViewId(next.id)
    })
    const offNextTab = window.api.onNextTab(() => {
      if (!views.length) return
      const idx = views.findIndex((v) => v.id === activeViewId)
      const next = views[(idx + 1) % views.length] ?? views[0]
      setActiveViewId(next.id)
    })
    const offGoto = window.api.onGotoTab((index) => {
      const v = views[index]
      if (v) setActiveViewId(v.id)
    })
    return () => {
      offClose()
      offPrev()
      offNextTab()
      offGoto()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, activeViewId])

  // --- agent attention effects ----------------------------------------------
  // Whether the window has focus decides both whether a signal is worth a
  // banner and whether looking at a tab counts as reading it. `document` is the
  // authority here, and asking it saves a main→renderer channel that would only
  // ever say the same thing.
  useEffect(() => {
    const on = (): void => setWinFocused(true)
    const off = (): void => setWinFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])

  // Native macOS fullscreen removes the traffic lights entirely, so the header
  // row's reserved left padding for them would otherwise show as a dead gutter.
  useEffect(() => {
    if (!isMac) return
    void window.api.winIsFullScreen().then(setFullScreen)
    return window.api.onFullScreenChange(setFullScreen)
  }, [])

  // Looking at a leaf is the acknowledgement — there is no separate dismiss, and
  // a dot that outlived the glance that answered it would train you to ignore
  // dots. Splits clear every leaf they show, since all of them are on screen.
  useEffect(() => {
    if (!winFocused) return
    setWaiting((w) => {
      if (!shownLeaves.some((id) => w.has(id))) return w
      const next = new Set(w)
      for (const id of shownLeaves) next.delete(id)
      return next
    })
    // shownLeaves is derived per render; activeView is the thing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winFocused, activeView])

  // Drop signals whose leaf is gone, so a closed tab can't hold the dock badge lit.
  useEffect(() => {
    setWaiting((w) => {
      if (w.size === 0) return w
      const live = new Set(tabs.map((t) => t.id))
      const kept = [...w].filter((id) => live.has(id))
      return kept.length === w.size ? w : new Set(kept)
    })
  }, [tabs])

  // The badge counts sessions, not signals — five questions from one agent is
  // still one session waiting on you. Only in `notify` mode: dot-only means the
  // tab strip is the whole surface, dock included.
  useEffect(() => {
    window.api.agentBadge(appSettings.terminal.agentAlerts === 'notify' ? waiting.size : 0)
  }, [waiting, appSettings.terminal.agentAlerts])

  // A clicked notification has to land on the session that sent it, which may be
  // a pane inside a split rather than a tab of its own.
  useEffect(
    () =>
      window.api.onAgentFocus((leafId) => {
        const v = viewsRef.current.find((x) => x.panes.includes(leafId))
        if (!v) return
        setActiveViewId(v.id)
        setViews((vs) =>
          vs.map((x) => (x.id === v.id ? { ...x, focused: Math.max(0, x.panes.indexOf(leafId)) } : x))
        )
      }),
    []
  )

  // Persist the open tabs + tab-bar views whenever they change (after restore).
  useEffect(() => {
    if (!restoredRef.current) return
    const idx = (id: string | null): number => (id ? tabs.findIndex((t) => t.id === id) : -1)
    const ws: Workspace = {
      tabs: tabs.map(serializeTab),
      active: idx(activeTabId),
      views: views.map((v) => ({
        direction: v.direction,
        panes: v.panes.map((p) => (p ? idx(p) : -1)),
        sizes: v.sizes,
        focused: v.focused
      })),
      activeView: views.findIndex((v) => v.id === (activeView?.id ?? activeViewId))
    }
    const json = JSON.stringify(ws)
    if (json === lastSavedRef.current) return // status flips etc. don't change the snapshot
    lastSavedRef.current = json
    window.api.setWorkspace(ws)
  }, [tabs, views, activeViewId, activeTabId])

  const askPassword = (title: string, label: string): Promise<string | null> =>
    new Promise((resolve) => setPwRequest({ title, label, resolve }))

  // Make a connection active and focus Summary. Only one connection's tabs can
  // be open at a time, so switching connections closes every tab that belongs to
  // a different one first — with a confirm, since that can drop a live session.
  const selectConnection = (connectionId: string): void => {
    const foreign = tabs.filter((t) => 'connectionId' in t && t.connectionId !== connectionId)
    if (foreign.length) {
      const from = connections.find((c) => c.id === activeConnectionId)
      const n = foreign.length
      if (!confirm(`Switch server? This closes ${n} open tab${n === 1 ? '' : 's'}${from ? ` for ${from.name}` : ''}.`))
        return
      removeTabs(foreign.map((t) => t.id))
    }
    setActiveConnectionId(connectionId)
    showLeaf(SUMMARY_TAB_ID)
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
  // Summary is guaranteed present and first regardless of what was persisted —
  // the initial state already seeds it, so this only needs to avoid dropping it.
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
    // The last connection any restored tab belonged to — Summary needs one to
    // show, and a restored workspace only ever has tabs for a single connection.
    let restoredConnectionId: string | null = null
    const has = (id: string): boolean => built.some((b) => b.id === id)
    // Map each persisted-tab index to the live leaf id it produced, so the saved
    // tab-bar views (which reference tabs by index) can be rebuilt afterwards.
    const idForIndex = new Map<number, string>()

    for (let i = 0; i < ws.tabs.length; i++) {
      const pt = ws.tabs[i]
      const makeActive = i === ws.active

      if (pt.kind === 'summary') {
        if (!has(SUMMARY_TAB_ID)) built.push({ kind: 'summary', id: SUMMARY_TAB_ID })
        if (makeActive) activeId = SUMMARY_TAB_ID
        idForIndex.set(i, SUMMARY_TAB_ID)
        continue
      }
      if (pt.kind === 'settings') {
        if (!has(SETTINGS_TAB_ID)) built.push({ kind: 'settings', id: SETTINGS_TAB_ID })
        if (makeActive) activeId = SETTINGS_TAB_ID
        idForIndex.set(i, SETTINGS_TAB_ID)
        continue
      }

      const conn = pt.connectionId ? byId.get(pt.connectionId) : undefined
      if (!conn) continue // connection deleted -> drop the tab
      restoredConnectionId = conn.id

      if (pt.kind === 'session') {
        const pw = await getPw(conn)
        if (pw === null) continue // cancelled prompt
        const id = crypto.randomUUID()
        built.push({
          kind: 'session',
          id,
          tabKey: pt.tabKey ?? crypto.randomUUID(),
          connectionId: conn.id,
          title: pt.title ?? conn.name,
          status: { kind: 'connecting', attempt: 1, retries: appSettings.connectRetries },
          password: pw ?? undefined,
          command: pt.command,
          // Workspaces written before 0.2.4 only stored the command; recover the
          // intent from it so restored tabs reattach automatically too.
          tmux: pt.tmux ?? parseTmuxIntent(pt.command) ?? undefined
        })
        if (makeActive) activeId = id
        idForIndex.set(i, id)
      } else if (pt.kind === 'tmux') {
        const pw = await getPw(conn)
        if (pw === null) continue // cancelled prompt
        const id = crypto.randomUUID()
        built.push({
          kind: 'tmux',
          id,
          tabKey: pt.tabKey ?? crypto.randomUUID(),
          connectionId: conn.id,
          title: pt.title ?? conn.name,
          status: { kind: 'connecting', attempt: 1, retries: appSettings.connectRetries },
          password: pw ?? undefined,
          command: pt.command,
          tmux: pt.tmux ?? parseTmuxIntent(pt.command) ?? undefined
        })
        if (makeActive) activeId = id
        idForIndex.set(i, id)
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
        idForIndex.set(i, id)
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
        idForIndex.set(i, id)
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
        idForIndex.set(i, id)
      } else if (pt.kind === 'worktrees') {
        if (!pt.initialPath) continue
        const pw = await getPw(conn)
        if (pw === null) continue
        const id = `wt:${conn.id}:${pt.initialPath}`
        if (!has(id))
          built.push({
            kind: 'worktrees',
            id,
            connectionId: conn.id,
            dir: pt.initialPath,
            title:
              pt.title ?? `Worktrees · ${pt.initialPath.split('/').filter(Boolean).pop() ?? '/'}`,
            password: pw ?? undefined
          })
        if (makeActive) activeId = id
        idForIndex.set(i, id)
      }
    }

    // Summary is never optional — add it if nothing persisted one (an older
    // workspace, or a fresh install with no other tabs at all).
    if (!has(SUMMARY_TAB_ID)) built.unshift({ kind: 'summary', id: SUMMARY_TAB_ID })
    if (restoredConnectionId) setActiveConnectionId(restoredConnectionId)
    setTabs(built)

    // Rebuild the saved tab-bar views, best-effort. Each pane index maps back to
    // a live leaf id; vanished leaves drop out; a view left with one real leaf
    // collapses to an ordinary tab; every surviving leaf ends up in exactly one
    // view (any not named by a saved view gets its own single-pane view).
    const placed = new Set<string>()
    const rebuilt: View[] = []
    if (Array.isArray(ws.views)) {
      for (const pv of ws.views) {
        if (!pv || !Array.isArray(pv.panes)) continue
        const direction: SplitDirection = pv.direction === 'rows' ? 'rows' : 'columns'
        const panes = pv.panes.slice(0, 3).map((idx) => {
          const id = idx >= 0 ? idForIndex.get(idx) : undefined
          if (id && !placed.has(id)) {
            placed.add(id)
            return id
          }
          return null
        })
        const real = panes.filter((p): p is string => p !== null)
        if (real.length === 0) continue
        if (real.length === 1) {
          rebuilt.push(makeView([real[0]], direction))
          continue
        }
        const raw =
          Array.isArray(pv.sizes) && pv.sizes.length === panes.length ? pv.sizes.map((s) => (s > 0 ? s : 0)) : []
        const sum = raw.reduce((a, b) => a + b, 0)
        const sizes = sum > 0 ? raw.map((s) => s / sum) : undefined
        let focused = Math.min(Math.max(0, Math.trunc(pv.focused) || 0), panes.length - 1)
        if (!panes[focused]) {
          const f = panes.findIndex((p) => p)
          if (f >= 0) focused = f
        }
        rebuilt.push(makeView(panes, direction, sizes, focused))
      }
    }
    for (const t of built) {
      if (!placed.has(t.id)) {
        rebuilt.push(makeView([t.id]))
        placed.add(t.id)
      }
    }
    // Summary is always first, regardless of where it fell above.
    const summaryViewIdx = rebuilt.findIndex((v) => v.panes.includes(SUMMARY_TAB_ID))
    if (summaryViewIdx > 0) rebuilt.unshift(...rebuilt.splice(summaryViewIdx, 1))
    setViews(rebuilt)
    // Reselect the view that was active. Prefer the one holding the focused leaf;
    // if that pane was empty (no focused leaf saved), fall back to the saved
    // activeView by matching any of its leaves, then to the last view.
    let activeRebuilt = activeId ? rebuilt.find((v) => v.panes.includes(activeId)) : null
    if (!activeRebuilt && Array.isArray(ws.views) && typeof ws.activeView === 'number' && ws.views[ws.activeView]) {
      const wantIds = ws.views[ws.activeView].panes
        .map((idx) => (idx >= 0 ? idForIndex.get(idx) : undefined))
        .filter((id): id is string => !!id)
      activeRebuilt = rebuilt.find((v) => wantIds.some((id) => v.panes.includes(id)))
    }
    setActiveViewId((activeRebuilt ?? rebuilt[rebuilt.length - 1])?.id ?? null)
  }

  // Open a console/tmux session as a NEW tab — the dashboard tab stays open.
  // With no explicit command, a tmux-enabled connection opens straight into its
  // persistent session (create-or-attach); otherwise it's a plain login shell.
  const openSession = async (
    conn: Connection,
    opts?: { session?: string; title?: string; agent?: { dir: string } }
  ): Promise<void> => {
    const password = await resolvePassword(conn)
    if (password === null) return // user cancelled the prompt
    let { title } = opts ?? {}
    const control = !!(conn.tmux && conn.tmuxControl)
    const agentDir = opts?.agent?.dir
    // The session name, if any: an explicit one (already exactly as tmux spells it)
    // wins over the connection's own. An agent's name comes from the directory it
    // runs in, so every entry point that opens on that directory lands on one
    // session instead of forking a second agent into the same working tree.
    const session =
      opts?.session ??
      (agentDir
        ? claudeSessionName(agentDir)
        : conn.tmux
          ? tmuxSessionName(conn.tmuxSession || conn.name)
          : undefined)
    // Kept structured rather than re-sniffed from the command string later, because
    // reattaching after a drop needs an attach-*only* command built from it.
    const tmux: TmuxIntent | undefined = session
      ? { session, control, detachOthers: !!conn.tmuxDetachOthers }
      : undefined
    if (tmux) title = title ?? `${conn.name} · ${agentDir ? 'claude' : session}`
    const sessionId = crypto.randomUUID()
    const base = {
      id: sessionId,
      tabKey: crypto.randomUUID(),
      connectionId: conn.id,
      title: title ?? conn.name,
      status: { kind: 'connecting' as const, attempt: 1, retries: appSettings.connectRetries },
      password: password ?? undefined,
      command: agentDir
        ? claudeTabCommand(agentDir, conn.claudePath, conn.tmux ? tmux : undefined)
        : tmux
          ? tmuxCreateCommand(tmux)
          : undefined,
      // An agent on a non-tmux connection has no session to attach to, so it must
      // not claim one: a TmuxIntent here would send the reattach path after a drop
      // to `attach -t` a session that was never created.
      tmux: agentDir && !conn.tmux ? undefined : tmux
    }
    const tab: Tab = control ? { kind: 'tmux', ...base } : { kind: 'session', ...base }
    setTabs((t) => [...t, tab])
    showLeaf(sessionId)
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
    showLeaf(sftpId)
  }

  // Open the port-forwarding manager for a connection as a NEW tab (or focus it).
  const openTunnels = async (conn: Connection): Promise<void> => {
    const id = tunId(conn.id)
    if (tabs.some((t) => t.id === id)) {
      showLeaf(id)
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
    showLeaf(id)
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
    showLeaf(id)
  }

  /**
   * Open the worktree list for the repository containing `dir`.
   *
   * Keyed by the directory the user clicked, not by the repo root, because the
   * root is only known after the server answers — and keying on it would mean two
   * clicks in two subdirectories of one repo open two tabs before either resolves.
   */
  const openWorktrees = (connectionId: string, password: string | undefined, dir: string): void => {
    if (!dir.startsWith('/')) return
    const id = `wt:${connectionId}:${dir}`
    setTabs((t) =>
      t.some((x) => x.id === id)
        ? t
        : [
            ...t,
            {
              kind: 'worktrees',
              id,
              connectionId,
              dir,
              title: `Worktrees · ${dir.split('/').filter(Boolean).pop() ?? '/'}`,
              password
            }
          ]
    )
    showLeaf(id)
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

  // The two dashboard reads take an already-resolved password rather than each
  // resolving its own. One click on Check runs both, back to back, and a
  // connection with no saved secret used to raise the identical prompt twice for
  // the same password — which reads as "it didn't take the first one". The
  // caller resolving once also makes it structurally impossible for the two to
  // overlap, and askPassword holds exactly one slot: a second prompt raised over
  // a live one orphans the first promise for good.
  const resolvePasswordFor = (conn: Connection) => () => resolvePassword(conn)

  const fetchHookStatusFor =
    (conn: Connection) =>
    (password?: string): Promise<ClaudeHookStatus> =>
      window.api.claudeHookStatus({ connectionId: conn.id, password })

  const fetchStatusLineStatusFor =
    (conn: Connection) =>
    (password?: string): Promise<ClaudeStatusLineStatus> =>
      window.api.claudeStatusLineStatus({ connectionId: conn.id, password })

  const fetchTmuxPassthroughStatusFor =
    (conn: Connection) =>
    (password?: string): Promise<ClaudeTmuxPassthroughStatus> =>
      window.api.claudeTmuxPassthroughStatus({ connectionId: conn.id, password })

  // Install/uninstall stays self-resolving: it is a separate deliberate click,
  // and it is the only one of the three, so it cannot collide with itself.
  const applyHookFor = (conn: Connection) => async (action: 'install' | 'uninstall') => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required to write the Claude settings file.')
    return window.api.claudeHookApply({ connectionId: conn.id, password: password ?? undefined, action })
  }

  const applyStatusLineFor = (conn: Connection) => async (action: 'install' | 'uninstall') => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required to write the Claude settings file.')
    return window.api.claudeStatusLineApply({ connectionId: conn.id, password: password ?? undefined, action })
  }

  const applyTmuxPassthroughFor = (conn: Connection) => async (action: 'install' | 'uninstall') => {
    const password = await resolvePassword(conn)
    if (password === null) throw new Error('Password required to write the tmux config file.')
    return window.api.claudeTmuxPassthroughApply({ connectionId: conn.id, password: password ?? undefined, action })
  }

  // Open Claude Code in a directory, as a new tab.
  //
  // Fails closed on anything that isn't an absolute path. The file manager's cwd
  // starts empty and stays empty when the first listing throws — its catch sets
  // only `listError` while status is already 'ready' — so without this guard a
  // click there would silently start an agent in $HOME under a session name
  // hashed from '', which no later launch on any real directory would ever match.
  // `label` names the tab when several agents are open on one host at once, which
  // is the worktree pane's whole point. Without it openSession falls back to
  // `<host> · claude` for every one of them, and three agents in three worktrees
  // give three identically titled tabs with no way to tell which is which.
  const openClaude = (conn: Connection, dir: string, label?: string): boolean => {
    if (!dir.startsWith('/')) return false
    void openSession(conn, {
      agent: { dir },
      title: label ? `${conn.name} · ${label}` : undefined
    })
    return true
  }

  // Attach (or create) a tmux session in a new terminal tab. `new -A` means a
  // session that died between listing and clicking won't error — it's recreated.
  // `name` comes from the server's own session list (or the user's new-session
  // field) and is passed through verbatim: sanitizing it here would attach to the
  // wrong name for any session tmux itself allows but tmuxSessionName() rewrites.
  const attachTmux = (conn: Connection, name: string): void => {
    void openSession(conn, { session: name, title: `${conn.name} · ${name}` })
  }

  // --- agent actions ----------------------------------------------------------
  // The command palette's agent results know a connection only by id — they come
  // from the cross-host scan, not from `connections` — so this looks it up first
  // and hands off to the same helper the per-host panes use.
  const attachFromInbox = (connectionId: string, session: string): void => {
    const conn = connections.find((c) => c.id === connectionId)
    if (conn) attachTmux(conn, session)
  }

  // Launch a brand-new agent from Summary's inline form, on the active connection.
  const newAgentFromActive = (dir: string): boolean => {
    const conn = connections.find((c) => c.id === activeConnectionId)
    return conn ? openClaude(conn, dir) : false
  }

  // Kill / rename run as one-shot commands; Summary refreshes its list after.
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

  // Close one or more leaves in a single pass (atomic so back-to-back closes
  // can't clobber each other). Their panes are removed from any view, and a view
  // left with no real leaf is dropped; the active-view effect re-targets if the
  // active tab vanished.
  const removeTabs = (ids: string[]): void => {
    const dead = new Set(ids)
    for (const t of tabs)
      if (dead.has(t.id) && (t.kind === 'session' || t.kind === 'tmux')) {
        window.api.closeSession(t.id)
        void window.api.draftsSet(t.tabKey, '')
      }
    setTabs((prev) => prev.filter((t) => !dead.has(t.id)))
    setViews((vs) => {
      const out: View[] = []
      for (const v of vs) {
        if (!v.panes.some((p) => p !== null && dead.has(p))) {
          out.push(v)
          continue
        }
        const keep = v.panes.map((p, i) => ({ p, i })).filter(({ p }) => !(p !== null && dead.has(p)))
        const panes = keep.map(({ p }) => p)
        if (!panes.some((p) => p !== null)) continue // view emptied -> drop it
        const keptSizes = keep.map(({ i }) => v.sizes[i] ?? 0)
        const sum = keptSizes.reduce((a, b) => a + (b > 0 ? b : 0), 0)
        const sizes = sum > 0 ? keptSizes.map((s) => (s > 0 ? s : 0) / sum) : panes.map(() => 1 / panes.length)
        // shift focus left for each removed pane that sat before it, so the focused
        // leaf stays focused instead of the index sliding onto a sibling
        const removedBefore = v.panes.filter((p, i) => i < v.focused && p !== null && dead.has(p)).length
        const focused = Math.max(0, Math.min(v.focused - removedBefore, panes.length - 1))
        out.push({ ...v, panes, sizes, focused })
      }
      return out
    })
  }

  // Close a whole tab from the bar: for a split that means closing all its leaves.
  const closeView = (viewId: string): void => {
    const idx = views.findIndex((v) => v.id === viewId)
    const v = views[idx]
    if (!v) return
    if ((activeView?.id ?? activeViewId) === viewId) {
      const neighbour = views[idx - 1] ?? views[idx + 1] ?? null
      setActiveViewId(neighbour?.id ?? null)
    }
    const leaves = v.panes.filter((p): p is string => !!p)
    if (leaves.length) removeTabs(leaves)
    else setViews((vs) => vs.filter((x) => x.id !== viewId))
  }

  // Reorder tabs by dropping the dragged view onto another. The views-change
  // effect persists the new order to the workspace automatically.
  const moveView = (fromId: string, toId: string): void => {
    if (fromId === toId) return
    setViews((vs) => {
      const from = vs.findIndex((v) => v.id === fromId)
      const to = vs.findIndex((v) => v.id === toId)
      if (from < 0 || to < 0) return vs
      const next = vs.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const onStatus = (sessionId: string, status: SessionStatus): void => {
    setTabs((t) =>
      t.map((x) =>
        (x.kind === 'session' || x.kind === 'tmux') && x.id === sessionId ? { ...x, status } : x
      )
    )
  }

  // A program in a session asked for a human (see lib/xtermAgentSignal).
  //
  // Each terminal's mount-once effect captures this callback, so everything it
  // reads comes from a ref — the render closure it was born in is long stale by
  // the time an agent actually rings.
  const onAgentSignal = (sessionId: string, signal: AgentSignal, onScreen = true): void => {
    const { alerts, visible } = attnRef.current
    if (alerts === 'off') return
    // A signal from the pane already in front of you isn't attention, it's noise
    // — you are, definitionally, already looking. `onScreen` is how a tmux
    // control tab says otherwise: its leaf can be showing while the pane that
    // rang sits in a tmux window you can't see.
    const seen = onScreen && visible.has(sessionId) && document.hasFocus()
    if (!seen) setWaiting((w) => (w.has(sessionId) ? w : new Set(w).add(sessionId)))
    // Only a sequence that carried text raises an OS notification. A bare bell
    // says *something* happened and nothing more, and shells ring for tab
    // completion — a banner reading "Claude Code" over that would be a lie.
    if (alerts === 'notify' && signal.kind === 'message' && !document.hasFocus()) {
      window.api.agentNotify(sessionId, signal.title, signal.body)
    }
  }

  // A shell re-sets its title on every prompt, so bail out on an unchanged one:
  // returning the same array lets React skip the render entirely.
  const onTitle = (sessionId: string, title: string): void => {
    const next = title || undefined
    setTabs((t) => {
      const cur = t.find((x) => x.id === sessionId)
      if (!cur || cur.kind !== 'session' || cur.liveTitle === next) return t
      return t.map((x) => (x.id === sessionId ? { ...x, liveTitle: next } : x))
    })
  }

  const saveConnection = async (draft: ConnectionDraft): Promise<void> => {
    await window.api.upsertConnection(draft)
    setDialogConn(undefined)
    await refresh()
  }

  const deleteConnection = async (conn: Connection): Promise<void> => {
    if (!confirm(`Delete connection “${conn.name}”?`)) return
    await window.api.removeConnection(conn.id)
    removeTabs(tabs.filter((t) => 'connectionId' in t && t.connectionId === conn.id).map((t) => t.id))
    if (activeConnectionId === conn.id) setActiveConnectionId(null)
    await refresh()
  }

  const sessionTabs = tabs.filter((t): t is SessionTab => t.kind === 'session')
  const controlTabs = tabs.filter((t): t is ControlTab => t.kind === 'tmux')
  const activeConnection = connections.find((c) => c.id === activeConnectionId) ?? null

  const activeIsPane = activeTab?.kind === 'session' || activeTab?.kind === 'tmux'
  const toggleActiveComposer = useCallback(() => {
    if (activeTabId) composerRefs.current.get(activeTabId)?.toggleComposer()
  }, [activeTabId])
  const activeComposerOpen = !!(activeTabId && composerOpen[activeTabId])

  return (
    <div className="flex h-full w-full flex-col">
      <div className="app-canvas flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Merged title/tab-bar row. `drag` on the root plus `no-drag` on every
            interactive cluster mirrors how Chrome's own tab strip stays
            draggable everywhere except its buttons and pills. */}
        <div
          className={`drag relative z-30 flex h-10 shrink-0 items-stretch gap-1 border-b border-line bg-surface/60 px-2 ${
            // leave room for the native traffic lights on macOS — they vanish
            // in true fullscreen, so the reserved gutter would go dead too
            isMac && !fullScreen ? 'pl-[78px]' : 'pl-2.5'
          }`}
        >
          {/* brand mark + menus — macOS gets a real menu bar (menu.ts) and native
              traffic lights instead; rendering both would give every command two
              homes and no reason to prefer either */}
          {!isMac && (
            <div className="no-drag flex shrink-0 items-center gap-2 self-center pr-1">
              <span className="h-2 w-2 rounded-full bg-accent dot-glow text-accent" />
              <MenuBar onNewConnection={() => setDialogConn(null)} />
            </div>
          )}

          {/* tab pills — pt-1.5 here (not the row root) so they read as "poking
              up" from the row's bottom border without pushing every other
              cluster down */}
          <div className="no-drag flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto pt-1.5">
            {views.map((view) => {
                const active = view.id === activeViewId
                const split = view.panes.length > 1
                const leaves = view.panes.map((p) => (p ? tabs.find((t) => t.id === p) ?? null : null))
                const waitingLeaves = leaves.filter((l): l is Tab => !!l && waiting.has(l.id))
                const label = split
                  ? leaves.map((l) => (l ? leafLabel(l) : '+')).join(view.direction === 'columns' ? ' │ ' : ' ─ ')
                  : leaves[0]
                    ? leafLabel(leaves[0])
                    : 'Tab'
                return (
                  <div
                    key={view.id}
                    draggable
                    onClick={() => setActiveViewId(view.id)}
                    onDragStart={(e) => {
                      dragViewId.current = view.id
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', view.id)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragViewId.current && dragViewId.current !== view.id) setDragOverId(view.id)
                    }}
                    onDragLeave={() => setDragOverId((id) => (id === view.id ? null : id))}
                    onDrop={(e) => {
                      e.preventDefault()
                      const from = dragViewId.current
                      if (from) moveView(from, view.id)
                      dragViewId.current = null
                      setDragOverId(null)
                    }}
                    onDragEnd={() => {
                      dragViewId.current = null
                      setDragOverId(null)
                    }}
                    className={`group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-3 text-sm transition-colors ${
                      dragOverId === view.id ? 'ring-2 ring-inset ring-accent/70' : ''
                    } ${
                      active
                        ? 'border-line bg-ink text-fg'
                        : 'border-transparent text-muted hover:bg-elevated/40 hover:text-fg/90'
                    }`}
                  >
                    {split ? (
                      <span className={active ? 'text-accent' : 'text-faint'} title="split tab">
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
                          {view.direction === 'columns' ? (
                            <line x1="7" y1="2.5" x2="7" y2="11.5" />
                          ) : (
                            <line x1="1.5" y1="7" x2="12.5" y2="7" />
                          )}
                        </svg>
                      </span>
                    ) : leaves[0] ? (
                      leafIcon(leaves[0], active)
                    ) : null}
                    {/* One dot per leaf of this tab that's waiting on you. In a
                        split they read left to right in the same order as the
                        joined label, so the dot and the name line up. */}
                    {waitingLeaves.length > 0 && (
                      <span
                        className="flex items-center gap-1"
                        title={`Waiting: ${waitingLeaves.map(leafLabel).join(', ')}`}
                      >
                        {waitingLeaves.map((l) => (
                          <span
                            key={l.id}
                            className="dot-glow h-1.5 w-1.5 shrink-0 rounded-full bg-amber text-amber"
                          />
                        ))}
                      </span>
                    )}
                    <span className="max-w-[260px] truncate font-mono text-[12px]">{label}</span>
                    {!(view.panes.length === 1 && view.panes[0] === SUMMARY_TAB_ID) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          closeView(view.id)
                        }}
                        className="text-faint opacity-60 transition-opacity hover:text-fg group-hover:opacity-100"
                        title={split ? 'Close split (all its panes)' : 'Close tab'}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
          </div>
          {/* split-screen controls, composer toggle, and settings — one
              cluster of fixed-height header actions */}
          <div className="no-drag flex shrink-0 items-center gap-1 self-center border-l border-line pl-2">
            <SplitControls
              count={activeView?.panes.length ?? 1}
              direction={activeView?.direction ?? 'columns'}
              onSingle={ungroup}
              onSplit={applySplit}
            />
            <button
              onClick={toggleActiveComposer}
              disabled={!activeIsPane}
              title={`Toggle prompt composer (${COMPOSE_ACCEL})`}
              className={`grid h-7 w-7 place-items-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-30 ${
                activeComposerOpen
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-transparent text-muted hover:bg-elevated hover:text-fg'
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </button>
            <button
              onClick={openSettings}
              title="Settings (Ctrl+,)"
              className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>

          {/* window controls — macOS supplies native traffic lights instead */}
          {!isMac && (
            <div className="no-drag flex h-full items-stretch">
              <WindowControls />
            </div>
          )}
        </div>

        {/* main content */}
        <div ref={contentRef} className="relative min-h-0 flex-1">
          {/* Summary stays mounted so vitals don't re-fetch on every tab switch;
              it's always present, so this needs no `tabs.some(...)` guard. */}
          <div className={`overflow-hidden ${paneRing(SUMMARY_TAB_ID)}`} {...paneProps(SUMMARY_TAB_ID)}>
            <SummaryView
              connection={activeConnection}
              hasConnections={connections.length > 0}
              onOpenSettings={openSettings}
              openSessions={
                activeConnection
                  ? sessionTabs.filter((t) => t.connectionId === activeConnection.id).length
                  : 0
              }
              onOpenTerminal={() => activeConnection && void openSession(activeConnection)}
              onOpenFiles={() => activeConnection && void openSftp(activeConnection)}
              onOpenTunnels={() => activeConnection && void openTunnels(activeConnection)}
              onEdit={() => activeConnection && setDialogConn(activeConnection)}
              fetchTmux={activeConnection ? fetchTmuxFor(activeConnection) : async () => []}
              fetchStats={
                activeConnection
                  ? fetchStatsFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              onAttach={(name) => activeConnection && attachTmux(activeConnection, name)}
              // A name the user just typed, unlike onAttach's, has never been
              // through tmux. Normalise it here so the tab records the name
              // tmux will actually use — `.` and `:` split tmux's target
              // syntax, so a session called "api.v2" could never be reattached.
              onNewSession={(name) =>
                activeConnection && attachTmux(activeConnection, tmuxSessionName(name))
              }
              onKillSession={activeConnection ? killTmux(activeConnection) : async () => {}}
              onRenameSession={activeConnection ? renameTmux(activeConnection) : async () => {}}
              resolvePassword={
                activeConnection ? resolvePasswordFor(activeConnection) : async () => null
              }
              fetchHookStatus={
                activeConnection
                  ? fetchHookStatusFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              applyHook={
                activeConnection
                  ? applyHookFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              fetchStatusLineStatus={
                activeConnection
                  ? fetchStatusLineStatusFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              applyStatusLine={
                activeConnection
                  ? applyStatusLineFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              fetchTmuxPassthroughStatus={
                activeConnection
                  ? fetchTmuxPassthroughStatusFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              applyTmuxPassthrough={
                activeConnection
                  ? applyTmuxPassthroughFor(activeConnection)
                  : async () => {
                      throw new Error('No active connection')
                    }
              }
              agentHosts={agentHosts}
              agentScanError={agentScanError}
              agentScanning={agentScanning}
              rescanAgents={rescanAgents}
              onNewAgent={newAgentFromActive}
            />
            {paneTools(SUMMARY_TAB_ID)}
          </div>

          {/* settings stays mounted so it can share a split pane like any tab */}
          {tabs.some((t) => t.kind === 'settings') && (
            <div className={`overflow-hidden ${paneRing(SETTINGS_TAB_ID)}`} {...paneProps(SETTINGS_TAB_ID)}>
              <SettingsPage
                settings={appSettings}
                onChange={updateSettings}
                onReset={resetSettings}
                connections={connections}
                activeConnectionId={activeConnectionId}
                onSelectConnection={selectConnection}
                onAddConnection={() => setDialogConn(null)}
                onEditConnection={(c) => setDialogConn(c)}
                onDeleteConnection={deleteConnection}
              />
              {paneTools(SETTINGS_TAB_ID)}
            </div>
          )}

          {/* terminals stay mounted so sessions persist; only shown ones are visible.
              Padding is colored to match xterm's own background (not the app's
              `bg-ink`), so the frame around the terminal reads as one continuous
              surface instead of a mismatched border. */}
          {sessionTabs.map((tab) => {
            const pp = paneProps(tab.id)
            return (
              <div
                key={tab.id}
                className={`overflow-hidden border-t border-line p-3 ${paneRing(tab.id)}`}
                {...pp}
                style={{ ...pp.style, backgroundColor: TERMINAL_BG }}
              >
                <TerminalView
                  ref={setComposerRef(tab.id)}
                  sessionId={tab.id}
                  connectionId={tab.connectionId}
                  active={activeTabId === tab.id}
                  password={tab.password}
                  command={tab.command}
                  tmux={tab.tmux}
                  retries={appSettings.connectRetries}
                  settings={appSettings.terminal}
                  onStatus={onStatus}
                  onTitle={onTitle}
                  onAgentSignal={onAgentSignal}
                  draftKey={tab.tabKey}
                  initialDraft={drafts[tab.tabKey] ?? ''}
                />
                {paneTools(tab.id)}
              </div>
            )
          })}

          {/* tmux control-mode sessions stay mounted so pane content persists */}
          {controlTabs.map((tab) => (
            <div
              key={tab.id}
              className={`overflow-hidden border-t border-line bg-ink ${paneRing(tab.id)}`}
              {...paneProps(tab.id)}
            >
              <TmuxControlView
                ref={setComposerRef(tab.id)}
                sessionId={tab.id}
                connectionId={tab.connectionId}
                active={activeTabId === tab.id}
                onScreen={onScreen(tab.id)}
                password={tab.password}
                command={tab.command}
                tmux={tab.tmux}
                retries={appSettings.connectRetries}
                settings={appSettings.terminal}
                onStatus={onStatus}
                onAgentSignal={onAgentSignal}
                draftKey={tab.tabKey}
                initialDrafts={parseTmuxDrafts(drafts[tab.tabKey])}
              />
              {paneTools(tab.id)}
            </div>
          ))}

          {/* file managers stay mounted so the SFTP channel + transfers persist */}
          {tabs
            .filter((t): t is SftpTab => t.kind === 'sftp')
            .map((tab) => (
              <div
                key={tab.id}
                className={`overflow-hidden border-t border-line ${paneRing(tab.id)}`}
                {...paneProps(tab.id)}
              >
                <FileManager
                  connectionId={tab.connectionId}
                  password={tab.password}
                  initialPath={tab.initialPath}
                  active={onScreen(tab.id)}
                  onOpenFile={(path, name) => openFile(tab.connectionId, tab.password, path, name)}
                  onCwdChange={(path) => {
                    rememberSftpPath(tab.connectionId, path)
                    updateSftpTabPath(tab.id, path)
                  }}
                  onOpenClaude={(dir) => {
                    const conn = connections.find((c) => c.id === tab.connectionId)
                    if (conn) openClaude(conn, dir)
                  }}
                  onOpenWorktrees={(dir) => openWorktrees(tab.connectionId, tab.password, dir)}
                />
                {paneTools(tab.id)}
              </div>
            ))}

          {/* editor tabs stay mounted so unsaved edits survive tab switches */}
          {tabs
            .filter((t): t is EditorTab => t.kind === 'editor')
            .map((tab) => (
              <div
                key={tab.id}
                className={`overflow-hidden border-t border-line ${paneRing(tab.id)}`}
                {...paneProps(tab.id)}
              >
                <EditorView
                  connectionId={tab.connectionId}
                  password={tab.password}
                  path={tab.path}
                  name={tab.name}
                  active={activeTabId === tab.id}
                  settings={appSettings.editor}
                />
                {paneTools(tab.id)}
              </div>
            ))}

          {/* worktree panes stay mounted so a half-filled create form survives a
              tab switch — and so the list doesn't re-read on every glance */}
          {tabs
            .filter((t): t is WorktreeTab => t.kind === 'worktrees')
            .map((tab) => (
              <div
                key={tab.id}
                className={`overflow-hidden border-t border-line ${paneRing(tab.id)}`}
                {...paneProps(tab.id)}
              >
                <WorktreeView
                  connectionId={tab.connectionId}
                  password={tab.password}
                  dir={tab.dir}
                  active={onScreen(tab.id)}
                  onOpenClaude={(wt) => {
                    const conn = connections.find((c) => c.id === tab.connectionId)
                    // Labelled with the worktree's own folder, since opening
                    // several of these at once is what this pane is for.
                    if (conn) openClaude(conn, wt, `claude · ${wt.split('/').pop() || wt}`)
                  }}
                />
                {paneTools(tab.id)}
              </div>
            ))}

          {/* tunnel managers stay mounted so live tunnel state survives tab switches */}
          {tabs
            .filter((t): t is TunnelTab => t.kind === 'tunnels')
            .map((tab) => (
              <div
                key={tab.id}
                className={`overflow-hidden border-t border-line ${paneRing(tab.id)}`}
                {...paneProps(tab.id)}
              >
                <TunnelManager
                  connectionId={tab.connectionId}
                  connectionName={nameOf(tab.connectionId)}
                  password={tab.password}
                  active={onScreen(tab.id)}
                />
                {paneTools(tab.id)}
              </div>
            ))}

          {/* empty split panes: pick a tab to join here */}
          {isSplit &&
            activeView &&
            activeView.panes.map((pid, i) =>
              pid !== null ? null : (
                <div
                  key={`empty-${activeView.id}-${i}`}
                  onMouseDown={() => focusPane(i)}
                  className={`absolute overflow-hidden ${
                    i === activeView.focused ? 'ring-2 ring-inset ring-accent/60' : 'ring-1 ring-inset ring-line/70'
                  }`}
                  style={{ position: 'absolute', visibility: 'visible', ...paneRect(i) }}
                >
                  <PanePicker
                    options={tabs
                      .filter((t) => !activeView.panes.includes(t.id))
                      .map((t) => ({ id: t.id, label: leafLabel(t) }))}
                    onPick={(leafId) => fillPane(activeView.id, i, leafId)}
                    onClose={() => closePaneLeaf(activeView.id, i)}
                  />
                </div>
              )
            )}

          {isSplit && activeView && (
            <PaneDividers
              direction={activeView.direction}
              sizes={activeView.sizes}
              containerRef={contentRef}
              onResize={(sizes) =>
                setViews((vs) => vs.map((v) => (v.id === activeView.id ? { ...v, sizes } : v)))
              }
            />
          )}
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

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        connections={connections}
        tabs={tabs}
        leafLabel={leafLabel}
        leafIcon={leafIcon}
        agentHosts={agentHosts}
        selectConnection={selectConnection}
        showLeaf={showLeaf}
        attachFromInbox={attachFromInbox}
        openSummary={openSummary}
      />
    </div>
  )
}
