// Shared xterm construction for the terminal view and tmux control-mode panes,
// so both render with identical options, theme, and addons.
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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
 * Create + open a terminal in `container` with the app's options/theme. WebGL is
 * attempted after open (falls back to canvas/DOM if unavailable). Pass
 * `{ fit: true }` to also attach a FitAddon (returned for the caller to drive).
 *
 * Search is loaded for every terminal rather than on demand: the addon indexes
 * nothing until asked, and a find bar that has to construct one first would miss
 * the buffer state at the moment the chord was pressed.
 */
export function createTerminal(
  settings: TerminalSettings,
  container: HTMLElement,
  opts?: { fit?: boolean }
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
  try {
    term.loadAddon(new WebglAddon())
  } catch {
    /* WebGL unavailable — falls back to canvas/DOM renderer */
  }
  return { term, fit, search }
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
