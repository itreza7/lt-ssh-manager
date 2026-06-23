// Shared xterm construction for the terminal view and tmux control-mode panes,
// so both render with identical options, theme, and addons.
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { resolveFontStack, type TerminalSettings } from './terminalSettings'

/** xterm cell line-height multiple; mirrored by the cell-metrics measurement. */
export const LINE_HEIGHT = 1.2

const THEME = {
  background: '#0c0f15',
  foreground: '#e8edf3',
  cursor: '#46d98a',
  cursorAccent: '#0c0f15',
  selectionBackground: 'rgba(124, 160, 214, 0.40)',
  selectionInactiveBackground: 'rgba(124, 160, 214, 0.22)',
  black: '#0b0e14',
  brightBlack: '#5a6473'
} as const

/**
 * Create + open a terminal in `container` with the app's options/theme. WebGL is
 * attempted after open (falls back to canvas/DOM if unavailable). Pass
 * `{ fit: true }` to also attach a FitAddon (returned for the caller to drive).
 */
export function createTerminal(
  settings: TerminalSettings,
  container: HTMLElement,
  opts?: { fit?: boolean }
): { term: XTerm; fit?: FitAddon } {
  const term = new XTerm({
    fontFamily: resolveFontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    lineHeight: LINE_HEIGHT,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    theme: { ...THEME }
  })
  let fit: FitAddon | undefined
  if (opts?.fit) {
    fit = new FitAddon()
    term.loadAddon(fit)
  }
  // Ctrl + left-click opens a URL in the OS browser (validated http/https in main).
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.ctrlKey && event.button === 0) window.api.openExternal(uri)
    })
  )
  term.open(container)
  try {
    term.loadAddon(new WebglAddon())
  } catch {
    /* WebGL unavailable — falls back to canvas/DOM renderer */
  }
  return { term, fit }
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
