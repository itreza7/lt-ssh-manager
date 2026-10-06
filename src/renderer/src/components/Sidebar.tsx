import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatSession } from '../../../shared/chatProtocol'
import type { AgentHostScan, Connection, SplitDirection, TmuxSession } from '../../../shared/types'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'
import { isMac } from '../lib/platform'
import { COMPOSE_ACCEL } from '../lib/xtermAttach'
import { CHAT_DOT, chatStatusOf, leaf, statusLabel, type ChatStatus } from './chat/format'
import { STATUS_DOT, STATUS_LABEL } from './SummaryView'

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
  agentHosts: AgentHostScan[] | null

  onOpenSettings: () => void
  onToggleComposer: () => void
  composerEnabled: boolean
  composerOpen: boolean

  fullScreen: boolean
  /** Tells the app shell whether the sidebar is collapsed, so the top bar can clear the traffic lights. */
  onCollapsedChange?: (collapsed: boolean) => void
}

const COLLAPSED_KEY = 'sidebar.collapsed'
const POLL_MS = 10000

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
    document.addEventListener('visibilitychange', onWake)
    return () => {
      dead = true
      clearInterval(timer)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [key])

  return list
}

interface ChatGroup {
  /** Repo path — the group's key, its header tooltip, and where its + starts a chat. */
  repo: string
  /** `wt` is the worktree name when the chat runs in `<repo>/.claude/worktrees/<wt>`. */
  rows: { chat: ChatSession; wt: string | null }[]
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
    g.rows.push({ chat, wt: wt ? wt[2] : null })
  }
  const cmp = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  const groups = [...byRepo.values()].sort((a, b) => cmp(leaf(a.repo), leaf(b.repo)))
  for (const g of groups) {
    g.rows.sort((a, b) =>
      a.wt === b.wt
        ? cmp(a.chat.name ?? '', b.chat.name ?? '')
        : a.wt === null
          ? -1
          : b.wt === null
            ? 1
            : cmp(a.wt, b.wt)
    )
  }
  return groups
}

/** What a chat row says: Claude's own title when it has one, else the folder; a worktree adds " · name". */
const chatRowText = (repo: string, chat: ChatSession, wt: string | null): string =>
  `${chat.name || leaf(repo)}${wt ? ` · ${wt}` : ''}`

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

/** Idle is a hollow ring; every other state is a filled dot in its own colour. */
const ChatDot = ({ status }: { status: ChatStatus }) =>
  status === 'idle' ? (
    <span className="box-border h-2 w-2 shrink-0 rounded-full border-[1.5px] border-faint" />
  ) : (
    <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'waiting' ? 'bg-amber' : CHAT_DOT[status]}`} />
  )

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
const ComposerIcon = () => (
  <Icon>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
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
  addTitle
}: {
  title: string
  tooltip?: string
  open: boolean
  onToggle: () => void
  onAdd?: () => void
  addTitle?: string
}) {
  return (
    <div className="flex h-7 items-center pl-[9px] pr-1 text-[13px] text-faint">
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
  agentHosts,
  onOpenSettings,
  onToggleComposer,
  composerEnabled,
  composerOpen,
  fullScreen,
  onCollapsedChange
}: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [serverOpen, setServerOpen] = useState(false)
  const [sections, setSections] = useState({ open: true, tmux: true })
  const toggleSection = (k: keyof typeof sections): void => setSections((s) => ({ ...s, [k]: !s[k] }))
  // Folded chat groups, by repo path. Open is the default, so a new folder is never hidden.
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = (repo: string): void =>
    setFoldedGroups((s) => {
      const next = new Set(s)
      if (!next.delete(repo)) next.add(repo)
      return next
    })
  const [query, setQuery] = useState('')
  const serverRef = useRef<HTMLDivElement>(null)

  // Tab drag-to-reorder state (operates on views).
  const dragViewId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const setCollapsedPersist = (v: boolean): void => {
    setCollapsed(v)
    writeCollapsed(v)
  }

  useEffect(() => onCollapsedChange?.(collapsed), [collapsed, onCollapsedChange])

  // ⌘B on macOS. Elsewhere Ctrl+B is tmux's prefix and has to reach the terminal,
  // so the chord takes Shift like the app's other non-mac chords (find, composer).
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
        rows: g.rows.filter(({ chat, wt }) =>
          [chatRowText(g.repo, chat, wt), chat.cwd].some((p) => p.toLowerCase().includes(needle))
        )
      }))
      .filter((g) => g.rows.length > 0)
  }, [chats, needle])
  // Summary and Settings are icons at the bottom, which light up instead of a row.
  const summaryActive = openRows.some((r) => r.special === 'summary' && r.active)
  const settingsActive = openRows.some((r) => r.special === 'settings' && r.active)
  // A live chat's tab is already its row under the folder, and a tmux terminal its row
  // under tmux, so only the rest are listed.
  const live = new Set(chats.map((c) => c.sessionId))
  const liveTmux = new Set(tmux.map((s) => s.name))
  const shownOpenRows = openRows.filter(
    (r) =>
      !r.special &&
      !(r.chatSessionId && live.has(r.chatSessionId)) &&
      !(r.tmuxSession && liveTmux.has(r.tmuxSession)) &&
      hit(r.label)
  )
  const shownTmux = tmux.filter((s) => hit(s.name))
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
        <div className="flex-1" />
        <button
          onClick={onToggleComposer}
          disabled={!composerEnabled}
          title={`Toggle prompt composer (${COMPOSE_ACCEL})`}
          aria-label="Toggle prompt composer"
          className={`${iconBtn(composerOpen)} mb-1`}
        >
          <ComposerIcon />
        </button>
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
              />
              {open &&
                g.rows.map(({ chat, wt }) => {
                  const st = chatStatusOf(chat)
                  return (
                    <button
                      key={chat.sessionId}
                      onClick={() => onOpenChat(chat)}
                      title={`${chat.cwd}\n${statusLabel(st, chat.waitingFor)}`}
                      className={rowCls(chat.sessionId === activeChatSessionId)}
                    >
                      <Slot>
                        <ChatDot status={st} />
                      </Slot>
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {chatRowText(g.repo, chat, wt)}
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
                      title={status ? `${s.name} · ${STATUS_LABEL[status]}` : s.name}
                      className={rowCls(s.name === activeTmuxName)}
                    >
                      <Slot>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${status ? STATUS_DOT[status] : 'bg-transparent'}`}
                        />
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

      {/* bottom — the server, like Claude's account row; settings and the composer toggle on the right */}
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
        <button
          onClick={onToggleComposer}
          disabled={!composerEnabled}
          title={`Toggle prompt composer (${COMPOSE_ACCEL})`}
          aria-label="Toggle prompt composer"
          className={iconBtn(composerOpen)}
        >
          <ComposerIcon />
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
