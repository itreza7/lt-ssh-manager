import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CommandPicker, box, usePopover, type CommandInfo } from './chat/Menus'
import type { UsageLimit } from '../../../shared/tuiKeys'

/** The plan limits for the ring's popover, read with /usage. */
export interface UsageInfo {
  state: 'idle' | 'loading' | 'ok' | 'failed'
  limits: UsageLimit[]
}

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
  /** The bottom row, after the "+": the mode. */
  leftControls?: ReactNode
  /** The bottom row, at the right: model and effort. */
  rightControls?: ReactNode
  /** The user's statusLine segments, shown as small text. */
  chips?: string[]
  /** Prompt tokens in use and the context window, for the ring. */
  ctx?: { tokens: number; window: number } | null
  /** The ring's popover: the TUI's "N% until auto-compact", plan limits, and Compact. */
  autoCompactLeft?: number
  usage?: UsageInfo
  /** Limits read off the statusLine (5h, 7d), shown while /usage has none. */
  usageFallback?: UsageLimit[]
  onContextOpen?: () => void
  onCompact?: () => void
  /** Another command is typing into the pane (a /usage read): Compact waits. */
  compactBusy?: boolean
  /** In the strip above the box: the folder, and the git branch once known. */
  folder?: string
  branch?: string | null
}

const MAX_HEIGHT = 240
const RING_R = 6
const RING_C = 2 * Math.PI * RING_R

const kTokens = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${+(n / 1000).toFixed(1)}k`)

/** How full the context window is: an amber ring that turns red as it fills. */
function ContextRing({ frac }: { frac: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
      <circle cx="8" cy="8" r={RING_R} fill="none" stroke="var(--color-sel)" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={RING_R}
        fill="none"
        stroke={frac > 0.9 ? 'var(--color-danger)' : 'var(--color-amber)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${frac * RING_C} ${RING_C}`}
      />
    </svg>
  )
}

function Bar({ frac, danger }: { frac: number; danger?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sel">
      <div className={`h-full rounded-full ${danger ? 'bg-danger' : 'bg-amber'}`} style={{ width: `${Math.round(Math.min(Math.max(frac, 0), 1) * 100)}%` }} />
    </div>
  )
}

