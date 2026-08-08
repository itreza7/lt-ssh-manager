import { useCallback, useEffect, useState } from 'react'
import type {
  TranscriptBlock,
  TranscriptToolBlock,
  TranscriptTurn
} from '../../../shared/transcript'
import { parseTranscript } from '../../../shared/transcript'
import { renderMarkdown } from './MarkdownPreview'

interface Props {
  connectionId: string
  password?: string
  /** The transcript's filename stem — the id `resume:read` resolves to a path. */
  sessionId: string
}

type Status = 'loading' | 'ready' | 'error'

function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameYear ? `${date} ${time}` : `${date} ${d.getFullYear()}`
}

// Collapsed by default: a tool call's input/result can run to thousands of
// characters, and a transcript is mostly these — expanding all of them by
// default would turn "readable conversation" back into a wall of JSON.
function ToolBlockView({ block }: { block: TranscriptToolBlock }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-2 rounded-md border border-line bg-elevated/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted transition-colors hover:text-fg"
      >
        <span className="w-3 shrink-0 text-faint">{open ? '▾' : '▸'}</span>
        <span className="truncate font-mono text-accent">{block.name}</span>
        {block.result?.isError && (
          <span className="ml-auto shrink-0 text-[10px] text-danger">error</span>
        )}
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-faint">
            {JSON.stringify(block.input, null, 2)}
          </pre>
          {block.result ? (
            <pre
              className={`mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md border px-2 py-1.5 font-mono text-[11px] ${
                block.result.isError
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-line bg-ink text-muted'
              }`}
            >
              {block.result.content}
            </pre>
          ) : (
            <p className="mt-2 text-[11px] italic text-faint">
              (no result — transcript may have been cut short)
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function BlockView({ block }: { block: TranscriptBlock }) {
  if (block.type === 'text') {
    return <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
  }
  if (block.type === 'tool') return <ToolBlockView block={block} />
  return <p className="text-[11px] italic text-faint">[image]</p>
}

function TurnView({ turn }: { turn: TranscriptTurn }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span
          className={`text-[11px] font-medium ${turn.role === 'user' ? 'text-accent' : 'text-fg/90'}`}
        >
          {turn.role === 'user' ? 'You' : 'Claude'}
        </span>
        {turn.timestamp && <span className="text-[10px] text-faint">{fmtTime(turn.timestamp)}</span>}
      </div>
      {turn.blocks.map((b, i) => (
        <BlockView key={b.type === 'tool' ? b.id : i} block={b} />
      ))}
    </div>
  )
}

export function TranscriptView({ connectionId, password, sessionId }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [skipped, setSkipped] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    try {
      const { content } = await window.api.resumeRead({ connectionId, password, id: sessionId })
      const parsed = parseTranscript(content)
      setTurns(parsed.turns)
      setSkipped(parsed.skipped)
      setStatus('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [connectionId, password, sessionId])

  // Loads on mount — no `active` gate like WorktreeView takes, since a
  // transcript is a fixed file on disk, not a list worth deferring, and a
  // background tab should already have it ready the moment it's switched to.
  useEffect(() => {
    if (status === 'loading') void load()
  }, [status, load])

  return (
    <div className="h-full overflow-y-auto bg-ink px-10 py-8">
      <div className="mx-auto max-w-3xl">
        {status === 'loading' && (
          <p className="px-3 py-10 text-center text-xs text-faint">Loading transcript…</p>
        )}

        {status === 'error' && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        {status === 'ready' && (
          <>
            {turns.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-faint">
                This transcript has no renderable turns.
              </p>
            ) : (
              turns.map((turn, i) => <TurnView key={i} turn={turn} />)
            )}
            {skipped > 0 && (
              <p className="mt-2 text-[10px] text-faint">
                {skipped} line{skipped === 1 ? '' : 's'} could not be parsed.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
