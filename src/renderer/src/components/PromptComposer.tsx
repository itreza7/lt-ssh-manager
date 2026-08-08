import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { fmtAccel, isMac } from '../lib/platform'
import { COMPOSE_ACCEL } from '../lib/xtermAttach'

const SEND_ACCEL = fmtAccel('Ctrl+Enter')
const INSERT_ACCEL = fmtAccel('Alt+Enter')

/** Ceiling on the drafting area itself; the panel is capped again in CSS. */
const TEXTAREA_MAX = 240
/** Tailwind's preflight makes everything border-box, so the border has to be
 *  added back: scrollHeight is content + padding, `height` is that plus border. */
const TEXTAREA_BORDER = 2

interface Props {
  /** The drafting panel is open. When closed, a draft still shows as a strip. */
  open: boolean
  /**
   * Bumped on every *request* to compose, not just on opening.
   *
   * Focus can leave an open composer without closing it — clicking the terminal
   * (xterm focuses its own helper textarea on mousedown), or the pane being
   * parked `display: none` behind another tab. If focus only followed the
   * open false→true edge, the chord couldn't get it back afterwards: the panel
   * would sit there looking ready while every keystroke went to the remote.
   */
  focusKey: number
  draft: string
  onDraft: (v: string) => void
  /** Send the draft; `submit` false leaves it on the remote's line unsent. */
  onSend: (submit: boolean) => void
  onOpen: () => void
  onClose: () => void
  onDiscard: () => void
  /** Where the text will land. Shown when a tab has more than one target. */
  target?: string
  /** The remote has bracketed paste on, so newlines stay newlines. */
  bracketed: boolean
}

/**
 * A drafting bar for multi-line input, overlaid on the bottom of a terminal.
 *
 * The point is Shift+Enter's problem one size up: some things you want to say to
 * a terminal agent are paragraphs, and typing a paragraph *into* a live prompt
 * means every keystroke races the program's own redraws. Here the draft is local
 * until you send it, and it arrives as a single bracketed paste — one unit, not
 * a stream of keys.
 *
 * It is deliberately an **overlay**, not a sibling in the pane's flex column: a
 * docked sibling changes the terminal host's box, which trips the ResizeObserver
 * and pushes a new PTY size. Under tmux that reflows the session for *every*
 * attached client, so opening a composer here would visibly reformat someone
 * else's window. The cost is that it covers the bottom rows while open, which is
 * why it stays as short as its content allows and disappears entirely when
 * there's nothing drafted.
 */
export function PromptComposer({
  open,
  focusKey,
  draft,
  onDraft,
  onSend,
  onOpen,
  onClose,
  onDiscard,
  target,
  bracketed
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the content up to a ceiling, then scroll. An explicit height, not
  // flex-1: a flex-basis of 0 in an auto-height column collapses the box, and the
  // panel's height should follow the draft anyway — it's covering terminal rows.
  // Layout effect so the box is already right on the frame it appears; measuring
  // after paint shows a one-line box that visibly jumps.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !open) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight + TEXTAREA_BORDER, TEXTAREA_MAX)}px`
  }, [draft, open])

  // Keyed on focusKey as well as open — see the prop. Re-focusing an element
  // that already has focus is a no-op in Chromium and leaves the caret alone,
  // so an extra bump costs nothing.
  useLayoutEffect(() => {
    if (open) ref.current?.focus()
  }, [open, focusKey])

  const body = draft.replace(/\s+$/, '')

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter is left alone on purpose: making a new line is what this is for.
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      onSend(true)
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      onSend(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open && !draft) return null

  // Closed with a draft: a 28px strip, so text you can't see is never text you
  // forgot about. Closed with nothing drafted renders nothing at all — a
  // permanent strip would sit exactly where a full-height terminal puts its
  // prompt.
  if (!open) {
    const lines = draft.split('\n')
    return (
      <div className="absolute inset-x-0 bottom-0 z-20 flex h-7 items-center gap-2 border-t border-line bg-surface/95 px-3 backdrop-blur-sm">
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="eyebrow shrink-0 text-accent">draft</span>
          <span className="truncate font-mono text-[11px] text-muted">
            {lines.find((l) => l.trim()) ?? ''}
          </span>
          {lines.length > 1 && (
            <span className="shrink-0 text-[11px] text-faint">+{lines.length - 1} more</span>
          )}
        </button>
        <span className="shrink-0 font-mono text-[11px] text-faint">{COMPOSE_ACCEL}</span>
        <button
          onClick={onDiscard}
          title="Discard draft"
          className="shrink-0 px-1 text-faint transition-colors hover:text-danger"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex max-h-[60%] flex-col border-t border-line bg-surface/95 shadow-lg shadow-ink/60 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <span className="eyebrow shrink-0 text-accent">prompt composer</span>
        {target && <span className="truncate font-mono text-[11px] text-faint">→ {target}</span>}
        <div className="flex-1" />
        <button
          onClick={onClose}
          title="Close (Esc)"
          className="px-1 text-faint transition-colors hover:text-fg"
        >
          ×
        </button>
      </div>

      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        placeholder="Write as many lines as you like — nothing reaches the remote until you send."
        className="mx-3 mt-1.5 min-h-0 resize-none overflow-y-auto rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint/70 focus:border-accent/60"
      />

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span className="text-[11px] text-faint">
          <Key>{SEND_ACCEL}</Key> send · <Key>{INSERT_ACCEL}</Key> insert without sending ·{' '}
          <Key>Esc</Key> close
        </span>
        {!bracketed && (
          <span className="text-[11px] text-amber">
            Bracketed paste is off here — each line will run as its own command.
          </span>
        )}
        <div className="flex-1" />
        <button
          disabled={!body}
          onClick={() => onSend(false)}
          className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-fg disabled:opacity-40 disabled:hover:text-muted"
        >
          Insert
        </button>
        <button
          disabled={!body}
          onClick={() => onSend(true)}
          className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Send ▸
        </button>
      </div>
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return <span className="font-mono text-muted">{children}</span>
}
