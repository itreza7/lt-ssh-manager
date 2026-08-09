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
import { SEP, shQuote, shWrap } from './shell'
import { tmuxCreateCommand } from './tmux'

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
].join(SEP)

/**
 * The script an agent tab runs: resolve the binary, `cd`, hand the pane to Claude.
 *
 * `resume` adds `--resume <id>`, and the `cd` above it stops being a convenience
 * and becomes the thing that makes it work: Claude Code looks a session id up under
 * the project directory for the cwd it starts in, so the same id from the wrong
 * directory is reported as "No conversation found" and nothing is resumed. It exits
 * 1 when it says that, which lands on `die` below and holds Claude's own sentence on
 * screen underneath ours — so the pane explains itself without this script having to
 * parse the failure. Both behaviours verified against 2.1.220.
 *
 * Every ending — clean, failed, or never-started — exits the pane. `die` holds
 * the message on screen first, because tmux restores the alternate screen the
 * instant a pane dies and an unread error is no error at all.
 *
 * What it must NOT do is drop to a login shell, however useful that looks. The
 * pane's tmux session is named after the directory, and `tmux new -A` attaches
 * to a session that already exists. A husk left behind by a failed launch would
 * therefore capture that name: after installing Claude Code, clicking `Claude
 * here` on that directory would attach to the old plain shell, forever, with no
 * error to explain it and no way back short of killing the session by hand.
 * Exiting frees the name, so the next click is a real launch. A shell on that
 * host is one click away on the dashboard regardless.
 */
export function claudeScript(dir: string, pin?: string, resume?: string): string {
  const resumeArg = resume ? ` --resume ${shQuote(resume)}` : ''
  // Everything above runs under /bin/sh (shWrap, for the fish/csh hosts CLAUDE_RESOLVE's
  // own comment describes), so it cannot source ~/.bashrc itself — bash-only syntax in a
  // stock bashrc (e.g. `>&`) is a parse error under dash, and a parse error in a dot-sourced
  // script kills the sourcing shell outright. A real bash has to do that part, as its own
  // subprocess: found the same cheap way CLAUDE_RESOLVE finds claude, then handed the same
  // PS1 trick — bash's stock bashrc returns on its first line for a non-interactive shell,
  // which `$SHELL -c` always is even under tmux's pty, so PS1 is forced non-empty purely to
  // clear that guard and unset right after. If the user's rc defines `claude` as a function
  // or alias — a model/effort default, a proxy, a permissions bypass — that's what runs, so
  // a tab behaves exactly like the user typing `claude` themselves, worktree directory or
  // not (the cwd is already set by the `cd` above, and bash -c inherits it). Otherwise it
  // falls back to the plain resolved binary, same as an explicit pin always does.
  const bashRun =
    `BB=$(command -v bash 2>/dev/null); ` +
    `if [ -n "$BB" ]; then "$BB" -c ${shQuote(
      `PS1=x; . "$HOME/.bashrc" >/dev/null 2>&1; unset PS1; t=$(type -t claude 2>/dev/null); ` +
        `if [ "$t" = function ] || [ "$t" = alias ]; then claude${resumeArg}; else "$CLI"${resumeArg}; fi`
    )}; rc=$?; ` +
    `else "$CLI"${resumeArg}; rc=$?; fi`
  return [
    // `%b` so callers can put a line break in a message without putting one in
    // the script; `read` falls back to a sleep where stdin is not a terminal.
    'die() { echo; printf "%b\\n\\n" "$1"; printf "[Enter to close] "; read _ 2>/dev/null || sleep 60; exit 1; }',
    `cd ${shQuote(dir)} 2>/dev/null || die ${shQuote(`Cannot enter ${dir}\\nIt may have been moved, removed, or never existed.`)}`,
    CLAUDE_TIMEOUT,
    `CLI=${pin ? shQuote(pin) : ''}`,
    CLAUDE_RESOLVE,
    `[ -n "$CLI" ] || die 'Claude Code was not found on this host.\\nInstall it with:  curl -fsSL https://claude.ai/install.sh | bash\\nOr, if it lives behind a version manager, set its full path in Edit > Claude Code binary.'`,
    'export CLI',
    // A pin is an explicit, exact-binary override from Settings — it always wins outright,
    // with no rc/wrapper involved, same as before this existed.
    pin ? `"$CLI"${resumeArg}; rc=$?` : bashRun,
    '[ "$rc" = 0 ] && exit 0',
    'die "claude exited with status $rc"'
  ].join(SEP)
}

/** What an agent tab's `command` is set to, tmux or not. */
export function claudeTabCommand(
  dir: string,
  pin?: string,
  tmux?: TmuxIntent,
  resume?: string
): string {
  const inner = shWrap(claudeScript(dir, pin, resume))
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

/**
 * Name a RESUMED session after the transcript, never after its directory.
 *
 * claudeSessionName() keys on the directory precisely so that one working tree
 * holds one agent, and resume cannot borrow that. `tmux new -A` on the directory's
 * name would attach to whatever agent is already running there instead of resuming
 * the transcript the user picked — the click would quietly do a different thing,
 * which is the one outcome worth engineering against.
 *
 * Keying on the transcript id keeps the same one-identity-one-session property that
 * name was built for, pointed at a different identity: clicking Resume twice on one
 * session attaches to the pane that is already resuming it rather than starting a
 * second `claude --resume` appending to the same transcript. What it gives up is the
 * directory guarantee — a resumed agent can share a working tree with one launched
 * from the file manager. That is a real thing to know and a bad thing to guess at
 * from a name, so the pane says so on the row instead. See AgentInbox.
 *
 * The shape still satisfies isClaudeSession(), so a resumed agent reads as an agent
 * on the dashboard: the slug is the directory's, for eyes, and the hash is the
 * transcript's, for identity.
 */
export function claudeResumeSessionName(sessionId: string, dir?: string | null): string {
  const base = (dir ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 16)
  return `claude-${slug || 'resume'}-${fnv1a32(sessionId)}`
}

/** Display only — drives the dashboard's `agent` chip. Never gates an action. */
export function isClaudeSession(name: string): boolean {
  return /^claude-(home|[a-z0-9_-]{1,16}-[0-9a-f]{8})$/.test(name)
}
