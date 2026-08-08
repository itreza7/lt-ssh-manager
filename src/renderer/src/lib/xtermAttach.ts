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
import { fmtAccel, isMac } from './platform'

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
  /**
   * The user asked for the prompt composer (see COMPOSE_ACCEL). Only the chord
   * is owned here; the caller owns the drafting UI and what it sends.
   */
  onCompose?: () => void
  /**
   * OS files are hovering over this terminal (`true`), or have left it / been
   * dropped (`false`). Only the hover state is reported — the caller draws
   * whatever affordance it likes. The app's own drags (tabs, which carry
   * `text/plain`) never trigger this.
   */
  onDragFiles?: (over: boolean) => void
  /** OS files were dropped on this terminal, as absolute local paths. */
  onDropFiles?: (paths: string[]) => void
  /** The image-paste chord was pressed (see IMAGE_PASTE_ACCEL). */
  onPasteImage?: () => void
}

/** Longest remote-set title we'll surface — a tab is not a billboard. */
const TITLE_MAX = 80

/**
 * The chord that opens the prompt composer.
 *
 * ⌘↩ on macOS: nothing in a terminal claims it, and ⌘ chords never reach the
 * remote anyway. Elsewhere it has to be Ctrl+Shift+↩ — plain Ctrl+key belongs to
 * readline, and Ctrl+Shift is already this app's namespace for its own keys
 * (copy and paste live there).
 */
export const COMPOSE_ACCEL = isMac ? fmtAccel('Cmd+Enter') : 'Ctrl+Shift+Enter'

/**
 * The chord that uploads the clipboard's image and puts its remote path on the
 * line — screenshot to a terminal agent in one gesture.
 *
 * ⌘⇧V on macOS, where ⌘V is the OS text paste and xterm already owns it. On
 * Windows/Linux Ctrl+Shift+V is *this app's* text paste, so the image chord
 * moves one key over rather than breaking paste for anyone who happens to have
 * an image on the clipboard.
 */
export const IMAGE_PASTE_ACCEL = isMac ? fmtAccel('Cmd+Shift+V') : 'Ctrl+Shift+U'

const isComposeChord = (e: KeyboardEvent): boolean =>
  isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey

/**
 * Put a composed body on the remote's input as one unit, then submit it.
 *
 * `term.paste()` is what wraps the body in the bracketed-paste markers when the
 * remote has that mode on, and those markers are the whole trick: inside them
 * the embedded newlines arrive as line breaks in the program's prompt rather
 * than as N separate commands. The submitting CR goes through `term.input()`
 * *afterwards*, never inside the paste — bracketed, it would be literal text and
 * nothing would be submitted at all.
 *
 * With bracketed paste off — a plain shell sitting at its prompt — this does
 * exactly what pasting the same text by hand does: every line runs. That's the
 * honest outcome rather than something to paper over, and the composer says so
 * before you send.
 */
export function sendComposed(term: XTerm, body: string, submit = true): void {
  term.paste(body)
  if (submit) term.input('\r')
}

/**
 * Put a remote path on the terminal's input line, with one trailing space and
 * never a carriage return.
 *
 * The no-CR rule is the contract, not a detail. This is called by a *drop*, and
 * dropping a file is not a decision to run anything — the path lands where the
 * cursor is and the user decides what to do with it. xterm's paste path rewrites
 * `\n` to `\r` before the bytes reach the wire, so a single newline anywhere in
 * the string would submit whatever is on the line; control characters are
 * therefore stripped here rather than trusted from the caller, because the
 * guarantee belongs next to the thing that would break it.
 *
 * The trailing space is what makes several dropped files read as several
 * arguments, and it's safe under both bracketed-paste states: a lone space is
 * inert text either way.
 */
export function injectPath(term: XTerm, path: string): void {
  // eslint-disable-next-line no-control-regex
  const clean = path.replace(/[\u0000-\u001f\u007f]/g, '')
  if (clean) term.paste(`${clean} `)
}

/** The bits of xterm's private selection service this module has to reach. */
interface SelectionServiceInternals {
  _enabled: boolean
  disable: () => void
}

/**
 * Stop xterm from destroying the selection every time the remote asserts mouse
 * tracking.
 *
 * xterm disables its selection service whenever the mouse protocol changes, and
 * `disable()` clears the current selection on its way out. That is harmless for a
 * one-off `tmux attach`, but a TUI agent re-emits its mouse-mode enable on
 * essentially every repaint — so while Claude Code is working the highlight is
 * wiped over and over, including mid-drag, where the clear also tears down the
 * drag listeners. The selection can then never be completed and there is nothing
 * left for copy-on-select or ⌘C to pick up.
 *
 * Measured against the pinned xterm 5.5: re-emitting an already-active
 * `CSI ? 1000 h` clears the selection, and with the clear removed it survives
 * both a re-emit and a protocol switch. `_enabled` still goes false, so xterm's
 * own mouse handling is untouched — including the ⌥ force-selection path, which
 * is explicitly written to run while the service is disabled.
 *
 * This reaches past the public API, so it is written to be inert if the internals
 * ever move: no service of the expected shape, no patch, and the terminal behaves
 * exactly as it does today.
 */
