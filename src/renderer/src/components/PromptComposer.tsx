import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type TransitionEvent
} from 'react'
import type { ComposerSendMode } from '../../../shared/types'
import { fmtAccel, isMac } from '../lib/platform'
import { COMPOSE_ACCEL } from '../lib/xtermAttach'

const SEND_ACCEL = fmtAccel('Ctrl+Enter')
const INSERT_ACCEL = fmtAccel('Alt+Enter')

/** Text commands the quick-actions row sends exactly like a typed + submitted
 *  draft — same `onSend` path, just skipping the textarea. */
const QUICK_COMMANDS: { label: string; text: string; title: string }[] = [
  { label: '/clear', text: '/clear', title: 'Clear conversation history' },
  { label: '/compact', text: '/compact', title: 'Compact conversation history' },
  { label: '/resume', text: '/resume', title: 'Resume a previous session' },
  { label: '/help', text: '/help', title: 'Show available commands' }
]

/** Raw key chords the quick-actions row sends unbracketed via `onSendKey` —
 *  these are keypresses Claude Code reads directly, not text to submit. */
const QUICK_KEYS: { label: string; data: string; title: string }[] = [
  { label: 'Shift+Tab', data: '\x1b[Z', title: 'Cycle mode (plan / auto-accept / default)' },
  { label: 'Esc', data: '\x1b', title: 'Interrupt the current turn' }
]

/** A paste past either threshold gets collapsed to a placeholder — short pastes
 *  (a URL, a one-liner) stay inline where they're easy to read and edit. */
const PASTE_COLLAPSE_MIN_LINES = 4
const PASTE_COLLAPSE_MIN_CHARS = 500

function shouldCollapsePaste(text: string): boolean {
  return text.length > PASTE_COLLAPSE_MIN_CHARS || text.split('\n').length > PASTE_COLLAPSE_MIN_LINES
}

function pasteLabel(n: number, text: string): string {
  return `[Pasted text #${n} +${text.split('\n').length} lines]`
}

/** Substitute every placeholder this session has minted back into the body
 *  that actually reaches the remote — the collapse is a display convenience,
 *  never a data loss. */
function expandPastes(text: string, pastes: Map<string, string>): string {
  if (pastes.size === 0) return text
  let out = text
  for (const [label, full] of pastes) out = out.split(label).join(full)
  return out
}

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
  /**
   * Send the draft; `submit` false leaves it on the remote's line unsent.
   * `body` is the draft with any collapsed-paste placeholders expanded back
   * to their full text — the caller sends this, not the raw `draft` value.
   */
  onSend: (submit: boolean, body: string) => void
  /** What plain Enter does here — see ComposerSendMode. */
  sendMode: ComposerSendMode
  onOpen: () => void
  onClose: () => void
  onDiscard: () => void
  /** Where the text will land. Shown when a tab has more than one target. */
  target?: string
  /** Send a raw key chord straight through, unbracketed — for quick actions
   *  like Shift+Tab that Claude Code reads as a keypress, not text. */
  onSendKey: (data: string) => void
}

/** The three heights this panel occupies, ordered short to tall. */
type Mode = 'empty' | 'strip' | 'open'
const RANK: Record<Mode, number> = { empty: 0, strip: 1, open: 2 }

/**
 * A drafting bar for multi-line input, docked below a terminal.
 *
 * The point is Shift+Enter's problem one size up: some things you want to say to
 * a terminal agent are paragraphs, and typing a paragraph *into* a live prompt
 * means every keystroke races the program's own redraws. Here the draft is local
 * until you send it, and it arrives as a single bracketed paste — one unit, not
 * a stream of keys.
 *
 * It is a real sibling in the pane's flex column, not an overlay — the caller is
 * responsible for the trade-off that implies (shrinking the terminal's box while
 * open, which under tmux reflows every attached client; see TerminalView's and
 * TmuxControlView's own doc comments where this mounts). What this component
 * owns is the animated collapse between three heights — nothing, the
 * closed-with-a-draft strip, and the full panel — so opening slides the panel up
 * into view and closing slides it back down instead of popping between sizes.
 * The outer wrapper's `max-height` is what animates; on the way down the old,
 * taller content stays mounted until the transition finishes so there's
 * something to visibly slide away, then swaps to the smaller content once the
 * box has actually reached its new size.
 */
