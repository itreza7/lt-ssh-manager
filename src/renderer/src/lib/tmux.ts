// Helpers for building tmux commands run inside a remote PTY.

/** Single-quote a string for safe interpolation into a POSIX shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Sanitize a session name into something tmux accepts. tmux rejects '.' and ':'
 * in session names; spaces are awkward, so collapse them to '-'. Falls back to
 * "main" when the result is empty.
 */
export function tmuxSessionName(raw: string): string {
  const cleaned = raw.trim().replace(/[.:]/g, '-').replace(/\s+/g, '-')
  return cleaned || 'main'
}

/**
 * Lines of scrollback tmux keeps per pane when mouse mode is enabled. tmux's
 * default is a stingy 2000; bumping it gives the wheel something to scroll back
 * through. Set globally *before* `new` so the first pane inherits it.
 */
export const TMUX_HISTORY_LIMIT = 50000

/**
 * Create-or-attach command for a named session.
 *
 * `new -A` attaches if the session already exists, else creates it — so it never
 * fails on a stale name the way `attach -t` does. `-D` (valid only with `-A`)
 * detaches any other clients so this window, not the smallest peer, drives the
 * pane size.
 *
 * With `mouse` on, prefix `set -g mouse on` + a larger `history-limit` so the
 * mouse wheel scrolls tmux's history (xterm's own scrollback can't, since tmux
 * lives in the alt-screen). `set-clipboard on` makes tmux's own copy-mode push
 * the selection to the outer terminal via OSC 52 — so a normal mouse drag copies
 * to the system clipboard (xterm honors the OSC 52, see TerminalView). The `\;`
 * are tmux command separators; the shell unescapes each to a literal `;` argument.
 */
export function tmuxAttachCommand(name: string, detachOthers = false, mouse = false): string {
  const attach = `new -A${detachOthers ? ' -D' : ''} -s ${shQuote(tmuxSessionName(name))}`
  const prefix = mouse
    ? `set -g mouse on \\; set -g history-limit ${TMUX_HISTORY_LIMIT} \\; set -g set-clipboard on \\; `
    : ''
  return `tmux ${prefix}${attach}`
}

/**
 * Create-or-attach command in tmux *control mode* (`tmux -CC`). tmux streams its
 * panes as a protocol instead of drawing a screen, so the app renders each pane
 * as its own terminal (native scrollback + copy, no mouse mode). No `set -g`
 * prefix is needed — scrollback is the host xterm's, not tmux's.
 */
export function tmuxControlCommand(name: string, detachOthers = false): string {
  return `tmux -CC new -A${detachOthers ? ' -D' : ''} -s ${shQuote(tmuxSessionName(name))}`
}
