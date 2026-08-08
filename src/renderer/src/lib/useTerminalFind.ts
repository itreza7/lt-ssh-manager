// The find bar's state machine, shared by the plain terminal and each tmux
// control-mode pane. The surfaces differ in where the bar is drawn and which
// terminal it points at; everything below that is identical, and a search that
// behaved differently between the two would be a bug either way.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import {
  isAltScreen,
  NO_FLAGS,
  type SearchFlags,
  type SearchResults,
  type TerminalSearch
} from './xtermSearch'

/** What the bar acts on. Resolved lazily — a tmux pane's terminal outlives it. */
export interface FindTarget {
  term: XTerm
  search: TerminalSearch
}

/**
 * Longest selection that seeds the query. A find box is for a phrase, and a
 * paragraph pasted into one is never what was meant.
 */
const SEED_MAX = 120

export interface TerminalFind {
  open: boolean
  focusKey: number
  query: string
  setQuery: (v: string) => void
  flags: SearchFlags
  setFlags: (f: SearchFlags) => void
  results: SearchResults | null
  badPattern: boolean
  altScreen: boolean
  /** Open the bar, or re-focus it if it is already open. Stable identity. */
  start: () => void
  find: (dir: 'next' | 'prev') => void
  close: () => void
  /** Focus left the bar — drop the active-match emphasis. */
  blur: () => void
}

/**
 * @param resolve which terminal the bar is searching, read at call time
 * @param onFound ran after a search that landed on a match — the overscroll
 *   host uses it to bring the match into its own scroll, since xterm can only
 *   scroll its own viewport and in that mode the viewport isn't what scrolls.
 */
export function useTerminalFind(resolve: () => FindTarget | null, onFound?: () => void): TerminalFind {
  const [open, setOpen] = useState(false)
  // Bumped on every *request* to find, so pressing the chord with the bar
  // already open re-focuses and re-selects it. See PromptComposer's focusKey.
  const [focusKey, bumpFocus] = useReducer((n: number) => n + 1, 0)
  const [query, setQuery] = useState('')
  const [flags, setFlags] = useState<SearchFlags>(NO_FLAGS)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [altScreen, setAltScreen] = useState(false)

  // `start` is handed to attachTerminal by a mount-once effect, so it has to
  // keep one identity for the life of the terminal; everything it reads is
  // therefore behind a ref.
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const foundRef = useRef(onFound)
  foundRef.current = onFound
  const openRef = useRef(open)
  openRef.current = open

  // In regex mode a query is a pattern under construction: `(fo` is not a search
  // that found nothing, it's a search that couldn't run. Told apart here so the
  // bar can say which, instead of reporting a confident zero.
  const badPattern = useMemo(() => {
    if (!flags.regex || !query) return false
    try {
      new RegExp(query)
      return false
    } catch {
      return true
    }
  }, [flags.regex, query])

  useEffect(() => {
    if (!open) return
    const t = resolveRef.current()
    return t?.search.onResults(setResults)
  }, [open])

  // Re-search as the query or the flags change. Incremental, so typing grows the
  // current match instead of walking forward one match per keystroke.
  useEffect(() => {
    if (!open) return
    const t = resolveRef.current()
    if (!t) return
    setAltScreen(isAltScreen(t.term))
    if (!query || badPattern) {
      t.search.clear()
      setResults(null)
      return
    }
    if (t.search.find(query, 'next', flags, true)) foundRef.current?.()
  }, [open, query, flags, badPattern])

  const start = useCallback(() => {
    const t = resolveRef.current()
    // Seed from the selection, but only when opening: with the bar already up
    // the selection *is* the active match, and in regex mode copying it back
    // over the box would replace the pattern with one of its own results.
    if (t && !openRef.current) {
      const sel = t.term.getSelection().trim()
      if (sel && !sel.includes('\n') && sel.length <= SEED_MAX) setQuery(sel)
    }
    if (t) setAltScreen(isAltScreen(t.term))
    setOpen(true)
    bumpFocus()
  }, [])

  const find = (dir: 'next' | 'prev'): void => {
    const t = resolveRef.current()
    if (!t || !query || badPattern) return
    setAltScreen(isAltScreen(t.term))
    if (t.search.find(query, dir, flags, false)) foundRef.current?.()
  }

  const close = useCallback(() => {
    const t = resolveRef.current()
    t?.search.clear()
    setOpen(false)
    setResults(null)
    t?.term.focus()
  }, [])

  const blur = useCallback(() => {
    resolveRef.current()?.search.blur()
  }, [])

  return {
    open,
    focusKey,
    query,
    setQuery,
    flags,
    setFlags,
    results,
    badPattern,
    altScreen,
    start,
    find,
    close,
    blur
  }
}
