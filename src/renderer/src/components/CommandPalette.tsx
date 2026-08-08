import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentHostScan,
  AgentSession,
  Connection,
  ResumeHostScan,
  ResumeSession
} from '../../../shared/types'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'
import { resumeTitle } from '../lib/resume'
import type { Tab } from '../App'

interface Props {
  open: boolean
  onClose: () => void
  connections: Connection[]
  tabs: Tab[]
  leafLabel: (t: Tab) => string
  leafIcon: (t: Tab, lit: boolean) => ReactNode
  agentHosts: AgentHostScan[] | null
  saved: ResumeHostScan[] | null
  selectConnection: (connectionId: string) => void
  showLeaf: (id: string) => void
  attachFromInbox: (connectionId: string, session: string) => void
  resumeFromInbox: (connectionId: string, s: ResumeSession, label: string) => void
  openInbox: () => void
}

/** How many rows one section shows — a jump list, not the full inbox. */
const MAX_RESULTS = 8

const AGENT_DOT: Record<AgentStatus, string> = {
  waiting: 'bg-amber dot-glow',
  working: 'bg-signal dot-glow animate-pulse',
  idle: 'bg-faint',
  unknown: 'bg-muted/40'
}

/** Keep the tail of a long path: the leaf is what identifies the work. */
function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

interface ResultItem {
  key: string
  label: string
  sub?: string
  icon: ReactNode
  run: () => void
}

export function CommandPalette({
  open,
  onClose,
  connections,
  tabs,
  leafLabel,
  leafIcon,
  agentHosts,
  saved,
  selectConnection,
  showLeaf,
  attachFromInbox,
  resumeFromInbox,
  openInbox
}: Props) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const hostResults = useMemo<ResultItem[]>(() => {
    const list = connections.filter((c) =>
      `${c.name} ${c.username} ${c.host}`.toLowerCase().includes(q)
    )
    return list.slice(0, MAX_RESULTS).map((c) => ({
      key: `host:${c.id}`,
      label: c.name,
      sub: `${c.username ? `${c.username}@` : ''}${c.host}:${c.port}`,
      icon: <span className="text-signal">▦</span>,
      run: () => selectConnection(c.id)
    }))
  }, [connections, q, selectConnection])

  const tabResults = useMemo<ResultItem[]>(() => {
    const list = tabs.filter((t) => leafLabel(t).toLowerCase().includes(q))
    return list.slice(0, MAX_RESULTS).map((t) => ({
      key: `tab:${t.id}`,
      label: leafLabel(t),
      icon: leafIcon(t, false),
      run: () => showLeaf(t.id)
    }))
  }, [tabs, leafLabel, leafIcon, q, showLeaf])

  const agentResults = useMemo<ResultItem[]>(() => {
    const rows: { connectionId: string; host: string; s: AgentSession }[] = []
    for (const h of agentHosts ?? []) {
      for (const s of h.sessions) rows.push({ connectionId: h.connectionId, host: h.name, s })
    }
    const filtered = rows.filter((r) =>
      `${r.host} ${r.s.session} ${r.s.dir} ${r.s.command}`.toLowerCase().includes(q)
    )
    return filtered.slice(0, MAX_RESULTS).map((r) => ({
      key: `agent:${r.connectionId}:${r.s.session}`,
      label: r.s.session,
      sub: `${r.host} · ${shortPath(r.s.dir) || r.s.command || '—'}`,
      icon: <span className={`h-2 w-2 rounded-full ${AGENT_DOT[agentStatus(r.s)]}`} />,
      run: () => attachFromInbox(r.connectionId, r.s.session)
    }))
  }, [agentHosts, q, attachFromInbox])

  // Only sessions `resumeFromInbox` can actually open — same guard AgentInbox
  // uses to disable its own Resume button (no cwd, or the cwd is gone/unreadable).
  const savedResults = useMemo<ResultItem[]>(() => {
    const rows: { connectionId: string; host: string; s: ResumeSession; label: string }[] = []
    for (const h of saved ?? []) {
      for (const s of h.sessions) {
        if (!s.dir || s.dirExists === false || s.dirLossy) continue
        rows.push({ connectionId: h.connectionId, host: h.name, s, label: resumeTitle(s) ?? 'Untitled session' })
      }
    }
    const filtered = rows.filter((r) =>
      `${r.host} ${r.label} ${r.s.dir ?? ''}`.toLowerCase().includes(q)
    )
    return filtered.slice(0, MAX_RESULTS).map((r) => ({
      key: `saved:${r.connectionId}:${r.s.id}`,
      label: r.label,
      sub: `${r.host} · ${shortPath(r.s.dir ?? '')}`,
      icon: <span className="text-signal">↺</span>,
      run: () => resumeFromInbox(r.connectionId, r.s, r.label)
    }))
  }, [saved, q, resumeFromInbox])

  const homeResult = useMemo<ResultItem | null>(() => {
    const label = 'Open Home'
    if (!label.toLowerCase().includes(q)) return null
    return {
      key: 'action:home',
      label,
      sub: 'Every agent, every host',
      icon: <span className="text-signal">◎</span>,
      run: () => openInbox()
    }
  }, [q, openInbox])

  const sections = useMemo(
    () =>
      [
        { title: 'Hosts', items: hostResults },
        { title: 'Open Tabs', items: tabResults },
        { title: 'Running Agents', items: agentResults },
        { title: 'Saved Sessions', items: savedResults }
      ].filter((s) => s.items.length > 0),
    [hostResults, tabResults, agentResults, savedResults]
  )

  const flatResults = useMemo(
    () => [...sections.flatMap((s) => s.items), ...(homeResult ? [homeResult] : [])],
    [sections, homeResult]
  )

  const resultIndex = useMemo(() => {
    const m = new Map<string, number>()
    flatResults.forEach((r, i) => m.set(r.key, i))
    return m
  }, [flatResults])

  const activeIndex = flatResults.length === 0 ? -1 : Math.min(cursor, flatResults.length - 1)

  const activate = (i: number): void => {
    const item = flatResults[i]
    if (!item) return
    item.run()
    onClose()
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(0, flatResults.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(activeIndex)
    }
  }

  const row = (item: ResultItem): ReactNode => {
    const i = resultIndex.get(item.key) ?? -1
    const active = i === activeIndex
    return (
      <button
        key={item.key}
        onMouseEnter={() => setCursor(i)}
        onClick={() => activate(i)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
          active ? 'bg-signal-soft/40' : 'hover:bg-elevated/50'
        }`}
      >
        <span className="grid w-4 shrink-0 place-items-center">{item.icon}</span>
        <span className="truncate text-sm font-medium text-fg/90">{item.label}</span>
        {item.sub && (
          <span className="ml-auto truncate pl-2 font-mono text-[11px] text-faint">{item.sub}</span>
        )}
      </button>
    )
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60 pt-[12vh] backdrop-blur-sm">
      <div
        ref={panelRef}
        className="panel animate-rise h-fit w-full max-w-xl overflow-hidden shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Jump to a host, tab, agent, or session…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm text-fg outline-none focus:border-signal/60 placeholder:text-faint"
        />

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {sections.map((section) => (
            <div key={section.title} className="mb-1 last:mb-0">
              <div className="eyebrow px-2.5 pb-1 pt-2">{section.title}</div>
              {section.items.map(row)}
            </div>
          ))}

          {homeResult && <div className="mt-1 border-t border-line/70 pt-1">{row(homeResult)}</div>}

          {flatResults.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-faint">No matches.</p>
          )}
        </div>
      </div>
    </div>
  )
}
