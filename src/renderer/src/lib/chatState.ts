import type {
  ChatBlock,
  ChatEvent,
  ChatHistoryMessage,
  ChatImage,
  ChatMode,
  ChatState,
  ModelChoice,
  RateLimitInfo,
  SlashCommandInfo
} from '../../../shared/chatProtocol'

// What the chat tab shows, folded out of the relay's event log. Pure and cheap:
// a replay is thousands of events, so reduceEvents() takes a whole batch and
// copies the containers once, not once per event.

/**
 * A block as rendered. `final` false = still streaming (or a placeholder for a
 * block that has begun but whose complete `assistant` event has not landed);
 * `idx` is the stream's content-block index, kept only to route deltas.
 */
export type UiBlock =
  | { type: 'text'; text: string; final: boolean; idx?: number }
  | { type: 'thinking'; text: string; final: boolean; idx?: number }
  | { type: 'tool_use'; id: string; name: string; input: unknown; final: boolean; idx?: number }

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

/** A line between messages: context compaction, a failed turn, a relay error. */
export interface NoteItem {
  kind: 'note'
  id: string
  tone: 'info' | 'error'
  text: string
}

export type ChatItem = UserItem | AssistantItem | NoteItem

export interface ToolResult {
  content: string
  isError: boolean
  truncated?: boolean
}

export interface ChatRequest {
  reqId: string
  kind: 'permission' | 'question' | 'plan'
  toolName: string
  toolUseId?: string
  input: unknown
  title?: string
  description?: string
}

export interface ChatUiState {
  /** The main thread, in order. Subagent messages are not in here. */
  items: ChatItem[]
  /** Subagent messages, grouped under the Task/Agent tool call (by its tool_use id) that spawned them. */
  children: Record<string, AssistantItem[]>
  /** Tool output by tool_use id — for main-thread and subagent calls alike. */
  results: Record<string, ToolResult>
  /** Requests waiting on the user, oldest first. */
  requests: ChatRequest[]
  status: ChatState['status']
  mode: ChatMode | null
  model: string | null
  models: ModelChoice[]
  slashCommands: SlashCommandInfo[]
  sessionId: string | null
  cwd: string | null
  /** Sum of every turn's cost. */
  costUsd: number
  /** Context fill as of the last finished turn. */
  context: { inputTokens: number; contextWindow: number } | null
  rateLimit: RateLimitInfo | null
  /** Why the relay exited; null while it is (or may be) running. */
  exited: string | null
  // Internal bookkeeping below.
  /** msgId -> where its item lives, so a delta or a repeated `assistant` event finds it. */
  where: Record<string, { parent: string | null; i: number }>
  /** msgIds that still hold streaming placeholders, to settle when the turn ends. */
  open: string[]
  /** Counter for ids of history rows and notes. */
  seq: number
}

export const initialChatState: ChatUiState = {
  items: [],
  children: {},
  results: {},
  requests: [],
  status: 'starting',
  mode: null,
  model: null,
  models: [],
  slashCommands: [],
  sessionId: null,
  cwd: null,
  costUsd: 0,
  context: null,
  rateLimit: null,
  exited: null,
  where: {},
  open: [],
  seq: 0
}

/** Fold a batch of events into the state. Returns `prev` untouched for an empty batch. */
export function reduceEvents(prev: ChatUiState, events: ChatEvent[]): ChatUiState {
  if (!events.length) return prev
  const s: ChatUiState = {
    ...prev,
    items: prev.items.slice(),
    children: { ...prev.children },
    results: { ...prev.results },
    where: { ...prev.where },
    open: prev.open.slice()
  }
  // Child lists copied already in this batch, so each is copied once, not per event.
  const copied = new Set<string>()
  for (const e of events) apply(s, e, copied)
  return s
}

function childList(s: ChatUiState, parent: string, copied: Set<string>): AssistantItem[] {
  if (!copied.has(parent)) {
    s.children[parent] = (s.children[parent] ?? []).slice()
    copied.add(parent)
  }
  return s.children[parent]
}

