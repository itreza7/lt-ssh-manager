// The remote half of the attention feature: the `Notification` hook we install
// into a server's `~/.claude/settings.json` so that Claude Code running there
// can tell this app it needs a human.
//
// The hook is a shell command Claude Code runs as a child process, and since
// Claude Code v2.1.139 that process has no controlling terminal at all — every
// interactive session is daemon-hosted, so a direct write to `/dev/tty` fails
// outright. The `terminalSequence` field on the hook's JSON stdout (Claude Code
// v2.1.141+) is the supported replacement: Claude Code's own front-end process,
// which still holds the real controlling terminal, relays the sequence through
// its internal terminal-write path instead. That path already knows how to
// reach the user under tmux and GNU screen, so — unlike the old `/dev/tty`
// write — this needs no `$TMUX` branching or passthrough-wrapping of our own;
// only tmux's `allow-passthrough` still has to be on for it to get through
// (see the tmux-passthrough section below).
//
// Read-modify-write lives here rather than in the renderer because a missing
// file has to be told apart from a failed read, and the SFTP error code that
// distinguishes them does not survive the trip across IPC.

/**
 * What marks a hook entry as ours. It rides along as a shell comment, which
 * makes an installed hook self-identifying in the file the user can read, and
 * gives uninstall something exact to match on. Anything else in `Notification`
 * belongs to the user and is never touched.
 */
export const HOOK_MARKER = 'lt-ssh-manager-attention'

/** Where Claude Code keeps per-user settings, relative to the remote home. */
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json'

/**
 * The command itself.
 *
 * Prints `{"terminalSequence": "<OSC 777 notify sequence>"}` on stdout —
 * `OSC 777` (urxvt/Ghostty/Warp notifications) is one of the handful of
 * sequences `terminalSequence` allowlists; everything else, including any
 * DCS/tmux-passthrough wrapper, is rejected. The JSON is a fixed string
 * literal rather than built with `jq`: the message text is fixed too (see
 * below), so there is nothing to escape, and this is the one hook where a
 * missing `jq` on the remote host must never be the reason an attention ping
 * silently doesn't fire.
 *
 * The message text is fixed rather than lifted from the hook's JSON payload on
 * stdin. Reading it would mean depending on `jq` being installed and
 * re-escaping arbitrary remote text into the middle of a JSON string; the tab
 * dot already says *which* session wants you, which is the part a fixed
 * string can't tell you.
 *
 * `exit 0` because a hook that fails is noise in Claude Code's log, and there
 * is no useful recovery from "this session has no tty" — that's just a Claude
 * Code running somewhere we can't see.
 */
export const HOOK_COMMAND =
  "printf '%s\\n' '{\"terminalSequence\":\"\\u001b]777;notify;Claude Code;Needs your attention\\u0007\"}'; " +
  `exit 0 # ${HOOK_MARKER}`

/** One command inside a hook entry. Unknown keys are preserved on write. */
interface HookCommand extends Record<string, unknown> {
  type?: string
  command?: string
}

/** One matcher group under an event. Unknown keys are preserved on write. */
interface HookEntry extends Record<string, unknown> {
  hooks?: HookCommand[]
}

