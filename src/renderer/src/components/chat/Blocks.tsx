import { memo, useMemo, useState, type ReactNode } from 'react'
import type {
  AssistantItem,
  NoteItem,
  ToolResult,
  UiBlock,
  UserItem
} from '../../lib/chatState'
import { renderMarkdown } from '../MarkdownPreview'

type ToolBlock = Extract<UiBlock, { type: 'tool_use' }>
type Input = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))
const firstLine = (s: string): string => s.split('\n', 1)[0]

/** The › that turns down when its row is open. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
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

// A plain muted row, as Claude desktop shows a run of tool calls.
const quietRow = 'flex max-w-full items-center gap-1 text-left text-[14px] leading-5 text-faint transition-colors hover:text-muted'
// What an open row holds.
const openBody = 'mt-1.5 rounded-lg bg-panel px-3 py-2.5'

// ---- diff ------------------------------------------------------------------

interface DiffLine {
  /** ' ' is the gap between two edits of a MultiEdit. */
  sign: '+' | '-' | ' '
  text: string
}

/**
 * Not a real diff: the common head and tail lines are dropped, and what is left
 * of the old text is shown removed and of the new text added. For an Edit
 * (a contiguous replacement) that is exactly the change.
 */
function lineDiff(oldS: string, newS: string): DiffLine[] {
  const a = lines(oldS)
  const b = lines(newS)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return [
    ...a.slice(head, a.length - tail).map((text): DiffLine => ({ sign: '-', text })),
    ...b.slice(head, b.length - tail).map((text): DiffLine => ({ sign: '+', text }))
  ]
}

function Diff({ edits }: { edits: { old: string; new: string }[] }) {
  const rows = useMemo(
    () => edits.flatMap((e, i) => (i ? [{ sign: ' ', text: '⋯' } as DiffLine, ...lineDiff(e.old, e.new)] : lineDiff(e.old, e.new))),
    [edits]
  )
  return (
    <pre dir="ltr" className="max-h-72 overflow-auto rounded-md bg-well py-1.5 font-mono text-[12px] leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={r.sign === '+' ? 'bg-signal/10 text-signal' : r.sign === '-' ? 'bg-danger/10 text-danger' : 'text-faint'}
        >
          <span className="inline-block w-5 select-none text-center opacity-70">{r.sign}</span>
          {r.text}
        </div>
      ))}
    </pre>
  )
}

// ---- tool summaries --------------------------------------------------------

interface Summary {
  glyph: string
  name: string
  /** One line next to the name. */
  detail: string
  stat?: ReactNode
}

const editsOf = (name: string, i: Input): { old: string; new: string }[] =>
  name === 'MultiEdit' && Array.isArray(i.edits)
    ? (i.edits as Input[]).map((e) => ({ old: str(e.old_string), new: str(e.new_string) }))
    : [{ old: str(i.old_string), new: str(i.new_string) }]

function summarize(name: string, i: Input): Summary {
  switch (name) {
    case 'Bash':
      return { glyph: '$', name, detail: str(i.description) || firstLine(str(i.command)) }
    case 'Read':
      return { glyph: '≡', name, detail: str(i.file_path) }
    case 'Edit':
    case 'MultiEdit': {
      const d = editsOf(name, i).flatMap((e) => lineDiff(e.old, e.new))
      const add = d.filter((l) => l.sign === '+').length
      const del = d.length - add
      return {
        glyph: '±',
        name,
        detail: str(i.file_path),
        stat: (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
            <span className="text-signal">+{add}</span> <span className="text-danger">−{del}</span>
          </span>
        )
      }
    }
    case 'Write':
      return {
        glyph: '+',
        name,
        detail: str(i.file_path),
        stat: <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-faint">{lines(str(i.content)).length} lines</span>
      }
    case 'Grep':
      return { glyph: '⌕', name, detail: [str(i.pattern), str(i.path)].filter(Boolean).join('  ·  ') }
    case 'Glob':
      return { glyph: '✱', name, detail: str(i.pattern) }
    case 'TodoWrite':
      return { glyph: '☑', name: 'Todos', detail: '' }
    case 'Task':
    case 'Agent':
      return { glyph: '◈', name: str(i.subagent_type) || 'Agent', detail: str(i.description) }
    case 'WebFetch':
      return { glyph: '↗', name, detail: str(i.url) }
    case 'WebSearch':
      return { glyph: '↗', name, detail: str(i.query) }
    default: {
      // mcp__server__tool reads better as "server · tool".
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      return { glyph: '·', name: m ? `${m[1]} · ${m[2]}` : name, detail: '' }
    }
  }
}

