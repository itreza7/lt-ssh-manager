import { useEffect, useRef, useState } from 'react'
import type { ChatTarget, WorkflowAgent } from '../../../../shared/chatProtocol'
import type { TaskState } from '../../lib/chatState'
import { renderMarkdown } from '../MarkdownPreview'
import { Button, Modal } from '../Modal'

interface Props {
  /** Tasks the panel may list: the caller has dropped the hidden ones. */
  tasks: TaskState[]
  target: ChatTarget
  /** The tab is on screen: journals are only polled then. */
  active: boolean
  /** A floating panel at the right of the window; otherwise a block above the composer. */
  side?: boolean
  /** The × : the caller hides the panel until a new task starts. */
  onClose?: () => void
  /** Stops a running workflow in the TUI. Resolves false when it could not (the caller says why). */
  onStop?: (task: TaskState) => Promise<boolean>
  /** The workflow's run file says it was stopped (from the TUI, or from here). */
  onKilled?: (toolUseId: string) => void
  /** The plan waiting for approval (markdown): a row at the top, opened in the panel itself. */
  plan?: string
  planOpen?: boolean
  onPlanOpen?: (open: boolean) => void
}

// How often a running workflow's journal is read: each read is an ssh exec.
const JOURNAL_MS = 3000

const card = 'rounded-lg bg-elevated px-3 py-2.5'
const iconBtn = 'grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-title'

const Icon = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

function Caret({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function Spinner() {
  return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-amber/30 border-t-amber" />
}

const Tick = () => <span className="w-3 shrink-0 text-center text-[12px] leading-none text-signal">✓</span>

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const statusText = (t: TaskState): string => (t.status && t.status !== 'completed' ? t.status : 'completed')

/** "2m 10s", "45s", "1h 3m". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Which phase an agent belongs to: by title, or by index when the journal numbers them. */
function phaseOf(agent: WorkflowAgent, phases: string[]): number {
  const p = agent.phase
  if (p === undefined || p === null || p === '') return -1
  const byTitle = phases.indexOf(String(p))
  if (byTitle >= 0) return byTitle
  return /^\d+$/.test(String(p)) && Number(p) < phases.length ? Number(p) : -1
}

function AgentRow({ agent }: { agent: WorkflowAgent }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => agent.preview && setOpen((o) => !o)}
        title={agent.preview || undefined}
        className="flex w-full items-center gap-2 py-0.5 text-left"
      >
        {agent.state === 'running' ? <Spinner /> : <Tick />}
        <span dir="auto" className={`min-w-0 flex-1 truncate text-[13px] ${agent.state === 'running' ? 'text-fg' : 'text-faint'}`}>
          {agent.label}
        </span>
        {agent.agentType && <span className="shrink-0 font-mono text-[11px] text-faint">{agent.agentType}</span>}
        {agent.preview && <span className="shrink-0 text-faint"><Caret open={open} size={12} /></span>}
      </button>
      {open && agent.preview && (
        <pre dir="auto" className="mb-1 ml-5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-2.5 py-1.5 font-mono text-[11px] text-fg/80">
          {agent.preview}
        </pre>
      )}
    </div>
  )
}

/** One phase of a workflow: "Build   2/2 ›", with its agents beneath when open. */
function PhaseRow({ title, agents, current }: { title: string; agents: WorkflowAgent[]; current: boolean }) {
  const [open, setOpen] = useState(false)
  const done = agents.filter((a) => a.state === 'done').length
  return (
    <div>
      <button onClick={() => agents.length > 0 && setOpen((o) => !o)} className="flex w-full items-center gap-2 py-1 text-left text-[14px] text-muted">
        {current && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />}
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {title}
        </span>
        {agents.length > 0 && (
          <span className="shrink-0 text-[13px] text-faint">
            {done}/{agents.length}
          </span>
        )}
        {agents.length > 0 && <span className="shrink-0 text-faint"><Caret open={open} /></span>}
      </button>
      {open && (
        <div className="mb-1 max-h-48 overflow-y-auto pl-2">
          {agents.map((a) => (
            <AgentRow key={a.agentId} agent={a} />
          ))}
        </div>
      )}
    </div>
  )
}

function Meta({ kind, task, now }: { kind: string; task: TaskState; now: number }) {
  const running = task.state === 'running'
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-5 text-faint">
      <span>{kind}</span>
      <span>{running ? 'Running' : cap(statusText(task))}</span>
      {running && task.startedAt > 0 && <span>{elapsed(now - task.startedAt)}</span>}
    </div>
  )
}

