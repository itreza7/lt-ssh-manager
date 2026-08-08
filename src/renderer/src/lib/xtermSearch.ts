// Find-in-terminal, shared by the plain terminal and the tmux control-mode
// panes: the search addon's lifecycle, the app's match colors, and the one rule
// the rest of the app has to know about an in-progress search (searchOwnsFocus).
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { Terminal as XTerm } from '@xterm/xterm'

/**
 * How many matches carry a highlight at once — the addon's own default, kept.
 *
 * It is a ceiling on decorations, and the reported result *count* is the length
 * of that same list, so a search that reaches it reports the ceiling rather than
 * the total. The bar says so with a `+` rather than quietly rounding down: one
 * letter against a screenful of JSON is exactly the search that gets there.
 */
const HIGHLIGHT_LIMIT = 1000

/**
 * Match colors, from the app's palette.
 *
 * Only the two overview-ruler fields are required by the type. A background is
 * safe on ordinary matches — they decorate *behind* the glyphs — but the active
 * match is registered by the addon with `layer: 'top'`, so a background there
 * would paint over the very text it just found. It gets a border and the
 * terminal's own selection instead, which also keeps it legible on a line where
 * every other match is already highlighted.
 */
const DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#21392c', // --color-signal-soft
  matchOverviewRuler: '#46d98a', // --color-signal
  activeMatchBorder: '#f3b75a', // --color-amber
  activeMatchColorOverviewRuler: '#f3b75a'
}

export interface SearchFlags {
  caseSensitive: boolean
  /**
   * Known gap, upstream and not worth vendoring the addon over: its `_findInLine`
   * abandons a line as soon as one candidate fails the word-boundary test instead
   * of resuming after it, so on `errors are not error here` the standalone
   * `error` is never reached. Whole-word counts are a floor on lines that hold
   * both a partial and a whole occurrence of the same term.
   */
  wholeWord: boolean
  regex: boolean
}

export const NO_FLAGS: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false }

export interface SearchResults {
  /** 1-based position of the active match; 0 when there isn't one. */
  index: number
  /** Matches highlighted. A floor, not a total, when `capped`. */
  count: number
  capped: boolean
}

export interface TerminalSearch {
  /**
   * Move to a match and highlight the rest. `incremental` grows the current
   * match while the query is still being typed instead of jumping ahead; the
   * addon only honors it going forwards.
   */
  find(query: string, dir: 'next' | 'prev', flags: SearchFlags, incremental?: boolean): boolean
  /** Drop the highlights and the match selection. */
  clear(): void
  /** Focus left the find bar — drop the active-match emphasis, keep the rest. */
  blur(): void
  onResults(cb: (r: SearchResults) => void): () => void
  dispose(): void
}

/**
 * The attribute marking the find bar's root element.
 *
 * The find bar is a normal part of the React tree, but "is the user searching
 * right now?" has to be answerable from plain DOM by code that is nowhere near
 * it — see searchOwnsFocus.
 */
export const SEARCH_ROOT_ATTR = 'data-terminal-search'

/**
 * True while the keyboard is inside a find bar.
 *
 * This exists for copy-on-select. A match is a selection the *app* made, and
 * xterm reports it through the same event as a mouse drag, so without this
 * every keystroke typed into the find box would overwrite the system clipboard
 * — including, at the worst possible moment, the thing the user copied in order
 * to paste into that terminal.
 */
export function searchOwnsFocus(): boolean {
  const el = document.activeElement
  return el instanceof Element && !!el.closest(`[${SEARCH_ROOT_ATTR}]`)
}

/**
 * Whether the terminal is on the alternate screen — a full-screen TUI, or a
 * `tmux attach` in a plain tab.
 *
 * Worth surfacing, because the alternate screen has no scrollback at all: a
 * search there covers the visible rows and nothing else, and finding two matches
 * in a session with a thousand lines of history is a result the user would
 * otherwise read as the truth.
 */
export function isAltScreen(term: XTerm): boolean {
  return term.buffer.active.type === 'alternate'
}

/** Load the search addon onto a terminal. Disposed with the terminal. */
export function createSearch(term: XTerm): TerminalSearch {
  const addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT })
  term.loadAddon(addon)

  const listeners = new Set<(r: SearchResults) => void>()
  const offResults = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
    // resultIndex is -1 when the active match fell outside the highlighted set,
    // which +1 turns into the same 0 that "nothing matched" produces. Both mean
    // "no position to show", and the bar renders them the same way.
    const r: SearchResults = {
      index: resultIndex + 1,
      count: resultCount,
      capped: resultCount >= HIGHLIGHT_LIMIT
    }
    for (const cb of listeners) cb(r)
  })

  return {
    find(query, dir, flags, incremental = false) {
      if (!query) {
        addon.clearDecorations()
        return true
      }
      const opts: ISearchOptions = {
        caseSensitive: flags.caseSensitive,
        wholeWord: flags.wholeWord,
        regex: flags.regex,
        decorations: DECORATIONS,
        incremental: dir === 'next' && incremental
      }
      try {
        return dir === 'next' ? addon.findNext(query, opts) : addon.findPrevious(query, opts)
      } catch {
        // A half-typed pattern reaches `new RegExp` inside the addon and throws.
        // The bar checks the pattern itself so it can say *why*; this is the
        // backstop that keeps the throw out of a React event handler.
        return false
      }
    },
    clear() {
      addon.clearDecorations()
      // Decorations and the selection are separate: clearing only the first
      // leaves a highlight sitting on the grid after the bar is gone, and on the
      // alternate screen it stays at those coordinates while the rows beneath it
      // scroll — the same trap the copy path documents.
      term.clearSelection()
    },
    blur() {
      addon.clearActiveDecoration()
    },
    onResults(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose() {
      listeners.clear()
      offResults.dispose()
      addon.dispose()
    }
  }
}
