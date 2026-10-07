// Shared xterm construction for the terminal view and tmux control-mode panes,
// so both render with identical options, theme, and addons.
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { resolveFontStack, type TerminalSettings } from './terminalSettings'
import { createSearch, type TerminalSearch } from './xtermSearch'
import { isMac } from './platform'

/** xterm cell line-height multiple; mirrored by the cell-metrics measurement.
 * 1.1 rather than 1.2 — closer to how a real terminal emulator (iTerm2, Terminal.app)
 * renders text, instead of the airier spacing a UI font expects. */
export const LINE_HEIGHT = 1.1

/** The terminal's own background — also used by the pane wrapper's padding so
 * the frame around xterm reads as one continuous surface, not a seam. */
export const TERMINAL_BG = '#0c0b0a'

const THEME = {
  background: TERMINAL_BG,
  foreground: '#cccac4',
  cursor: '#46d98a',
  cursorAccent: TERMINAL_BG,
  selectionBackground: 'rgba(154, 145, 125, 0.35)',
  selectionInactiveBackground: 'rgba(154, 145, 125, 0.18)',
  black: '#090908',
  brightBlack: '#6f6a5c'
} as const

/**
 * Create + open a terminal in `container` with the app's options/theme, on
 * xterm's DOM renderer (see enableRowBidi below for why not WebGL). Pass
 * `{ fit: true }` to also attach a FitAddon (returned for the caller to drive).
 *
 * Search is loaded for every terminal rather than on demand: the addon indexes
 * nothing until asked, and a find bar that has to construct one first would miss
 * the buffer state at the moment the chord was pressed.
 */
export function createTerminal(
  settings: TerminalSettings,
  container: HTMLElement,
  opts?: { fit?: boolean; onFontsReady?: () => void }
): { term: XTerm; fit?: FitAddon; search: TerminalSearch } {
  const term = new XTerm({
    fontFamily: resolveFontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    lineHeight: LINE_HEIGHT,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    // Let ⌥+drag force a local selection on macOS. Without this there is no way
    // to select text inside a mouse-mode app (tmux, htop, a TUI agent): xterm's
    // force-selection modifier is Shift everywhere *except* macOS, where it is
    // Alt gated behind this flag — and it defaults off, so the drag goes to the
    // remote app and no selection is ever made.
    macOptionClickForcesSelection: true,
    theme: { ...THEME }
  })
  let fit: FitAddon | undefined
  if (opts?.fit) {
    fit = new FitAddon()
    term.loadAddon(fit)
  }
  // Ctrl (or Cmd on macOS) + left-click opens a URL in the OS browser (validated
  // http/https in main). On macOS a Ctrl+click is also synthesized as a secondary
  // click; the clipboard handler swallows that so it doesn't paste as well.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      const modifier = event.ctrlKey || (isMac && event.metaKey)
      if (modifier && event.button === 0) window.api.openExternal(uri)
    })
  )
  const search = createSearch(term)
  term.open(container)
  enableRowBidi(term)
  // xterm measures its own character cell against whatever font is actually
  // available the moment term.open() runs, and only re-measures later if
  // fontFamily/fontSize change — never on its own once a pending web font
  // finishes loading. The app's bundled fonts (main.tsx) are imported as CSS
  // side effects with nobody awaiting them, so a cold launch that reconnects
  // several terminals at once routinely opens them before the font is ready,
  // silently measuring the fallback instead. That leaves xterm's rendered
  // pixel size out of sync with its logical grid for the rest of the
  // session — the wrong cell size never corrects itself — until something
  // reassigns fontFamily and forces a real remeasure. Reassigning to the
  // (unchanged) real value is a no-op change-detection-wise, so bounce
  // through a throwaway value first to guarantee the final assignment is
  // seen as a change. A bare fit() only fixes the local grid — a caller
  // driving a live PTY (a plain session, not a tmux control-mode pane)
  // already told the remote the pre-remeasure cols/rows at connect time, so
  // it needs onFontsReady to redo whatever step also notifies the remote.
  const family = term.options.fontFamily
  void document.fonts.ready.then(() => {
    term.options.fontFamily = `${family}, monospace`
    term.options.fontFamily = family
    opts?.onFontsReady?.()
  })
  return { term, fit, search }
}

