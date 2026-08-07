// Builders for the tmux commands run inside a remote PTY.
//
// Shared, not renderer-only: the renderer builds the create-or-attach command a
// tab opens with, and the main process builds the *attach-only* command used when
// a dropped session is reattached automatically. Both must agree on the session
// name, so the name travels as a TmuxIntent and neither side re-parses the other's
// command string.
import type { TmuxIntent } from './types'

/** Single-quote a string for safe interpolation into a POSIX shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Sanitize a user-supplied session name into one tmux can still address later.
 *
 * Modern tmux accepts almost any name (cmd-new-session.c only checks for valid
 * UTF-8), but `.` and `:` are separators in tmux's own target syntax
 * (`session:window.pane`), so a session containing them can never be targeted
 * again — including by the reattach command. Spaces are legal but awkward inside
 * a shell command, so collapse them. Falls back to "main" when nothing is left.
 */
export function tmuxSessionName(raw: string): string {
  const cleaned = raw.trim().replace(/[.:]/g, '-').replace(/\s+/g, '-')
  return cleaned || 'main'
}

/**
 * Create-or-attach — what a tab runs when the user opens it.
 *
 * `new -A` attaches if the session already exists and creates it otherwise, so it
 * never fails on a stale name the way `attach -t` does. `-D` (valid only with
 * `-A`) detaches any other clients so this window, not the smallest peer, drives
 * the pane size.
 *
 * The exact byte form is load-bearing: it is persisted in workspace.json and read
 * back by parseTmuxIntent() when a tab is restored. Change it and add a case there.
 *
 * `run` is the shell-command tmux should start the session's first pane with —
 * what an agent tab uses instead of a login shell. Two things about it:
 *
 *  - tmux runs it as `default-shell -c`, i.e. non-login and possibly fish or csh,
 *    which is why the only caller passes a `/bin/sh -c …` wrapper rather than a
 *    bare script (see shared/claude.ts).
 *  - **`new -A` discards it when the session already exists.** That is the point,
 *    not a caveat: relaunching an agent on a directory attaches to the one
 *    already running there instead of starting a second in the same pane.
 *
 * CREATE_RE below is anchored at `$` and so does not parse the `run` form. Left
 * that way on purpose — parseTmuxIntent is the pre-0.2.4 legacy path, tabs saved
 * since carry their intent directly, and teaching it to accept a trailing command
 * would make a restored tab re-run that command.
 */
export function tmuxCreateCommand(i: TmuxIntent, run?: string): string {
  const base = `tmux${i.control ? ' -CC' : ''} new -A${i.detachOthers ? ' -D' : ''} -s ${shQuote(i.session)}`
  return run ? `${base} ${shQuote(run)}` : base
}

/**
 * Attach-only reattach for a session that must already exist. Returns null when
 * the name cannot be targeted safely, which disables automatic reattach for that
 * session rather than guessing.
 *
 * This command runs unattended, so two properties are load-bearing (both checked
 * against tmux master):
 *
 *  - **It can never create a session.** `has-session` carries no CMD_STARTSERVER
 *    and its exec body returns immediately without touching any session
 *    (cmd-new-session.c: `cmd_has_session_entry`), so it can only report; a
 *    missing session or dead server makes it exit non-zero and the `&&`
 *    short-circuits. `attach` requires an existing session. `new -A` — what the
 *    tab originally ran — is deliberately *not* reused: retrying it would
 *    silently resurrect a killed session as an empty one.
 *  - **`=NAME` forces an exact match** (cmd-find.c sets CMD_FIND_EXACT_SESSION and
 *    stops after the exact lookup). A bare `-t NAME` matches a name *prefix* and
 *    then a glob pattern, so reattaching "dev" could land on "dev-api" — and the
 *    `-d` below would then kick that session's real client off.
 *
 * `-d` is unconditional, unlike the `-D` of tmuxCreateCommand: after an abrupt
 * drop the server usually has not noticed yet and the dead connection's client is
 * still attached, so without `-d` the new client joins alongside a zombie and the
 * session shrinks to their smallest common size.
 */
export function tmuxReattachCommand(i: TmuxIntent): string | null {
  const name = i.session
  if (!name) return null
  if (name.startsWith('$')) return null // '$N' is tmux session-*ID* syntax, not a name
  if (/[.:\n\r]/.test(name)) return null // '.' and ':' split tmux's target syntax
  const target = shQuote(`=${name}`)
  const tmux = `tmux${i.control ? ' -CC' : ''}`
  return `tmux has-session -t ${target} 2>/dev/null && exec ${tmux} attach -d -t ${target}`
}

// A single-quoted token exactly as shQuote() writes one: a quote can only ever
// appear as the 4-character `'\''` escape, so the pattern cannot be fooled by a
// stray quote elsewhere in the command.
const TOKEN = String.raw`'[^']*(?:'\\''[^']*)*'`
// The create-or-attach forms this app has ever written. The `set -g K V \;` group
// is the pre-0.2.1 tmux-mouse prefix (removed in a3f2b8b) — still sitting in
// saved workspaces, so it must parse. Anchored at both ends: anything else at all
// is treated as a hand-written command whose intent we must not guess.
const CREATE_RE = new RegExp(
  String.raw`^tmux( -CC)? ((?:set -g \S+ \S+ \\; )*)new -A( -D)? -s (${TOKEN})$`
)

/** Inverse of shQuote for a single token; null if it isn't canonically quoted. */
function shUnquote(token: string): string | null {
  const body = token.slice(1, -1).split(`'\\''`).join(`'`)
  return shQuote(body) === token ? body : null
}

/**
 * Recover a TmuxIntent from a persisted command string. Legacy path only — tabs
 * saved since 0.2.4 carry the intent directly. Fails closed: an unrecognized
 * command yields null, which leaves that tab on manual reconnect instead of
 * running a rebuilt command against a session we only guessed the name of.
 */
export function parseTmuxIntent(command: string | undefined | null): TmuxIntent | null {
  if (!command) return null
  const m = CREATE_RE.exec(command)
  if (!m) return null
  const session = shUnquote(m[4])
  if (!session) return null
  return { session, control: !!m[1], detachOthers: !!m[3] }
}
