import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHostScan, AgentSession } from '../../../shared/types'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'

interface Props {
  active: boolean
  /** Attach a terminal tab to this tmux session on this host. */
  onAttach: (connectionId: string, session: string) => void
  /** Open Review Changes for the agent's working directory. */
  onReview: (connectionId: string, dir: string) => void
}

/** How often a visible inbox re-scans. */
const POLL_MS = 10000

/** One session, flattened with the host it was found on, ready to render. */
interface Row {
  connectionId: string
  host: string
  s: AgentSession
  status: AgentStatus
}

/**
 * Order: whoever needs a human first, then whoever is doing something, then the
 * rest. Within a group the more recently active session comes first, so the row
 * you are most likely to want never sinks below a stale one.
 */
const RANK: Record<AgentStatus, number> = { waiting: 0, working: 1, idle: 2, unknown: 3 }

const STATUS_LABEL: Record<AgentStatus, string> = {
  waiting: 'Waiting for you',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Unknown'
}

const STATUS_DOT: Record<AgentStatus, string> = {
  waiting: 'bg-amber dot-glow text-amber',
  working: 'bg-signal dot-glow text-signal animate-pulse',
  idle: 'bg-faint',
  unknown: 'bg-muted/40'
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  waiting: 'text-amber',
  working: 'text-signal',
  idle: 'text-faint',
  unknown: 'text-faint'
}

/** Coarse on purpose — this is a glance, not a stopwatch. */
function age(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** Keep the tail of a long path: the leaf is what identifies the work. */
function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

export function AgentInbox({ active, onAttach, onReview }: Props) {
  const [hosts, setHosts] = useState<AgentHostScan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [agentsOnly, setAgentsOnly] = useState(true)

  // One scan in flight at a time. The poll interval is shorter than a sweep
  // across a slow host takes, so without this a stalled host would pile up
  // overlapping scans — each holding a pooled connection open — until it healed.
  const busy = useRef(false)

  const scan = useCallback(async (retryFailed = false): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setScanning(true)
    try {
      setHosts(await window.api.agentsScan(retryFailed))
      setError(null)
    } catch (e) {
      // Only the sweep itself failing lands here; a single unreachable host is
      // reported inside the result and never throws.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busy.current = false
      setScanning(false)
    }
  }, [])

  // Polls only while the pane is on screen. A background poll would be the thing
  // that lets an unopened host notify you — worth having, and deliberately not in
  // this first version: it needs a story for how often, and for hosts that are
  // down, that a visible panel does not.
  useEffect(() => {
    if (!active) return
    void scan()
    const t = setInterval(() => void scan(), POLL_MS)
    return () => clearInterval(t)
  }, [active, scan])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const h of hosts ?? []) {
      for (const s of h.sessions) {
        if (agentsOnly && !s.agent) continue
        out.push({ connectionId: h.connectionId, host: h.name, s, status: agentStatus(s) })
      }
    }
    return out.sort((a, b) => {
      const r = RANK[a.status] - RANK[b.status]
      if (r !== 0) return r
      const ai = a.s.idleSeconds ?? Number.MAX_SAFE_INTEGER
      const bi = b.s.idleSeconds ?? Number.MAX_SAFE_INTEGER
      return ai - bi || a.host.localeCompare(b.host) || a.s.session.localeCompare(b.s.session)
    })
  }, [hosts, agentsOnly])

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { waiting: 0, working: 0, idle: 0, unknown: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  // A host we chose not to contact and a host that refused us both belong under
  // "Not scanned", but neither is a host we scanned — the header count is of
  // hosts that actually answered.
  const problems = (hosts ?? []).filter((h) => h.error || h.skipped)
  const scanned = (hosts ?? []).length - problems.length

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-line bg-ink">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="leading-tight">
          <div className="eyebrow">Agent Inbox</div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px]">
            {counts.waiting > 0 && <span className="text-amber">{counts.waiting} waiting</span>}
            {counts.working > 0 && <span className="text-signal">{counts.working} working</span>}
            <span className="text-faint">
              {counts.idle + counts.unknown} idle · {scanned} host{scanned === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label
            className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted"
            title="Show every tmux session, not just the ones that look like agents"
          >
            <input
              type="checkbox"
              checked={agentsOnly}
              onChange={(e) => setAgentsOnly(e.target.checked)}
              className="accent-signal"
            />
            Agents only
          </label>
          <button
            // Explicitly asking is what clears the main process's memory of hosts
            // that refused us; the ten-second poll must not, or it would be
            // hammering them again by another name.
            onClick={() => void scan(true)}
            disabled={scanning}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-50"
          >
            {scanning ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error && (
          <p className="mx-2 mb-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        {hosts === null && !error && (
          <p className="px-3 py-10 text-center text-xs text-faint">Scanning your hosts…</p>
        )}

        {hosts !== null && rows.length === 0 && (
          <p className="px-3 py-10 text-center text-xs leading-relaxed text-faint">
            No {agentsOnly ? 'agents' : 'tmux sessions'} running.
            <br />
            {agentsOnly
              ? 'Start one with “Open Claude here” from a host’s file manager.'
              : 'Nothing is running under tmux on any host.'}
          </p>
        )}

        {rows.map((r, i) => (
          <div
            key={`${r.connectionId}:${r.s.session}`}
            style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
            className="animate-rise group mb-1 rounded-lg px-3 py-2.5 transition-colors hover:bg-elevated/50"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} />
              <span className={`shrink-0 text-[11px] ${STATUS_TEXT[r.status]}`}>
                {STATUS_LABEL[r.status]}
              </span>
              <span className="truncate font-mono text-[11px] text-muted" title={r.s.dir || undefined}>
                {shortPath(r.s.dir) || r.s.command || '—'}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                {age(r.s.idleSeconds)}
              </span>
            </div>

            <div className="mt-1 flex items-center gap-2">
              <span className="shrink-0 text-sm font-medium text-fg/90">{r.host}</span>
              <span className="truncate font-mono text-[11px] text-faint" title={r.s.session}>
                {r.s.session}
              </span>
              {r.s.attached && (
                <span
                  className="shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-faint"
                  title="A client is already attached to this session"
                >
                  OPEN
                </span>
              )}
              <div className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {r.s.dir && (
                  <button
                    onClick={() => onReview(r.connectionId, r.s.dir)}
                    className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-signal/40 hover:text-signal"
                    title="Review the working tree this agent is changing"
                  >
                    Changes
                  </button>
                )}
                <button
                  onClick={() => onAttach(r.connectionId, r.s.session)}
                  className="rounded-md border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] text-signal transition-colors hover:bg-signal/20"
                >
                  Attach
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* Hosts that contributed nothing, and why — a silent omission here reads
            as "no agents running", which is a different and wrong answer. */}
        {problems.length > 0 && (
          <div className="mt-3 border-t border-line px-3 pt-2">
            <div className="eyebrow mb-1">Not scanned · {problems.length}</div>
            {problems.map((h) => (
              <div key={h.connectionId} className="flex items-baseline gap-2 py-0.5 text-[11px]">
                <span className="shrink-0 text-muted">{h.name}</span>
                <span className="truncate font-mono text-faint" title={h.error}>
                  {h.skipped ? `skipped — ${h.error ?? 'not contacted'}` : h.error}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
