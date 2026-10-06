// Turns the records of Claude Code's own transcript (see claudeTranscript.ts) into
// the ChatEvents the chat tab renders. The mapper is stateful because the
// transcript is not one record per thing: an assistant message is written as one
// record per content block (the same message.id repeated), and a question or plan
// request only ends when a later record carries its tool_result.
//
// Records arrive in file order, in batches. The first batch starts mid-file (the
// last 4 MiB), so a tool_result can name a tool_use that was never seen: tolerated.
import type { ChatBlock, ChatEvent, ChatImage, ChatMode } from './chatProtocol'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

export const TOOL_RESULT_CAP = 20_000
/** Assistant messages kept for merging block-per-record; older ones never get another block. */
const MAX_MESSAGES = 200

const MODES: ReadonlySet<string> = new Set<ChatMode>(['bypassPermissions', 'default', 'acceptEdits', 'plan'])
const REQUEST_KIND: Record<string, 'question' | 'plan'> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }

// Text Claude Code injects into user turns that the user never typed (the same
// set claudeTranscript.ts skips).
const SYNTHETIC_USER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification)>/

/** What a background Workflow or Agent call said it was, kept to merge into its tool_result. */
interface TaskInfo {
  kind: 'workflow' | 'agent'
  name: string
  phases: string[]
}
const MAX_TASKS = 200
const NOTE_CAP = 20_000

// ANSI: CSI sequences and OSC strings.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** The quoted JS string literal starting at `src[at]`: its value and the index after it, or null. */
function jsString(src: string, at: number): { value: string; end: number } | null {
  const q = src[at]
  if (q !== '"' && q !== "'" && q !== '`') return null
  let value = ''
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') value += src[++i] ?? ''
    else if (c === q) return { value, end: i + 1 }
    else value += c
  }
  return null
}

/**
 * Name and phase titles out of a workflow script's `export const meta = { name: '…',
 * phases: [{ title: '…' }, …] }`. The script is JavaScript, not JSON, so this scans
 * for the keys; anything it cannot find is left out.
 */
