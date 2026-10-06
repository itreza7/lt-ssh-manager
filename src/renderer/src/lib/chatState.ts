import type { ChatBlock, ChatEvent, ChatImage, ChatMode } from '../../../shared/chatProtocol'

// What the chat tab shows, folded out of the ChatEvents that transcriptEvents.ts
// builds from Claude Code's transcript, plus the status poll. Pure and cheap: the
// first load is thousands of events, so reduceEvents() takes a whole batch and
// copies the containers once, not once per event.

/** A block as rendered. The transcript only holds finished blocks, so there is no streaming state. */
export type UiBlock = ChatBlock

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images?: ChatImage[]
}

export interface AssistantItem {
  kind: 'assistant'
  msgId: string
  blocks: UiBlock[]
}

/**
 * A line between messages: context compaction. With a `title` it is a card of
 * monospace output instead (a local command's, like `/context`).
 */
export interface NoteItem {
  kind: 'note'
  id: string
  tone: 'info' | 'error'
  text: string
  title?: string
}

export type ChatItem = UserItem | AssistantItem | NoteItem

export interface ToolResult {
  content: string
  isError: boolean
  truncated?: boolean
}

/** A question or plan waiting on the user. A permission prompt is not here: it is status `waiting`. */
export interface ChatRequest {
  /** The tool_use id. */
  reqId: string
  kind: 'question' | 'plan'
  toolName: string
  input: unknown
}

/** A background Workflow or Agent: running until its task-notification arrives. */
export interface TaskState {
  /** The tool_use id that launched it: the key. */
  toolUseId: string
  taskId?: string
  kind: 'workflow' | 'agent'
  name: string
  phases: string[]
  /** Workflow only: where its journal.jsonl lives on the host. */
  dir?: string
  state: 'running' | 'done'
  /** completed, failed, killed… as the notification says. */
  status?: string
  summary?: string
  startedAt: number
  /** Finished, and a user message came after: the panel no longer lists it. */
  hidden?: boolean
}

export interface ChatUiState {
  /** The main thread, in order. Subagent messages are not in here. */
  items: ChatItem[]
  /** Subagent messages, grouped under the Task/Agent tool call (by its tool_use id) that spawned them. */
  children: Record<string, AssistantItem[]>
  /** Tool output by tool_use id — for main-thread and subagent calls alike. */
  results: Record<string, ToolResult>
  /** Questions and plans waiting on the user, oldest first. */
  requests: ChatRequest[]
  /** Claude Code's own status, from the status poll. `ended` = no live Claude for this session. */
  status: 'idle' | 'busy' | 'waiting' | 'ended'
  /** What `waiting` is waiting for, when Claude Code says. */
  waitingFor: string | null
  /** A turn is under way: set by a user message (not a slash command) or `busy`; cleared by `result`, `idle`, `ended`. */
  turn: boolean
  mode: ChatMode | null
  model: string | null
  /** The git branch the session works on, once a record names it. */
  branch: string | null
  /** Background tasks by tool_use id, in launch order. */
  tasks: Record<string, TaskState>
  /** Prompt size of the last assistant message: what fills the context window. */
  context: { inputTokens: number } | null
  // Internal bookkeeping below.
  /** msgId -> where its item lives, so a repeated `assistant` event finds it. */
  where: Record<string, { parent: string | null; i: number }>
}

export const initialChatState: ChatUiState = {
  items: [],
  children: {},
  results: {},
  requests: [],
  status: 'idle',
  waitingFor: null,
  turn: false,
  mode: null,
  model: null,
  branch: null,
  tasks: {},
  context: null,
  where: {}
}

/** Fold a batch of events into the state. Returns `prev` untouched for an empty batch. */
export function reduceEvents(prev: ChatUiState, events: ChatEvent[]): ChatUiState {
  if (!events.length) return prev
  const s: ChatUiState = {
    ...prev,
    items: prev.items.slice(),
    children: { ...prev.children },
    results: { ...prev.results },
    tasks: { ...prev.tasks },
    where: { ...prev.where }
  }
  // Child lists copied already in this batch, so each is copied once, not per event.
  const copied = new Set<string>()
  for (const e of events) apply(s, e, copied)
  return s
}

function listFor(s: ChatUiState, parent: string | null, copied: Set<string>): ChatItem[] {
  if (parent === null) return s.items
  if (!copied.has(parent)) {
    s.children[parent] = (s.children[parent] ?? []).slice()
    copied.add(parent)
  }
  return s.children[parent]
}

/** An assistant message is replaced in place when it grows, so its place in the thread is where it began. */
function putMsg(s: ChatUiState, parent: string | null, item: AssistantItem, copied: Set<string>): void {
  const loc = s.where[item.msgId]
  if (loc) {
    ;(listFor(s, loc.parent, copied) as AssistantItem[])[loc.i] = item
  } else {
    const list = listFor(s, parent, copied)
    list.push(item)
    s.where[item.msgId] = { parent, i: list.length - 1 }
  }
}