// ---- tool card -------------------------------------------------------------

function Out({ result }: { result: ToolResult }) {
  return (
    <>
      <pre
        dir="ltr"
        className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well p-3 font-mono text-[12px] leading-relaxed ${
          result.isError ? 'text-danger' : 'text-fg/85'
        }`}
      >
        {result.content || '(no output)'}
      </pre>
      {result.truncated && <div className="mt-1 text-[11px] text-faint">Output was cut short.</div>}
    </>
  )
}

function TodoList({ input }: { input: Input }) {
  const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : []
  return (
    <div dir="auto" className="rounded-lg bg-panel px-3.5 py-2.5">
      <div className="eyebrow mb-1.5">Todos</div>
      <ul className="space-y-1">
        {todos.map((t, k) => {
          const done = t.status === 'completed'
          const doing = t.status === 'in_progress'
          return (
            <li key={k} className={`flex gap-2 text-sm ${done ? 'text-faint line-through' : doing ? 'text-fg' : 'text-muted'}`}>
              <span className={`shrink-0 ${doing ? 'text-accent' : ''}`}>{done ? '☑' : doing ? '◐' : '☐'}</span>
              <span>{str(doing && t.activeForm ? t.activeForm : t.content)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface CardProps {
  block: ToolBlock
  result?: ToolResult
  /** The call has no result yet and the turn is still going. */
  pending: boolean
  subs?: AssistantItem[]
  results: Record<string, ToolResult>
  groups: Record<string, AssistantItem[]>
}

function ToolCard({ block, result, pending, subs, results, groups }: CardProps) {
  const [open, setOpen] = useState(false)
  const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Input
  if (block.name === 'TodoWrite') return <TodoList input={input} />

  const sum = summarize(block.name, input)
  const stepCount = subs?.reduce((n, m) => n + m.blocks.filter((b) => b.type === 'tool_use').length, 0) ?? 0
  const isTask = block.name === 'Task' || block.name === 'Agent'
  const isEdit = block.name === 'Edit' || block.name === 'MultiEdit'
  const body = (): ReactNode => {
    if (isEdit) return <Diff edits={editsOf(block.name, input)} />
    if (block.name === 'Write') return <Out result={{ content: str(input.content).slice(0, 20000), isError: false }} />
    if (block.name === 'Bash') {
      return (
        <div className="space-y-2">
          <pre dir="ltr" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well p-3 font-mono text-[12px] text-fg/90">
            {str(input.command)}
          </pre>
          {result && <Out result={result} />}
        </div>
      )
    }
    if (isTask) {
      return (
        <div className="space-y-2">
          {str(input.prompt) && (
            <div dir="auto" className="whitespace-pre-wrap text-[13px] text-muted">
              {str(input.prompt)}
            </div>
          )}
          {subs && subs.length > 0 && (
            <div className="space-y-1.5 border-l border-sel pl-3">
              {subs.map((m) => (
                <AssistantBlocks key={m.msgId} item={m} live={false} results={results} groups={groups} compact />
              ))}
            </div>
          )}
          {result && <Out result={result} />}
        </div>
      )
    }
    const generic = block.name !== 'Read' && block.name !== 'Grep' && block.name !== 'Glob' && block.name !== 'WebFetch' && block.name !== 'WebSearch'
    return (
      <div className="space-y-2">
        {generic && (
          <pre dir="ltr" className="max-h-48 overflow-auto rounded-md bg-well p-3 font-mono text-[12px] text-fg/80">
            {JSON.stringify(block.input, null, 2)}
          </pre>
        )}
        {result && <Out result={result} />}
      </div>
    )
  }

  const failed = result?.isError
  const expandable = (isEdit || isTask || !!result || block.name === 'Bash' || block.name === 'Write' || block.input !== undefined)
  return (
    <div>
      <button onClick={() => expandable && setOpen((o) => !o)} className={`${quietRow} ${failed ? '!text-danger' : ''}`}>
        <span className="shrink-0">{sum.name || block.name}</span>
        <span dir="auto" className="min-w-0 truncate font-mono text-[12px]">
          {sum.detail}
        </span>
        {isTask && stepCount > 0 && <span className="shrink-0 text-[12px]">{stepCount} step{stepCount === 1 ? '' : 's'}</span>}
        {sum.stat}
        {pending && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />}
        {failed && <span className="shrink-0 text-[12px]">failed</span>}
        {expandable && <Caret open={open} />}
      </button>
      {open && <div className={openBody}>{body()}</div>}
    </div>
  )
}

// ---- tool group ------------------------------------------------------------

// What a group's summary counts: [kind, one, many].
const KINDS: Record<string, [string, string, string]> = {
  Bash: ['ran', 'command', 'commands'],
  Read: ['read', 'file', 'files'],
  Edit: ['edited', 'file', 'files'],
  MultiEdit: ['edited', 'file', 'files'],
  Write: ['edited', 'file', 'files'],
  Grep: ['searched', 'time', 'times'],
  Glob: ['searched', 'time', 'times']
}
const OTHER: [string, string, string] = ['used', 'tool', 'tools']

/** "Ran 3 commands, read 2 files": calls counted by kind, in the order the kinds first appear. */
function groupSummary(blocks: ToolBlock[]): string {
  const counts = new Map<string, { kind: [string, string, string]; n: number }>()
  for (const b of blocks) {
    const kind = KINDS[b.name] ?? OTHER
    const c = counts.get(kind[0])
    if (c) c.n++
    else counts.set(kind[0], { kind, n: 1 })
  }
  const text = [...counts.values()].map(({ kind, n }) => `${kind[0]} ${n} ${n === 1 ? kind[1] : kind[2]}`).join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A run of finished tool calls as one collapsed row; it opens into the usual cards. */
export function ToolGroup({ blocks, results, groups }: { blocks: ToolBlock[]; results: Record<string, ToolResult>; groups: Record<string, AssistantItem[]> }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className={quietRow}>
        <span className="min-w-0 truncate">{groupSummary(blocks)}</span>
        <Caret open={open} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {blocks.map((b) => (
            <ToolCard key={b.id} block={b} result={results[b.id]} pending={false} subs={groups[b.id]} results={results} groups={groups} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- messages --------------------------------------------------------------

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div dir="auto" className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}

interface AssistantProps {
  item: AssistantItem
  /** This is the live end of the transcript and a turn is running. */
  live: boolean
  results: Record<string, ToolResult>
  groups: Record<string, AssistantItem[]>
  compact?: boolean
}

function AssistantBlocksImpl({ item, live, results, groups, compact }: AssistantProps) {
  return (
    <div className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-2.5'}`}>
      {item.blocks.map((b, k) => {
        if (b.type === 'text') {
          if (!b.text) return null
          return compact ? (
            <div key={k} dir="auto" className="whitespace-pre-wrap text-[13px] text-muted">
              {b.text}
            </div>
          ) : (
            <Markdown key={k} text={b.text} />
          )
        }
        if (b.type === 'thinking') {
          return b.text ? (
            <details key={k} className="text-sm text-faint">
              <summary className="cursor-pointer select-none">Thinking</summary>
              <div dir="auto" className="mt-1 whitespace-pre-wrap">{b.text}</div>
            </details>
          ) : null
        }
        const result = results[b.id]
        return (
          <ToolCard
            key={b.id}
            block={b}
            result={result}
            pending={live && !result}
            subs={groups[b.id]}
            results={results}
            groups={groups}
          />
        )
      })}
    </div>
  )
}

