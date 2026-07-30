// Decides, from what actually happened as a session died, whether reattaching can
// help — or whether the remote session is gone/deliberately left, in which case
// retrying would be wrong. Pure: no timers, no I/O, no manager state.
//
// The distinction the whole feature rests on is *not* an exit code. It is whether
// the remote end reported an exit at all:
//
//   channel 'exit' fired        the command finished and told us how -> trust it
//   only channel 'close' fired  the transport died mid-command (ssh2 tears every
//                               channel down without an exit-status) -> a drop
//
// See ssh2's utils.js `cleanup()`/`onCHANNEL_CLOSE(..., dead=true)`: on transport
// death it emits 'close' with no code and never emits 'exit'.
import type { CloseReason } from '../../shared/types'

/**
 * The tmux client exit reasons (client.c `client_exit_message()`) that another
 * attach can recover from, because the *session* normally outlives them:
 *  - "too far behind": the server killed this control client for lagging
 *    (control.c, CONTROL_MAXIMUM_AGE).
 *  - "server exited unexpectedly" / "lost server": the client lost its link.
 *  - "lost tty": the client's pty vanished under it, i.e. our channel died.
 * Everything else the client can print is final — see classifyTmuxExit.
 */
const TRANSIENT = /too far behind|server exited unexpectedly|lost server|lost tty/i

/**
 * The same reasons in the form an *attached* client prints them: client.c:409-431
 * writes `[%s]\n` to stdout — the pty — when it was drawing, and only uses stderr
 * or a `%exit` line when it was not. The brackets are required here because this
 * is matched against terminal output, where a shell echoing the words "lost
 * server" must not be mistaken for tmux saying it.
 */
const TRANSIENT_BANNER = /\[(?:too far behind|server exited unexpectedly|lost server|lost tty)\]/i
/** `[detached (from session x)]` — the banner for a deliberate C-b d. */
const DETACHED_BANNER = /\[detached\b/i

export interface DropFacts {
  /** The tab is tmux-backed at all. A plain login shell is never reattached. */
  tmuxBacked: boolean
  /** A `%exit` line arrived from a control-mode client. */
  sawTmuxExit: boolean
  /** Its reason text; '' for a bare `%exit` (tmux printed no reason). */
  tmuxExitReason: string
  /** The channel reported an exit status, i.e. the remote command finished. */
  sawStreamExit: boolean
  exitCode: number | null
  /** Set instead of a code when the remote command died from a signal. */
  exitSignal?: string
  /**
   * Tail of what the command last printed, escape sequences stripped. This is
   * terminal output, not stderr: every interactive channel runs under a pty, which
   * merges the remote's fd 2 into the pty master, so an attached tmux client's
   * parting banner arrives here and `stream.stderr` never fires at all.
   */
  outputTail: string
}

export type DropVerdict =
  | { action: 'reattach' }
  | { action: 'stop'; reason: Exclude<CloseReason, 'unreachable'> }

/**
 * A control client's `%exit`. Reaching us at all means tmux decided to exit and
 * had time to say so — an abrupt drop produces no `%exit` line whatsoever — so
 * the default here is to stop, and only the enumerated reasons retry.
 */
function classifyTmuxExit(reason: string): DropVerdict {
  if (TRANSIENT.test(reason)) return { action: 'reattach' }
  // "detached", "detached (from session x)", "detached and SIGHUP …": the user
  // pressed C-b d. Reattaching here would make detaching impossible.
  if (/^detached/i.test(reason)) return { action: 'stop', reason: 'detached' }
  if (/^exited$/i.test(reason)) return { action: 'stop', reason: 'exited' }
  // A bare `%exit` is CLIENT_EXIT_NONE — tmux left on its own terms without a
  // reason. Treat it as final for the same reason as a detach.
  if (!reason) return { action: 'stop', reason: 'detached' }
  // "server exited" (kill-server), "terminated" (the client was signalled), or a
  // message we don't know: the session is not something an attach will recover.
  return { action: 'stop', reason: 'gone' }
}

export function classifyDrop(f: DropFacts): DropVerdict {
  if (f.sawTmuxExit) return classifyTmuxExit(f.tmuxExitReason)

  if (f.sawStreamExit) {
    // Killed by a signal: the remote tmux client (or shell) was torn down from
    // outside. Nothing an attach can fix on its own.
    if (f.exitSignal) return { action: 'stop', reason: 'gone' }
    if (f.exitCode === 0) {
      if (!f.tmuxBacked) return { action: 'stop', reason: 'exited' }
      // Exit 0 is not proof of a detach. Verified against tmux master, a drawn
      // client also exits 0 when another client runs `kill-session` and when the
      // last pane's shell exits: both reach server_destroy_session(), which sets
      // CLIENT_EXIT while leaving the client's retval at 0 (server-fn.c:509-521,
      // server-client.c:2313-2325). Only the banner tells them apart —
      // "[detached (from session x)]" against a bare "[exited]".
      //
      // So this fails closed. Without positive evidence of a detach we must not
      // claim the session survived: saying "still running" about a session that
      // was killed sends the user to a reattach that cannot succeed. The reverse
      // mistake is harmless — a detached session reported as gone still reattaches
      // fine, because the recovery command attaches when the session exists.
      if (DETACHED_BANNER.test(f.outputTail)) return { action: 'stop', reason: 'detached' }
      return { action: 'stop', reason: 'gone' }
    }
    // Non-zero. "[lost server]" and friends mean the client died under a session
    // that normally outlives it, so another attach is worth trying; "can't find
    // session: x" and "no server running on …" are final.
    if (TRANSIENT_BANNER.test(f.outputTail)) return { action: 'reattach' }
    return { action: 'stop', reason: f.tmuxBacked ? 'gone' : 'exited' }
  }

  // No exit status at all — the link died under a command that was still running.
  return { action: 'reattach' }
}

/**
 * The user-facing ladder: 1s, 2s, 3s, 4s, 5s, then 5s while the outage looks
 * short. Past a minute of failures it tapers to 30s — an unreachable host would
 * otherwise mean an SSH handshake attempt every 5 seconds all night, which is the
 * kind of idle drain this app goes out of its way to avoid. The ladder itself
 * never ends: only a session proven gone, a permanent error, closing the tab, or
 * the banner's Stop button stops it.
 */
const LADDER = [1000, 2000, 3000, 4000, 5000] as const
const TAIL_MS = 5000
const SLOW_AFTER_ATTEMPTS = 12
const SLOW_MS = 30000

export function ladderDelay(attempt: number): number {
  if (attempt < LADDER.length) return LADDER[attempt]
  return attempt < SLOW_AFTER_ATTEMPTS ? TAIL_MS : SLOW_MS
}

/** Spread simultaneous reattaches (many tabs on one host wake together). */
export function withJitter(delayMs: number): number {
  return Math.round(delayMs + Math.random() * delayMs * 0.25)
}
