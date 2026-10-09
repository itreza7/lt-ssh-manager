import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { ChatSession } from '../../../shared/chatProtocol'
import type { AgentHostScan, Connection, SplitDirection, TmuxSession } from '../../../shared/types'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'
import { isMac } from '../lib/platform'
import { CHATS_CHANGED, chatStatusOf, leaf, statusLabel } from './chat/format'
import { Spinner } from './chat/Blocks'
import { MenuItem, PromptDialog } from './Modal'
import { STATUS_LABEL } from './SummaryView'

/** One entry of the "Open" list — a view (a tab, or a split that is itself a tab). */
export interface SidebarOpenRow {
  id: string
  active: boolean
  split: boolean
  direction: SplitDirection
  label: string
  /** The single-pane icon (unused for a split, which gets the split glyph). */
  icon: ReactNode
  /** One entry per leaf of this view that is waiting on you. */
  waiting: { id: string; label: string }[]
  closable: boolean
  /** Set when the view is one chat tab: its row is the chat's own, under its folder. */
  chatSessionId?: string
  /** The ids that chat tab had before /clear or /resume moved it. */
  chatFormerIds?: string[]
  /** Set when the view is one terminal on a tmux session: its row is the session's own. */
  tmuxSession?: string
  /** Summary and Settings: not listed, their icons at the bottom light up instead. */
  special?: 'summary' | 'settings'
}

interface Props {
  connections: Connection[]
  activeConnection: Connection | null
  onSelectConnection: (id: string) => void
  onNewChat: () => void
  /** Start a new chat in this folder (a group's + button). */
  onNewChatIn: (cwd: string) => void
  onOpenSummary: () => void

  openRows: SidebarOpenRow[]
  onSelectView: (id: string) => void
  onCloseView: (id: string) => void
  onMoveView: (fromId: string, toId: string) => void

  /** Quiet reads: they never raise a password prompt, and may resolve to []. */
  fetchChats: () => Promise<ChatSession[]>
  fetchTmux: () => Promise<TmuxSession[]>
  /** Session id of the chat tab on screen, if one is. */
  activeChatSessionId: string | null
  /** tmux session name of the terminal tab on screen, if it is on a tmux session. */
  activeTmuxName: string | null
  onOpenChat: (chat: ChatSession) => void
  onOpenTmux: (name: string) => void
  /** Create (and open) a tmux session; a name the user typed. */
  onNewTmux: (name: string) => void
  onRenameTmux: (from: string, to: string) => Promise<void>
  onKillTmux: (name: string) => Promise<void>
  agentHosts: AgentHostScan[] | null

  onOpenSettings: () => void

  fullScreen: boolean
  /** The split-screen buttons, at the right of the top row (stacked in the rail). */
  splitControls: ReactNode
  /** Tells the app shell whether the sidebar is collapsed, so the top bar can clear the traffic lights. */
  onCollapsedChange?: (collapsed: boolean) => void
}

/** One row of the right-click menu. */
interface MenuEntry {
  label: string
  run: () => void
  danger?: boolean
}

const COLLAPSED_KEY = 'sidebar.collapsed'
const POLL_MS = 10000
// How long a chat that left the list is still treated as live (see `live`).
const MOVE_GRACE_MS = 15000

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    /* private window / blocked storage — the sidebar just won't be remembered */
  }
}

const FOLDED_KEY = 'sidebar.foldedGroups'

/** The folder groups folded in the sidebar, by repo path; remembered across restarts. */
function readFolded(): ReadonlySet<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeFolded(v: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...v]))
  } catch {
    /* private window / blocked storage — the folds just won't be remembered */
  }
}

const SEEN_KEY = 'sidebar.chatSeen'
/** A seen mark older than this is dropped: its chat is long gone. */
const SEEN_TTL_MS = 14 * 24 * 3600_000

/**
 * Per chat, the newest status-file time (`updatedAt`, the server's clock) you have
 * seen: a later one is news. Remembered across restarts.
 */
function readSeen(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    if (!v || typeof v !== 'object') return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    return {}
  }
}

function writeSeen(v: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v))
  } catch {
    /* private window / blocked storage — news is just not remembered */
  }
}