export interface HookPlan {
  /** The file as it stands, pretty-printed. `{}` when there is no file yet. */
  before: string
  /** What we would write. Identical to `before` when there is nothing to do. */
  after: string
  /** Our hook is present *and* current — i.e. install would change nothing. */
  installed: boolean
  /** Any of ours is present, current or not — i.e. uninstall has work to do. */
  present: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isOurs = (c: unknown): boolean =>
  isRecord(c) && typeof c.command === 'string' && c.command.includes(HOOK_MARKER)

/** Pretty-print the way an editor would leave it: two spaces, trailing newline. */
const render = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`

/**
 * Work out what installing or removing the hook would do to a settings file.
 *
 * `raw` is the file's contents, or `null` when it does not exist — a distinction
 * the caller has to make, because "no settings yet" is the normal state of a
 * fresh server and must produce a valid plan rather than an error.
 *
 * The whole document is parsed and re-serialized, so every key we don't know
 * about survives. Malformed JSON throws: silently replacing a file we couldn't
 * understand would take a user's settings with it.
 */
export function planHooks(raw: string | null, action: 'install' | 'uninstall'): HookPlan {
  const text = raw === null ? '' : raw.trim()
  let doc: unknown
  try {
    doc = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${CLAUDE_SETTINGS_PATH} is not valid JSON — fix or move it, then try again`)
  }
  if (!isRecord(doc)) throw new Error(`${CLAUDE_SETTINGS_PATH} is not a JSON object`)

  const before = render(doc)
  const hooks = isRecord(doc.hooks) ? doc.hooks : {}
  const events = Array.isArray(hooks.Notification) ? (hooks.Notification as HookEntry[]) : []

  const ours = events.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks.filter(isOurs) : []))
  const present = ours.length > 0
  const installed = ours.length === 1 && ours[0].command === HOOK_COMMAND && events.length >= 1

  // Rebuild `Notification` without any of ours, keeping the user's own entries
  // and their order. An entry that held nothing but our command goes with it,
  // rather than being left behind as an empty group.
  const kept = events
    .map((e) =>
      Array.isArray(e?.hooks) ? { ...e, hooks: e.hooks.filter((c) => !isOurs(c)) } : e
    )
    .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0)

  const next =
    action === 'install'
      ? [...kept, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }]
      : kept

  // Prune on the way out so uninstalling from a file that had nothing else in it
  // leaves `{}` rather than a scaffold of empty containers.
  const nextHooks = { ...hooks }
  if (next.length > 0) nextHooks.Notification = next
  else delete nextHooks.Notification
  const nextDoc = { ...doc }
  if (Object.keys(nextHooks).length > 0) nextDoc.hooks = nextHooks
  else delete nextDoc.hooks

  return { before, after: render(nextDoc), installed, present }
}

// ---------------------------------------------------------------------------
// The remote half of the status-line feature: a `statusLine` command we
// install so Claude Code's own native status line — the row it already
// renders at the bottom of the interface — shows the model, directory,
// worktree, reasoning effort, context usage, and rate limits. Unlike the
// Notification hook above, this never touches `/dev/tty` or any escape
// sequence: Claude Code pipes the session's JSON to this command on stdin and
// renders whatever it prints on stdout as plain text (see
// code.claude.com/docs/en/statusline) — the same mechanism whether or not the
// session is daemon-hosted or running under tmux, so there is nothing here for
// the daemon-tty change to break. Same read-modify-write shape as the
// Notification hook above, but `statusLine` is a single slot in the settings
// document rather than an array, so installing always replaces whatever
// command is there — the before/after diff the caller shows is what keeps
// that from being a silent clobber of a command the user wrote themselves.

/** What marks a `statusLine.command` as ours, the same way HOOK_MARKER does. */
export const STATUSLINE_MARKER = 'lt-ssh-manager-statusline'

/**
 * The command itself: pulls a handful of fields out of Claude Code's JSON
 * payload on stdin with `jq` — the same tool every example in Claude Code's
 * own statusline docs uses — and prints one ANSI-colored line. Colors are
 * plain SGR escape codes in the printed text (code.claude.com/docs/en/statusline
 * documents this as supported, distinct from the OSC `terminalSequence` field
 * hooks use) — no JSON/relay involved, Claude Code just renders whatever bytes
 * the command prints. Percentages are colored green/yellow/red at the same
 * 70%/90% thresholds the official docs' own example uses. `rate_limits` is a
 * Claude Code field that is only
 * populated for Claude.ai Pro/Max accounts, and only once the session's first
 * API response has come back — on any other plan, or before that first
 * response, `FIVE`/`WEEK` are legitimately empty and those segments just
 * don't print, the same as every other optional field here. A remote host
 * without `jq` gets an empty status line, the same failure mode the official
 * examples accept; there is no hand-rolled fallback parser here for the same
 * reason there isn't one there.
 */
