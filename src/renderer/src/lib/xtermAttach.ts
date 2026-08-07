// Everything that sits between an xterm instance and the app, for both plain
// terminals and tmux control-mode panes: clipboard (copy-on-select, copy/paste
// keys, right/middle-click paste, OSC 52 writes), the Shift+Enter encoding, and
// the remote-set window title.
//
// The two byte directions both cross here, which is why it's one function:
// inbound goes through `term.parser` / xterm's event emitters, outbound through
// the caller's `sendData`. A feature that needs either only has to be wired in
// once to reach every terminal in the app.
import type { Terminal as XTerm } from '@xterm/xterm'
import type { TerminalSettings } from './terminalSettings'
import { isMac } from './platform'

export interface TerminalAttachOptions {
  /**
   * Send bytes to the remote end. Everything this module synthesizes goes
   * through here; the caller owns the transport (an SSH PTY via `sendInput`, or
   * a tmux pane via `tmuxSendKeys`), so both look the same from in here.
   */
  sendData: (data: string) => void
  /** Read the *current* settings — a getter, so a live change is picked up. */
  settings: () => TerminalSettings
  /**
   * The remote set the window title (OSC 0/2), sanitized and length-capped.
   * Empty string means it was cleared. Not wired for control-mode panes: there
   * are many panes per tab and tmux already reports window names itself.
   */
  onTitle?: (title: string) => void
}

/** Longest remote-set title we'll surface — a tab is not a billboard. */
const TITLE_MAX = 80

/**
 * A title is a remote-controlled string that lands in our chrome. React escapes
 * it, so this is about legibility rather than injection: drop control characters
 * (which would smuggle in line breaks) and cap the length.
 */
function sanitizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TITLE_MAX)
}

/**
 * Wire app behavior onto a terminal + its container element. Returns a disposer
 * that removes the DOM listeners and every xterm subscription taken here (the
 * terminal's own dispose() would also release them, but a caller that reuses a
 * terminal shouldn't have to know that).
 */
export function attachTerminal(term: XTerm, el: HTMLElement, opts: TerminalAttachOptions): () => void {
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
  const offSelection = term.onSelectionChange(copySelection)

  // Surface the remote's window title. Programs set it to the running command or
  // the working directory, which is exactly what a tab label wants to say.
  const offTitle = opts.onTitle
    ? term.onTitleChange((t) => opts.onTitle!(sanitizeTitle(t)))
    : undefined

  // Honor OSC 52 clipboard *writes* so a mouse-drag selection inside a
  // mouse-mode app (notably tmux with `set-clipboard on`) lands on the system
  // clipboard. We handle writes only: a `?` read query is ignored so a remote
  // host can never exfiltrate the local clipboard. Payload `Pc;Pd` = selection
  // target(s) + base64 (UTF-8) data; decode the bytes, then write.
  const offOsc52 = term.parser.registerOscHandler(52, (data) => {
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
    // Shift+Enter. xterm gives it the same CR as Enter, so a terminal agent that
    // wants a newline inside its prompt can't distinguish them and submits early.
    // Encode it explicitly instead — see ShiftEnterMode for the choices.
    //
    // preventDefault() *and* returning false are both required. Returning false
    // alone stops xterm's keydown path but still lets the browser fire keypress,
    // which xterm handles separately and would write the CR anyway — the same
    // double-input shape as the macOS paste bug fixed in 0.2.5.
    if (k === 'enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const mode = opts.settings().shiftEnter
      if (mode === 'submit') return true
      e.preventDefault()
      opts.sendData(mode === 'escape-cr' ? '\x1b\r' : '\n')
      return false
    }
    // Explicit copy: ⌘C on macOS, Ctrl+Shift+C elsewhere (bare Ctrl+C is SIGINT).
    const copyChord = isMac ? e.metaKey && !e.shiftKey && k === 'c' : e.ctrlKey && e.shiftKey && k === 'c'
    if (copyChord) {
      copySelection()
      return false
    }
    // Paste. On macOS ⌘V is the OS paste shortcut and xterm already handles it
    // natively — intercepting it here too would paste twice — so we only wire the
    // Ctrl+Shift+V convenience chord on Windows/Linux, where nothing else pastes.
    if (!isMac && e.ctrlKey && e.shiftKey && k === 'v') {
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
    offSelection.dispose()
    offTitle?.dispose()
    offOsc52.dispose()
  }
}
