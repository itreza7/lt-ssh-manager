import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

interface Props {
  /** Key of the autosaved draft (see window.api.drafts*). */
  draftKey: string
  /** The tab is on screen: take focus. */
  active: boolean
  /** Nothing to type into: the session ended, or it is not in a tmux pane. */
  disabled: boolean
  /** What the box says when disabled. */
  disabledHint: string
  /** A turn is running: Esc interrupts it. */
  busy: boolean
  /** Resolves true once the text was typed into the TUI; the draft is kept otherwise. */
  onSend: (text: string) => Promise<boolean>
  onInterrupt: () => void
}

const MAX_HEIGHT = 240

/**
 * The message box at the bottom of a chat. Enter sends, Shift+Enter breaks the
 * line. The text is pasted into the Claude Code TUI in tmux; if that refuses (it
 * holds unsent text of its own), the draft stays here.
 */
export function ChatComposer({ draftKey, active, disabled, disabledHint, busy, onSend, onInterrupt }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  // Nothing is saved until the stored draft has been read: the empty initial
  // value would otherwise overwrite it.
  const [loaded, setLoaded] = useState(false)
  const [sending, setSending] = useState(false)

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

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || disabled || sending) return
    setSending(true)
    try {
      if (await onSend(text)) setDraft((d) => (d.trim() === text ? '' : d))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Persian/Arabic/CJK input methods use Enter to commit a candidate.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && busy && !disabled) {
      e.preventDefault()
      onInterrupt()
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-[46rem] px-6 pb-4 pt-2">
      <div
        className={`flex items-end gap-2 rounded-2xl border bg-surface px-3.5 py-2.5 transition-colors focus-within:border-accent/60 ${
          busy ? 'border-accent/30' : 'border-line'
        }`}
      >
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          dir="auto"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? disabledHint : 'Message Claude…'}
          className="min-h-[1.75rem] flex-1 resize-none bg-transparent py-0.5 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
        />
        <button
          onClick={() => void send()}
          disabled={disabled || sending || !draft.trim()}
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
