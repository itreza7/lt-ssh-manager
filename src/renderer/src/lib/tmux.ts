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
 * Create-or-attach command for a named session.
 *
 * `new -A` attaches if the session already exists, else creates it — so it never
 * fails on a stale name the way `attach -t` does. `-D` (valid only with `-A`)
 * detaches any other clients so this window, not the smallest peer, drives the
 * pane size.
 */
export function tmuxAttachCommand(name: string, detachOthers = false): string {
  return `tmux new -A${detachOthers ? ' -D' : ''} -s ${shQuote(tmuxSessionName(name))}`
}
