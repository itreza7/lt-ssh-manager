import { useState } from 'react'
import type { ChatAnswer, TuiPrompt } from '../../../../shared/chatProtocol'
import { Button } from '../Modal'
import { renderMarkdown } from '../MarkdownPreview'
import { Spinner } from './Blocks'

interface Props {
  prompt: TuiPrompt
  /** Types the answer into the TUI. Rejects when it could not, so the card can be used again. */
  onAnswer: (a: ChatAnswer) => Promise<void>
  /** Hand the prompt to the terminal tab instead. */
  onTerminal?: () => void
  /** The full plan to show in the card (the screen holds only its end). */
  plan?: string
  /** The plan is in the panel at the right: the card shows no copy of it. */
  planAside?: boolean
  /** Opens the plan panel again after it was hidden. */
  onShowPlan?: () => void
}

const UNLOCK_MS = 8000

const card = 'animate-rise rounded-xl border border-sel bg-bubble p-4'

const HEADER: Record<TuiPrompt['kind'], string> = {
  question: 'Claude asks',
  review: 'Review answers',
  plan: 'Plan ready',
  permission: 'Permission'
}

/** The dialog Claude Code has open, read off the screen. Every button types one option's digit. */
export function PromptCard({ prompt, onAnswer, onTerminal, plan, planAside, onShowPlan }: Props) {
  // The buttons lock once an answer is on its way, and stay locked until the card goes:
  // the screen is read again right after. A send that fails unlocks them.
  // `chosen`: the option's digit (or 'tab' / 'back'), shown with a spinner meanwhile.
  const [chosen, setChosen] = useState<string | null>(null)
  const sent = chosen !== null
  const [freeDigit, setFreeDigit] = useState<string | null>(null)
  const [text, setText] = useState('')

  const answer = (a: ChatAnswer, again = false): void => {
    setChosen(a.kind === 'option' ? a.digit : a.kind)
    onAnswer(a).then(
      // A checkbox toggles in place; the card stays, so it is usable again.
      // If the same dialog is still there after a while, let it be used again.
      () => (again ? setChosen(null) : setTimeout(() => setChosen(null), UNLOCK_MS)),
      () => setChosen(null)
    )
  }

  return (
    <div className={card}>
      <div className={`eyebrow mb-1.5 ${prompt.kind === 'permission' ? 'text-amber' : 'text-accent'}`}>{HEADER[prompt.kind]}</div>
      {prompt.kind === 'plan' && planAside && <div className="mb-3 text-[13px] text-faint">The plan is open on the right.</div>}
      {prompt.kind === 'plan' && !planAside && (plan || prompt.body) && (
        <div dir="auto" className="md-body mb-3 max-h-[50vh] overflow-y-auto pr-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan || prompt.body) }} />
      )}
      {prompt.body &&
        (prompt.kind === 'plan' ? null : (
          <div dir="auto" className="mb-3 max-h-[40vh] overflow-y-auto whitespace-pre-wrap text-[14px] text-fg">
            {prompt.body}
          </div>
        ))}
      <div className="space-y-1.5">
        {prompt.options.map((o) => {
          const open = freeDigit === o.digit
          return (
            <div key={o.digit}>
              <button
                disabled={sent}
                onClick={() =>
                  o.freeText ? setFreeDigit(open ? null : o.digit) : answer({ kind: 'option', digit: o.digit, label: o.label }, o.checked !== undefined)
                }
                className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                  o.checked || open || chosen === o.digit ? 'border-accent/70 bg-accent/10' : 'border-sel hover:bg-line'
                } ${sent && chosen !== o.digit ? 'opacity-50' : ''}`}
              >
                <span className={`mt-0.5 shrink-0 text-sm ${o.checked ? 'text-accent' : 'text-faint'}`}>
                  {o.checked !== undefined ? (o.checked ? '☑' : '☐') : `${o.digit}.`}
                </span>
                <span className="min-w-0" dir="auto">
                  <span className="block text-sm text-fg">{o.label}</span>
                  {o.description && <span className="block text-[12px] text-faint">{o.description}</span>}
                </span>
                {chosen === o.digit && <Spinner className="ml-auto mt-1 text-accent" />}
              </button>
              {open && (
                <div className="mt-1.5 flex items-end gap-2">
                  <textarea
                    autoFocus
                    dir="auto"
                    rows={3}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="min-w-0 flex-1 resize-none rounded-lg border border-sel bg-panel px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-[#444]"
                  />
                  <Button
                    variant="primary"
                    disabled={sent || !text.trim()}
                    onClick={() => answer({ kind: 'option', digit: o.digit, label: o.label, text: text.trim() })}
                  >
                    Send
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {onTerminal && (
          <button onClick={onTerminal} className="mr-auto text-[12px] text-faint transition-colors hover:text-fg">
            Open in terminal
          </button>
        )}
        {onShowPlan && <Button onClick={onShowPlan}>View plan</Button>}
        {prompt.canBack && (
          <Button disabled={sent} onClick={() => answer({ kind: 'back' }, true)}>
            {chosen === 'back' ? <Spinner /> : '← Back'}
          </Button>
        )}
        {prompt.canTab && (
          <Button disabled={sent} onClick={() => answer({ kind: 'tab' }, true)}>
            {chosen === 'tab' ? <Spinner /> : 'Next ⇥'}
          </Button>
        )}
      </div>
    </div>
  )
}
