// One pass over a host's tmux server for the Agent Inbox: every session, what it
// is running, and whether it is asking for a human.
//
// The same two shell facts that shape shared/claude.ts and shared/git.ts shape
// this file: the script goes through shWrap and must be a single line joined with
// SEP, because the remote login shell may be fish or csh. See shared/shell.ts.
//
// The interesting design fact is a third one. tmux already tracks the two things
// an inbox needs, for every session, whether or not anyone is attached:
// `session_activity` (a timestamp it bumps on pane output) and
// `window_bell_flag` (set when a program rang the bell in a window no client is
// looking at, cleared when a client looks). Step 4's Claude Code hook pairs its
// notification with a plain BEL for exactly the reason that matters here — the
// bell is what survives a stock tmux — so an agent that wants you has already
// left a mark on the server that outlives the moment it made it. Nothing needs to
// be attached, and no output needs to be scraped.
import { isClaudeSession } from './claude'
import { SEP, shQuote } from './shell'
import type { AgentSession } from './types'

/**
 * Field separator inside one scan row.
 *
 * Not `|`, which the dashboard's session list can get away with because none of
 * its three fields is a path. `pane_current_path` is a path, and a directory
 * containing `|` is legal on every filesystem this app talks to. The path is
 * therefore also placed LAST and the parser rejoins the tail, so the only string
 * that can still break a row is a session name containing this exact sequence.
 */
export const FIELD_SEP = '|::|'

/** Marks a scan row, so tmux's own error text can never be parsed as one. */
const ROW = 'w'

/**
 * Marks the clock line, for the same reason rows are marked.
 *
 * A bare `now=` prefix would have been enough to read, but not enough to trust:
 * `pane_current_path` is a directory name chosen on the far side, and a directory
 * containing a newline followed by `now=<epoch>` would have been parsed as the
 * host's clock. Every session's idle time is computed against that one number, so
 * a single such path would have mislabelled the whole host — every agent on it
 * reported idle, or every one reported working. Marked and first-wins (the script
 * emits the real clock before it runs tmux at all), it cannot be reached.
 */
const CLOCK = `${ROW}${FIELD_SEP}now${FIELD_SEP}`

/**
 * Order is load-bearing: the parser reads by position, and `pane_current_path`
 * must stay last (see FIELD_SEP).
 *
 * `window_active` is what tells us which of a session's windows the session is
 * actually on, so the reported command and directory describe that one rather
 * than whichever window tmux happened to list first.
 */
const FIELDS = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_activity}',
  '#{window_active}',
  '#{window_bell_flag}',
  '#{pane_current_command}',
  '#{pane_current_path}'
]

/**
 * List every window on the host's tmux server, plus the server's own clock.
 *
 * The clock is not a nicety. Idle time is the difference between two timestamps,
 * and the only one we would otherwise have is the laptop's — so a host whose
 * clock is a few minutes off would report every agent as either permanently busy
 * or permanently stale. Both timestamps come from the same machine here.
 *
 * `|| true` because a host with no tmux server running is a perfectly normal
 * answer to this question, not a failure: tmux exits non-zero and prints "no
 * server running on …", and the parser simply finds no rows.
 */
export function agentScanScript(): string {
  const format = [ROW, ...FIELDS].join(FIELD_SEP)
  return [
    `echo "${CLOCK}$(date +%s)"`,
    `tmux list-windows -a -F ${shQuote(format)} 2>/dev/null || true`
  ].join(SEP)
}

export type AgentStatus = 'waiting' | 'working' | 'idle' | 'unknown'

/**
 * How recently a session must have produced output to count as working.
 *
 * Deliberately generous. An agent that is thinking rather than printing emits
 * nothing for tens of seconds at a time, and flickering it to "idle" between
 * paragraphs would make the whole column untrustworthy.
 */
export const WORKING_WITHIN_SECONDS = 60

/**
 * `waiting` outranks everything: a session that rang the bell wants a human
 * whether or not it has printed anything since.
 */
export function agentStatus(s: AgentSession): AgentStatus {
  if (s.wantsAttention) return 'waiting'
  if (s.idleSeconds === null) return 'unknown'
  return s.idleSeconds <= WORKING_WITHIN_SECONDS ? 'working' : 'idle'
}

/**
 * Does this session look like a Claude Code agent?
 *
 * Two independent tests, because they cover different origins. A session this app
 * launched is named by claudeSessionName() and matches by name no matter what is
 * running in it right now. A session the user started by hand — `tmux new`, then
 * `claude` — has an arbitrary name, so the only evidence is the foreground
 * process. `node` is deliberately NOT accepted as evidence: Claude Code has
 * shipped as a native binary for a while, and matching `node` would tag every
 * dev server on the host as an agent.
 *
 * Applied per window and OR'd across the session, like the bell — an agent
 * running in a window that is not the one the session is currently on is exactly
 * the case where the bell fires and nobody is looking.
 */