function listFor(s: ChatUiState, parent: string | null, copied: Set<string>): ChatItem[] {
  return parent === null ? s.items : childList(s, parent, copied)
}

function getMsg(s: ChatUiState, msgId: string, copied: Set<string>): AssistantItem | undefined {
  const loc = s.where[msgId]
  if (!loc) return undefined
  const it = listFor(s, loc.parent, copied)[loc.i]
  return it && it.kind === 'assistant' ? it : undefined
}

function putMsg(s: ChatUiState, parent: string | null, item: AssistantItem, copied: Set<string>): void {
  const list = listFor(s, parent, copied)
  const loc = s.where[item.msgId]
  if (loc) {
    list[loc.i] = item
  } else {
    list.push(item)
    s.where[item.msgId] = { parent, i: list.length - 1 }
  }
}

function markOpen(s: ChatUiState, msgId: string): void {
  if (!s.open.includes(msgId)) s.open.push(msgId)
}

const finalize = (b: ChatBlock): UiBlock => ({ ...b, final: true }) as UiBlock

function sameBlock(a: UiBlock, b: ChatBlock): boolean {
  if (a.type === 'tool_use') return b.type === 'tool_use' && a.id === b.id
  return b.type === a.type && a.text === b.text
}

/**
 * An `assistant` event is authoritative for the blocks it carries. The SDK emits
 * one block per message (the same msgId repeats per block), so usually these are
 * appended; if the relay instead re-sends the whole list, the first incoming
 * block matches one already final and everything from there is replaced.
 * Streaming placeholders for the blocks that arrive are consumed either way.
 */
function mergeAssistant(existing: UiBlock[], incoming: ChatBlock[]): UiBlock[] {
  const fin = existing.filter((b) => b.final)
  const ph = existing.filter((b) => !b.final)
  const j = incoming.length ? fin.findIndex((f) => sameBlock(f, incoming[0])) : -1
  const kept = j >= 0 ? fin.slice(0, j) : fin
  const fresh = j >= 0 ? incoming.length - (fin.length - j) : incoming.length
  // The trailing `fresh` blocks are new to this message: each takes over a placeholder.
  for (const b of incoming.slice(Math.max(0, incoming.length - fresh))) {
    const at = ph.findIndex((p) =>
      b.type === 'tool_use' ? p.type === 'tool_use' && p.id === b.id : p.type === b.type
    )
    if (at >= 0) ph.splice(at, 1)
  }
  return [...kept, ...incoming.map(finalize), ...ph]
}

/** The turn is over: whatever still streams stays as text, or goes if it holds nothing. */
function settle(s: ChatUiState, copied: Set<string>): void {
  for (const msgId of s.open) {
    const m = getMsg(s, msgId, copied)
    if (!m) continue
    const blocks = m.blocks.flatMap((b): UiBlock[] =>
      b.final ? [b] : b.type === 'text' && b.text ? [{ ...b, final: true }] : []
    )
    putMsg(s, s.where[msgId].parent, { ...m, blocks }, copied)
  }
  s.open = []
}

function note(s: ChatUiState, tone: NoteItem['tone'], text: string): void {
  s.items.push({ kind: 'note', id: `n${s.seq++}`, tone, text })
}

function addHistory(s: ChatUiState, m: ChatHistoryMessage): void {
  if (m.role === 'user') {
    s.items.push({ kind: 'user', id: `h${s.seq++}`, text: m.text })
  } else if (m.role === 'assistant') {
    const msgId = `h${s.seq++}`
    s.items.push({ kind: 'assistant', msgId, blocks: m.blocks.map(finalize) })
    s.where[msgId] = { parent: null, i: s.items.length - 1 }
  } else {
    s.results[m.toolUseId] = { content: m.content, isError: m.isError }
  }
}