// A streaming delta or a tool result touches one message; the rest keep their
// DOM. Messages holding a subagent group also follow `results`, since the group's
// own tool results are looked up in it.
export const AssistantBlocks = memo(AssistantBlocksImpl, (a, b) => {
  if (a.item !== b.item || a.live !== b.live || a.compact !== b.compact) return false
  for (const bl of a.item.blocks) {
    if (bl.type !== 'tool_use') continue
    if (a.results[bl.id] !== b.results[bl.id] || a.groups[bl.id] !== b.groups[bl.id]) return false
    if (a.groups[bl.id] && a.results !== b.results) return false
  }
  return true
})

// Text pasted into the TUI reaches the transcript wrapped in these tags.
// The closing tag may repeat the id: </pasted_content id="42b7">.
const PASTED = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g

type MessagePart = { pasted: boolean; text: string }

function splitPasted(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  let at = 0
  const plain = (s: string): void => {
    if (s.trim()) parts.push({ pasted: false, text: s.replace(/^\n+|\s+$/g, '') })
  }
  for (const m of text.matchAll(PASTED)) {
    plain(text.slice(at, m.index))
    parts.push({ pasted: true, text: m[1] })
    at = m.index + m[0].length
  }
  plain(text.slice(at))
  return parts
}

/** A pasted block, closed to one row until clicked. */
function PastedBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const n = lines(text).length
  return (
    <div className="my-1 rounded-lg bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 px-2.5 py-1.5 text-left text-[12px] text-faint hover:text-muted">
        <Caret open={open} />
        Pasted text · {n} {n === 1 ? 'line' : 'lines'}
      </button>
      {open && (
        <pre dir="auto" className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 pb-2.5 font-mono text-[12px] leading-[18px] text-muted">
          {text}
        </pre>
      )}
    </div>
  )
}

