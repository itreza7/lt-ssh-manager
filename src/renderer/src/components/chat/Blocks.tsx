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
    <pre dir="ltr" className="max-h-72 overflow-auto rounded-lg border border-line bg-ink/60 py-1.5 font-mono text-[12px] leading-relaxed">
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
          <span className="font-mono text-[11px]">
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
        stat: <span className="font-mono text-[11px] text-faint">{lines(str(i.content)).length} lines</span>
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
        className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-ink/60 p-3 font-mono text-[12px] leading-relaxed ${
          result.isError ? 'border-danger/40 text-danger' : 'border-line text-fg/85'
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
    <div dir="auto" className="rounded-lg border border-line px-3.5 py-2.5">
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
  if (block.name === 'TodoWrite' && block.final) return <TodoList input={input} />

  const sum = summarize(block.name, input)
  const stepCount = subs?.reduce((n, m) => n + m.blocks.filter((b) => b.type === 'tool_use').length, 0) ?? 0
  const isTask = block.name === 'Task' || block.name === 'Agent'
  const isEdit = block.name === 'Edit' || block.name === 'MultiEdit'
  // Streaming placeholder: the name is known, the input is not yet.
  const arriving = !block.final

  const body = (): ReactNode => {
    if (isEdit) return <Diff edits={editsOf(block.name, input)} />
    if (block.name === 'Write') return <Out result={{ content: str(input.content).slice(0, 20000), isError: false }} />
    if (block.name === 'Bash') {
      return (
        <div className="space-y-2">
          <pre dir="ltr" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-ink/60 p-3 font-mono text-[12px] text-fg/90">
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
            <div className="space-y-1.5 border-l border-line pl-3">
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
          <pre dir="ltr" className="max-h-48 overflow-auto rounded-lg border border-line bg-ink/60 p-3 font-mono text-[12px] text-fg/80">
            {JSON.stringify(block.input, null, 2)}
          </pre>
        )}
        {result && <Out result={result} />}
      </div>
    )
  }

  const failed = result?.isError
  const expandable = !arriving && (isEdit || isTask || !!result || block.name === 'Bash' || block.name === 'Write' || block.input !== undefined)
  return (
    <div className={`rounded-lg border ${failed ? 'border-danger/40' : 'border-line'} bg-surface/40`}>
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
      >
        <span className={`w-4 shrink-0 text-center font-mono text-[12px] ${failed ? 'text-danger' : 'text-accent'}`}>{sum.glyph}</span>
        <span className="shrink-0 text-[13px] font-medium text-fg/90">{sum.name || block.name}</span>
        <span dir="auto" className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint">
          {sum.detail}
        </span>
        {isTask && stepCount > 0 && <span className="shrink-0 text-[11px] text-faint">{stepCount} step{stepCount === 1 ? '' : 's'}</span>}
        {sum.stat}
        {(pending || arriving) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-signal" />}
        {failed && <span className="shrink-0 text-[11px] text-danger">failed</span>}
        {expandable && <span className="shrink-0 text-[10px] text-faint">{open ? '▾' : '▸'}</span>}
      </button>
      {open && <div className="border-t border-line-soft px-3 py-2.5">{body()}</div>}
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
          // This build streams no thinking text; the block only marks activity.
          if (!b.final) return live ? <div key={k} className="animate-glow text-sm text-faint">Thinking…</div> : null
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

export const UserMessage = memo(function UserMessage({ item }: { item: Pick<UserItem, 'text' | 'images'> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-elevated px-4 py-2.5 text-[15px] leading-relaxed text-fg">
        {item.images?.map((im, k) => (
          <img key={k} src={`data:${im.mediaType};base64,${im.data}`} className="mb-2 max-h-56 rounded-lg" />
        ))}
        <div dir="auto" className="whitespace-pre-wrap break-words">
          {item.text}
        </div>
      </div>
    </div>
  )
})

export function QueuedMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end opacity-60">
      <div className="max-w-[85%] rounded-2xl bg-elevated px-4 py-2.5 text-[15px] leading-relaxed text-fg">
        <div dir="auto" className="whitespace-pre-wrap break-words">
          {text}
        </div>
        <div className="mt-1 text-right text-[10px] text-faint">queued</div>
      </div>
    </div>
  )
}

export function NoteLine({ item }: { item: NoteItem }) {
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
