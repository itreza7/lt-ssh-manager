// The relay: a small Node process that runs on the remote host, inside tmux, and
// drives Claude Code through the Agent SDK for one chat tab. The app never talks
// to it directly — it appends commands to inbox.jsonl and tails events.jsonl, so
// a sleeping laptop or a dropped connection loses nothing (see
// shared/chatProtocol.ts for the contract).
//
// Bundled by vite.relay.config.ts into resources/relay.mjs with the SDK inlined,
// so the host needs nothing but Node. Run as: `node relay.mjs <absolute chatDir>`.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, PermissionMode, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  RELAY_VERSION,
  type ChatBlock,
  type ChatCommand,
  type ChatConfig,
  type ChatEventBody,
  type ChatHistoryMessage,
  type ChatImage,
  type ChatMode,
  type ChatState,
  type ModelChoice,
  type RateLimitInfo,
  type SlashCommandInfo
} from '../shared/chatProtocol'
import { projectSlug } from '../shared/claudeTranscript'

// SDK messages are consumed by shape, not by the SDK's union: the relay only reads
// the fields the contract needs, and a field a newer Claude Code adds is ignored.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

const TOOL_RESULT_CAP = 20_000
const HISTORY_MESSAGES = 400
const HISTORY_RESULT_CAP = 4_000
const DELTA_FLUSH_MS = 50
const INBOX_POLL_MS = 150

const chatDir = process.argv[2]
if (!chatDir) {
  process.stderr.write('usage: node relay.mjs <chatDir>\n')
  process.exit(2)
}
const eventsPath = join(chatDir, 'events.jsonl')
const inboxPath = join(chatDir, 'inbox.jsonl')
const statePath = join(chatDir, 'state.json')
const logPath = join(chatDir, 'relay.log')

function log(line: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // The log is best effort; it must never take the relay down.
  }
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

mkdirSync(chatDir, { recursive: true })
const config = readJson<ChatConfig>(join(chatDir, 'config.json'))
if (!config) {
  process.stderr.write(`relay: cannot read ${join(chatDir, 'config.json')}\n`)
  process.exit(2)
}
// A restarted relay carries on from what the last run left in state.json: the
// session it had, the model and mode the user switched to since config.json.
const prior = readJson<ChatState>(statePath)

// ---- events.jsonl ----

/** The last `seq` in an existing events.jsonl, so a restarted relay continues the count. */
function lastSeq(): number {
  let size = 0
  try {
    size = statSync(eventsPath).size
  } catch {
    return 0
  }
  if (!size) return 0
  const fd = openSync(eventsPath, 'r')
  try {
    // Walk back in growing windows until a whole last line is in hand — one event
    // (a history, a big tool result) can be far longer than any fixed tail.
    for (let len = 64 * 1024; ; len *= 4) {
      const start = Math.max(0, size - len)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString('utf8')
      const lines = text.split('\n').filter((l) => l.trim())
      // Drop the first line unless the window reaches the file start: it may be cut.
      for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
        try {
          const ev = JSON.parse(lines[i]) as { seq?: number }
          if (typeof ev.seq === 'number') return ev.seq
        } catch {
          // A torn last line from a crash — fall back to the one before it.
        }
      }
      if (start === 0) return 0
    }
  } finally {
    closeSync(fd)
  }
}

const eventsWereEmpty = !existsSync(eventsPath) || statSync(eventsPath).size === 0
let seq = lastSeq()
// A crash mid-write could leave the file without a trailing newline; start on a fresh line.
try {
  if (!eventsWereEmpty) {
    const fd = openSync(eventsPath, 'r')
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, statSync(eventsPath).size - 1)
    closeSync(fd)
    if (last[0] !== 10) appendFileSync(eventsPath, '\n')
  }
} catch {
  // Fine — worst case one line is lost to the parser.
}

/** Write one event now. One appendFileSync per line, so a reader never sees half an event. */
function writeEvent(body: ChatEventBody): void {
  seq++
  state.seq = seq
  try {
    appendFileSync(eventsPath, JSON.stringify({ ...body, seq, ts: Date.now() }) + '\n')
  } catch (e) {
    log(`append failed: ${String(e)}`)
  }
}