function isAgent(session: string, command: string): boolean {
  return isClaudeSession(session) || /^claude$/i.test(command.trim())
}

/**
 * Read the scan output into one entry per session.
 *
 * Written to degrade rather than to trust. Every numeric field is parsed
 * defensively and an unusable one becomes `null`/`false` instead of a wrong
 * number, because the tmux on the far side is whatever that host happens to
 * have: `session_activity` has been an epoch since tmux 2.1 but was a formatted
 * string before it, and an unknown `#{…}` expands to the empty string rather than
 * an error. A field this parser cannot read shows up in the UI as "unknown",
 * which is the honest answer.
 */
export function parseAgentScan(
  text: string
): { now: number | null; sessions: Omit<AgentSession, 'connectionId'>[] } {
  let now: number | null = null
  /**
   * Keyed by session name — one entry per session, folded over its windows.
   *
   * `connectionId` is deliberately absent here: this parser is host-agnostic
   * and has no idea which connection produced `text`. The IPC handler that
   * calls it stamps that field on afterward — see types.ts on AgentSession.
   */
  const byName = new Map<string, Omit<AgentSession, 'connectionId'>>()
  /** Sessions whose genuinely active window has already been read (see below). */
  const latched = new Set<string>()

  for (const line of text.split('\n')) {
    const row = line.trim()
    if (!row) continue
    if (row.startsWith(CLOCK)) {
      // First wins: the script emits this before it runs tmux, so the first one
      // is the real one and nothing downstream can replace it.
      if (now === null) {
        const n = parseInt(row.slice(CLOCK.length), 10)
        if (Number.isFinite(n) && n > 0) now = n
      }
      continue
    }
    const parts = row.split(FIELD_SEP)
    // marker + 7 fields; more only when the path itself contained the separator.
    if (parts.length < 8 || parts[0] !== ROW) continue
    const [, session, attached, activity, active, bell] = parts
    const command = parts[6]
    const dir = parts.slice(7).join(FIELD_SEP) // path is last and may contain SEP
    if (!session) continue

    const at = parseInt(activity, 10)
    const existing = byName.get(session)
    const isActiveWindow = active === '1'
    const entry: Omit<AgentSession, 'connectionId'> = existing ?? {
      session,
      dir: '',
      command: '',
      // A client COUNT, not a flag — two attached clients report '2'.
      attached: (parseInt(attached, 10) || 0) > 0,
      idleSeconds: null,
      lastActiveAt: null,
      wantsAttention: false,
      agent: false
    }
    // The bell is an OR across the session's windows: an agent that rang in a
    // background window is exactly the case this feature exists for.
    if (bell === '1') entry.wantsAttention = true
    // session_activity repeats identically on every row of a session, so max()
    // is just defensiveness against a tmux that scopes it per window.
    if (Number.isFinite(at) && at > 0) {
      entry.idleSeconds = entry.idleSeconds === null ? at : Math.max(entry.idleSeconds, at)
    }
    // Describe the window the session is actually on; fall back to the first row
    // seen so a session whose active window tmux didn't flag still says something.
    //
    // The latch is a separate Set rather than a test on `entry.command`, because
    // an empty command is a real answer here — `#{pane_current_command}` expands
    // empty on a tmux that doesn't know the variable. Reading emptiness as "not
    // filled in yet" let the next background window overwrite the active window's
    // command *and* directory, which is the directory the Review button opens.
    if (isActiveWindow ? !latched.has(session) : !existing) {
      entry.command = command ?? ''
      entry.dir = dir ?? ''
    }
    if (isActiveWindow) latched.add(session)
    if (isAgent(session, command ?? '')) entry.agent = true
    byName.set(session, entry)
  }

  // idleSeconds currently holds the raw activity timestamp; turn it into an age
  // only once, and only if the host told us its clock. lastActiveAt keeps that
  // same raw timestamp as an absolute point in time — no second remote call,
  // just the one CLOCK value read above given to both fields.
  const sessions = [...byName.values()].map((s) => ({
    ...s,
    idleSeconds:
      s.idleSeconds !== null && now !== null ? Math.max(0, now - s.idleSeconds) : null,
    lastActiveAt: s.idleSeconds !== null && now !== null ? s.idleSeconds : null
  }))
  return { now, sessions }
}