export const STATUSLINE_COMMAND =
  'd=$(cat); ' +
  "MODEL=$(printf '%s' \"$d\" | jq -r '.model.display_name // empty'); " +
  "DIR=$(printf '%s' \"$d\" | jq -r '.workspace.current_dir // empty'); " +
  "WT=$(printf '%s' \"$d\" | jq -r '.workspace.git_worktree // empty'); " +
  "EFFORT=$(printf '%s' \"$d\" | jq -r '.effort.level // empty'); " +
  "PCT=$(printf '%s' \"$d\" | jq -r '.context_window.used_percentage // empty'); " +
  "FIVE=$(printf '%s' \"$d\" | jq -r '.rate_limits.five_hour.used_percentage // empty'); " +
  "WEEK=$(printf '%s' \"$d\" | jq -r '.rate_limits.seven_day.used_percentage // empty'); " +
  "RESET='\x1b[0m'; DIM='\x1b[2m'; CYAN='\x1b[1;36m'; MAG='\x1b[35m'; BLU='\x1b[34m'; GRN='\x1b[32m'; YEL='\x1b[33m'; RED='\x1b[31m'; " +
  'DOT="${DIM} · ${RESET}"; ' +
  'pcolor() { v=${1%.*}; if [ -z "$v" ]; then printf \'\'; elif [ "$v" -ge 90 ] 2>/dev/null; then printf \'%s\' "$RED"; elif [ "$v" -ge 70 ] 2>/dev/null; then printf \'%s\' "$YEL"; else printf \'%s\' "$GRN"; fi; }; ' +
  'PCTI=${PCT%.*}; FIVEI=${FIVE%.*}; WEEKI=${WEEK%.*}; ' +
  'PCOL=$(pcolor "$PCT"); FCOL=$(pcolor "$FIVE"); WCOL=$(pcolor "$WEEK"); ' +
  'OUT="${CYAN}${MODEL}${RESET}"; ' +
  '[ -n "$DIR" ] && OUT="$OUT${DOT}${DIR##*/}"; ' +
  '[ -n "$WT" ] && OUT="$OUT${DOT}${DIM}(${RESET}${MAG}⑂ ${WT}${RESET}${DIM})${RESET}"; ' +
  '[ -n "$EFFORT" ] && OUT="$OUT${DOT}${BLU}${EFFORT}${RESET}"; ' +
  '[ -n "$PCTI" ] && OUT="$OUT${DOT}${DIM}ctx${RESET} ${PCOL}${PCTI}%${RESET}"; ' +
  '[ -n "$FIVE" ] && OUT="$OUT${DOT}${DIM}5h${RESET} ${FCOL}${FIVEI}%${RESET}"; ' +
  '[ -n "$WEEK" ] && OUT="$OUT${DOT}${DIM}7d${RESET} ${WCOL}${WEEKI}%${RESET}"; ' +
  `echo "$OUT"; exit 0 # ${STATUSLINE_MARKER}`

/** One `statusLine` entry. Unknown keys are preserved on write. */
interface StatusLineCommand extends Record<string, unknown> {
  type?: string
  command?: string
}

export interface StatusLinePlan {
  /** The file as it stands, pretty-printed. `{}` when there is no file yet. */
  before: string
  /** What we would write. Identical to `before` when there is nothing to do. */
  after: string
  /** Our command is present *and* current — i.e. install would change nothing. */
  installed: boolean
  /** Our command is present, current or not — i.e. uninstall has work to do. */
  present: boolean
}

const isOurStatusLine = (v: unknown): v is StatusLineCommand =>
  isRecord(v) && typeof v.command === 'string' && v.command.includes(STATUSLINE_MARKER)

