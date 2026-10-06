import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CommandInfo } from './chat/Menus'

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
  /** Built-ins, skills and commands offered when the text starts with "/". */
  commands: CommandInfo[]
  /** Called when the box first starts with "/": the parent loads the list then. */
  onNeedCommands: () => void
  /** A new `id` puts `text` in the box and focuses it (an Actions menu pick). */
  insert: { id: number; text: string } | null
}

const MAX_HEIGHT = 240

/**
 * The message box at the bottom of a chat. Enter sends, Shift+Enter breaks the
 * line. The text is pasted into the Claude Code TUI in tmux; if that refuses (it
 * holds unsent text of its own), the draft stays here.
 */
export function ChatComposer({ draftKey, active, disabled, disabledHint, busy, onSend, onInterrupt, commands, onNeedCommands, insert }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  // Nothing is saved until the stored draft has been read: the empty initial
  // value would otherwise overwrite it.
  const [loaded, setLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const [sel, setSel] = useState(0)
  // Esc closes the suggestions until the text changes.
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

  useEffect(() => {
    if (!insert) return
    setDraft(insert.text)
    ref.current?.focus()
    // Only a new request inserts; `insert` itself is a fresh object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.id])

  // "/" at the start, before any space: still choosing the command.
  const query = /^\/([^\s/]*)$/.exec(draft)?.[1] ?? null
  useEffect(() => {
    if (query !== null) onNeedCommands()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query !== null])
  const matches = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q))
    const has = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))
    return [...starts, ...has].slice(0, 30)
  }, [query, commands])
  const showing = !disabled && !dismissed && matches.length > 0
  const at = Math.min(sel, Math.max(matches.length - 1, 0))

  const pick = (c: CommandInfo): void => {
    setDraft(`/${c.name} `)
    setSel(0)
  }

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
    if (showing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((at + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && matches[at].name !== query)) {
        e.preventDefault()
        pick(matches[at])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
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
      {showing && (
        <div className="panel animate-rise absolute inset-x-6 bottom-[calc(100%-0.5rem)] z-20 max-h-56 overflow-y-auto p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
          {matches.map((c, i) => (
            <button
              key={`${c.source}:${c.name}`}
              // mousedown, so the textarea keeps its focus
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors ${i === at ? 'bg-accent/15' : ''}`}
            >
              <span className={`shrink-0 font-mono text-[13px] ${i === at ? 'text-accent' : 'text-fg/90'}`}>/{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{c.description}</span>
              <span className="shrink-0 text-[10px] text-faint">{c.source}</span>
            </button>
          ))}
        </div>
      )}
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
          onChange={(e) => {
            setDraft(e.target.value)
            setSel(0)
            setDismissed(false)
          }}
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