function MessageText({ text }: { text: string }) {
  const parts = useMemo(() => splitPasted(text), [text])
  return (
    <>
      {parts.map((p, k) =>
        p.pasted ? (
          <PastedBlock key={k} text={p.text} />
        ) : (
          <div key={k} dir="auto" className="whitespace-pre-wrap break-words">
            {p.text}
          </div>
        )
      )}
    </>
  )
}

export const UserMessage = memo(function UserMessage({ item }: { item: Pick<UserItem, 'text' | 'images'> }) {
  return (
    <div className="my-2 flex justify-end">
      <div className="max-w-[85%] rounded-xl bg-bubble px-3 py-2 text-[14px] leading-5 text-fg">
        {item.images?.map((im, k) => (
          <img key={k} src={`data:${im.mediaType};base64,${im.data}`} className="mb-2 max-h-56 rounded-lg" />
        ))}
        <MessageText text={item.text} />
      </div>
    </div>
  )
})

export type PendingState = 'sending' | 'sent' | 'failed'

const iconBtn = 'flex h-5 w-5 items-center justify-center rounded text-[12px] text-faint transition-colors hover:bg-line hover:text-fg'

/**
 * A message on its way: shown at once, until the transcript echoes it back. Its state sits
 * beside the bubble, so the bubble is as tall as a sent one.
 * `onCancel`: unset while a cancel is running. `note`: why it failed, or why it could not be cancelled.
 */
export function QueuedMessage({
  text,
  state,
  note,
  onCancel,
  onRetry,
  onDismiss
}: {
  text: string
  state: PendingState
  note?: string
  onCancel?: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const failed = state === 'failed'
  return (
    <div className="my-2 flex items-center justify-end gap-1.5">
      {failed ? (
        <>
          <span title={note || 'Not sent'} className="text-[13px] text-red-400">
            ⚠
          </span>
          <button title="Retry" onClick={onRetry} className={iconBtn}>
            ↻
          </button>
          <button title="Dismiss" onClick={onDismiss} className={iconBtn}>
            ✕
          </button>
        </>
      ) : (
        <>
          {onCancel && (
            <button title="Cancel" onClick={onCancel} className={iconBtn}>
              ✕
            </button>
          )}
          <span title={note || (state === 'sending' ? 'Sending…' : 'Waiting for Claude…')} className="flex text-faint">
            <Spinner />
          </span>
        </>
      )}
      <div
        className={`max-w-[85%] rounded-xl bg-bubble px-3 py-2 text-[14px] leading-5 text-fg ${failed ? 'border border-red-500/50' : 'opacity-70'}`}
      >
        <MessageText text={text} />
      </div>
    </div>
  )
}

/** A slash command being typed into the TUI. */
export function RunningCommand({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[12px] text-faint">
      <Spinner /> Running {command}…
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`} />
}

/** A command's output as a collapsed monospace card: `/context`, `/usage`. */
export function OutputCard({ title, text, onDismiss }: { title: string; text: string; onDismiss?: () => void }) {
  const [open, setOpen] = useState(!!onDismiss)
  return (
    <div>
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen((o) => !o)} className={`${quietRow} min-w-0`}>
          <span className="truncate font-mono text-[12px]">{title}</span>
          <Caret open={open} />
        </button>
        {onDismiss && (
          <button onClick={onDismiss} title="Dismiss" className="shrink-0 rounded-md px-1.5 text-base leading-none text-faint transition-colors hover:text-fg">
            ×
          </button>
        )}
      </div>
      {open && (
        <pre dir="ltr" className={`${openBody} max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg/85`}>
          {text || '(no output)'}
        </pre>
      )}
    </div>
  )
}

export function NoteLine({ item }: { item: NoteItem }) {
  if (item.title) return <OutputCard title={item.title} text={item.text} />
  return item.tone === 'error' ? (
    <div dir="auto" className="rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2 text-sm text-danger">
      {item.text}
    </div>
  ) : (
    <div className="flex items-center gap-3 text-[11px] text-faint">
      <span className="h-px flex-1 bg-line" />
      {item.text}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}