function WorkflowRow({
  task,
  target,
  active,
  now,
  onStop,
  onKilled
}: {
  task: TaskState
  target: ChatTarget
  active: boolean
  now: number
  onStop?: (task: TaskState) => Promise<boolean>
  onKilled?: (toolUseId: string) => void
}) {
  const [agents, setAgents] = useState<WorkflowAgent[]>([])
  const running = task.state === 'running'
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const killedRef = useRef(onKilled)
  killedRef.current = onKilled
  const [open, setOpen] = useState(running)
  // Only a workflow seen running gets the closing read: a finished one loaded from the transcript stays one line.
  const sawRunning = useRef(running)
  if (running) sawRunning.current = true

  useEffect(() => {
    const dir = task.dir
    if (!dir || !sawRunning.current) return
    let off = false
    let t: ReturnType<typeof setInterval> | undefined
    // No notification ever comes for a workflow whose Claude exited (a resume): stop once the journal sat finished for 2 polls.
    let settled = 0
    const poll = async (): Promise<void> => {
      try {
        const { agents: a, status } = await window.api.chatJournal({ ...target, dir })
        if (off) return
        setAgents((prev) => (JSON.stringify(prev) === JSON.stringify(a) ? prev : a))
        // A stop writes no notification to the transcript; the run file is the only record.
        if (status === 'killed') killedRef.current?.(task.toolUseId)
        settled = a.length > 0 && a.every((x) => x.state === 'done') ? settled + 1 : 0
        if (settled >= 2 && t) {
          clearInterval(t)
          t = undefined
        }
      } catch {
        /* a dropped link says nothing about the workflow; keep what we knew */
      }
    }
    void poll()
    if (!running || !active) return () => void (off = true)
    t = setInterval(() => void poll(), JOURNAL_MS)
    return () => {
      off = true
      if (t) clearInterval(t)
    }
    // target is a fresh object each render; its two fields are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.dir, running, active, target.connectionId, target.password])

  // Phases the journal names but the script's meta did not: shown after the known ones.
  const extra: string[] = []
  for (const a of agents) {
    if (a.phase && phaseOf(a, task.phases) < 0 && !extra.includes(String(a.phase))) extra.push(String(a.phase))
  }
  const all = [...task.phases, ...extra]
  const mine = (title: string, i: number): WorkflowAgent[] =>
    agents.filter((a) => (i < task.phases.length ? phaseOf(a, task.phases) === i : String(a.phase) === title))
  const loose = agents.filter((a) => !a.phase || (phaseOf(a, task.phases) < 0 && !extra.includes(String(a.phase))))
  const hasDetail = !!task.summary || agents.length > 0 || all.length > 0

  return (
    <div className={card}>
      <button onClick={() => hasDetail && setOpen((o) => !o)} className="block w-full text-left">
        <div className="flex items-center gap-2">
          {running && <Spinner />}
          <span dir="auto" className={`min-w-0 flex-1 truncate text-[14px] leading-5 ${running ? 'text-fg' : 'text-faint'}`}>
            {task.name}
          </span>
          {running && onStop && (
            <span
              role="button"
              title="Stop this workflow"
              onClick={(e) => {
                e.stopPropagation()
                if (!stopping) setAsking(true)
              }}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-danger"
            >
              {stopping ? (
                <Spinner />
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              )}
            </span>
          )}
          {hasDetail && <span className="shrink-0 text-faint"><Caret open={open} /></span>}
        </div>
        <Meta kind="Workflow" task={task} now={now} />
      </button>
      {asking && onStop && (
        <Modal
          title="Stop workflow"
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button onClick={() => setAsking(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setAsking(false)
                  setStopping(true)
                  void onStop(task).finally(() => setStopping(false))
                }}
              >
                Stop
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg/85">
            Stop workflow “{task.name}”? Its agents stop too.
          </p>
        </Modal>
      )}
      {open && (
        <div className="mt-2 space-y-1">
          {task.summary && (
            <div dir="auto" className="whitespace-pre-wrap pb-1 text-[13px] text-muted">
              {task.summary}
            </div>
          )}
          {all.length > 0 && <div className="pt-1 text-[13px] text-faint">Phases</div>}
          {all.map((title, i) => {
            const list = mine(title, i)
            return <PhaseRow key={`${i}-${title}`} title={title} agents={list} current={list.some((a) => a.state === 'running')} />
          })}
          {loose.length > 0 && (
            <div className="max-h-48 overflow-y-auto">
              {loose.map((a) => (
                <AgentRow key={a.agentId} agent={a} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AgentTaskRow({ task, now }: { task: TaskState; now: number }) {
  const running = task.state === 'running'
  return (
    <div className={card} title={task.summary || undefined}>
      <div className="flex items-center gap-2">
        {running && <Spinner />}
        <span dir="auto" className={`min-w-0 truncate text-[14px] leading-5 ${running ? 'text-fg' : 'text-faint'}`}>
          {task.name}
        </span>
      </div>
      <Meta kind="Agent" task={task} now={now} />
    </div>
  )
}

/**
 * Background Workflows and agents: a floating panel at the right of the window (or a block above the composer when it is narrow).
 * A running Workflow shows its phases and agents live, read from its journal. A finished task is one
 * card; the reducer hides it once the next user message arrives.
 */
export function TasksPanel({ tasks, target, active, side, onClose, onStop, onKilled, plan, planOpen, onPlanOpen }: Props) {
  const [finishedOpen, setFinishedOpen] = useState(true)
  const [wider, setWider] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const running = tasks.filter((t) => t.state === 'running')
  const finished = tasks.filter((t) => t.state === 'done')

  // The clock behind "2m 10s", only while something runs and the tab is on screen.
  const ticking = running.length > 0 && active
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])

  if (!tasks.length && !plan) return null
  const showingPlan = !!plan && !!planOpen

  const render = (t: TaskState) =>
    t.kind === 'workflow' ? (
      <WorkflowRow key={t.toolUseId} task={t} target={target} active={active} now={now} onStop={onStop} onKilled={onKilled} />
    ) : (
      <AgentTaskRow key={t.toolUseId} task={t} now={now} />
    )

  const body = (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 pl-4 pr-2">
        {showingPlan ? (
          <button onClick={() => onPlanOpen?.(false)} title="Back to the list" className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px] text-muted transition-colors hover:text-title">
            <Icon>
              <path d="m15 18-6-6 6-6" />
            </Icon>
            <span className="truncate">Plan</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[14px] text-muted">{tasks.length ? 'Background tasks' : 'Plan'}</span>
        )}
        {side && (
          <button onClick={() => setWider((w) => !w)} title={wider ? 'Narrower' : 'Wider'} className={iconBtn}>
            {wider ? (
              <Icon>
                <path d="m14 10 7-7M20 10h-6V4M3 21l7-7M4 14h6v6" />
              </Icon>
            ) : (
              <Icon>
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </Icon>
            )}
          </button>
        )}
        {onClose && (
          <button onClick={onClose} title="Hide" className={iconBtn}>
            <Icon>
              <path d="M18 6 6 18M6 6l12 12" />
            </Icon>
          </button>
        )}
      </div>
      {showingPlan ? (
        <div dir="auto" className="md-body min-h-0 flex-1 overflow-y-auto px-4 pb-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
        {plan && (
          <>
            <div className="px-2 pb-1.5 pt-1 text-[13px] text-faint">Waiting for you</div>
            <button onClick={() => onPlanOpen?.(true)} className={`${card} flex w-full items-center gap-2 text-left transition-colors hover:bg-white/[0.06]`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 text-fg">Plan</span>
                <span className="block text-[12.5px] text-faint">Ready for approval</span>
              </span>
              <Caret open={false} />
            </button>
          </>
        )}
        {running.length > 0 && (
          <>
            <div className={`px-2 pb-1.5 text-[13px] text-faint ${plan ? 'pt-3' : 'pt-1'}`}>Running {running.length}</div>
            <div className="space-y-1">{running.map(render)}</div>
          </>
        )}
        {finished.length > 0 && (
          <>
            <button
              onClick={() => setFinishedOpen((o) => !o)}
              className={`flex items-center gap-1 px-2 pb-1.5 text-[13px] text-faint transition-colors hover:text-muted ${running.length || plan ? 'pt-3' : 'pt-1'}`}
            >
              Finished {finished.length}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${finishedOpen ? '' : '-rotate-90'}`}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {finishedOpen && <div className="space-y-1">{finished.map(render)}</div>}
          </>
        )}
      </div>
      )}
    </>
  )

  if (side) {
    return (
      <aside className={`m-2 ml-0 flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-float ${wider ? 'w-[560px] max-w-[60%]' : 'w-[400px]'}`}>
        {body}
      </aside>
    )
  }
  return (
    <div className="mx-auto w-full max-w-[740px] shrink-0 px-6 pt-2">
      <div className="flex max-h-[40vh] flex-col overflow-hidden rounded-xl bg-float">{body}</div>
    </div>
  )
}
