import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHostScan, AgentSession, ResumeHostScan, ResumeSession } from '../../../shared/types'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'
import { claudeResumeSessionName } from '../lib/claude'
import { RESUME_LIMIT, resumeTitle, savedSessionStatus } from '../lib/resume'
import type { SavedSessionStatus } from '../lib/resume'

interface Props {
  active: boolean
  /** The live-agent sweep, owned by useAgentSessions and lifted to App.tsx so it
   *  can keep polling in the background regardless of which tab is visible. */
  hosts: AgentHostScan[] | null
  error: string | null
  scanning: boolean
  /** Re-scan now, clearing any hosts latched as refused — the Refresh button. */
  rescan: () => void
  /** Attach a terminal tab to this tmux session on this host. */
  onAttach: (connectionId: string, session: string) => void
  /** Open a new agent tab resuming this saved transcript. `label` titles the tab. */
  onResume: (connectionId: string, session: ResumeSession, label: string) => void
}

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

/**
 * A transcript's size, coarsely.
 *
 * On the row because a third of the saved sessions on a real host have no label at
 * all, and this is the one number that separates a conversation worth returning to
 * from one that never started. What it can and cannot tell you is written down on
 * ResumeSession.sizeBytes — briefly, everything under about 100 KB is boilerplate.
 */
