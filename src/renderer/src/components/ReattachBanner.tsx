import { useEffect, useState } from 'react'

interface Props {
  sessionId: string
  /** Which rung of the ladder we're on (1-based). */
  attempt: number
  /** How long the main process will wait before this attempt dials. */
  delayMs: number
  /** Why the session dropped, as far as we can tell. */
  error: string
}

/**
 * The notice shown while a dropped tmux session reattaches itself.
 *
 * Deliberately a thin strip over the terminal rather than the blocking overlay:
 * the pane still holds the screen as it was, which is the whole point of the
 * automatic reattach — the user watches it come back rather than being asked to
 * click. Nothing here is written *into* the terminal: mid-session tmux lives in
 * xterm's alternate buffer, and a writeln would permanently scribble over the
 * frozen frame the reattach is about to restore.
 */
export function ReattachBanner({ sessionId, attempt, delayMs, error }: Props) {
  // Counted down locally. Ticking this through App state would re-render every
  // open tab once a second for as long as a host is down.
  const [left, setLeft] = useState(delayMs)
  useEffect(() => {
    setLeft(delayMs)
    const started = Date.now()
    const id = setInterval(() => setLeft(Math.max(0, delayMs - (Date.now() - started))), 250)
    return () => clearInterval(id)
  }, [delayMs, attempt])

  const secs = Math.ceil(left / 1000)
  return (
    // pointer-events-none so a click meant for the terminal underneath still
    // lands; the Stop button opts back in.
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center p-2">
      <div className="panel animate-rise flex items-center gap-3 px-3 py-1.5 shadow-lg shadow-ink/40">
        <span className="animate-glow text-signal">⟳</span>
        <span className="text-xs text-fg">
          Reconnecting{secs > 0 ? ` in ${secs}s` : '…'}
          <span className="text-faint"> · attempt {attempt}</span>
        </span>
        {error && <span className="max-w-[22rem] truncate font-mono text-[11px] text-faint">{error}</span>}
        <button
          onClick={() => window.api.stopReattach(sessionId)}
          className="pointer-events-auto rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg"
        >
          Stop
        </button>
      </div>
    </div>
  )
}
