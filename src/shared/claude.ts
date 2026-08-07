// Builders for running Claude Code on a remote server: the script a tab launches
// it with, the probe the dashboard describes it with, and the tmux session name
// that keeps one directory to one agent.
//
// Shared, not renderer-only, for the same reason shared/tmux.ts is: the main
// process builds the probe out of CLAUDE_RESOLVE and the renderer builds the
// launch script out of the same text. If the two drift, the card describes one
// install and the tab starts another.
//
// One fact shapes almost everything here. sshd runs an exec channel as
// `$SHELL -c <cmd>`, and tmux runs a shell-command as `default-shell -c <cmd>` —
// both non-login and non-interactive. Neither reads ~/.profile, and Debian and
// Ubuntu's stock ~/.bashrc returns early when non-interactive, so `~/.local/bin`
// is off PATH. `ssh host 'claude --version'` therefore exits 127 on a machine
// where Claude Code plainly works in a terminal. Hence the resolver ladder below
// and the `/bin/sh -c` wrapper: the remote login shell may also be fish or csh,
// neither of which can parse `$( )`, `for…do…done` or `case`.
import type { TmuxIntent } from './types'
import { shQuote, tmuxCreateCommand } from './tmux'

/**
 * `$TMO` is used UNQUOTED at every call site so it word-splits into `timeout 6`
 * when coreutils is there and vanishes when it is not; `"$TMO"` would try to
 * exec a program named "". It is probed rather than assumed because `timeout`
 * ships with coreutils/busybox and is absent on stock macOS and some BSDs.
 */
export const CLAUDE_TIMEOUT = 'TMO=; command -v timeout >/dev/null 2>&1 && TMO="timeout 6"'

/**
 * Resolve `claude` into `$CLI`, or leave `$CLI` empty. Expects `$CLI` to already
 * hold the per-connection override, or the empty string.
 *
 * Four rungs, cheapest first. The last pays for a whole login shell exactly once,
 * because that is the only way to see a version-manager shim — nvm, asdf, mise,
 * bun — which lives on a PATH no rung can enumerate. It is the one rung that runs
 * another program, so it is the one rung that is time-bounded: a login shell whose
 * rc file blocks on a prompt would otherwise hang the tab with no visible cause.
 *
 * The trailing `case` is the security boundary, not a tidy-up. `command -v` inside
 * a login shell can hand back an alias, a function body, or whatever the rc file
 * printed first — and a `$SHELL` of /usr/sbin/nologin prints a refusal message.
 * Anything that is not an absolute path to an executable file is discarded, and
 * the caller takes its not-found branch instead of exec'ing that text.
 */
export const CLAUDE_RESOLVE = [
  // A pin saved when the binary existed, then orphaned by an upgrade that moved
  // it, must not skip the ladder and dead-end on a path that no longer resolves.
  '[ -n "$CLI" ] && [ ! -x "$CLI" ] && CLI=',
  '[ -n "$CLI" ] || CLI=$(command -v claude 2>/dev/null)',
  '[ -n "$CLI" ] || for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude /usr/bin/claude /opt/homebrew/bin/claude /snap/bin/claude; do [ -x "$c" ] && CLI=$c && break; done',
  '[ -n "$CLI" ] || CLI=$($TMO "${SHELL:-/bin/sh}" -lc "command -v claude" 2>/dev/null | tail -n 1)',
  'case "$CLI" in /*) [ -x "$CLI" ] || CLI= ;; *) CLI= ;; esac'
].join('\n')

/** Wrap a POSIX script for a remote login shell that may be fish or csh. */
export const shWrap = (script: string): string => `/bin/sh -c ${shQuote(script)}`

/**
 * The script an agent tab runs: resolve the binary, `cd`, hand the pane to Claude.
 *
 * The ending branches on exit status, and both halves are deliberate. On a clean
 * exit the pane dies, a tmux session dies with it, and the next launch on that
 * directory starts a fresh agent instead of attaching to a husk. On a non-zero
 * exit the pane must NOT die: tmux restores the alternate screen the instant it
 * does, so a bad install's error message would scroll away before anyone read it.
 * Only the failure case lingers, which is exactly when lingering is useful.
 */
export function claudeScript(dir: string, pin?: string): string {
  return [
    `cd ${shQuote(dir)} || exit 1`,
    CLAUDE_TIMEOUT,
    `CLI=${pin ? shQuote(pin) : ''}`,
    CLAUDE_RESOLVE,
    `[ -n "$CLI" ] || { echo 'Claude Code was not found on this host.'; echo 'Install it with:  curl -fsSL https://claude.ai/install.sh | bash'; exec "\${SHELL:-/bin/sh}" -l; }`,
    '"$CLI"; rc=$?',
    '[ "$rc" = 0 ] && exit 0',
    'echo "claude exited with status $rc"',
    'exec "${SHELL:-/bin/sh}" -l'
  ].join('\n')
}

/** What an agent tab's `command` is set to, tmux or not. */
export function claudeTabCommand(dir: string, pin?: string, tmux?: TmuxIntent): string {
  const inner = shWrap(claudeScript(dir, pin))
  // `exec` on the non-tmux path so the wrapper shell does not linger as a third
  // process between sshd and the agent, swallowing a signal on disconnect.
  return tmux ? tmuxCreateCommand(tmux, inner) : `exec ${inner}`
}

/**
 * FNV-1a, 32-bit. A hash with no dependency, because the name it produces has to
 * come out byte-identical in the renderer today and in any future main-process
 * caller — a different hash is a different session, which is a second agent.
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Name a session after the ABSOLUTE directory, never after a display string.
 *
 * tmuxSessionName() collapses `.`, `:` and whitespace all to `-`, so /srv/a.b,
 * /srv/a-b and /srv/a b would flatten to one name — and `tmux new -A` would then
 * attach the user to another project's *running* agent, in the wrong working
 * tree, with no error and a perfectly plausible prompt. The slug is for the eye;
 * the hash is what makes the name unique, and what makes it identical for a
 * dashboard launch and a file-browser launch on the same path. That identity is
 * the whole mechanism that stops two agents opening on one directory.
 */
export function claudeSessionName(dir: string): string {
  const base = dir.replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 16)
  return slug ? `claude-${slug}-${fnv1a32(dir)}` : 'claude-home'
}

/** Display only — drives the dashboard's `agent` chip. Never gates an action. */
export function isClaudeSession(name: string): boolean {
  return /^claude-(home|[a-z0-9_-]{1,16}-[0-9a-f]{8})$/.test(name)
}
