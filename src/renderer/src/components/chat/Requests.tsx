import { useState } from 'react'
import type { ChatRequest } from '../../lib/chatState'
import { Button } from '../Modal'
import { renderMarkdown } from '../MarkdownPreview'

/** What the user decided, as the `answer` command carries it. */
export interface Decision {
  decision: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
}

interface Props {
  req: ChatRequest
  /** Rejects when the command could not be sent, so the card can be used again. */
  onAnswer: (d: Decision) => Promise<void>
}

// The buttons lock once an answer is on its way, so a double click cannot answer
// twice; a send that fails unlocks them again.
function useAnswer(onAnswer: Props['onAnswer']): [boolean, (d: Decision) => void] {
  const [sent, setSent] = useState(false)
  return [
    sent,
    (d) => {
      setSent(true)
      onAnswer(d).catch(() => setSent(false))
    }
  ]
}

interface Question {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function questionsOf(input: unknown): Question[] {
  const qs = asRecord(input).questions
  return Array.isArray(qs) ? (qs as Question[]).map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options : [] })) : []
}

const card = 'animate-rise rounded-xl border border-accent/40 bg-elevated/70 p-4 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.6)]'

function QuestionCard({ req, onAnswer }: Props) {
  const questions = questionsOf(req.input)
  const [sel, setSel] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [sent, answer] = useAnswer(onAnswer)

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setSel((s) => {
      const cur = s[qi] ?? []
      return { ...s, [qi]: multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] }
    })
    // One answer per single-select question: picking an option drops typed text.
    if (!multi) setOther((o) => ({ ...o, [qi]: '' }))
  }

  const answerFor = (qi: number): string => {
    const free = (other[qi] ?? '').trim()
    const picked = sel[qi] ?? []
    return questions[qi].multiSelect ? [...picked, ...(free ? [free] : [])].join(', ') : free || picked[0] || ''
  }
  const complete = questions.length > 0 && questions.every((_, i) => answerFor(i) !== '')

  const submit = (): void => {
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)]))
    answer({ decision: 'allow', updatedInput: { ...asRecord(req.input), answers } })
  }

  return (
    <div className={card}>
      {questions.map((q, qi) => (
        <div key={qi} className="mb-4 last:mb-3">
          {q.header && <div className="eyebrow mb-1 text-accent">{q.header}</div>}
          <div dir="auto" className="mb-2 text-[15px] font-medium text-fg">
            {q.question}
          </div>
          <div className="space-y-1.5">
            {q.options.map((o) => {
              const on = (sel[qi] ?? []).includes(o.label)
              return (
                <button
                  key={o.label}
                  disabled={sent}
                  onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                    on ? 'border-accent/70 bg-accent/10' : 'border-line hover:border-faint'
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 text-sm ${on ? 'text-accent' : 'text-faint'}`}>
                    {q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○'}
                  </span>
                  <span className="min-w-0" dir="auto">
                    <span className="block text-sm text-fg">{o.label}</span>
                    {o.description && <span className="block text-[12px] text-faint">{o.description}</span>}
                  </span>
                </button>
              )
            })}
            <input
              value={other[qi] ?? ''}
              disabled={sent}
              dir="auto"
              onChange={(e) => {
                const v = e.target.value
                setOther((o) => ({ ...o, [qi]: v }))
                if (!q.multiSelect && v) setSel((s) => ({ ...s, [qi]: [] }))
              }}
              placeholder="Other…"
              className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60"
            />
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button disabled={sent} onClick={() => answer({ decision: 'deny', message: 'The user dismissed the question.' })}>
          Dismiss
        </Button>
        <Button variant="primary" disabled={sent || !complete} onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  )
}

function PlanCard({ req, onAnswer }: Props) {
  const plan = String(asRecord(req.input).plan ?? '')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [sent, answer] = useAnswer(onAnswer)
  return (
    <div className={card}>
      <div className="eyebrow mb-2 text-accent">Plan</div>
      <div dir="auto" className="md-body max-h-[50vh] overflow-y-auto pr-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
      {feedback !== null && (
        <textarea
          autoFocus
          dir="auto"
          rows={3}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What should change? (optional)"
          className="mt-3 w-full resize-none rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60"
        />
      )}
      <div className="mt-3 flex justify-end gap-2">
        {feedback === null ? (
          <Button disabled={sent} onClick={() => setFeedback('')}>
            Keep planning
          </Button>
        ) : (
          <Button
            disabled={sent}
            onClick={() => answer({ decision: 'deny', message: feedback.trim() || 'Keep planning.' })}
          >
            Send feedback
          </Button>
        )}
        <Button
          variant="primary"
          disabled={sent}
          onClick={() => answer({ decision: 'allow', updatedInput: req.input })}
        >
          Approve
        </Button>
      </div>
    </div>
  )
}

/** One line saying what the tool is about to do. */
function permissionSummary(req: ChatRequest): string {
  const i = asRecord(req.input)
  const pick = [i.command, i.file_path, i.path, i.pattern, i.url, i.query].find((v) => typeof v === 'string' && v)
  return typeof pick === 'string' ? pick : req.description ?? ''
}

function PermissionCard({ req, onAnswer }: Props) {
  const [sent, answer] = useAnswer(onAnswer)
  const summary = permissionSummary(req)
  return (
    <div className={card}>
      <div className="eyebrow mb-1.5 text-amber">Permission</div>
      <div className="text-sm text-fg">{req.title || `Claude wants to use ${req.toolName}`}</div>
      {summary && (
        <pre dir="ltr" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-ink/60 p-3 font-mono text-[12px] text-fg/85">
          {summary}
        </pre>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button disabled={sent} onClick={() => answer({ decision: 'deny', message: 'The user denied this action.' })}>
          Deny
        </Button>
        <Button
          variant="primary"
          disabled={sent}
          onClick={() => answer({ decision: 'allow', updatedInput: req.input })}
        >
          Allow
        </Button>
      </div>
    </div>
  )
}

export function RequestCard({ req, onAnswer }: Props) {
  if (req.kind === 'question') return <QuestionCard req={req} onAnswer={onAnswer} />
  if (req.kind === 'plan') return <PlanCard req={req} onAnswer={onAnswer} />
  return <PermissionCard req={req} onAnswer={onAnswer} />
}