/**
 * A list kept fresh in the background: on mount, every POLL_MS while the window is
 * visible, and on focus. `key` names what is being listed (the connection) — a new
 * key drops the old list so another host's rows never show under this one. A failed
 * read keeps the last list, since a blip should not blank the sidebar, and pauses the
 * timer until the next focus: a declined host key or a refused login is not retried
 * (and re-prompted, or re-dialed) every 10 s behind the user's back.
 */
function usePolled<T>(fetcher: () => Promise<T[]>, key: string | null): T[] {
  const [list, setList] = useState<T[]>([])
  // Callers pass a fresh closure every render; the effect must not restart on it.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    setList([])
    if (!key) return
    let dead = false
    let busy = false
    let failed = false
    const run = async (wake: boolean): Promise<void> => {
      if (busy || document.visibilityState !== 'visible' || (failed && !wake)) return
      busy = true
      try {
        const next = await fetcherRef.current()
        failed = false
        if (!dead) setList(next)
      } catch {
        /* keep the last list */
        failed = true
      } finally {
        busy = false
      }
    }
    void run(true)
    const timer = setInterval(() => void run(false), POLL_MS)
    const onWake = (): void => void run(true)
    window.addEventListener('focus', onWake)
    window.addEventListener(CHATS_CHANGED, onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      dead = true
      clearInterval(timer)
      window.removeEventListener('focus', onWake)
      window.removeEventListener(CHATS_CHANGED, onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [key])

  return list
}

interface ChatGroup {
  /** Repo path — the group's key, its header tooltip, and where its + starts a chat. */
  repo: string
  /** `wt` is the worktree name when the chat runs in `<repo>/.claude/worktrees/<wt>`; `label` is what the row says (chatLabels). */
  rows: { chat: ChatSession; wt: string | null; label: string }[]
}

/**
 * Chats by repo folder. A session in `<repo>/.claude/worktrees/<name>` belongs to
 * `<repo>` and carries the worktree name; any other cwd is its own repo.
 * (The same pattern as chatLabel in chat/format.ts.)
 */
function groupChats(chats: ChatSession[]): ChatGroup[] {
  const byRepo = new Map<string, ChatGroup>()
  for (const chat of chats) {
    const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)/.exec(chat.cwd)
    const repo = wt ? wt[1] : chat.cwd
    let g = byRepo.get(repo)
    if (!g) byRepo.set(repo, (g = { repo, rows: [] }))
    g.rows.push({ chat, wt: wt ? wt[2] : null, label: '' })
  }
  const cmp = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  const groups = [...byRepo.values()].sort((a, b) => cmp(leaf(a.repo), leaf(b.repo)))
  for (const g of groups) {
    chatLabels(g)
    g.rows.sort((a, b) => cmp(a.label, b.label))
  }
  return groups
}

/**
 * What each row of a group says: its worktree; else (no worktree, or one shared with
 * another row) its tmux session; else Claude's title, else the folder. A name still
 * shared gets the start of the session id.
 */
function chatLabels(g: ChatGroup): void {
  const count = (names: (string | null)[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const n of names) if (n) m.set(n, (m.get(n) ?? 0) + 1)
    return m
  }
  const wts = count(g.rows.map((r) => r.wt))
  for (const r of g.rows) {
    r.label = r.wt && wts.get(r.wt) === 1 ? r.wt : r.chat.tmux?.session || r.chat.name || leaf(r.chat.cwd)
  }
  const labels = count(g.rows.map((r) => r.label))
  for (const r of g.rows) if ((labels.get(r.label) ?? 0) > 1) r.label = `${r.label} · ${r.chat.sessionId.slice(0, 4)}`
}