function size(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** One saved session, flattened with its host and everything the row needs. */
interface SavedRow {
  connectionId: string
  host: string
  s: ResumeSession
  /** resumeTitle()'s answer, or null when the transcript has no label at all. */
  label: string | null
  /** Names of other live sessions sitting in this session's directory. Often empty. */
  live: string[]
  /**
   * The tmux session already resuming THIS transcript, or null.
   *
   * An identity rather than a heuristic: the session name is a pure function of the
   * transcript id, so a hit means this exact transcript is open right now. The row is
   * not folded away for it — it changes verb, because resuming a transcript that is
   * already resumed starts a second `claude --resume` appending to the same file.
   */
  running: string | null
  /**
   * The one authoritative answer driving the row's badge and button — see
   * savedSessionStatus() in shared/resume.ts. `dirLossy`/`dirExists` on `s` are
   * still read directly where the row needs to pick between GONE and
   * UNREADABLE, both of which collapse into `unavailable` here.
   */
  status: SavedSessionStatus
}

/**
 * Fold a newly fetched page into the pages already on screen.
 *
 * Keyed by transcript id and first-wins, which is not defensive tidying: the host
 * orders by mtime, so a live agent writing to its transcript between two page
 * requests moves that row to the top and pushes the boundary down — page two then
 * repeats a row page one already showed. The reverse also happens and is accepted:
 * a row can be stepped over, and it is by definition an older one, which Rescan
 * recovers. Counts and errors come from the newer response, since they describe the
 * host as it is now; rows are kept because they were true when they were read.
 */
function mergeSaved(prev: ResumeHostScan[], next: ResumeHostScan[]): ResumeHostScan[] {
  const before = new Map(prev.map((h) => [h.connectionId, h]))
  return next.map((h) => {
    const had = before.get(h.connectionId)
    if (!had) return h
    const seen = new Set(had.sessions.map((s) => s.id))
    return { ...h, sessions: [...had.sessions, ...h.sessions.filter((s) => !seen.has(s.id))] }
  })
}

export function AgentInbox({ active, hosts, error, scanning, rescan, onAttach, onResume }: Props) {
  const [saved, setSaved] = useState<ResumeHostScan[] | null>(null)
  const [savedOpen, setSavedOpen] = useState(false)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [savedScanning, setSavedScanning] = useState(false)
  const [savedOffset, setSavedOffset] = useState(0)
  const savedBusy = useRef(false)
  const savedOnce = useRef(false)

  const scanSaved = useCallback(
    async (opts?: { retryFailed?: boolean; more?: boolean }): Promise<void> => {
      if (savedBusy.current) return
      savedBusy.current = true
      setSavedScanning(true)
      // Rescan starts over rather than reloading every page: the pages are a trail of
      // where the list was, and a fresh look at a host is the thing the button offers.
      const offset = opts?.more ? savedOffset + RESUME_LIMIT : 0
      try {
        const page = await window.api.resumeScan({ retryFailed: opts?.retryFailed, offset })
        setSaved((prev) => (offset > 0 && prev ? mergeSaved(prev, page) : page))
        setSavedOffset(offset)
        setSavedError(null)
      } catch (e) {
        setSavedError(e instanceof Error ? e.message : String(e))
      } finally {
        savedBusy.current = false
        setSavedScanning(false)
      }
    },
    [savedOffset]
  )

  // Once when the pane first opens, and then only when asked — deliberately NOT on
  // the ten-second poll the live list runs on. A running agent's status changes from
  // second to second; a transcript on disk changes when somebody works in it. This
  // sweep reads the newest sixty files on every host, so paying for it repeatedly
  // would cost real time on a host with a thousand of them to tell the user nothing
  // new. The count in the section header is what makes the one scan worth doing
  // eagerly: a collapsed section that had never scanned could only say "Saved
  // sessions", which gives no reason to open it.
  //
  // Latched on a ref, not on `saved === null`: the effect is what sets `saved`, so
  // reading it here would re-run this on every response and stop only because the
  // value had stopped being null — a latch made out of a coincidence.
  useEffect(() => {
    if (!active || savedOnce.current) return
    savedOnce.current = true
    void scanSaved()
  }, [active, scanSaved])

  // Every tmux session on every host, agent-looking or not. There is no filter:
  // whether a session "looks like an agent" is a guess from its name, and a guess
  // has no business hiding a running process from the one view that lists them.
  // The session name is on every row, so an agent still reads as one.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const h of hosts ?? []) {
      for (const s of h.sessions) {
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
  }, [hosts])

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { waiting: 0, working: 0, idle: 0, unknown: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  // Which directories already have something live sitting in them, per host.
  //
  // This is the one thing a resumed session gives up. An agent launched from a
  // directory owns the tmux session named after that directory; a resumed one is
  // named after its transcript instead, precisely so that clicking Resume cannot
  // silently attach to a different agent (see claudeResumeSessionName). The cost is
  // that resuming CAN put a second agent in a working tree that already has one, and
  // two agents editing one tree is a genuinely bad afternoon. So the row says so,
  // rather than the button quietly refusing or the list quietly hiding it — the
  // overlap is a real state, and the reader is the one who knows whether it is fine.
  //
  // Every name is kept, not just the newest: a host with three sessions parked in one
  // checkout is ordinary, and a badge naming only the last of them would be pointing at
  // an arbitrary one of the three while implying it was the only one.
  //
  // What is compared here is narrower than it looks, and worth being exact about. A live
  // row's directory is its tmux pane's current path; a saved row's is the cwd its
  // transcript recorded. So this catches something parked in the same place, and does
  // NOT catch an agent that has since cd'd elsewhere, nor one whose pane sits at a
  // repository root while the transcript names a worktree below it. Hence a badge that
  // reports what was matched and leaves the conclusion to the reader, rather than a
  // warning that would be wrong in both directions.
  const liveDirs = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const h of hosts ?? []) {
      for (const s of h.sessions) {
        if (!s.dir) continue
        const k = `${h.connectionId} ${s.dir}`
        const at = m.get(k)
        if (at) at.push(s.session)
        else m.set(k, [s.session])
      }
    }
    return m
  }, [hosts])

  // Every live tmux session name, per host — the other half of the comparison above,
  // and a much stronger one. A resumed agent's session is named from the transcript
  // id (claudeResumeSessionName), so a name in this set matching the name a row would
  // be resumed under is not evidence about the row, it IS the row, already open.
  const liveNames = useMemo(() => {
    const m = new Set<string>()
    for (const h of hosts ?? []) {
      for (const s of h.sessions) m.add(`${h.connectionId} ${s.session}`)
    }
    return m
  }, [hosts])

  const savedRows = useMemo<SavedRow[]>(() => {
    const out: SavedRow[] = []
    for (const h of saved ?? []) {
      for (const s of h.sessions) {
        const name = claudeResumeSessionName(s.id, s.dir)
        const running = liveNames.has(`${h.connectionId} ${name}`) ? name : null
        // The session resuming this very transcript is in the same directory by
        // definition, so naming it here as a neighbour would be a warning about
        // itself.
        const live = ((s.dir ? liveDirs.get(`${h.connectionId} ${s.dir}`) : undefined) ?? []).filter(
          (n) => n !== running
        )
        out.push({
          connectionId: h.connectionId,
          host: h.name,
          s,
          label: resumeTitle(s),
          live,
          running,
          status: savedSessionStatus(s, running !== null, live.length > 0)
        })
      }
    }
    // `ls -t` already ordered each host's rows; this interleaves the hosts by the
    // same key so one busy server cannot bury a session you touched minutes ago.
    return out.sort((a, b) => {
      const ai = a.s.ageSeconds ?? Number.MAX_SAFE_INTEGER
      const bi = b.s.ageSeconds ?? Number.MAX_SAFE_INTEGER
      return ai - bi || a.host.localeCompare(b.host) || a.s.id.localeCompare(b.s.id)
    })
  }, [saved, liveDirs, liveNames])

  // Both numbers, because they answer different questions: how many rows are here,
  // and how many exist. RESUME_LIMIT means the second is routinely much larger.
  const savedTotal = (saved ?? []).reduce((n, h) => n + h.total, 0)
  const savedProblems = (saved ?? []).filter((h) => h.error || h.skipped || h.listFailed)
  // A host whose page arrived without its end marker. Skipped hosts are excluded:
  // they never started, so there is nothing about them to have been cut short.
  const savedCut = (saved ?? []).filter((h) => !h.complete && !h.skipped)

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
          <button
            // Explicitly asking is what clears the main process's memory of hosts
            // that refused us; the ten-second poll must not, or it would be
            // hammering them again by another name.
            onClick={() => rescan()}
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
            Nothing is running under tmux on any host.
            <br />
            Start an agent with “Claude here” from a host’s file manager or worktree list
            {/* An empty pane sitting above a thousand resumable transcripts should say
                so, or the feature below is only found by accident. */}
            {savedTotal > 0 ? ', or pick up a saved session below.' : '.'}
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

        {/* Saved sessions — transcripts on disk, not processes. Collapsed by default
            because sixty of them would bury the handful of agents actually running,
            which is what this pane is for. */}
        {(savedTotal > 0 || savedError || savedProblems.length > 0) && (
          <div className="mt-3 border-t border-line pt-2">
            <div className="flex items-center gap-2 px-3">
              <button
                onClick={() => setSavedOpen((v) => !v)}
                className="flex items-center gap-1.5 text-left transition-colors hover:text-signal"
              >
                <span className={`font-mono text-[9px] text-faint ${savedOpen ? '' : '-rotate-90'}`}>
                  ▾
                </span>
                <span className="eyebrow">Saved sessions</span>
                <span className="font-mono text-[11px] text-faint">
                  {savedRows.length === savedTotal
                    ? savedTotal
                    : `${savedRows.length} of ${savedTotal}`}
                </span>
              </button>
              {savedCut.length > 0 && (
                <span
                  className="shrink-0 rounded border border-amber/40 px-1 py-px font-mono text-[9px] tracking-wider text-amber"
                  title={`The listing from ${savedCut
                    .map((h) => h.name)
                    .join(', ')} stopped before it finished, so these rows are some of what is there rather than all of it. Rescan to ask again.`}
                >
                  CUT SHORT
                </span>
              )}
              {savedOpen && (
                <button
                  onClick={() => void scanSaved({ retryFailed: true })}
                  disabled={savedScanning}
                  className="ml-auto rounded-md border border-line px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-50"
                >
                  {savedScanning ? 'Scanning…' : 'Rescan'}
                </button>
              )}
            </div>

            {savedOpen && (
              <div className="mt-1">
                {savedError && (
                  <p className="mx-2 mb-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {savedError}
                  </p>
                )}

                {savedRows.map((r) => (
                  <div
                    key={`${r.connectionId}:${r.s.id}`}
                    className="group mb-1 rounded-lg px-3 py-2.5 transition-colors hover:bg-elevated/50"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate text-[12px] ${r.label ? 'text-fg/90' : 'italic text-faint'}`}
                        title={r.label ?? 'This transcript has no title and no prompt to show'}
                      >
                        {r.label ?? 'Untitled session'}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                        {age(r.s.ageSeconds)}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-muted">{r.host}</span>
                      <span
                        className={`truncate font-mono text-[11px] ${r.s.dir ? 'text-faint' : 'text-amber/70'}`}
                        title={
                          r.s.dir ??
                          'This transcript records no working directory, and --resume can only find a session from the directory it ran in.'
                        }
                      >
                        {r.s.dir ? shortPath(r.s.dir) : 'no directory'}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-faint">
                        {size(r.s.sizeBytes)}
                      </span>
                      {r.status === 'running' && (
                        <span
                          className="shrink-0 rounded border border-signal/40 px-1 py-px font-mono text-[9px] tracking-wider text-signal"
                          title={`This transcript is open right now in ${r.running}. Attach goes to that pane; resuming it again would start a second agent appending to the same file.`}
                        >
                          RUNNING
                        </span>
                      )}
                      {/* `unavailable` collapses GONE and UNREADABLE into one status
                          value; dirLossy/dirExists still pick the exact badge text,
                          since the reader needs to know which one it is. */}
                      {r.status === 'unavailable' && r.s.dirExists === false && (
                        <span
                          className="shrink-0 rounded border border-danger/40 px-1 py-px font-mono text-[9px] tracking-wider text-danger"
                          title={`${r.s.dir} is no longer a directory on this host, and --resume can only find a session from the directory it ran in.`}
                        >
                          GONE
                        </span>
                      )}
                      {r.status === 'unavailable' && r.s.dirLossy && (
                        <span
                          className="shrink-0 rounded border border-danger/40 px-1 py-px font-mono text-[9px] tracking-wider text-danger"
                          title="This path holds bytes that are not valid text, so what is shown is not the path on disk. Resuming would open a tab only to fail in it."
                        >
                          UNREADABLE
                        </span>
                      )}
                      {r.status === 'in-use' && (
                        <span
                          className="shrink-0 rounded border border-amber/40 px-1 py-px font-mono text-[9px] tracking-wider text-amber"
                          title={`${r.live.join(', ')} ${r.live.length === 1 ? 'is' : 'are'} live in this same directory. Resuming starts a separate agent here — check they will not be editing the same files.`}
                        >
                          IN USE
                        </span>
                      )}
                      <div className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {r.running !== null ? (
                          <button
                            onClick={() => onAttach(r.connectionId, r.running as string)}
                            title={`Attach to ${r.running}, which is already resuming this transcript`}
                            className="rounded-md border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] text-signal transition-colors hover:bg-signal/20"
                          >
                            Attach
                          </button>
                        ) : (
                          <button
                            onClick={() => onResume(r.connectionId, r.s, r.label ?? 'claude')}
                            disabled={!r.s.dir || r.s.dirExists === false || r.s.dirLossy}
                            title={
                              !r.s.dir
                                ? 'Not resumable — no working directory recorded'
                                : r.s.dirExists === false
                                  ? 'Not resumable — the directory it ran in is gone'
                                  : r.s.dirLossy
                                    ? 'Not resumable — its directory came back unreadable'
                                    : undefined
                            }
                            className="rounded-md border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] text-signal transition-colors hover:bg-signal/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
                          >
                            Resume
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Only when there is a next page to ask for. The count is of the
                    whole set, so this is also the honest statement of how much of it
                    is not on screen. */}
                {savedRows.length < savedTotal && (
                  <div className="px-3 pt-1">
                    <button
                      onClick={() => void scanSaved({ more: true })}
                      disabled={savedScanning}
                      className="rounded-md border border-line px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-50"
                    >
                      {savedScanning
                        ? 'Loading…'
                        : `Load ${Math.min(RESUME_LIMIT, savedTotal - savedRows.length)} more`}
                    </button>
                  </div>
                )}

                {savedProblems.length > 0 && (
                  <div className="px-3 pt-1">
                    {savedProblems.map((h) => (
                      <div
                        key={h.connectionId}
                        className="flex items-baseline gap-2 py-0.5 text-[11px]"
                      >
                        <span className="shrink-0 text-muted">{h.name}</span>
                        <span className="truncate font-mono text-faint" title={h.error}>
                          {h.skipped
                            ? `skipped — ${h.error ?? 'not contacted'}`
                            : (h.error ??
                              'saved sessions could not be listed — this host may have them')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
