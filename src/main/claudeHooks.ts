// The remote half of the attention feature: the `Notification` hook we install
// into a server's `~/.claude/settings.json` so that Claude Code running there
// can tell this app it needs a human.
//
// The hook is a shell command Claude Code runs as a child process. Its stdout is
// Claude Code's, not the terminal's, so the sequence has to be written to
// `/dev/tty` — the controlling terminal, which is our PTY (or, under tmux, the
// pane's).
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
 * `OSC 777 ; notify ; title ; body` as printf format text — the sequence
 * xtermAgentSignal listens for. Written as a printf format rather than raw
 * bytes so the JSON we store on the server stays plain ASCII and stays legible
 * to whoever opens it next.
 */
const NOTIFY = String.raw`\033]777;notify;Claude Code;Needs your attention\033\\`

/**
 * The same sequence wrapped for tmux passthrough, with every ESC in the body
 * doubled as the wrapper requires. Under tmux the pane's tty belongs to tmux,
 * so an unwrapped OSC would be tmux's to interpret and would stop there.
 *
 * …and the wrapper alone is not enough, which is what the trailing BEL is for.
 * tmux drops passthrough unless `allow-passthrough` is set, and it has been off
 * by default since tmux 3.3 — so on a stock server the wrapped OSC reaches
 * nothing. A bell is the one attention signal tmux forwards out of the box
 * (`bell-action any`, `visual-bell off`), including from a background window,
 * where even `allow-passthrough on` stays silent. So we send both: the OSC
 * carries the text when the server allows it, and the bell always lights the
 * tab dot. Both land on the same leaf id, and `waiting` is a set, so the pair
 * marks one session once.
 */
const NOTIFY_TMUX =
  String.raw`\033Ptmux;\033\033]777;notify;Claude Code;Needs your attention\033\033\\\033\\` + String.raw`\007`

/**
 * The command itself.
 *
 * The message text is fixed rather than lifted from the hook's JSON payload on
 * stdin. Reading it would mean depending on `jq` being installed and re-escaping
 * arbitrary remote text into the middle of an escape sequence; the tab dot
 * already says *which* session wants you, which is the part a fixed string
 * can't tell you.
 *
 * `exit 0` because a hook that fails is noise in Claude Code's log, and there is
 * no useful recovery from "this session has no tty" — that's just a Claude Code
 * running somewhere we can't see.
 */
export const HOOK_COMMAND =
  `if [ -n "$TMUX" ]; then printf '${NOTIFY_TMUX}'; else printf '${NOTIFY}'; fi ` +
  `>/dev/tty 2>/dev/null; exit 0 # ${HOOK_MARKER}`

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