/** Two letters for the server badge: first letters of its first two words, else its first two characters. */
function initials(name: string | undefined): string {
  const words = (name ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return '–'
  const out = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return out.toUpperCase()
}

// A row is a 16px leading slot (icon or dot) then text, on a 28px line, like Claude's.
const rowCls = (active: boolean): string =>
  `group flex h-7 w-full min-w-0 items-center gap-2 rounded-lg pl-2.5 pr-2 text-left text-[13px] leading-5 transition-colors ${
    active ? 'bg-sel text-fg' : 'text-muted hover:bg-elevated'
  }`

const Slot = ({ children }: { children?: ReactNode }) => (
  <span className="grid h-4 w-4 shrink-0 place-items-center">{children}</span>
)

/** A row's mark: a spinner while it works (an older ring is stale by then), amber when it
 *  has news for you (a decision, or a finished turn), else nothing. */
const RowMark = ({ news, busy }: { news: boolean; busy: boolean }) =>
  busy ? (
    <Spinner className="text-faint" />
  ) : news ? (
    <span className="h-2 w-2 shrink-0 rounded-full bg-amber dot-glow" />
  ) : null

const Icon = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

const PlusIcon = () => (
  <Icon>
    <path d="M5 12h14M12 5v14" />
  </Icon>
)
const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
)
const SummaryIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
)
const ChevronRight = () => (
  <Icon size={13}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)
const ChevronDown = () => (
  <Icon size={14}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)
const CloseIcon = () => (
  <Icon size={14}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)
const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
)
/** Panel glyph for the collapse / expand button. */
const PanelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </Icon>
)

// Ghost icon button: muted glyph, #262626 on hover, radius 6.
const iconBtn = (active = false): string =>
  `grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30 ${
    active ? 'bg-elevated text-accent' : 'text-muted hover:bg-elevated hover:text-fg'
  }`