export function PromptComposer({
  open,
  focusKey,
  draft,
  onDraft,
  onSend,
  sendMode,
  onOpen,
  onClose,
  onDiscard,
  target,
  onSendKey
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Placeholders minted by this composer instance, label -> full pasted text.
  // Never persisted (a restart losing the odd in-flight paste is an acceptable
  // trade for not doubling the on-disk draft format) and never reset on its
  // own — the counter only climbs, so two pastes never mint the same label.
  const pastesRef = useRef<Map<string, string>>(new Map())
  const pasteCounterRef = useRef(0)

  // Keyed on focusKey as well as open — see the prop. Re-focusing an element
  // that already has focus is a no-op in Chromium and leaves the caret alone,
  // so an extra bump costs nothing.
  useLayoutEffect(() => {
    if (open) ref.current?.focus()
  }, [open, focusKey])

  const body = draft.replace(/\s+$/, '')

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onDraft(e.target.value)
  }

  /** Splice `insert` in at [start, end), returning the new draft and where the
   *  caret belongs afterward. */
  const spliceDraft = (insert: string, start: number, end: number): { next: string; caret: number } => {
    const next = draft.slice(0, start) + insert + draft.slice(end)
    return { next, caret: start + insert.length }
  }

  /** Land text in the draft, collapsing it to a placeholder first if it's long
   *  enough to be more noise than signal inline. Shared by the paste-intercept
   *  below and the explicit Paste button, so clicking the button behaves
   *  exactly like pasting into the textarea would. */
  const landPastedText = (text: string, start: number, end: number): void => {
    let insert = text
    if (shouldCollapsePaste(text)) {
      const label = pasteLabel(++pasteCounterRef.current, text)
      pastesRef.current.set(label, text)
      insert = label
    }
    const { next, caret } = spliceDraft(insert, start, end)
    onDraft(next)
    // The textarea re-renders with `next` before this runs, so the caret can
    // land correctly instead of jumping to wherever the browser's own paste
    // would have put it.
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret))
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = e.clipboardData.getData('text/plain')
    if (!text || !shouldCollapsePaste(text)) return // short paste — let the browser handle it normally
    e.preventDefault()
    const el = ref.current
    landPastedText(text, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length)
  }

  const onPasteButton = (): void => {
    const text = window.api.clipboardRead()
    if (!text) return
    const el = ref.current
    landPastedText(text, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length)
    el?.focus()
  }

  const send = (submit: boolean): void => {
    onSend(submit, expandPastes(body, pastesRef.current))
    pastesRef.current.clear()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // A placeholder reads and deletes as one unit — backspacing into the
    // middle of "[Pasted text #1 +40 lines]" one character at a time would be
    // exactly the noise the collapse exists to avoid.
    if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const el = e.currentTarget
      if (el.selectionStart === el.selectionEnd) {
        const pos = el.selectionStart
        for (const label of pastesRef.current.keys()) {
          if (pos >= label.length && draft.slice(pos - label.length, pos) === label) {
            e.preventDefault()
            const { next, caret } = spliceDraft('', pos - label.length, pos)
            onDraft(next)
            requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret))
            return
          }
        }
      }
    }
    // mod-Enter always sends and Alt+Enter always inserts without sending,
    // whatever sendMode is. Plain Enter is the setting: a newline by default (the
    // original behavior — nothing sends early), or the send key itself once the
    // newline has been traded for Shift+Enter (see ComposerSendMode).
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      send(true)
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      send(false)
    } else if (e.key === 'Enter' && sendMode === 'enter' && !e.shiftKey) {
      e.preventDefault()
      send(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Closed with a draft: a 28px strip, so text you can't see is never text you
  // forgot about. Closed with nothing drafted collapses to nothing — a
  // permanent strip would sit exactly where a full-height terminal puts its
  // prompt.
  const mode: Mode = open ? 'open' : draft ? 'strip' : 'empty'
  const [displayMode, setDisplayMode] = useState<Mode>(mode)
  const prevModeRef = useRef(mode)

  // Grow immediately (before paint) so the taller content is already in the DOM
  // for the box to expand around. Shrinks wait for onTransitionEnd below, so the
  // taller/older content stays visible — being clipped by overflow-hidden — for
  // the full slide instead of popping away the instant the target height drops.
  useLayoutEffect(() => {
    if (RANK[mode] > RANK[prevModeRef.current]) setDisplayMode(mode)
    prevModeRef.current = mode
  }, [mode])

  const onWrapTransitionEnd = (e: TransitionEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    setDisplayMode(mode)
  }

  const lines = draft.split('\n')

  return (
    <div
      onTransitionEnd={onWrapTransitionEnd}
      className={`w-full shrink-0 overflow-hidden bg-surface/95 backdrop-blur-sm transition-[max-height] duration-200 ease-out ${
        mode === 'open' ? 'max-h-[420px]' : mode === 'strip' ? 'max-h-7' : 'max-h-0'
      } ${displayMode === 'open' ? 'shadow-lg shadow-ink/60' : ''} ${
        displayMode !== 'empty' ? 'border-t border-line' : ''
      }`}
    >
      {displayMode === 'strip' && (
        <div className="flex h-7 items-center gap-2 px-3">
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
      )}

      {displayMode === 'open' && (
        <div className="flex flex-col">
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
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            rows={2}
            placeholder="Write as many lines as you like — nothing reaches the remote until you send."
            className="mx-3 mt-1.5 resize-none overflow-y-auto rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint/70 focus:border-accent/60"
          />

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-1.5">
            <span className="text-[11px] text-faint">quick:</span>
            {QUICK_COMMANDS.map((c) => (
              <button
                key={c.label}
                onClick={() => onSend(true, c.text)}
                title={c.title}
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-fg"
              >
                {c.label}
              </button>
            ))}
            {QUICK_KEYS.map((k) => (
              <button
                key={k.label}
                onClick={() => onSendKey(k.data)}
                title={k.title}
                className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:text-fg"
              >
                {k.label}
              </button>
            ))}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="text-[11px] text-faint">
              {sendMode === 'enter' ? (
                <>
                  <Key>Enter</Key> send · <Key>Shift+Enter</Key> newline ·{' '}
                </>
              ) : (
                <>
                  <Key>{SEND_ACCEL}</Key> send · <Key>Enter</Key> newline ·{' '}
                </>
              )}
              <Key>{INSERT_ACCEL}</Key> insert without sending · <Key>Esc</Key> close
            </span>
            <div className="flex-1" />
            <button
              onClick={onPasteButton}
              title="Paste from clipboard"
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-fg"
            >
              Paste
            </button>
            <button
              disabled={!body}
              onClick={() => send(false)}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-fg disabled:opacity-40 disabled:hover:text-muted"
            >
              Insert
            </button>
            <button
              disabled={!body}
              onClick={() => send(true)}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Send ▸
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return <span className="font-mono text-muted">{children}</span>
}