function apply(s: ChatUiState, e: ChatEvent, copied: Set<string>): void {
  switch (e.t) {
    case 'ready':
      // A fresh relay process: nothing it was waiting on survives a restart.
      s.exited = null
      s.requests = []
      settle(s, copied)
      return
    case 'init':
      s.sessionId = e.sessionId
      s.model = e.model
      s.cwd = e.cwd
      s.mode = e.mode
      s.slashCommands = e.slashCommands
      s.models = e.models
      s.exited = null
      return
    case 'history':
      for (const m of e.messages) addHistory(s, m)
      return
    case 'user':
      s.items.push({ kind: 'user', id: e.id, text: e.text, images: e.images })
      return
    case 'block_start': {
      const parent = e.parentToolUseId ?? null
      const m = getMsg(s, e.msgId, copied) ?? { kind: 'assistant' as const, msgId: e.msgId, blocks: [] }
      if (m.blocks.some((b) => !b.final && b.idx === e.index)) return
      const ph: UiBlock =
        e.kind === 'tool_use'
          ? { type: 'tool_use', id: e.toolId ?? `${e.msgId}:${e.index}`, name: e.toolName ?? '', input: undefined, final: false, idx: e.index }
          : { type: e.kind, text: '', final: false, idx: e.index }
      putMsg(s, parent, { ...m, blocks: [...m.blocks, ph] }, copied)
      markOpen(s, e.msgId)
      return
    }
    case 'delta': {
      const loc = s.where[e.msgId]
      const m = getMsg(s, e.msgId, copied) ?? { kind: 'assistant' as const, msgId: e.msgId, blocks: [] }
      const at = m.blocks.findIndex((b) => !b.final && b.idx === e.index && b.type === e.kind)
      // Text that arrives for a block we never saw begin still has to show.
      const blocks =
        at >= 0
          ? m.blocks.map((b, k) => (k === at && b.type !== 'tool_use' ? { ...b, text: b.text + e.text } : b))
          : [...m.blocks, { type: e.kind, text: e.text, final: false, idx: e.index } as UiBlock]
      putMsg(s, loc?.parent ?? null, { ...m, blocks }, copied)
      markOpen(s, e.msgId)
      return
    }
    case 'assistant': {
      const m = getMsg(s, e.msgId, copied) ?? { kind: 'assistant' as const, msgId: e.msgId, blocks: [] }
      putMsg(s, s.where[e.msgId]?.parent ?? e.parentToolUseId, { ...m, blocks: mergeAssistant(m.blocks, e.blocks) }, copied)
      return
    }
    case 'tool_result':
      s.results[e.toolUseId] = { content: e.content, isError: e.isError, truncated: e.truncated }
      return
    case 'status':
      s.status = e.status
      if (e.status === 'idle' || e.status === 'exited') settle(s, copied)
      return
    case 'mode':
      s.mode = e.mode
      return
    case 'model':
      s.model = e.model
      return
    case 'request':
      if (s.requests.some((r) => r.reqId === e.reqId)) return
      s.requests = [
        ...s.requests,
        { reqId: e.reqId, kind: e.kind, toolName: e.toolName, toolUseId: e.toolUseId, input: e.input, title: e.title, description: e.description }
      ]
      return
    case 'request_done':
      s.requests = s.requests.filter((r) => r.reqId !== e.reqId)
      return
    case 'result':
      // total_cost_usd is already cumulative across turns: the latest result wins.
      s.costUsd = e.costUsd || s.costUsd
      if (e.inputTokens && e.contextWindow) s.context = { inputTokens: e.inputTokens, contextWindow: e.contextWindow }
      settle(s, copied)
      if (e.isError) note(s, 'error', e.text || e.subtype.replace(/_/g, ' '))
      return
    case 'rate_limit':
      s.rateLimit = e.info
      return
    case 'compact':
      note(s, 'info', e.preTokens ? `Context compacted (was ${Math.round(e.preTokens / 1000)}k tokens)` : 'Context compacted')
      return
    case 'error':
      note(s, 'error', e.message)
      return
    case 'exit':
      s.exited = e.reason
      s.status = 'exited'
      s.requests = []
      settle(s, copied)
      return
  }
}