/** The ring, and on click what Claude desktop shows there: the context window and the plan's usage limits. */
function ContextButton(p: {
  tokens: number
  window: number
  chips?: string[]
  autoCompactLeft?: number
  usage?: UsageInfo
  usageFallback?: UsageLimit[]
  onOpen?: () => void
  onCompact?: () => void
  compactBusy?: boolean
}) {
  const { open, setOpen, ref } = usePopover()
  const frac = Math.min(Math.max(p.tokens / p.window, 0), 1)
  const pct = Math.round(frac * 100)
  const line = `${kTokens(p.tokens)} / ${kTokens(p.window)} (${pct}%)`
  const tip = [`Context ${line}`, ...(p.chips ?? [])].join(' · ')
  const limits = p.usage?.limits.length ? p.usage.limits : (p.usageFallback ?? [])
  const head = 'text-[12px] font-medium text-muted'
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (!open) p.onOpen?.()
          setOpen(!open)
        }}
        title={open ? undefined : tip}
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-white/[0.06] ${open ? 'bg-white/[0.06]' : ''}`}
      >
        <ContextRing frac={frac} />
      </button>
      {open && (
        <div className={`${box} bottom-[calc(100%+6px)] right-0 w-72 p-3 text-[13px] text-fg`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className={head}>Context window</span>
            <span className="text-[12px] text-faint">{line}</span>
          </div>
          <div className="mt-2">
            <Bar frac={frac} danger={frac > 0.9} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[12px] text-faint">
              {p.autoCompactLeft !== undefined ? `${p.autoCompactLeft}% left until auto-compact` : 'Auto-compacts when full'}
            </span>
            {p.onCompact && (
              <button
                disabled={p.compactBusy}
                onClick={() => {
                  setOpen(false)
                  p.onCompact?.()
                }}
                className="shrink-0 rounded-md bg-sel px-2 py-0.5 text-[12px] text-title transition-colors hover:bg-white/[0.12] disabled:opacity-40 disabled:hover:bg-sel"
              >
                Compact session
              </button>
            )}
          </div>
          <div className="my-3 h-px bg-sel" />
          <div className="flex items-baseline justify-between gap-2">
            <span className={head}>Plan usage limits</span>
            {p.usage?.state === 'loading' && <span className="animate-glow text-[11px] text-faint">Loading…</span>}
          </div>
          {limits.length === 0 ? (
            <div className="mt-2 text-[12px] text-faint">
              {p.usage?.state === 'loading' ? 'Reading /usage…' : p.usage?.state === 'failed' ? 'Could not read /usage right now.' : 'No usage data yet.'}
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2.5">
              {limits.map((l) => (
                <div key={l.label}>
                  <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                    <span className="truncate">{l.label}</span>
                    <span className="shrink-0 text-faint">{Math.round(l.percent)}%</span>
                  </div>
                  <div className="mt-1">
                    <Bar frac={l.percent / 100} danger={l.percent >= 90} />
                  </div>
                  {l.resets && <div className="mt-0.5 text-[11px] text-faint">Resets {l.resets}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The message box at the bottom of a chat. Enter sends, Shift+Enter breaks the
 * line. The text is pasted into the Claude Code TUI in tmux; if that refuses (it
 * holds unsent text of its own), the draft stays here.
 */
export function ChatComposer({ draftKey, active, disabled, disabledHint, busy, onSend, onInterrupt, commands, onNeedCommands, insert, leftControls, rightControls, chips, ctx, autoCompactLeft, usage, usageFallback, onContextOpen, onCompact, compactBusy, folder, branch }: Props) {
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
  // From the "+" menu: same as choosing it in the suggestions.
  const pickName = (name: string): void => {
    setDraft(`/${name} `)
    setSel(0)
    ref.current?.focus()
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
    <div className="w-full shrink-0 px-6 pb-0.5 pt-2">
      <div className="mx-auto w-full max-w-[740px]">
        <div className="relative">
          {showing && (
            <div className="animate-rise absolute inset-x-0 bottom-[calc(100%+8px)] z-20 max-h-56 overflow-y-auto rounded-[10px] border border-sel bg-elevated p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]">
              {matches.map((c, i) => (
                <button
                  key={`${c.source}:${c.name}`}
                  // mousedown, so the textarea keeps its focus
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(c)
                  }}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left transition-colors ${i === at ? 'bg-sel' : ''}`}
                >
                  <span className="shrink-0 font-mono text-[13px] text-fg">/{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{c.description}</span>
                  <span className="shrink-0 text-[11px] text-faint">{c.source}</span>
                </button>
              ))}
            </div>
          )}
          {(folder || branch) && (
            <div className="mb-1.5 flex h-10 min-w-0 items-center gap-2 rounded-lg bg-bubble px-3 text-[13px] text-faint">
              {folder && <span className="truncate font-sans">{folder}</span>}
              {branch && (
                <span className="min-w-0 truncate font-mono" title="Git branch">
                  {branch}
                </span>
              )}
            </div>
          )}
          <div
            className={`flex items-end rounded-lg border bg-panel transition-colors focus-within:border-[#444] ${
              busy ? 'border-amber/40' : 'border-line'
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
              className="min-h-[38px] min-w-0 flex-1 resize-none bg-transparent px-3 py-[9px] text-[14px] leading-5 text-fg outline-none placeholder:text-faint"
            />
            {busy && !disabled && !draft.trim() ? (
              <button
                onClick={onInterrupt}
                title="Stop the current turn (Esc)"
                className="mb-1 mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-title"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={disabled || sending || !draft.trim()}
                title="Send (Enter)"
                className="mb-1 mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg transition-colors hover:bg-white/[0.06] disabled:text-faint disabled:hover:bg-transparent"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 10 4 15 9 20" />
                  <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex h-8 items-center gap-1">
          <CommandPicker commands={commands} disabled={disabled} onNeedCommands={onNeedCommands} onPick={pickName} />
          {leftControls}
          <div className="min-w-0 flex-1" />
          {rightControls}
          {ctx && (
            <ContextButton
              tokens={ctx.tokens}
              window={ctx.window}
              chips={chips}
              autoCompactLeft={autoCompactLeft}
              usage={usage}
              usageFallback={usageFallback}
              onOpen={onContextOpen}
              onCompact={onCompact}
              compactBusy={compactBusy}
            />
          )}
        </div>
      </div>
    </div>
  )
}
