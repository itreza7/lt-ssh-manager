// Shared clipboard wiring for xterm instances (terminals + tmux control panes).
// Copy-on-select, explicit copy/paste keys, right/middle-click paste, and an
// OSC 52 *write* handler so a mouse-drag selection inside a mouse-mode app
// (e.g. tmux with `set-clipboard on`) reaches the system clipboard.
import type { Terminal as XTerm } from '@xterm/xterm'
import { isMac } from './platform'

/**
 * Wire clipboard behavior onto a terminal + its container element. Returns a
 * disposer that removes the DOM listeners (xterm's own handlers are released
 * when the terminal is disposed).
 */
export function attachTerminalClipboard(term: XTerm, el: HTMLElement): () => void {
  const copySelection = (): void => {
    const sel = term.getSelection()
    if (sel) window.api.clipboardWrite(sel)
  }
  const paste = (): void => {
    const text = window.api.clipboardRead()
    if (text) term.paste(text) // bracketed-paste aware: multi-line stays inert
  }

  // Copy-on-select — selecting text (drag, or Shift+drag inside mouse-mode apps
  // like htop) copies it to the clipboard automatically.
  term.onSelectionChange(copySelection)

  // Honor OSC 52 clipboard *writes* so a mouse-drag selection inside a
  // mouse-mode app (notably tmux with `set-clipboard on`) lands on the system
  // clipboard. We handle writes only: a `?` read query is ignored so a remote
  // host can never exfiltrate the local clipboard. Payload `Pc;Pd` = selection
  // target(s) + base64 (UTF-8) data; decode the bytes, then write.
  term.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';')
    if (sep === -1) return false
    const payload = data.slice(sep + 1)
    if (payload === '' || payload === '?') return false // clear / read query — not honored
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      const text = new TextDecoder().decode(bytes)
      if (text) window.api.clipboardWrite(text)
    } catch {
      return false // malformed base64 — let xterm fall through
    }
    return true
  })

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const k = e.key.toLowerCase()
    // Explicit copy / paste. macOS uses ⌘C / ⌘V (safe in a terminal — Cmd never
    // reaches the PTY); elsewhere Ctrl+Shift+C / Ctrl+Shift+V, since bare Ctrl+C
    // is SIGINT.
    const copyChord = isMac ? e.metaKey && !e.shiftKey && k === 'c' : e.ctrlKey && e.shiftKey && k === 'c'
    const pasteChord = isMac ? e.metaKey && !e.shiftKey && k === 'v' : e.ctrlKey && e.shiftKey && k === 'v'
    if (copyChord) {
      copySelection()
      return false
    }
    if (pasteChord) {
      paste()
      return false
    }
    // Windows/Linux: Ctrl+C copies if text is selected, otherwise falls through
    // as SIGINT. On macOS ⌘C owns copy, so Ctrl+C is always left as SIGINT.
    if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c' && term.hasSelection()) {
      copySelection()
      term.clearSelection() // so the next Ctrl+C interrupts as usual
      return false
    }
    return true
  })

  // Right-click and middle-click paste (the selection is already auto-copied).
  // On macOS a Ctrl+left-click arrives here as a secondary click; that chord is
  // reserved for other gestures, so swallow it instead of pasting.
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    if (isMac && e.ctrlKey) return
    paste()
  }
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault()
      paste()
    }
  }
  el.addEventListener('contextmenu', onContextMenu)
  el.addEventListener('mousedown', onMouseDown)

  return () => {
    el.removeEventListener('contextmenu', onContextMenu)
    el.removeEventListener('mousedown', onMouseDown)
  }
}