const RTL_LETTER = /[\u05d0-\u05ea\u0620-\u064a\u066e-\u06d3\u06fa-\u06ff\ufb1d-\ufdff\ufe70-\ufefc]/
const FIRST_LETTER = /[\u05d0-\u05ea\u0620-\u064a\u066e-\u06d3\u06fa-\u06ff\ufb1d-\ufdff\ufe70-\ufefcA-Za-z\u00c0-\u024f]/

/**
 * Right-to-left text (Persian, Arabic, Hebrew). xterm has no BiDi support, so it
 * lays every row out left to right. On the DOM renderer the browser already
 * shapes the letters, so what's missing is the row's direction: a Persian row
 * is laid out as one right-to-left paragraph (ordered by the Unicode BiDi
 * algorithm, right-aligned), and an English row with some RTL in it is still
 * ordered as one paragraph, left to right. Two things xterm does have to
 * be undone on those rows:
 * - every span is `inline-block`, an atomic box the BiDi algorithm can't see
 *   into — so the row was ordered box by box, left to right, and only the text
 *   inside each box was reversed. Inline spans make the row one paragraph.
 * - the per-span letter-spacing that pins glyphs to cells pulls joined Persian
 *   letters apart.
 *
 * A row's direction is its first strong letter's — the Unicode BiDi rule
 * (P2/P3), as VTE and the Reader panel's `dir="auto"` apply it; leading `●`,
 * `-`, emoji and digits are neutral and skipped. A Persian sentence that opens
 * with an English word therefore stays left to right here; the Reader panel,
 * which sees whole paragraphs, is the place to read those.
 *
 * Render-only: the buffer stays logical, so copy, search and what is sent to
 * the remote are untouched. The selection highlight is still drawn by cell, so
 * on an RTL row it no longer lines up with the text. This is also why the app
 * runs the DOM renderer rather than WebGL, whose glyph atlas can't shape text.
 *
 * Hooks xterm's private row factory (xterm 5.5); if that ever moves, rows just
 * render as before.
 */
function enableRowBidi(term: XTerm): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = (term as any)._core?._renderService?._renderer?.value?._rowFactory
  const proto = factory && Object.getPrototypeOf(factory)
  if (!proto || typeof proto.createRow !== 'function' || proto.__rowBidi) return
  proto.__rowBidi = true
  const createRow = proto.createRow
  proto.createRow = function (
    this: unknown,
    lineData: { translateToString(trimRight?: boolean): string },
    ...rest: unknown[]
  ): HTMLElement[] {
    const spans: HTMLElement[] = createRow.call(this, lineData, ...rest)
    const text = lineData.translateToString(true)
    if (!RTL_LETTER.test(text)) return spans
    const row = document.createElement('span')
    row.dir = RTL_LETTER.test(text.match(FIRST_LETTER)?.[0] ?? '') ? 'rtl' : 'ltr'
    row.style.cssText = 'display:block;letter-spacing:0'
    for (const span of spans) {
      span.style.letterSpacing = ''
      span.style.display = 'inline'
      row.appendChild(span)
    }
    return [row]
  }
}

/** Apply live setting changes (font, cursor, scrollback) to an existing terminal. */
export function applyTerminalSettings(term: XTerm, settings: TerminalSettings): void {
  term.options.fontFamily = resolveFontStack(settings.fontFamily)
  term.options.fontSize = settings.fontSize
  term.options.cursorStyle = settings.cursorStyle
  term.options.cursorBlink = settings.cursorBlink
  term.options.scrollback = settings.scrollback
}

/**
 * Measure one monospace cell (in CSS px) for the given font, matching how xterm
 * rounds. Used by control mode to convert a pixel area into a tmux cell grid.
 */
export function measureCell(settings: TerminalSettings): { cw: number; ch: number } {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return { cw: Math.ceil(settings.fontSize * 0.6), ch: Math.ceil(settings.fontSize * LINE_HEIGHT) }
  ctx.font = `${settings.fontSize}px ${resolveFontStack(settings.fontFamily)}`
  const w = ctx.measureText('W').width
  return {
    cw: Math.max(1, Math.ceil(w)),
    ch: Math.max(1, Math.ceil(settings.fontSize * LINE_HEIGHT))
  }
}