// Text deltas are coalesced per (msgId, index) and flushed on a timer, and before
// any other event so the stream keeps its order.
const pendingDeltas = new Map<string, { msgId: string; index: number; kind: 'text' | 'thinking'; text: string }>()
let deltaTimer: NodeJS.Timeout | null = null

function flushDeltas(): void {
  if (deltaTimer) {
    clearTimeout(deltaTimer)
    deltaTimer = null
  }
  for (const d of pendingDeltas.values()) writeEvent({ t: 'delta', ...d })
  pendingDeltas.clear()
}

function addDelta(msgId: string, index: number, kind: 'text' | 'thinking', text: string): void {
  const key = `${msgId}:${index}`
  const cur = pendingDeltas.get(key)
  if (cur) cur.text += text
  else pendingDeltas.set(key, { msgId, index, kind, text })
  if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
}

function emit(body: ChatEventBody): void {
  flushDeltas()
  writeEvent(body)
  saveState()
}

// ---- state.json ----

const state: ChatState = {
  chatId: config.chatId,
  pid: process.pid,
  sessionId: prior?.sessionId,
  cwd: config.cwd,
  model: prior?.model ?? config.model,
  mode: prior?.mode ?? config.mode,
  title: config.title ?? prior?.title,
  status: 'starting',
  inboxOffset: prior?.inboxOffset ?? 0,
  seq,
  updatedAt: Date.now()
}

