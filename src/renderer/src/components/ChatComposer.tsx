import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SlashCommandInfo } from '../../../shared/chatProtocol'

interface Props {
  /** Key of the autosaved draft (see window.api.drafts*). */
  draftKey: string
  /** The tab is on screen: take focus. */
  active: boolean
  /** The session is gone, so there is nothing to send to. */
  disabled: boolean
  /** A turn is running: Esc interrupts it. Typing and sending still work — the relay queues. */
  running: boolean
  slashCommands: SlashCommandInfo[]
  onSend: (text: string) => void
  onInterrupt: () => void
}

const MAX_HEIGHT = 240
const MAX_SUGGESTIONS = 8

/**
 * The message box at the bottom of a chat. Enter sends, Shift+Enter breaks the
 * line. It stays typeable while Claude works: what is sent then is queued by the
 * relay and handed over when the turn ends.
 */
export function ChatComposer({ draftKey, active, disabled, running, slashCommands, onSend, onInterrupt }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  // Nothing is saved until the stored draft has been read: the empty initial
  // value would otherwise overwrite it.
  const [loaded, setLoaded] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let off = false
    void window.api.draftsAll().then((all) => {
      if (off) return
      setDraft((d) => d || all[draftKey] || '')
      setLoaded(true)
    })
    return () => {
      off = true
    }
  }, [draftKey])

  // Local autosave, like the terminal composer: survives a restart.
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => void window.api.draftsSet(draftKey, draft), 300)
    return () => clearTimeout(t)
  }, [draft, draftKey, loaded])

  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active])

  // Grow with the text, up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [draft])

  // "/co" offers the commands that start with it; once a space follows, the
  // user is typing arguments and the list goes away.
  const slash = /^\/(\S*)$/.exec(draft)
  const suggestions =
    slash && !dismissed
      ? slashCommands.filter((c) => c.name.replace(/^\//, '').startsWith(slash[1])).slice(0, MAX_SUGGESTIONS)
      : []
  const at = Math.min(cursor, Math.max(0, suggestions.length - 1))

  const complete = (c: SlashCommandInfo): void => {
    setDraft(`/${c.name.replace(/^\//, '')} `)
    setDismissed(false)
    ref.current?.focus()
  }

  const send = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
    setDismissed(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Persian/Arabic/CJK input methods use Enter to commit a candidate.
    if (e.nativeEvent.isComposing) return
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (e.key === 'ArrowDown' ? Math.min(c + 1, suggestions.length - 1) : Math.max(c - 1, 0)))
        return
      }
      const exact = draft.trim() === `/${suggestions[at].name.replace(/^\//, '')}`
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
        e.preventDefault()
        complete(suggestions[at])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (suggestions.length) setDismissed(true)
      else if (running) onInterrupt()
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-[46rem] px-6 pb-4 pt-2">
      {suggestions.length > 0 && (
        <div className="panel absolute inset-x-6 bottom-full mb-1 max-h-64 overflow-y-auto p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
          {suggestions.map((c, i) => (
            <button
              key={c.name}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus in the textarea
                complete(c)
              }}
              onMouseEnter={() => setCursor(i)}
              className={`flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left ${i === at ? 'bg-accent/15' : ''}`}
            >
              <span className="shrink-0 font-mono text-sm text-fg">
                /{c.name.replace(/^\//, '')}
                {c.argumentHint && <span className="text-faint"> {c.argumentHint}</span>}
              </span>
              <span className="truncate text-[12px] text-faint">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={`flex items-end gap-2 rounded-2xl border bg-surface px-3.5 py-2.5 transition-colors focus-within:border-accent/60 ${
          running ? 'border-accent/30' : 'border-line'
        }`}
      >
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          dir="auto"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setCursor(0)
            setDismissed(false)
          }}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Session stopped' : running ? 'Claude is working — your message will be queued' : 'Message Claude…'}
          className="min-h-[1.75rem] flex-1 resize-none bg-transparent py-0.5 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
        />
        <button
          onClick={send}
          disabled={disabled || !draft.trim()}
          title="Send (Enter)"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-ink transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