/** A group's header: "folder ›" (click folds it) with a + on the right. */
function GroupHeader({
  title,
  tooltip,
  open,
  onToggle,
  onAdd,
  addTitle,
  onMenu
}: {
  title: string
  tooltip?: string
  open: boolean
  onToggle: () => void
  onAdd?: () => void
  addTitle?: string
  onMenu?: (e: ReactMouseEvent) => void
}) {
  return (
    <div onContextMenu={onMenu} className="flex h-7 items-center pl-[9px] pr-1 text-[13px] text-faint">
      <button
        onClick={onToggle}
        title={tooltip}
        className="flex min-w-0 items-center gap-1 text-left transition-colors hover:text-muted"
      >
        <span className="truncate">{title}</span>
        {!open && (
          <span className="shrink-0">
            <ChevronRight />
          </span>
        )}
      </button>
      <span className="flex-1" />
      {onAdd && (
        <button
          onClick={onAdd}
          title={addTitle}
          aria-label={addTitle}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-elevated hover:text-fg"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  )
}

export function Sidebar({
  connections,
  activeConnection,
  onSelectConnection,
  onNewChat,
  onNewChatIn,
  onOpenSummary,
  openRows,
  onSelectView,
  onCloseView,
  onMoveView,
  fetchChats,
  fetchTmux,
  activeChatSessionId,
  activeTmuxName,
  onOpenChat,
  onOpenTmux,
  onNewTmux,
  onRenameTmux,
  onKillTmux,
  agentHosts,
  onOpenSettings,
  fullScreen,
  splitControls,
  onCollapsedChange
}: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [serverOpen, setServerOpen] = useState(false)
  const [sections, setSections] = useState({ open: true, tmux: true })
  const toggleSection = (k: keyof typeof sections): void => setSections((s) => ({ ...s, [k]: !s[k] }))
  // Folded chat groups, by repo path, remembered. Open is the default, so a new folder is never hidden.
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(readFolded)
  const toggleGroup = (repo: string): void =>
    setFoldedGroups((s) => {
      const next = new Set(s)
      if (!next.delete(repo)) next.add(repo)
      writeFolded(next)
      return next
    })
  const [query, setQuery] = useState('')
  const serverRef = useRef<HTMLDivElement>(null)

  // The right-click menu (null entries are separators), and the name it may ask for.
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuEntry | null)[] } | null>(null)
  const [ask, setAsk] = useState<{ title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void } | null>(null)
  const openMenu = (e: ReactMouseEvent, items: (MenuEntry | null)[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // tmux changes: both lists are read again at once (they listen for CHATS_CHANGED).
  const tmuxAction = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      window.dispatchEvent(new Event(CHATS_CHANGED))
    }
  }
  const renameTmux = (name: string): void =>
    setAsk({
      title: 'Rename tmux session',
      label: 'New name',
      initial: name,
      confirmLabel: 'Rename',
      run: (to) => to !== name && void tmuxAction(() => onRenameTmux(name, to))
    })
  const killTmux = (name: string, claude: boolean): void => {
    const what = claude ? 'The Claude running in it stops too.' : 'Running programs are terminated.'
    if (confirm(`Kill tmux session “${name}”? ${what}`)) void tmuxAction(() => onKillTmux(name))
  }
  const newTmux = (): void =>
    setAsk({ title: 'New tmux session', label: 'Session name', initial: 'main', confirmLabel: 'Create', run: (name) => {
        onNewTmux(name)
        // The session exists once its tab has dialed in.
        setTimeout(() => window.dispatchEvent(new Event(CHATS_CHANGED)), 1500)
      }
    })
  const copy = (text: string): void => void navigator.clipboard.writeText(text).catch(() => {})

  // Tab drag-to-reorder state (operates on views).
  const dragViewId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const setCollapsedPersist = (v: boolean): void => {
    setCollapsed(v)
    writeCollapsed(v)
  }

  useEffect(() => onCollapsedChange?.(collapsed), [collapsed, onCollapsedChange])

  // ⌘B on macOS. Elsewhere Ctrl+B is tmux's prefix and has to reach the terminal,
  // so the chord takes Shift like the app's other non-mac chords (find).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'b' || e.altKey) return
      const hit = isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      setCollapsed((c) => {
        writeCollapsed(!c)
        return !c
      })
    }
    // Capture, so a focused terminal can't swallow it first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Server popover: close on an outside press or Escape.
  useEffect(() => {
    if (!serverOpen) return
    const onDown = (e: MouseEvent): void => {
      if (serverRef.current && !serverRef.current.contains(e.target as Node)) setServerOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setServerOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [serverOpen])

  const connKey = activeConnection?.id ?? null
  const chats = usePolled(fetchChats, connKey)
  const tmux = usePolled(fetchTmux, connKey)

  // The search box filters all three lists by substring, case-insensitively.
  const needle = query.trim().toLowerCase()
  const searching = needle !== ''
  const hit = (...parts: (string | undefined)[]): boolean =>
    !searching || parts.some((p) => !!p && p.toLowerCase().includes(needle))

  const groups = useMemo(() => {
    const all = groupChats(chats)
    if (!needle) return all
    return all
      .map((g) => ({
        ...g,
        rows: g.rows.filter(({ chat, label }) =>
          [label, chat.name ?? '', chat.cwd].some((p) => p.toLowerCase().includes(needle))
        )
      }))
      .filter((g) => g.rows.length > 0)
  }, [chats, needle])
  // Summary and Settings are icons at the bottom, which light up instead of a row.
  const summaryActive = openRows.some((r) => r.special === 'summary' && r.active)
  const settingsActive = openRows.some((r) => r.special === 'settings' && r.active)
  // A live chat's tab is already its row under the folder, and a tmux terminal its row
  // under tmux, so only the rest are listed.
  // A chat that was live a moment ago is moving to a new session id (/clear, /resume):
  // its tab learns the new id a little after this list does, so it is not listed meanwhile.
  const seenAt = useRef(new Map<string, number>())
  const now = Date.now()
  for (const c of chats) seenAt.current.set(c.sessionId, now)
  const live = new Set([...seenAt.current].filter(([, at]) => now - at < MOVE_GRACE_MS).map(([id]) => id))
  const liveTmux = new Set(tmux.map((s) => s.name))
  // Chats whose open tab has news you haven't seen.
  const idsOf = (r: SidebarOpenRow): string[] => (r.chatSessionId ? [r.chatSessionId, ...(r.chatFormerIds ?? [])] : [])
  const unread = new Set(openRows.filter((r) => r.waiting.length > 0).flatMap(idsOf))
  // The open tab's row may still carry an id it has moved away from.
  const activeIds = new Set(openRows.filter((r) => r.active).flatMap(idsOf))
  const shownOpenRows = openRows.filter(
    (r) =>
      !r.special &&
      !idsOf(r).some((id) => live.has(id)) &&
      !(r.tmuxSession && liveTmux.has(r.tmuxSession)) &&
      hit(r.label)
  )
  // A tmux session running a Claude is that chat's row (with its Chat / Terminal
  // switch), so the tmux list keeps only the plain ones.
  const claudeTmux = new Set(chats.flatMap((c) => (c.tmux ? [c.tmux.session] : [])))
  const shownTmux = tmux.filter((s) => !claudeTmux.has(s.name) && hit(s.name))
  const nothingFound = searching && groups.length === 0 && shownOpenRows.length === 0 && shownTmux.length === 0

  // This host's slice of the live-agent sweep, keyed by session name — the same
  // mapping SummaryView uses for its tmux rows.
  const agentStatusByName = useMemo(() => {
    const m = new Map<string, AgentStatus>()
    if (!activeConnection) return m
    const host = (agentHosts ?? []).find((h) => h.connectionId === activeConnection.id)
    for (const s of host?.sessions ?? []) m.set(s.session, agentStatus(s))
    return m
  }, [agentHosts, activeConnection])

  // News: a dot on a row only for what needs you — a decision, or a turn that ended —
  // since you last had it in front of you. Opening it is what clears it; the row in
  // front never has one.
  const inFront = (c: ChatSession): boolean =>
    c.sessionId === activeChatSessionId || activeIds.has(c.sessionId) || (!!c.tmux && c.tmux.session === activeTmuxName)
  const [seen, setSeen] = useState<Record<string, number>>(readSeen)
  useEffect(() => {
    setSeen((prev) => {
      const next: Record<string, number> = {}
      let changed = false
      for (const [id, at] of Object.entries(prev)) {
        if (Date.now() - at < SEEN_TTL_MS) next[id] = at
        else changed = true
      }
      for (const c of chats) {
        // A chat seen for the first time brings no news: an old one is not new.
        const at = inFront(c) ? c.updatedAt : (next[c.sessionId] ?? c.updatedAt)
        if (next[c.sessionId] !== at) {
          next[c.sessionId] = at
          changed = true
        }
      }
      if (!changed) return prev
      writeSeen(next)
      return next
    })
    // inFront reads the props below; the chats poll re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeChatSessionId, activeTmuxName, openRows])
  const chatNews = (c: ChatSession): boolean =>
    !inFront(c) &&
    (unread.has(c.sessionId) || ((c.status === 'idle' || c.status === 'waiting') && c.updatedAt > (seen[c.sessionId] ?? c.updatedAt)))

  // A plain tmux session has news when the agent scan sees it start waiting, or stop working.
  const lastAgent = useRef(new Map<string, AgentStatus>())
  const [tmuxNews, setTmuxNews] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const add: string[] = []
    for (const [name, st] of agentStatusByName) {
      const was = lastAgent.current.get(name)
      lastAgent.current.set(name, st)
      if (was === undefined || was === st) continue
      if (st === 'waiting' || (was === 'working' && st === 'idle'))
        if (name !== activeTmuxName) add.push(name)
    }
    if (add.length) setTmuxNews((s) => new Set([...s, ...add]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentStatusByName])
  useEffect(() => {
    if (!activeTmuxName || !tmuxNews.has(activeTmuxName)) return
    setTmuxNews((s) => {
      const n = new Set(s)
      n.delete(activeTmuxName)
      return n
    })
  }, [activeTmuxName, tmuxNews, chats])

  if (collapsed) {
    return (
      <aside
        className={`relative z-30 flex h-full shrink-0 flex-col items-center border-r border-line-soft bg-surface ${
          // The native traffic lights sit over the rail's top on macOS, so it is as wide as they are.
          isMac && !fullScreen ? 'w-[78px]' : 'w-11'
        }`}
      >
        <div className="drag h-11 w-full shrink-0" />
        <button
          onClick={() => setCollapsedPersist(false)}
          title={`Show sidebar (${isMac ? '⌘B' : 'Ctrl+Shift+B'})`}
          aria-label="Show sidebar"
          className={iconBtn()}
        >
          <PanelIcon />
        </button>
        <button onClick={onNewChat} disabled={!activeConnection} title="New chat" aria-label="New chat" className={`${iconBtn()} mt-1`}>
          <PlusIcon />
        </button>
        <button onClick={onOpenSummary} title="Summary" aria-label="Summary" className={`${iconBtn()} mt-1`}>
          <SummaryIcon />
        </button>
        <div className="mt-2 [&_div]:flex-col [&_div]:ml-0 [&_div]:border-l-0 [&_div]:pl-0">{splitControls}</div>
        <div className="flex-1" />
        <button onClick={onOpenSettings} title="Settings (Ctrl+,)" aria-label="Settings" className={`${iconBtn()} mb-2`}>
          <SettingsIcon />
        </button>
      </aside>
    )
  }

  return (
    <aside className="relative z-30 flex h-full w-[285px] shrink-0 flex-col border-r border-line-soft bg-surface">
      {/* drag region — on macOS it carries the native traffic lights, which vanish
          in true fullscreen along with the gutter reserved for them */}
      <div
        className={`drag flex h-11 shrink-0 items-center pr-2 ${isMac && !fullScreen ? 'pl-[78px]' : 'pl-3'}`}
      >
        <button
          onClick={() => setCollapsedPersist(true)}
          title={`Hide sidebar (${isMac ? '⌘B' : 'Ctrl+Shift+B'})`}
          aria-label="Hide sidebar"
          className={`no-drag ${iconBtn()}`}
        >
          <PanelIcon />
        </button>
        <span className="flex-1" />
        <div className="no-drag">{splitControls}</div>
      </div>

      {/* search */}
      <div className="shrink-0 px-1.5 pt-[7px]">
        <label className="flex h-[26px] items-center gap-2 rounded-lg border border-line bg-field pl-2 pr-1 text-faint focus-within:border-faint">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              }
            }}
            placeholder="Search"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-fg outline-none placeholder:text-faint"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              title="Clear search"
              aria-label="Clear search"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md hover:bg-elevated hover:text-fg"
            >
              <CloseIcon />
            </button>
          )}
        </label>
      </div>


      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-4 [scrollbar-width:none]">
        {/* Open — the views, exactly as the old tab strip had them, as rows */}
        {shownOpenRows.length > 0 && (
          <div className="mt-3">
            <GroupHeader
              title="Open"
              open={sections.open || searching}
              onToggle={() => toggleSection('open')}
            />
            {(sections.open || searching) &&
              shownOpenRows.map((row) => (
                <div
                  key={row.id}
                  draggable
                  onClick={() => onSelectView(row.id)}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: 'Show', run: () => onSelectView(row.id) },
                      row.closable ? { label: row.split ? 'Close split' : 'Close tab', run: () => onCloseView(row.id) } : null
                    ])
                  }
                  onDragStart={(e) => {
                    dragViewId.current = row.id
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', row.id)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragViewId.current && dragViewId.current !== row.id) setDragOverId(row.id)
                  }}
                  onDragLeave={() => setDragOverId((id) => (id === row.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = dragViewId.current
                    if (from) onMoveView(from, row.id)
                    dragViewId.current = null
                    setDragOverId(null)
                  }}
                  onDragEnd={() => {
                    dragViewId.current = null
                    setDragOverId(null)
                  }}
                  className={`cursor-pointer ${rowCls(row.active)} ${
                    dragOverId === row.id ? 'ring-2 ring-inset ring-accent/70' : ''
                  }`}
                >
                  <Slot>
                    {row.split ? (
                      <span className={row.active ? 'text-accent' : 'text-faint'} title="split tab">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
                          {row.direction === 'columns' ? (
                            <line x1="7" y1="2.5" x2="7" y2="11.5" />
                          ) : (
                            <line x1="1.5" y1="7" x2="12.5" y2="7" />
                          )}
                        </svg>
                      </span>
                    ) : (
                      <span className="text-[12px]">{row.icon}</span>
                    )}
                  </Slot>
                  {/* One dot per leaf of this view that's waiting on you. In a split they
                      read left to right in the same order as the joined label. */}
                  {row.waiting.length > 0 && (
                    <span
                      className="flex shrink-0 items-center gap-1"
                      title={`Waiting: ${row.waiting.map((w) => w.label).join(', ')}`}
                    >
                      {row.waiting.map((w) => (
                        <span key={w.id} className="h-2 w-2 shrink-0 rounded-full bg-amber" />
                      ))}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  {row.closable && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseView(row.id)
                      }}
                      className="text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                      title={row.split ? 'Close split (all its panes)' : 'Close tab'}
                      aria-label={row.split ? 'Close split' : 'Close tab'}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* Chats — live Claudes on this server, one group per repo folder */}
        {!activeConnection && <p className="mt-3 px-[9px] text-[13px] text-faint">Pick a server.</p>}
        {activeConnection && chats.length === 0 && <p className="mt-3 px-[9px] text-[13px] text-faint">No live chats.</p>}
        {groups.map((g) => {
          const open = searching || !foldedGroups.has(g.repo)
          return (
            <div key={g.repo} className="mt-[7px]">
              <GroupHeader
                title={leaf(g.repo)}
                tooltip={g.repo}
                open={open}
                onToggle={() => toggleGroup(g.repo)}
                onAdd={() => onNewChatIn(g.repo)}
                addTitle={`New chat in ${leaf(g.repo)}`}
                onMenu={(e) =>
                  openMenu(e, [
                    { label: 'New chat here', run: () => onNewChatIn(g.repo) },
                    { label: open ? 'Collapse' : 'Expand', run: () => toggleGroup(g.repo) },
                    null,
                    { label: 'Copy path', run: () => copy(g.repo) }
                  ])
                }
              />
              {open &&
                g.rows.map(({ chat, label }) => {
                  const st = chatStatusOf(chat)
                  return (
                    <button
                      key={chat.sessionId}
                      onClick={() => onOpenChat(chat)}
                      onContextMenu={(e) => {
                        const t = chat.tmux?.session
                        openMenu(e, [
                          { label: 'Open chat', run: () => onOpenChat(chat) },
                          t ? { label: 'Open terminal', run: () => onOpenTmux(t) } : null,
                          { label: `New chat in ${leaf(chat.cwd)}`, run: () => onNewChatIn(chat.cwd) },
                          null,
                          t ? { label: 'Rename tmux session…', run: () => renameTmux(t) } : null,
                          { label: 'Copy folder path', run: () => copy(chat.cwd) },
                          { label: 'Copy session id', run: () => copy(chat.sessionId) },
                          ...(t ? [null, { label: 'Kill tmux session…', danger: true, run: () => killTmux(t, true) }] : [])
                        ])
                      }}
                      title={`${chat.name ? `${chat.name}\n` : ''}${chat.cwd}\n${statusLabel(st, chat.waitingFor)}${
                        chat.drivable ? '' : chat.tmux ? '\nRead only: not a TUI' : '\nRead only: not in tmux'
                      }`}
                      className={rowCls(
                        chat.sessionId === activeChatSessionId || activeIds.has(chat.sessionId) || (!!chat.tmux && chat.tmux.session === activeTmuxName)
                      )}
                    >
                      <Slot>
                        <RowMark news={chatNews(chat)} busy={st === 'busy'} />
                      </Slot>
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {label}
                      </span>
                    </button>
                  )
                })}
            </div>
          )
        })}

        {/* tmux — this server's sessions, with the agent status the Summary shows */}
        {(shownTmux.length > 0 || (!searching && activeConnection)) && (
          <div className="mt-[7px]">
            <GroupHeader
              title="tmux"
              open={sections.tmux || searching}
              onToggle={() => toggleSection('tmux')}
              onAdd={newTmux}
              addTitle="New tmux session"
              onMenu={(e) =>
                openMenu(e, [
                  { label: 'New tmux session…', run: newTmux },
                  { label: sections.tmux ? 'Collapse' : 'Expand', run: () => toggleSection('tmux') }
                ])
              }
            />
            {(sections.tmux || searching) && (
              <>
                {activeConnection && tmux.length === 0 && <p className="px-[9px] text-[13px] text-faint">No tmux sessions.</p>}
                {shownTmux.map((s) => {
                  const status = agentStatusByName.get(s.name)
                  return (
                    <button
                      key={s.name}
                      onClick={() => onOpenTmux(s.name)}
                      onContextMenu={(e) =>
                        openMenu(e, [
                          { label: 'Open', run: () => onOpenTmux(s.name) },
                          { label: 'Rename…', run: () => renameTmux(s.name) },
                          { label: 'Copy name', run: () => copy(s.name) },
                          null,
                          { label: 'Kill session…', danger: true, run: () => killTmux(s.name, false) }
                        ])
                      }
                      title={[
                        s.name,
                        `${s.windows} window${s.windows === 1 ? '' : 's'}`,
                        s.attached ? 'attached' : '',
                        status ? STATUS_LABEL[status] : ''
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      className={rowCls(s.name === activeTmuxName)}
                    >
                      <Slot>
                        <RowMark news={tmuxNews.has(s.name)} busy={status === 'working'} />
                      </Slot>
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}

        {nothingFound && <p className="mt-3 px-[9px] text-[13px] text-faint">No matches.</p>}
      </div>

      {menu && (
        <div
          className="panel fixed z-40 min-w-44 overflow-hidden py-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 16 - menu.items.length * 32)
          }}
        >
          {menu.items.map((it, k) =>
            it ? (
              <MenuItem key={k} danger={it.danger} onClick={it.run}>
                {it.label}
              </MenuItem>
            ) : (
              // A separator, unless it would lead, trail or double up.
              k > 0 && k < menu.items.length - 1 && menu.items[k - 1] && <div key={k} className="my-1 border-t border-line-soft" />
            )
          )}
        </div>
      )}
      {ask && (
        <PromptDialog
          title={ask.title}
          label={ask.label}
          initial={ask.initial}
          confirmLabel={ask.confirmLabel}
          onCancel={() => setAsk(null)}
          onConfirm={(v) => {
            setAsk(null)
            ask.run(v)
          }}
        />
      )}

      {/* bottom — the server, like Claude's account row; settings on the right */}
      <div ref={serverRef} className="relative flex h-11 shrink-0 items-center gap-1 border-t border-line-soft px-1.5">
        <button
          onClick={() => setServerOpen((o) => !o)}
          title={activeConnection ? `${activeConnection.name} · ${activeConnection.host} — switch server` : 'Switch server'}
          className={`flex h-8 min-w-0 items-center gap-2 rounded-lg pl-1.5 pr-2 text-left transition-colors hover:bg-elevated ${
            serverOpen ? 'bg-elevated' : ''
          }`}
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-elevated text-[10px] font-medium leading-none text-title">
            {initials(activeConnection?.name)}
          </span>
          <span className="min-w-0 truncate text-[13px] text-muted">{activeConnection?.name ?? 'No server'}</span>
          <span className={`shrink-0 text-faint transition-transform ${serverOpen ? 'rotate-180' : ''}`}>
            <ChevronDown />
          </span>
        </button>
        <span className="flex-1" />
        <button onClick={onNewChat} disabled={!activeConnection} title="New chat" aria-label="New chat" className={`${iconBtn()} disabled:opacity-40`}>
          <PlusIcon />
        </button>
        <button onClick={onOpenSummary} title="Summary" aria-label="Summary" className={iconBtn(summaryActive)}>
          <SummaryIcon />
        </button>
        <button onClick={onOpenSettings} title="Settings (Ctrl+,)" aria-label="Settings" className={iconBtn(settingsActive)}>
          <SettingsIcon />
        </button>
        {serverOpen && (
          <div className="panel absolute inset-x-1.5 bottom-full z-40 mb-1 max-h-72 overflow-y-auto p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
            {connections.length === 0 && <p className="px-2.5 py-2 text-[13px] text-faint">No servers yet. Add one in Settings.</p>}
            {connections.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setServerOpen(false)
                  if (c.id !== activeConnection?.id) onSelectConnection(c.id)
                }}
                className={`flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                  c.id === activeConnection?.id ? 'bg-sel text-fg' : 'text-muted hover:bg-elevated'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.id === activeConnection?.id && <span className="text-[12px]">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
