import { useEffect, useRef, useState } from 'react'
import type { ChatTarget, WorkflowAgent } from '../../../../shared/chatProtocol'
import type { TaskState } from '../../lib/chatState'

interface Props {
  /** Tasks the panel may list: the caller has dropped the hidden ones. */
  tasks: TaskState[]
  target: ChatTarget
  /** The tab is on screen: journals are only polled then. */
  active: boolean
}

// How often a running workflow's journal is read: each read is an ssh exec.
const JOURNAL_MS = 3000

const card = 'rounded-xl border border-line bg-elevated/60'

function Spinner() {
  return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent" />
}

const Tick = () => <span className="w-3 shrink-0 text-center text-[12px] leading-none text-signal">✓</span>

const statusText = (t: TaskState): string => (t.status && t.status !== 'completed' ? t.status : 'completed')

type PhaseState = 'done' | 'current' | 'waiting'

/** Which phase an agent belongs to: by title, or by index when the journal numbers them. */
function phaseOf(agent: WorkflowAgent, phases: string[]): number {
  const p = agent.phase
  if (p === undefined || p === null || p === '') return -1
  const byTitle = phases.indexOf(String(p))
  if (byTitle >= 0) return byTitle
  return /^\d+$/.test(String(p)) && Number(p) < phases.length ? Number(p) : -1
}

const PHASE_CHIP: Record<PhaseState, string> = {
  done: 'border-signal/40 text-signal',
  current: 'border-accent/60 bg-accent/10 text-accent',
  waiting: 'border-line text-faint'
}

function Chips({ phases, agents, finished }: { phases: string[]; agents: WorkflowAgent[]; finished: boolean }) {
  // Phases the journal names but the script's meta did not: shown after the known ones.
  const extra: string[] = []
  for (const a of agents) {
    if (a.phase && phaseOf(a, phases) < 0 && !extra.includes(String(a.phase))) extra.push(String(a.phase))
  }
  const all = [...phases, ...extra]
  if (!all.length) return null
  const stateOf = (title: string, i: number): PhaseState => {
    const mine = agents.filter((a) => (i < phases.length ? phaseOf(a, phases) === i : String(a.phase) === title))
    if (mine.some((a) => a.state === 'running')) return 'current'
    if (finished || (mine.length > 0 && mine.every((a) => a.state === 'done'))) return 'done'
    return 'waiting'
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((title, i) => {
        const st = stateOf(title, i)
        return (
          <span key={`${i}-${title}`} className={`flex items-center gap-1 rounded-full border px-2 py-px text-[11px] ${PHASE_CHIP[st]}`}>
            {st === 'done' ? '✓' : st === 'current' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
            {title}
          </span>
        )
      })}
    </div>
  )
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
        <span dir="auto" className={`min-w-0 flex-1 truncate text-[13px] ${agent.state === 'running' ? 'text-fg' : 'text-muted'}`}>
          {agent.label}
        </span>
        {agent.agentType && <span className="shrink-0 font-mono text-[10px] text-faint">{agent.agentType}</span>}
        {agent.phase && <span className="shrink-0 text-[11px] text-faint">{agent.phase}</span>}
        {agent.preview && <span className="shrink-0 text-[10px] text-faint">{open ? '▾' : '▸'}</span>}
      </button>
      {open && agent.preview && (
        <pre dir="auto" className="mb-1 ml-5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-soft bg-ink/60 px-2.5 py-1.5 font-mono text-[11px] text-fg/80">
          {agent.preview}
        </pre>
      )}
    </div>
  )
}

function WorkflowRow({ task, target, active }: { task: TaskState; target: ChatTarget; active: boolean }) {
  const [agents, setAgents] = useState<WorkflowAgent[]>([])
  const [open, setOpen] = useState(false)
  const running = task.state === 'running'
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
        const a = await window.api.chatJournal({ ...target, dir })
        if (off) return
        setAgents((prev) => (JSON.stringify(prev) === JSON.stringify(a) ? prev : a))
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

  const doneCount = agents.filter((a) => a.state === 'done').length

  if (!running) {
    const hasDetail = !!task.summary || agents.length > 0
    return (
      <div className={card}>
        <button onClick={() => hasDetail && setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
          <Tick />
          <span dir="auto" className="min-w-0 truncate text-[13px] text-muted">
            {task.name} — {statusText(task)}
          </span>
          {hasDetail && <span className="ml-auto shrink-0 text-[10px] text-faint">{open ? '▾' : '▸'}</span>}
        </button>
        {open && (
          <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
            {task.summary && (
              <div dir="auto" className="whitespace-pre-wrap text-[12px] text-muted">
                {task.summary}
              </div>
            )}
            <Chips phases={task.phases} agents={agents} finished />
            <div className="max-h-48 overflow-y-auto">
              {agents.map((a) => (
                <AgentRow key={a.agentId} agent={a} />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`${card} space-y-2 px-3 py-2.5`}>
      <div className="flex items-center gap-2.5">
        <Spinner />
        <span dir="auto" className="min-w-0 truncate text-[13px] font-medium text-fg">
          {task.name}
        </span>
        <span className="eyebrow shrink-0">Workflow</span>
        {agents.length > 0 && (
          <span className="ml-auto shrink-0 text-[11px] text-faint">
            {doneCount}/{agents.length} agents
          </span>
        )}
      </div>
      <Chips phases={task.phases} agents={agents} finished={false} />
      {agents.length > 0 && (
        <div className="max-h-48 overflow-y-auto">
          {agents.map((a) => (
            <AgentRow key={a.agentId} agent={a} />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentTaskRow({ task }: { task: TaskState }) {
  const running = task.state === 'running'
  return (
    <div className={`${card} flex items-center gap-2.5 px-3 py-2`} title={task.summary || undefined}>
      {running ? <Spinner /> : <Tick />}
      <span dir="auto" className={`min-w-0 truncate text-[13px] ${running ? 'font-medium text-fg' : 'text-muted'}`}>
        {task.name}
        {!running && ` — ${statusText(task)}`}
      </span>
      {running && <span className="eyebrow ml-auto shrink-0">Agent</span>}
    </div>
  )
}

/**
 * Background Workflows and agents, pinned above the composer. A running Workflow
 * shows its phases and agents live, read from its journal. A finished task is one
 * line; the reducer hides it once the next user message arrives.
 */
export function TasksPanel({ tasks, target, active }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  if (!tasks.length) return null
  const running = tasks.filter((t) => t.state === 'running')
  // Running ones first, then the finished lines, each group in launch order.
  const ordered = [...running, ...tasks.filter((t) => t.state === 'done')]
  return (
    <div className="mx-auto w-full max-w-[46rem] shrink-0 px-6 pt-2">
      <button onClick={() => setCollapsed((c) => !c)} className="mb-1.5 flex w-full items-center gap-2 text-left">
        <span className={`eyebrow ${running.length ? '!text-accent' : ''}`}>{running.length ? `Running · ${running.length}` : 'Done'}</span>
        <span className="text-[10px] text-faint">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
          {ordered.map((t) =>
            t.kind === 'workflow' ? (
              <WorkflowRow key={t.toolUseId} task={t} target={target} active={active} />
            ) : (
              <AgentTaskRow key={t.toolUseId} task={t} />
            )
          )}
        </div>
      )}
    </div>
  )
}
