// The primitives every remote script in this app is built out of.
//
// They live together because three unrelated features — tmux tabs, Claude Code
// launches, and git review — each assemble a command string for a shell nobody
// here chose, and all three break in the same two ways if they get it wrong.
//
// Fact one: the remote login shell may be fish or csh. Neither can parse `$( )`,
// `for…do…done` or `case`, so anything beyond a bare command has to be handed to
// /bin/sh explicitly — that is shWrap.
//
// Fact two: csh cannot carry a single-quoted word across a newline. That makes
// the wrapper self-defeating unless the script inside it is a single line, which
// is what SEP is for.

/** Single-quote a string for safe interpolation into a POSIX shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Statement separator for every script that goes through shWrap — `'; '`, never
 * a newline.
 *
 * shWrap single-quotes the script so a fish or csh login shell hands it to
 * /bin/sh intact. csh cannot carry a single-quoted word across a newline:
 * `tcsh -c "/bin/sh -c 'echo A<LF>echo B'"` prints `Unmatched '.` and then runs
 * the remaining lines as csh. So a newline-joined script fails on exactly the
 * shell the wrapper is there to survive — the tab fills with csh parse errors,
 * and a probe emits a partial answer its handler rejects, on a host where the
 * thing being probed is installed and fine. Keep every builder on one line.
 */
export const SEP = '; '

/**
 * Wrap a POSIX script for a remote login shell that may be fish or csh.
 *
 * The wrapped script must be a single LINE — see SEP. csh cannot carry a
 * single-quoted word across a newline, so a multi-line script here fails on
 * precisely the shell this wrapper exists to defend against.
 */
export const shWrap = (script: string): string => `/bin/sh -c ${shQuote(script)}`