function apply(s: ChatUiState, e: ChatEvent, copied: Set<string>): void {
  switch (e.t) {
    case 'user':
      s.items.push({ kind: 'user', id: e.id, text: e.text, images: e.images })
      // A slash command is a local command: it writes no turn_duration, so it must not start a turn.
      if (!e.text.startsWith('/')) s.turn = true
      // The next thing the user says is the end of a finished task's panel line.
      for (const id in s.tasks) {
        if (s.tasks[id].state === 'done' && !s.tasks[id].hidden) s.tasks[id] = { ...s.tasks[id], hidden: true }
      }
      return
    case 'assistant':
      putMsg(s, e.parentToolUseId, { kind: 'assistant', msgId: e.msgId, blocks: e.blocks }, copied)
      return
    case 'tool_result':
      s.results[e.toolUseId] = { content: e.content, isError: e.isError, truncated: e.truncated }
      // The tool ran, so a question or plan on it was answered (here or in the terminal).
      if (s.requests.some((r) => r.reqId === e.toolUseId)) s.requests = s.requests.filter((r) => r.reqId !== e.toolUseId)
      return
    case 'status':
      s.status = e.status
      s.waitingFor = e.status === 'waiting' ? (e.waitingFor ?? null) : null
      if (e.status === 'busy') s.turn = true
      else if (e.status === 'idle' || e.status === 'ended') s.turn = false
      if (e.status === 'ended') s.requests = []
      return
    case 'mode':
      s.mode = e.mode
      return
    case 'model':
      s.model = e.model
      return
    case 'branch':
      s.branch = e.branch
      return
    case 'usage':
      s.context = { inputTokens: e.inputTokens }
      return
    case 'request':
      if (s.requests.some((r) => r.reqId === e.reqId)) return
      s.requests = [...s.requests, { reqId: e.reqId, kind: e.kind, toolName: e.toolName, input: e.input }]
      return
    case 'request_done':
      s.requests = s.requests.filter((r) => r.reqId !== e.reqId)
      return
    case 'result':
      // A finished turn has nothing left to ask.
      s.turn = false
      s.requests = []
      return
    case 'task': {
      // Emitted twice (the launch, then its result with the task id and journal dir): merge.
      const old = s.tasks[e.toolUseId]
      s.tasks[e.toolUseId] = {
        toolUseId: e.toolUseId,
        taskId: e.taskId ?? old?.taskId,
        kind: e.kind,
        name: e.name || old?.name || (e.kind === 'workflow' ? 'Workflow' : 'Agent'),
        phases: e.phases.length ? e.phases : (old?.phases ?? []),
        dir: e.dir ?? old?.dir,
        state: old?.state ?? 'running',
        status: old?.status,
        summary: old?.summary,
        startedAt: old?.startedAt ?? Date.now()
      }
      return
    }
    case 'task_done': {
      const id = Object.keys(s.tasks).find(
        (k) => (e.toolUseId && k === e.toolUseId) || (e.taskId && s.tasks[k].taskId === e.taskId)
      )
      if (id) s.tasks[id] = { ...s.tasks[id], state: 'done', status: e.status, summary: e.summary }
      return
    }
    case 'note':
      s.items.push({ kind: 'note', id: e.id, tone: 'info', text: e.text, title: e.title })
      return
    case 'compact':
      s.items.push({
        kind: 'note',
        id: `compact-${e.id}`,
        tone: 'info',
        text: e.preTokens ? `Context compacted (was ${Math.round(e.preTokens / 1000)}k tokens)` : 'Context compacted'
      })
      return
  }
}

/**
 * Put `older` — the state of an earlier part of the transcript, read by its own
 * mapper — in front of `cur`. Anything live (status, requests, mode…) is cur's.
 * An assistant message cut by the boundary is in both: its blocks join in the
 * older slot.
 */
export function prependState(older: ChatUiState, cur: ChatUiState): ChatUiState {
  const join = (a: AssistantItem, b: AssistantItem): AssistantItem => {
    const blocks = a.blocks.slice()
    for (const x of b.blocks) {
      if (!blocks.some((y) => (x.type === 'tool_use' ? y.type === 'tool_use' && y.id === x.id : y.type === x.type && 'text' in y && y.text === x.text))) blocks.push(x)
    }
    return { ...a, blocks }
  }
  const merge = <T extends ChatItem>(a: T[], b: T[]): T[] => {
    const out = a.slice()
    const at = new Map<string, number>()
    out.forEach((it, i) => it.kind === 'assistant' && at.set(it.msgId, i))
    for (const it of b) {
      const i = it.kind === 'assistant' ? at.get(it.msgId) : undefined
      if (i === undefined) out.push(it)
      else out[i] = join(out[i] as AssistantItem, it as AssistantItem) as T
    }
    return out
  }
  const items = merge(older.items, cur.items)
  const children: Record<string, AssistantItem[]> = { ...older.children }
  for (const k in cur.children) children[k] = children[k] ? merge(children[k], cur.children[k]) : cur.children[k]
  const where: ChatUiState['where'] = {}
  items.forEach((it, i) => {
    if (it.kind === 'assistant') where[it.msgId] = { parent: null, i }
  })
  for (const k in children) children[k].forEach((it, i) => (where[it.msgId] = { parent: k, i }))
  const tasks: Record<string, TaskState> = {}
  // Older tasks are history: their task-notification may be in cur, where it found no task to finish.
  for (const k in older.tasks) if (!cur.tasks[k]) tasks[k] = { ...older.tasks[k], hidden: true }
  Object.assign(tasks, cur.tasks)
  return {
    ...cur,
    items,
    children,
    results: { ...older.results, ...cur.results },
    tasks,
    mode: cur.mode ?? older.mode,
    model: cur.model ?? older.model,
    branch: cur.branch ?? older.branch,
    context: cur.context ?? older.context,
    where
  }
}