export function workflowMeta(script: string): { name?: string; phases: string[] } {
  const at = script.search(/\bmeta\s*=\s*\{/)
  const src = script.slice(Math.max(at, 0), Math.max(at, 0) + 20_000)
  const nameAt = /\bname\s*:\s*(?=["'`])/.exec(src)
  const name = nameAt ? jsString(src, nameAt.index + nameAt[0].length)?.value : undefined
  const phases: string[] = []
  const ph = /\bphases\s*:\s*\[/.exec(src)
  if (ph) {
    // Walk the array to its closing bracket, stepping over strings.
    let depth = 1
    const start = ph.index + ph[0].length
    let end = src.length
    for (let i = start; i < src.length && depth > 0; ) {
      const str = jsString(src, i)
      if (str) i = str.end
      else {
        if (src[i] === '[') depth++
        else if (src[i] === ']' && --depth === 0) end = i
        i++
      }
    }
    const body = src.slice(start, end)
    const re = /\btitle\s*:\s*(?=["'`])/g
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const t = jsString(body, m.index + m[0].length)?.value
      if (t) phases.push(t)
    }
  }
  return { name: name || undefined, phases }
}

/** The text Claude Code writes as a user record when a turn is interrupted. */
const INTERRUPTED = /^\s*\[Request interrupted by user/

/** A tool_result's content as plain text. Images become a placeholder; other blocks carry nothing to show. */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: Loose) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** "/model opus" for a slash command's wrapper text, or null if it is not one. */
function slashCommand(text: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)
  if (!name || !name[1]) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  return [name[1], args?.[1].trim()].filter(Boolean).join(' ')
}

function toBlock(b: Loose): ChatBlock | null {
  if (b?.type === 'text') return typeof b.text === 'string' && b.text.trim() ? { type: 'text', text: b.text } : null
  // Thinking is often stored empty (only a signature); there is nothing to show then.
  if (b?.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.trim() ? { type: 'thinking', text: b.thinking } : null
  if (b?.type === 'tool_use') return { type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input }
  return null
}

const sameBlock = (a: ChatBlock, b: ChatBlock): boolean =>
  a.type === 'tool_use' ? b.type === 'tool_use' && a.id === b.id : a.type === b.type && a.text === (b as { text: string }).text

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m?.[1].trim() || undefined
}

export interface TranscriptMapper {
  /** Map a batch of whole records, in file order, to events. */
  push(records: unknown[]): ChatEvent[]
}

export function createTranscriptMapper(): TranscriptMapper {
  /** Blocks of each assistant message so far, by message.id (insertion order = age). */
  const messages = new Map<string, ChatBlock[]>()
  /** Question/plan requests seen: tool_use id -> true once its tool_result arrived. */
  const requests = new Map<string, boolean>()
  /** Workflow / background agent calls seen, by tool_use id. */
  const tasks = new Map<string, TaskInfo>()
  let model = ''
  let usage = 0
  let anon = 0

  function assistant(r: Loose, out: ChatEvent[]): void {
    const msg = (r.message ?? {}) as Loose
    const id = String(msg.id ?? r.uuid ?? `a${++anon}`)
    const parent = ((r.parent_tool_use_id ?? r.parentToolUseId) as string | null | undefined) ?? null

    if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>' && msg.model !== model) {
      model = msg.model
      out.push({ t: 'model', model })
    }
    const u = (msg.usage ?? {}) as Loose
    const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    if (n > 0 && n !== usage) {
      usage = n
      out.push({ t: 'usage', inputTokens: n })
    }

    let blocks = messages.get(id)
    if (!blocks) {
      blocks = []
      messages.set(id, blocks)
      if (messages.size > MAX_MESSAGES) messages.delete(messages.keys().next().value as string)
    }
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? (msg.content as Loose[]) : []
    const added: ChatBlock[] = []
    for (const b of content) {
      const block = toBlock(b)
      if (block && !blocks.some((x) => sameBlock(x, block))) {
        blocks.push(block)
        added.push(block)
      }
    }
    if (!added.length) return
    out.push({ t: 'assistant', msgId: id, blocks: [...blocks], parentToolUseId: parent })
    for (const b of added) {
      const kind = b.type === 'tool_use' ? REQUEST_KIND[b.name] : undefined
      if (b.type === 'tool_use' && kind && !requests.has(b.id)) {
        requests.set(b.id, false)
        out.push({ t: 'request', reqId: b.id, kind, toolName: b.name, input: b.input })
      }
      if (b.type === 'tool_use' && !tasks.has(b.id)) task(b, out)
    }
  }

  /** A Workflow call, or an Agent/Task call run in the background. */
  function task(b: Extract<ChatBlock, { type: 'tool_use' }>, out: ChatEvent[]): void {
    const input = (b.input ?? {}) as Loose
    let info: TaskInfo | null = null
    if (b.name === 'Workflow') {
      const meta = typeof input.script === 'string' ? workflowMeta(input.script) : { phases: [] as string[] }
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : meta.name
      info = { kind: 'workflow', name: name || 'Workflow', phases: meta.phases }
    } else if ((b.name === 'Agent' || b.name === 'Task') && input.run_in_background === true) {
      const name = [input.description, input.subagent_type].find((x) => typeof x === 'string' && x.trim()) as string | undefined
      info = { kind: 'agent', name: name?.trim() || 'Agent', phases: [] }
    }
    if (!info) return
    tasks.set(b.id, info)
    if (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value as string)
    out.push({ t: 'task', toolUseId: b.id, ...info })
  }

  /** The tool_result of a task call: the id and transcript directory it launched with. */
  function taskResult(id: string, text: string, out: ChatEvent[]): void {
    let info = tasks.get(id)
    const launched = /^\s*Workflow launched in background/.test(text)
    // A load that starts mid-file never saw the tool_use; the result alone still says what ran.
    if (!info && launched) {
      info = { kind: 'workflow', name: /^Summary:\s*(.+)$/m.exec(text)?.[1].trim() || 'Workflow', phases: [] }
      tasks.set(id, info)
    }
    if (!info) return
    const taskId = (info.kind === 'workflow' ? /Task ID:\s*(\S+)/ : /(?:Task ID|agentId|agent_id)\W+([A-Za-z0-9_-]+)/i).exec(text)?.[1]
    const dir = info.kind === 'workflow' ? /^Transcript dir:\s*(.+?)\s*$/m.exec(text)?.[1] : undefined
    if (!taskId && !dir) return
    out.push({ t: 'task', toolUseId: id, ...info, ...(taskId ? { taskId } : {}), ...(dir ? { dir } : {}) })
  }

  /** A finished background task, from the user record Claude Code writes for it. Never shown as a message. */
  function notification(text: string, out: ChatEvent[]): void {
    const status = tag(text, 'status')
    const toolUseId = tag(text, 'tool-use-id')
    const taskId = tag(text, 'task-id')
    if (!status || !(toolUseId || taskId)) return
    const summary = tag(text, 'summary')
    out.push({ t: 'task_done', ...(toolUseId ? { toolUseId } : {}), ...(taskId ? { taskId } : {}), status, ...(summary ? { summary } : {}) })
  }

  function user(r: Loose, out: ChatEvent[]): void {
    const content = r.message?.content
    const blocks: Loose[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const parent = ((r.parent_tool_use_id ?? r.parentToolUseId) as string | null | undefined) ?? null
    const texts: string[] = []
    const images: ChatImage[] = []
    let interrupted = false
    for (const b of blocks) {
      if (b?.type === 'tool_result') {
        const id = String(b.tool_use_id)
        let text = flatten(b.content)
        const truncated = text.length > TOOL_RESULT_CAP
        if (truncated) text = text.slice(0, TOOL_RESULT_CAP)
        out.push({ t: 'tool_result', toolUseId: id, content: text, isError: b.is_error === true, parentToolUseId: parent, truncated: truncated || undefined })
        if (b.is_error !== true) taskResult(id, text, out)
        if (requests.get(id) === false) {
          requests.set(id, true)
          out.push({ t: 'request_done', reqId: id })
        }
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const cmd = slashCommand(b.text)
        if (/^\s*<task-notification>/.test(b.text)) notification(b.text, out)
        else if (cmd) texts.push(cmd)
        // An interrupted turn writes no turn_duration; this marker is what ends it.
        else if (INTERRUPTED.test(b.text)) interrupted = true
        else if (!SYNTHETIC_USER.test(b.text)) texts.push(b.text)
      } else if (b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
        images.push({ mediaType: String(b.source.media_type ?? 'image/png'), data: b.source.data })
      }
    }
    if (texts.length || images.length) {
      out.push({ t: 'user', id: String(r.uuid ?? `u${++anon}`), text: texts.join('\n'), images: images.length ? images : undefined })
    }
    if (interrupted) out.push({ t: 'result' })
  }

  // A message typed while Claude is busy is stored as a queued_command attachment (checked in
  // the 2.1.289 binary), not a user record. Anything not from the user (a task
  // notification, say) carries another origin kind and stays out.
  function queued(r: Loose, out: ChatEvent[]): void {
    const a = (r.attachment ?? {}) as Loose
    if (a.type !== 'queued_command') return
    if (a.origin?.kind && a.origin.kind !== 'human') return
    const p = a.prompt
    const text = typeof p === 'string' ? p : Array.isArray(p) ? p.map((b: Loose) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n') : ''
    if (!text.trim() || SYNTHETIC_USER.test(text)) return
    out.push({ t: 'user', id: String(r.uuid ?? `u${++anon}`), text })
  }

  function system(r: Loose, out: ChatEvent[]): void {
    if (r.subtype === 'turn_duration') {
      out.push({ t: 'result', durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined })
    } else if (r.subtype === 'compact_boundary') {
      const m = (r.compactMetadata ?? r.compact_metadata ?? {}) as Loose
      out.push({ t: 'compact', trigger: m.trigger === 'manual' ? 'manual' : 'auto', preTokens: typeof m.preTokens === 'number' ? m.preTokens : undefined })
    } else if (r.subtype === 'local_command' && typeof r.content === 'string') {
      // A command's own output (/context, say), not in any message. A command with
      // none (/clear) writes an empty one.
      const m = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(r.content)
      const text = (m?.[1] ?? '').replace(ANSI_RE, '').replace(/\s+$/, '').replace(/^\s*\n+/, '')
      if (!text.trim()) return
      const run = (r.commandRun ?? {}) as Loose
      const command = typeof run.command === 'string' ? run.command.replace(/^\//, '') : ''
      const args = typeof run.args === 'string' ? run.args.trim() : ''
      out.push({
        t: 'note',
        id: String(r.uuid ?? `n${++anon}`),
        title: command ? `/${command}${args ? ' ' + args : ''}` : 'Command output',
        text: text.length > NOTE_CAP ? text.slice(0, NOTE_CAP) : text
      })
    }
  }

  return {
    push(records) {
      const out: ChatEvent[] = []
      for (const rec of records) {
        if (!rec || typeof rec !== 'object') continue
        const r = rec as Loose
        try {
          if (r.type === 'permission-mode') {
            if (MODES.has(r.permissionMode)) out.push({ t: 'mode', mode: r.permissionMode as ChatMode })
            continue
          }
          // Subagent work lives in the Task call's own result; it is not part of this thread.
          if (r.isSidechain === true) continue
          if (r.type === 'assistant') assistant(r, out)
          else if (r.type === 'user') {
            // A notification may be written as a meta record; it still ends the task.
            const c = r.message?.content
            const first = typeof c === 'string' ? c : Array.isArray(c) && typeof c[0]?.text === 'string' ? c[0].text : ''
            if (r.isMeta && /^\s*<task-notification>/.test(first)) notification(first, out)
            else if (!r.isMeta && !r.isCompactSummary) user(r, out)
          } else if (r.type === 'attachment') queued(r, out)
          else if (r.type === 'system') system(r, out)
        } catch {
          // One odd record must not drop the rest of the batch.
        }
      }
      return out
    }
  }
}