/** Atomic (tmp + rename): the app lists chats by reading this while the relay rewrites it. */
function saveState(): void {
  state.updatedAt = Date.now()
  const tmp = `${statePath}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, statePath)
  } catch (e) {
    log(`state write failed: ${String(e)}`)
  }
}

let pendingTurns = 0
const requests = new Map<string, OpenRequest>()

function setStatus(status: ChatState['status']): void {
  if (state.status === status) return
  state.status = status
  emit({ t: 'status', status })
}

/** What the status should be when nothing changes it explicitly. */
function settleStatus(): void {
  setStatus(requests.size ? 'waiting' : pendingTurns > 0 ? 'running' : 'idle')
}

// ---- modes ----

/** `bypass` is the relay's own mode: the SDK runs in `default` and the relay allows each tool itself. */
const sdkMode = (m: ChatMode): PermissionMode => (m === 'bypass' ? 'default' : m)

let mode: ChatMode = state.mode
/** The mode to go back to when a plan is approved (or Claude leaves plan mode). */
let prePlanMode: ChatMode = mode === 'plan' ? 'bypass' : mode
/** Until this time a stray SDK mode report is corrected back to `mode` (see ExitPlanMode). */
let restoreUntil = 0

function changeMode(next: ChatMode): void {
  if (next === mode) return
  if (next === 'plan' && mode !== 'plan') prePlanMode = mode
  mode = next
  state.mode = next
  emit({ t: 'mode', mode: next })
}

// ---- requests: canUseTool promises waiting on the user ----

interface OpenRequest {
  kind: 'permission' | 'question' | 'plan'
  input: Record<string, unknown>
  resolve: (r: PermissionResult) => void
  cleanup: () => void
}

function settleRequest(reqId: string, result: PermissionResult, outcome: 'allow' | 'deny' | 'cancelled'): void {
  const req = requests.get(reqId)
  if (!req) return
  requests.delete(reqId)
  req.cleanup()
  req.resolve(result)
  emit({ t: 'request_done', reqId, outcome })
  settleStatus()
  if (req.kind === 'plan' && outcome === 'allow') leavePlanMode()
}

/** Approving a plan drops the SDK to `default`; put back the mode the user had before. */
function leavePlanMode(): void {
  const back = prePlanMode
  restoreUntil = Date.now() + 10_000
  changeMode(back)
  void q.setPermissionMode(sdkMode(back)).catch((e) => log(`setPermissionMode failed: ${String(e)}`))
}

function cancelAllRequests(): void {
  for (const reqId of [...requests.keys()]) {
    settleRequest(reqId, { behavior: 'deny', message: 'The user interrupted.', interrupt: true }, 'cancelled')
  }
}

const canUseTool: CanUseTool = (toolName, input, opts) => {
  const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission'
  // The relay's bypass: allow everything except the two tools that exist to ask the user.
  if (kind === 'permission' && mode === 'bypass') return Promise.resolve({ behavior: 'allow', updatedInput: input })
  return new Promise<PermissionResult>((resolve) => {
    const reqId = `r${randomBytes(6).toString('hex')}`
    const onAbort = (): void => settleRequest(reqId, { behavior: 'deny', message: 'The request was cancelled.' }, 'cancelled')
    opts.signal.addEventListener('abort', onAbort, { once: true })
    requests.set(reqId, { kind, input, resolve, cleanup: () => opts.signal.removeEventListener('abort', onAbort) })
    emit({ t: 'request', reqId, kind, toolName, toolUseId: opts.toolUseID, input, title: opts.title, description: opts.description })
    setStatus('waiting')
  })
}

// ---- the SDK query, fed from a queue ----

const inQueue: SDKUserMessage[] = []
let wake: (() => void) | null = null
let closing = false

/** The query's input. It must never throw — a throw here would end the session. */
async function* inputStream(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (inQueue.length) yield inQueue.shift() as SDKUserMessage
    if (closing) return
    await new Promise<void>((r) => (wake = r))
    wake = null
  }
}

function pushUser(cmd: { id: string; text: string; images?: ChatImage[] }): void {
  const content: Loose[] = (cmd.images ?? []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }))
  content.push({ type: 'text', text: cmd.text })
  inQueue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage)
  wake?.()
  if (!state.title) state.title = cmd.text.trim().replace(/\s+/g, ' ').slice(0, 80)
  pendingTurns++
  emit({ t: 'user', id: cmd.id, text: cmd.text, images: cmd.images?.length ? cmd.images : undefined })
  settleStatus()
}

// ---- resumed conversation ----

// Text Claude Code injects into user turns that the user never typed (the same
// set shared/claudeTranscript.ts skips).
const SYNTHETIC_USER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr)>/

/** Long strings inside tool input (a Write's whole file) would bloat the one history event. */
function shrink(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v
  if (Array.isArray(v)) return v.map(shrink)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]))
  return v
}

function findTranscript(sessionId: string, cwd: string): string | null {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const direct = join(root, projectSlug(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // A cwd whose slug was cut and hashed, or a session started elsewhere: look everywhere.
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir yet.
  }
  return null
}

function loadHistory(sessionId: string, cwd: string): ChatHistoryMessage[] {
  const file = findTranscript(sessionId, cwd)
  if (!file) return []
  const out: ChatHistoryMessage[] = []
  let lastAssistantId = ''
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r: Loose
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isSidechain || r.isCompactSummary) continue
    const content = r.message?.content
    const blocks: Loose[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    if (r.type === 'user') {
      lastAssistantId = ''
      const text: string[] = []
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool_result', toolUseId: String(b.tool_use_id), content: textOf(b.content).slice(0, HISTORY_RESULT_CAP), isError: b.is_error === true })
        } else if (b.type === 'text' && b.text?.trim() && !SYNTHETIC_USER.test(b.text)) {
          text.push(b.text)
        }
      }
      if (text.length) out.push({ role: 'user', text: text.join('\n') })
    } else {
      const mine: ChatBlock[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) mine.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') mine.push({ type: 'tool_use', id: String(b.id), name: String(b.name), input: shrink(b.input) })
      }
      if (!mine.length) continue
      // The transcript stores one record per block, the same message id repeated.
      const id = String(r.message?.id ?? '')
      const prev = out[out.length - 1]
      if (id && id === lastAssistantId && prev?.role === 'assistant') prev.blocks.push(...mine)
      else out.push({ role: 'assistant', blocks: mine })
      lastAssistantId = id
    }
  }
  return out.slice(-HISTORY_MESSAGES)
}

const resumeId = prior?.sessionId ?? config.resume

// Resumed chat with no events yet: show the earlier conversation first.
if (resumeId && eventsWereEmpty) {
  emit({ t: 'ready', pid: process.pid, relayVersion: RELAY_VERSION })
  try {
    const messages = loadHistory(resumeId, config.cwd)
    if (messages.length) emit({ t: 'history', messages })
  } catch (e) {
    log(`history failed: ${String(e)}`)
  }
} else {
  emit({ t: 'ready', pid: process.pid, relayVersion: RELAY_VERSION })
}

const q: Query = query({
  prompt: inputStream(),
  options: {
    pathToClaudeCodeExecutable: config.claudePath,
    cwd: config.cwd,
    ...(state.model ? { model: state.model } : {}),
    ...(resumeId ? { resume: resumeId } : {}),
    permissionMode: sdkMode(mode),
    includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    canUseTool,
    stderr: (data) => log(`[claude] ${data.trimEnd()}`)
  }
})

// ---- SDK message -> events ----

/** Resolved model id from system/init; state.model can become an alias after set_model. */
let initModel = ''
/** Prompt size of the latest main-thread request: what fills the context window (result.usage sums every call in the turn). */
let lastCtx = 0

/** Streaming message id per parent tool use ('' = the main thread), set by message_start. */
const curMsg = new Map<string, string>()
/** Content blocks of each assistant message so far: the SDK sends one block per message, repeating the id. */
const assistantBlocks = new Map<string, ChatBlock[]>()

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // Images become a placeholder; other non-text blocks (tool_reference…) carry nothing to show.
  return content
    .map((b: Loose) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

function toBlock(b: Loose): ChatBlock | null {
  if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') }
  if (b.type === 'thinking') return { type: 'thinking', text: String(b.thinking ?? '') }
  if (b.type === 'tool_use') return { type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input }
  return null
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

let lastInit = ''

async function emitInit(): Promise<void> {
  const [cmds, models] = await Promise.all([
    withTimeout(q.supportedCommands().catch(() => []), 8000, []),
    withTimeout(q.supportedModels().catch(() => []), 8000, [])
  ])
  const slashCommands: SlashCommandInfo[] = cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }))
  const choices: ModelChoice[] = models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }))
  // The SDK starts the session on the first message, so commands_changed can fire
  // before system/init: sessionId is then empty. An identical init is not re-sent.
  const init: ChatEventBody = { t: 'init', sessionId: state.sessionId ?? '', model: state.model ?? '', cwd: state.cwd, mode, slashCommands, models: choices }
  const key = JSON.stringify(init)
  if (key === lastInit) return
  lastInit = key
  emit(init)
}

function onStream(msg: Loose): void {
  const ev = msg.event as Loose
  const parent = (msg.parent_tool_use_id as string | null) ?? null
  const pk = parent ?? ''
  if (ev.type === 'message_start') {
    curMsg.set(pk, String(ev.message?.id ?? ''))
    if (parent === null) {
      const u = (ev.message?.usage ?? {}) as Loose
      const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      if (n > 0) lastCtx = n
    }
    return
  }
  const msgId = curMsg.get(pk) || `m-${pk}`
  if (ev.type === 'content_block_start') {
    const cb = ev.content_block as Loose
    if (cb.type !== 'text' && cb.type !== 'thinking' && cb.type !== 'tool_use') return
    emit({
      t: 'block_start',
      msgId,
      index: ev.index,
      kind: cb.type,
      toolName: cb.type === 'tool_use' ? cb.name : undefined,
      toolId: cb.type === 'tool_use' ? cb.id : undefined,
      parentToolUseId: parent
    })
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta as Loose
    if (d.type === 'text_delta') addDelta(msgId, ev.index, 'text', String(d.text ?? ''))
    else if (d.type === 'thinking_delta') addDelta(msgId, ev.index, 'thinking', String(d.thinking ?? ''))
  }
}

function onAssistant(msg: Loose): void {
  const id = String(msg.message?.id ?? '')
  const blocks = assistantBlocks.get(id) ?? []
  for (const b of (msg.message?.content ?? []) as Loose[]) {
    const block = toBlock(b)
    if (block) blocks.push(block)
  }
  assistantBlocks.delete(id)
  assistantBlocks.set(id, blocks)
  // Keep only recent messages; older ones never get another block.
  if (assistantBlocks.size > 200) assistantBlocks.delete(assistantBlocks.keys().next().value as string)
  emit({ t: 'assistant', msgId: id, blocks: [...blocks], parentToolUseId: (msg.parent_tool_use_id as string | null) ?? null })
}

function onUser(msg: Loose): void {
  const content = msg.message?.content
  if (!Array.isArray(content)) return
  for (const b of content as Loose[]) {
    if (b?.type !== 'tool_result') continue
    let text = textOf(b.content)
    const truncated = text.length > TOOL_RESULT_CAP
    if (truncated) text = text.slice(0, TOOL_RESULT_CAP)
    emit({
      t: 'tool_result',
      toolUseId: String(b.tool_use_id),
      content: text,
      isError: b.is_error === true,
      parentToolUseId: (msg.parent_tool_use_id as string | null) ?? null,
      truncated: truncated || undefined
    })
  }
}

function onResult(msg: Loose): void {
  // modelUsage is keyed by resolved model id; the main model is the one the session runs.
  const mu = (msg.modelUsage ?? {}) as Record<string, Loose>
  const keys = Object.keys(mu)
  const m = initModel || state.model
  const key = keys.find((k) => k === m) ?? keys.find((k) => m && (k.startsWith(m) || m.startsWith(k))) ?? keys[0]
  // Queued sends can coalesce into fewer turns, so trust the SDK's own count of what is still pending.
  pendingTurns = typeof msg.queued_turn_count === 'number' ? msg.queued_turn_count : 0
  emit({
    t: 'result',
    isError: msg.is_error === true,
    subtype: String(msg.subtype ?? ''),
    costUsd: Number(msg.total_cost_usd ?? 0),
    durationMs: msg.duration_ms,
    numTurns: msg.num_turns,
    text: typeof msg.result === 'string' ? msg.result : undefined,
    contextWindow: key ? mu[key]?.contextWindow : undefined,
    inputTokens: lastCtx || undefined
  })
  settleStatus()
}

function onRateLimit(msg: Loose): void {
  const i = (msg.rate_limit_info ?? {}) as Loose
  const windows: NonNullable<RateLimitInfo['windows']> = {}
  for (const [name, w] of Object.entries((i.unifiedWindows ?? {}) as Record<string, Loose>)) {
    if (typeof w?.utilization === 'number') windows[name] = { utilization: w.utilization, resetsAt: w.resetsAt }
  }
  emit({
    t: 'rate_limit',
    info: { status: String(i.status ?? ''), rateLimitType: i.rateLimitType, resetsAt: i.resetsAt, windows: Object.keys(windows).length ? windows : undefined }
  })
}

function onSystem(msg: Loose): void {
  switch (msg.subtype) {
    case 'init':
      state.sessionId = msg.session_id
      if (msg.model) {
        state.model = msg.model
        initModel = String(msg.model)
      }
      saveState()
      void withTimeout(emitInit(), 20_000, undefined).catch((e) => log(`init failed: ${String(e)}`))
      break
    case 'commands_changed':
      void withTimeout(emitInit(), 20_000, undefined).catch((e) => log(`init failed: ${String(e)}`))
      break
    case 'status': {
      const pm = msg.permissionMode as PermissionMode | undefined
      if (!pm) break
      if (pm === 'plan' && mode !== 'plan') {
        // Claude entered plan mode on its own (EnterPlanMode).
        changeMode('plan')
      } else if (pm !== 'plan' && Date.now() < restoreUntil && pm !== sdkMode(mode)) {
        // ExitPlanMode also resets the SDK to `default`, possibly after our restore.
        void q.setPermissionMode(sdkMode(mode)).catch((e) => log(`setPermissionMode failed: ${String(e)}`))
      }
      break
    }
    case 'compact_boundary':
      emit({ t: 'compact', trigger: msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto', preTokens: msg.compact_metadata?.pre_tokens })
      break
    // hook_started, hook_response, thinking_tokens and the rest: not shown.
  }
}

function onMessage(msg: Loose): void {
  switch (msg.type) {
    case 'stream_event':
      onStream(msg)
      break
    case 'assistant':
      onAssistant(msg)
      break
    case 'user':
      onUser(msg)
      break
    case 'result':
      onResult(msg)
      break
    case 'rate_limit_event':
      onRateLimit(msg)
      break
    case 'system':
      onSystem(msg)
      break
  }
}

// ---- commands from the app ----

function handleCommand(cmd: ChatCommand): void {
  switch (cmd.t) {
    case 'user':
      pushUser(cmd)
      break
    case 'interrupt':
      cancelAllRequests()
      void q.interrupt().catch((e) => log(`interrupt failed: ${String(e)}`))
      break
    case 'set_model':
      state.model = cmd.model
      emit({ t: 'model', model: cmd.model })
      void q.setModel(cmd.model).catch((e) => emit({ t: 'error', message: `Could not switch model: ${String(e)}` }))
      break
    case 'set_mode':
      changeMode(cmd.mode)
      void q.setPermissionMode(sdkMode(cmd.mode)).catch((e) => emit({ t: 'error', message: `Could not switch mode: ${String(e)}` }))
      break
    case 'answer': {
      const req = requests.get(cmd.reqId)
      if (!req) break
      if (cmd.decision === 'allow') {
        const updated = (cmd.updatedInput ?? req.input) as Record<string, unknown>
        settleRequest(cmd.reqId, { behavior: 'allow', updatedInput: updated }, 'allow')
      } else {
        settleRequest(cmd.reqId, { behavior: 'deny', message: cmd.message || 'The user declined.' }, 'deny')
      }
      break
    }
    case 'stop':
      exitNow('stopped', 0)
      break
  }
}

/** Consume whole new lines of inbox.jsonl; the offset only moves past a line once it is handled. */
function pollInbox(): void {
  let size: number
  try {
    size = statSync(inboxPath).size
  } catch {
    return
  }
  if (size <= state.inboxOffset) return
  const buf = Buffer.alloc(size - state.inboxOffset)
  const fd = openSync(inboxPath, 'r')
  try {
    readSync(fd, buf, 0, buf.length, state.inboxOffset)
  } finally {
    closeSync(fd)
  }
  let from = 0
  for (let nl = buf.indexOf(10, from); nl !== -1; nl = buf.indexOf(10, from)) {
    const line = buf.subarray(from, nl).toString('utf8')
    state.inboxOffset += nl + 1 - from
    from = nl + 1
    try {
      if (line.trim()) handleCommand(JSON.parse(line) as ChatCommand)
    } catch (e) {
      log(`bad inbox line: ${String(e)}`)
    }
    saveState()
  }
}

// ---- lifecycle ----

let exiting = false
function exitNow(reason: string, code: number): void {
  if (exiting) return
  exiting = true
  closing = true
  wake?.()
  if (deltaTimer) clearTimeout(deltaTimer)
  state.status = 'exited'
  emit({ t: 'exit', reason })
  try {
    q.close()
  } catch {
    // Already gone.
  }
  process.exit(code)
}

function fatal(message: string): void {
  if (exiting) return
  log(`fatal: ${message}`)
  emit({ t: 'error', message })
  exitNow('error', 1)
}

process.on('SIGTERM', () => exitNow('SIGTERM', 0))
process.on('SIGHUP', () => exitNow('SIGHUP', 0))
process.on('SIGINT', () => exitNow('SIGINT', 0))
process.on('uncaughtException', (e) => fatal(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`))
process.on('unhandledRejection', (e) => {
  // A rejected control request (interrupt, setModel) must not end the chat.
  log(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
})

setInterval(() => {
  try {
    pollInbox()
  } catch (e) {
    log(`poll failed: ${String(e)}`)
  }
}, INBOX_POLL_MS)

saveState()
// Leaves `starting`: nothing is running until the first message.
settleStatus()

void (async () => {
  try {
    // Iterate to the end — a `result` is the end of a turn, not of the session.
    for await (const msg of q) {
      try {
        onMessage(msg as Loose)
      } catch (e) {
        log(`message handler failed: ${String(e)}`)
      }
    }
    if (!exiting) {
      emit({ t: 'error', message: 'The Claude process ended unexpectedly.' })
      exitNow('claude ended', 1)
    }
  } catch (e) {
    fatal(e instanceof Error ? e.message : String(e))
  }
})()
