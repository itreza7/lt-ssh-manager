import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { SEARCH_ROOT_ATTR, type SearchFlags, type SearchResults } from '../lib/xtermSearch'

interface Props {
  /** Bumped on every *request* to find, so ⌘F re-focuses an already-open bar. */
  focusKey: number
  query: string
  onQuery: (v: string) => void
  flags: SearchFlags
  onFlags: (f: SearchFlags) => void
  /** Null until the first search has reported. */
  results: SearchResults | null
  /** Regex mode with a pattern that doesn't compile — say so, don't say "0". */
  badPattern: boolean
  /** The terminal is on the alternate screen, where there is no scrollback. */
  altScreen: boolean
  onFind: (dir: 'next' | 'prev') => void
  onClose: () => void
  /** Focus left the bar entirely (not for a click on one of its own buttons). */
  onBlur: () => void
}

/**
 * Find-in-terminal, overlaid on the top-right of a terminal.
 *
 * Like the prompt composer, this is an **overlay** rather than a sibling in the
 * pane's layout: a docked bar changes the terminal host's box, the ResizeObserver
 * turns that into a PTY resize, and under tmux that reflows the session for every
 * attached client. Top-right rather than the composer's bottom edge, so both can
 * be open at once and neither covers the other — and because the bottom rows are
 * where a terminal keeps the thing you are usually reading.
 */
export function TerminalFindBar({
  focusKey,
  query,
  onQuery,
  flags,
  onFlags,
  results,
  badPattern,
  altScreen,
  onFind,
  onClose,
  onBlur
}: Props) {
  const ref = useRef<HTMLInputElement>(null)

  // Focus and select on every request, not just on mount: pressing the chord
  // again with the bar already open should let you type a new query straight
  // over the old one, which is what every other find box does.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusKey])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onFind(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const status = !query ? null : badPattern ? (
    <span className="text-danger">bad pattern</span>
  ) : !results || results.count === 0 ? (
    <span className="text-amber">no matches</span>
  ) : (
    <span className="text-muted">
      {results.index > 0 && `${results.index}/`}
      {results.count}
      {results.capped && '+'}
    </span>
  )

  return (
    <div
      {...{ [SEARCH_ROOT_ATTR]: '' }}
      // Focus moving between this bar's own controls bubbles a blur too, so only
      // report the one that actually leaves — otherwise clicking `next` would
      // drop the active-match emphasis it is about to redraw.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlur()
      }}
      className="absolute right-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-col gap-1 rounded-lg border border-line bg-surface/95 px-2 py-1.5 shadow-lg shadow-ink/60 backdrop-blur-sm"
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="Find in terminal"
          className="w-48 min-w-0 rounded-md border border-line bg-ink/60 px-2 py-0.5 font-mono text-[12px] text-fg outline-none transition-colors placeholder:text-faint/70 focus:border-accent/60"
        />
        <span className="w-20 shrink-0 truncate text-right font-mono text-[11px]">{status}</span>

        <Toggle
          on={flags.caseSensitive}
          title="Match case"
          onClick={() => onFlags({ ...flags, caseSensitive: !flags.caseSensitive })}
        >
          Aa
        </Toggle>
        <Toggle
          on={flags.wholeWord}
          title="Whole word"
          onClick={() => onFlags({ ...flags, wholeWord: !flags.wholeWord })}
        >
          [ab]
        </Toggle>
        <Toggle
          on={flags.regex}
          title="Regular expression"
          onClick={() => onFlags({ ...flags, regex: !flags.regex })}
        >
          .*
        </Toggle>

        <Step title="Previous (⇧↩)" onClick={() => onFind('prev')}>
          ↑
        </Step>
        <Step title="Next (↩)" onClick={() => onFind('next')}>
          ↓
        </Step>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          title="Close (Esc)"
          className="shrink-0 px-1 text-faint transition-colors hover:text-fg"
        >
          ×
        </button>
      </div>

      {altScreen && (
        <p className="text-[11px] text-amber">
          Full-screen program — only the visible rows can be searched.
        </p>
      )}
    </div>
  )
}

/**
 * The buttons all cancel the mousedown so focus never leaves the input. That
 * keeps typing where the user left it, and it is also what makes "the find bar
 * has focus" a usable signal elsewhere — see searchOwnsFocus.
 */
function Toggle({
  on,
  title,
  onClick,
  children
}: {
  on: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        on
          ? 'border-accent/60 bg-accent-soft text-accent'
          : 'border-transparent text-faint hover:text-muted'
      }`}
    >
      {children}
    </button>
  )
}

function Step({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-ink/60 hover:text-fg"
    >
      {children}
    </button>
  )
}