/**
 * Same contract as {@link planHooks}, for the `statusLine` setting.
 *
 * The one structural difference: `statusLine` is a single object, not an
 * array of matcher groups, so there is no "ours among others" to merge —
 * install always replaces the whole value, and uninstall only ever removes a
 * value that is already ours. A `statusLine` some other tool or the user
 * configured is left exactly as it is by uninstall, and is only replaced by
 * install after the caller has shown the user what that replacement is.
 */
export function planStatusLine(raw: string | null, action: 'install' | 'uninstall'): StatusLinePlan {
  const text = raw === null ? '' : raw.trim()
  let doc: unknown
  try {
    doc = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${CLAUDE_SETTINGS_PATH} is not valid JSON — fix or move it, then try again`)
  }
  if (!isRecord(doc)) throw new Error(`${CLAUDE_SETTINGS_PATH} is not a JSON object`)

  const before = render(doc)
  const current = doc.statusLine
  const present = isOurStatusLine(current)
  const installed =
    present &&
    (current as StatusLineCommand).type === 'command' &&
    (current as StatusLineCommand).command === STATUSLINE_COMMAND

  const nextDoc = { ...doc }
  if (action === 'install') {
    nextDoc.statusLine = { type: 'command', command: STATUSLINE_COMMAND }
  } else if (present) {
    delete nextDoc.statusLine
  }
  // uninstall on a foreign or absent statusLine: nextDoc is left as a copy of doc, unchanged.

  return { before, after: render(nextDoc), installed, present }
}

// ---------------------------------------------------------------------------
// The remote half of the tmux-passthrough requirement: `terminalSequence`
// (used by the Notification hook above) reaches the user by having Claude
// Code's own front-end process write the escape sequence to its controlling
// terminal. Under tmux that terminal is the pane's tty, which belongs to the
// tmux server — and tmux drops any escape sequence it doesn't itself
// recognize unless `allow-passthrough` is on, which it has been off by
// default since tmux 3.3. The status line above has no such dependency at
// all: it is plain stdout text Claude Code renders directly, tmux or not.

/** Where tmux reads its startup config, relative to the remote home. */
export const TMUX_CONF_PATH = '.tmux.conf'

/** What marks a `~/.tmux.conf` line as ours, the same way HOOK_MARKER does. */
export const TMUX_PASSTHROUGH_MARKER = 'lt-ssh-manager-passthrough'

/** The line itself — a tmux config statement, not a shell command. */
export const TMUX_PASSTHROUGH_LINE = `set -g allow-passthrough all # ${TMUX_PASSTHROUGH_MARKER}`

export interface TmuxPassthroughPlan {
  /** The file as it stands, verbatim. `''` when there is no file yet. */
  before: string
  /** What we would write. Identical to `before` when there is nothing to do. */
  after: string
  /** Our line is present *and* current — i.e. install would change nothing. */
  installed: boolean
  /** Any of ours is present, current or not — i.e. uninstall has work to do. */
  present: boolean
}

/**
 * Same read-modify-write contract as {@link planHooks} and {@link
 * planStatusLine}, but for a plain-text tmux config rather than JSON: a line
 * is ours if it carries the marker, and everything else in the file — the
 * user's own config, in whatever order they left it — passes through
 * untouched. Only ever appended to, never reordered, so a re-run diffs as "no
 * change" instead of shuffling someone's file.
 */
export function planTmuxPassthrough(raw: string | null, action: 'install' | 'uninstall'): TmuxPassthroughPlan {
  const before = raw ?? ''
  const lines = before.length > 0 ? before.split('\n') : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const isOurs = (line: string): boolean => line.includes(TMUX_PASSTHROUGH_MARKER)
  const present = lines.some(isOurs)
  const installed = present && lines.some((l) => l === TMUX_PASSTHROUGH_LINE)

  const kept = lines.filter((l) => !isOurs(l))
  const next = action === 'install' ? [...kept, TMUX_PASSTHROUGH_LINE] : kept

  return { before, after: next.length > 0 ? `${next.join('\n')}\n` : '', installed, present }
}
