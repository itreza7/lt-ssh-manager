import { useState } from 'react'
import type { ChatAnswer, TuiPrompt } from '../../../../shared/chatProtocol'
import { Button } from '../Modal'
import { renderMarkdown } from '../MarkdownPreview'

interface Props {
  prompt: TuiPrompt
  /** Types the answer into the TUI. Rejects when it could not, so the card can be used again. */
  onAnswer: (a: ChatAnswer) => Promise<void>
  /** Hand the prompt to the terminal tab instead. */
  onTerminal?: () => void
}

const card = 'animate-rise rounded-xl border border-sel bg-bubble p-4'

const HEADER: Record<TuiPrompt['kind'], string> = {
  question: 'Claude asks',
  review: 'Review answers',
  plan: 'Plan ready',
  permission: 'Permission'
}

/** The dialog Claude Code has open, read off the screen. Every button types one option's digit. */
export function PromptCard({ prompt, onAnswer, onTerminal }: Props) {
  // The buttons lock once an answer is on its way; a send that fails unlocks them again.
  const [sent, setSent] = useState(false)
  const [freeDigit, setFreeDigit] = useState<string | null>(null)
  const [text, setText] = useState('')

  const answer = (a: ChatAnswer): void => {
    setSent(true)
    onAnswer(a).then(
      () => setSent(false),
      () => setSent(false)
    )
  }

  return (
    <div className={card}>
      <div className={`eyebrow mb-1.5 ${prompt.kind === 'permission' ? 'text-amber' : 'text-accent'}`}>{HEADER[prompt.kind]}</div>
      {prompt.body &&
        (prompt.kind === 'plan' ? (
          <div dir="auto" className="md-body mb-3 max-h-[50vh] overflow-y-auto pr-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.body) }} />
        ) : (
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
                onClick={() => (o.freeText ? setFreeDigit(open ? null : o.digit) : answer({ kind: 'option', digit: o.digit, label: o.label }))}
                className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                  o.checked || open ? 'border-accent/70 bg-accent/10' : 'border-sel hover:bg-line'
                }`}
              >
                <span className={`mt-0.5 shrink-0 text-sm ${o.checked ? 'text-accent' : 'text-faint'}`}>
                  {o.checked !== undefined ? (o.checked ? '☑' : '☐') : `${o.digit}.`}
                </span>
                <span className="min-w-0" dir="auto">
                  <span className="block text-sm text-fg">{o.label}</span>
                  {o.description && <span className="block text-[12px] text-faint">{o.description}</span>}
                </span>
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
        {prompt.canTab && (
          <Button disabled={sent} onClick={() => answer({ kind: 'tab' })}>
            Next ⇥
          </Button>
        )}
      </div>
    </div>
  )
}
