// Turns a Claude Code .jsonl session transcript into a readable sequence of
// conversation turns. Renderer-agnostic: this module only knows the record
// shapes Claude Code itself writes, not how they get drawn.
//
// A transcript interleaves several record `type`s. Only two carry actual
// conversation: `user` and `assistant`. The rest — `system` (hook/telemetry
// summaries), `attachment` (tool-list deltas and similar), `ai-title`,
// `custom-title`, `last-prompt`, `mode`, `queue-operation`, `pr-link` — are
// metadata shared/resume.ts already reads for other purposes, not turns, and
// are skipped here outright.
//
// A tool call and its result are two physically separate JSONL lines: an
// `assistant` record's `tool_use` block, and the *next* `user` record's
// `tool_result` block carrying the matching `tool_use_id`. Claude's own
// history view shows these as one collapsible unit, not as a dangling
// "user: [object]" turn, so this module re-pairs them by id and folds a
// tool-result-only `user` record back into the assistant turn that opened
// it rather than emitting it as a turn of its own.
//
// `isSidechain: true` records belong to a subagent's own internal thread
// (spawned via the Task tool, sharing this file). They are dropped, the same
// way the real app's history view surfaces the Task call and its final
// result on the main thread without inlining the subagent's turns.
//
// `thinking` content blocks are dropped too — Claude's own history view does
// not render raw reasoning traces, and a transcript already runs to
// thousands of lines without them.

export interface TranscriptTextBlock {
  type: 'text'
  text: string
}

export interface TranscriptImageBlock {
  type: 'image'
}

export interface TranscriptToolBlock {
  type: 'tool'
  id: string
  name: string
  input: unknown
  /** Null until the matching tool_result record arrives (or never does — a transcript can end mid-call). */
  result: { content: string; isError: boolean } | null
}

export type TranscriptBlock = TranscriptTextBlock | TranscriptImageBlock | TranscriptToolBlock

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  timestamp: string | null
  blocks: TranscriptBlock[]
}

export interface ParsedTranscript {
  turns: TranscriptTurn[]
  /**
   * Lines that were valid JSON but not a shape this parser understands, or not
   * valid JSON at all. Surfaced as a count, never as content — a malformed
   * line is not something to render, but a transcript that skipped hundreds
   * of lines is a fact worth one line in the UI rather than silence.
   */
  skipped: number
}

/**
 * tool_result content is `string | Array<{type:'text',text}|other>` per the
 * Anthropic API — a Read on an image, for instance, returns array content.
 * Only the text parts are shown; anything else in the array is omitted
 * rather than guessed at.
 */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: 'text'; text: string } => Boolean(b) && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
    return parts.length ? parts.join('\n') : null
  }
  return null
}

interface RawRecord {
  type?: unknown
  isSidechain?: unknown
  timestamp?: unknown
  message?: { role?: unknown; content?: unknown }
}

interface RawBlock {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

export function parseTranscript(raw: string): ParsedTranscript {
  const turns: TranscriptTurn[] = []
  // Tool blocks are indexed by id so the tool_result record that follows —
  // physically a separate line — can mutate the same object already sitting
  // in `turns`, rather than the parser tracking any other cross-line state.
  const toolBlocks = new Map<string, TranscriptToolBlock>()
  let skipped = 0

  const resolveResult = (b: RawBlock): void => {
    if (typeof b.tool_use_id !== 'string') return
    const target = toolBlocks.get(b.tool_use_id)
    if (target) target.result = { content: textOf(b.content) ?? '', isError: Boolean(b.is_error) }
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: RawRecord
    try {
      rec = JSON.parse(trimmed)
    } catch {
      skipped++
      continue
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    if (rec.isSidechain === true) continue
    const message = rec.message
    if (!message || typeof message !== 'object') {
      skipped++
      continue
    }
    const role = message.role
    if (role !== 'user' && role !== 'assistant') {
      skipped++
      continue
    }
    const content = message.content
    const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : null

    if (typeof content === 'string') {
      if (!content.trim()) continue
      turns.push({ role, timestamp, blocks: [{ type: 'text', text: content }] })
      continue
    }
    if (!Array.isArray(content)) {
      skipped++
      continue
    }

    // A user record that is ENTIRELY tool_results carries no turn of its
    // own — it's the second half of tool calls the previous assistant turn
    // already opened.
    const allToolResults =
      content.length > 0 && content.every((b: RawBlock) => b && b.type === 'tool_result')
    if (role === 'user' && allToolResults) {
      for (const b of content as RawBlock[]) resolveResult(b)
      continue
    }

    const blocks: TranscriptBlock[] = []
    for (const b of content as RawBlock[]) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        blocks.push({ type: 'text', text: b.text })
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const block: TranscriptToolBlock = { type: 'tool', id: b.id, name: b.name, input: b.input, result: null }
        toolBlocks.set(b.id, block)
        blocks.push(block)
      } else if (b.type === 'tool_result') {
        // A tool_result mixed into an otherwise-mixed array (rare, but legal) —
        // resolved the same way as the all-tool_result fast path above.
        resolveResult(b)
      } else if (b.type === 'image') {
        blocks.push({ type: 'image' })
      }
      // 'thinking' and anything else: intentionally dropped, not an error.
    }
    if (blocks.length) turns.push({ role, timestamp, blocks })
  }

  return { turns, skipped }
}
