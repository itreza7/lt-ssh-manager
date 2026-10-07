// Reading a Claude Code conversation from its on-disk transcript, so the Reader
// panel can show it as HTML — where right-to-left text (Persian, Arabic) lays
// out properly, which no terminal grid can do for a TUI.
//
// The format belongs to Claude Code, not this repo: one JSON record per line in
// `~/.claude/projects/<project slug>/<session id>.jsonl`. Only `user` and
// `assistant` records carry the conversation; everything else (attachments,
// titles, file-history snapshots, queue operations) is bookkeeping and skipped.

/** One transcript file on the remote, as listed for the session picker. */
export interface ReaderSession {
  path: string
  /** Modification time, seconds since the epoch. */
  mtime: number
  size: number
}

/** A chunk of a transcript file, read from a byte offset. */
export interface ReaderChunk {
  /** Size of the whole file at read time — the next read's offset. */
  size: number
  /** Complete lines only; a partial last line is left for the next read. */
  text: string
  /** Byte offset just past `text`; the caller passes it back as the next offset. */
  next: number
}

export type ReaderEntry =
  | { kind: 'user' | 'assistant'; text: string; ts?: string }
  | { kind: 'tool'; name: string; summary: string }

/**
 * The project folder Claude Code keeps a cwd's transcripts in. Verified against
 * the CLI bundle (2.1.289): every non-alphanumeric character becomes `-`, and a
 * slug over 200 chars is cut to 200 and suffixed with a hash we can't reproduce
 * here — so callers match a long one by its 200-char prefix.
 */
export const PROJECT_SLUG_MAX = 200
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// Text Claude Code injects into user turns that the user never typed.
const SYNTHETIC_USER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr)>/

interface Block {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

/** A one-line description of a tool call — its most telling argument. */
function toolSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v.split('\n')[0].slice(0, 200)
  }
  return ''
}

/** Parse complete JSONL lines into displayable entries; malformed lines are skipped. */
export function parseTranscript(jsonl: string): ReaderEntry[] {
  const out: ReaderEntry[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let r: {
      type?: string
      isMeta?: boolean
      isSidechain?: boolean
      timestamp?: string
      message?: { content?: string | Block[] }
    }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isSidechain) continue
    const content = r.message?.content
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        if (r.type === 'user' && SYNTHETIC_USER.test(b.text)) continue
        out.push({ kind: r.type, text: b.text, ts: r.timestamp })
      } else if (b.type === 'tool_use' && r.type === 'assistant') {
        out.push({ kind: 'tool', name: b.name ?? 'tool', summary: toolSummary(b.input) })
      }
    }
  }
  return out
}
