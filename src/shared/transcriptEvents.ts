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

export interface TranscriptMapper {
  /** Map a batch of whole records, in file order, to events. */
  push(records: unknown[]): ChatEvent[]
}

export function createTranscriptMapper(): TranscriptMapper {
  /** Blocks of each assistant message so far, by message.id (insertion order = age). */
  const messages = new Map<string, ChatBlock[]>()
  /** Question/plan requests seen: tool_use id -> true once its tool_result arrived. */
  const requests = new Map<string, boolean>()
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
    }
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
        if (requests.get(id) === false) {
          requests.set(id, true)
          out.push({ t: 'request_done', reqId: id })
        }
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const cmd = slashCommand(b.text)
        if (cmd) texts.push(cmd)
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
            if (!r.isMeta && !r.isCompactSummary) user(r, out)
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