function keepSelectionAcrossMouseModes(term: XTerm): void {
  const svc = (term as unknown as { _core?: { _selectionService?: SelectionServiceInternals } })._core
    ?._selectionService
  if (!svc || typeof svc.disable !== 'function' || typeof svc._enabled !== 'boolean') return
  svc.disable = function (this: SelectionServiceInternals): void {
    this._enabled = false
  }
}

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
  keepSelectionAcrossMouseModes(term)

  /**
   * The most recent non-empty selection, as it read at the moment it was made.
   *
   * `term.getSelection()` is not stable over time: it re-reads the buffer at the
   * selection's coordinates, and in the alternate buffer — tmux, or any
   * full-screen TUI — rows scroll *under* a selection that stays where it is. A
   * second after highlighting a line, those same coordinates hold something else,
   * so a later read returns text the user never selected.
   */
  let lastSelection = ''

  const copySelection = (): void => {
    const sel = term.getSelection()
    if (sel) {
      lastSelection = sel
      window.api.clipboardWrite(sel)
    }
  }
  /**
   * What an explicit copy chord copies: what was selected, not what has since
   * scrolled into its place (see lastSelection). Copy-on-select has normally put
   * the same text on the clipboard already, which is also why the fallback to a
   * stale value is safe — pressing copy after a selection is gone re-writes the
   * text that is on the clipboard anyway.
   */
  const copyExplicit = (): void => {
    const text = lastSelection || term.getSelection()
    if (text) window.api.clipboardWrite(text)
  }
  const paste = (): void => {
    const text = window.api.clipboardRead()
    if (text) term.paste(text) // bracketed-paste aware: multi-line stays inert
  }

  // Copy-on-select — selecting text copies it to the clipboard automatically.
  // Inside a mouse-mode app (tmux, htop) the drag belongs to the remote, so hold
  // the force-selection modifier to keep it local: ⌥ on macOS, Shift elsewhere.
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
    // The prompt composer, claimed ahead of the Shift+Enter branch so the
    // non-mac chord can't be mistaken for a bare Shift+Enter.
    if (k === 'enter' && opts.onCompose && isComposeChord(e)) {
      e.preventDefault()
      opts.onCompose()
      return false
    }
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
    // Image paste — see IMAGE_PASTE_ACCEL. Claimed ahead of the copy/paste
    // branches below, which share its modifier prefix on both platforms.
    // preventDefault matters on macOS: ⌘⇧V is Chromium's paste-as-plain-text, so
    // without it the clipboard's *text* would also land on the line.
    if (
      opts.onPasteImage &&
      (isMac
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && k === 'v'
        : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && k === 'u')
    ) {
      e.preventDefault()
      opts.onPasteImage()
      return false
    }
    // Explicit copy: ⌘C on macOS, Ctrl+Shift+C elsewhere (bare Ctrl+C is SIGINT).
    // preventDefault for the same reason as paste below: the browser's own Copy
    // would otherwise still run against xterm's helper textarea and overwrite the
    // clipboard we just wrote with whatever (usually nothing) it holds.
    const copyChord = isMac ? e.metaKey && !e.shiftKey && k === 'c' : e.ctrlKey && e.shiftKey && k === 'c'
    if (copyChord) {
      e.preventDefault()
      copyExplicit()
      return false
    }
    // Paste. 0.2.5 dropped the macOS ⌘V branch because it pasted twice, but the
    // double came from calling paste() *without* preventDefault — the same trap
    // the Shift+Enter comment above describes — and the app runs with no
    // application menu (Menu.setApplicationMenu(null) in main), so nothing else
    // reliably owns ⌘V. Claim it and cancel the native path: exactly one paste.
    if (
      isMac
        ? e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && k === 'v'
        : e.ctrlKey && e.shiftKey && k === 'v'
    ) {
      e.preventDefault()
      paste()
      return false
    }
    // Windows/Linux: Ctrl+C copies if text is selected, otherwise falls through
    // as SIGINT. On macOS ⌘C owns copy, so Ctrl+C is always left as SIGINT.
    if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c' && term.hasSelection()) {
      copyExplicit()
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
  // OS file drops. Both handlers below run whether or not the caller wants the
  // files, and that is the point: Chromium's default action for an unhandled
  // file drop is to *navigate* the window to `file:///…`, which unmounts the
  // React tree and kills every live session in the app. Swallowing it here is
  // the near end of the same rule the main process enforces on `will-navigate`.
  //
  // `dataTransfer.files` is empty during a drag — only `types` is readable —
  // which is also what keeps the app's own tab drags (they carry `text/plain`)
  // from lighting up a drop affordance.
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
  // dragenter/dragleave fire again for every child element the pointer crosses,
  // and xterm's host is several nested layers, so count them instead of toggling
  // — otherwise the affordance strobes as the pointer moves across the pane.
  let depth = 0
  const setOver = (v: boolean): void => {
    depth = v ? depth : 0
    opts.onDragFiles?.(v)
  }
  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault()
    if (!hasFiles(e)) return
    if (++depth === 1) opts.onDragFiles?.(true)
  }
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault()
    if (e.dataTransfer && hasFiles(e)) e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    if (--depth <= 0) setOver(false)
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    if (!opts.onDropFiles) return
    // Electron 33 removed File.path; the preload resolves it via webUtils.
    const paths = Array.from(e.dataTransfer?.files ?? [])
      .map((f) => window.api.pathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length) opts.onDropFiles(paths)
  }

  el.addEventListener('contextmenu', onContextMenu)
  el.addEventListener('mousedown', onMouseDown)
  el.addEventListener('dragenter', onDragEnter)
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('dragleave', onDragLeave)
  el.addEventListener('drop', onDrop)

  return () => {
    el.removeEventListener('contextmenu', onContextMenu)
    el.removeEventListener('mousedown', onMouseDown)
    el.removeEventListener('dragenter', onDragEnter)
    el.removeEventListener('dragover', onDragOver)
    el.removeEventListener('dragleave', onDragLeave)
    el.removeEventListener('drop', onDrop)
    offSelection.dispose()
    offTitle?.dispose()
    offOsc52.dispose()
  }
}
