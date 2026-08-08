import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentHostScan } from '../../../shared/types'

/** How often the live-agent sweep re-scans, once it is running at all. */
const POLL_MS = 10000

interface UseAgentSessions {
  hosts: AgentHostScan[] | null
  error: string | null
  scanning: boolean
  /** Re-scan now, clearing any hosts latched as refused — the Refresh button. */
  rescan: () => void
}

/**
 * The live tmux-agent sweep, owned independently of whether the Inbox tab
 * happens to be the one on screen.
 *
 * `enabled` gates the whole effect rather than just the interval, because
 * hooks cannot be called conditionally — App.tsx calls this hook
 * unconditionally on every render and passes whether the inbox has ever been
 * opened this session (the same condition that decides whether AgentInbox
 * itself is mounted at all). Once that flips true it stays true for the rest
 * of the session, so in practice the poll starts on first open and keeps
 * running every POLL_MS from then on — including while some other tab is the
 * one visible — rather than stopping the moment the user looks away. An agent
 * that starts waiting for you while you are in a terminal tab should already
 * be known about the moment you switch back, not ten seconds after.
 *
 * `enabled` going back to false is handled defensively (the interval is
 * cleared like any other effect cleanup) even though nothing in the app
 * exercises that path today.
 */
export function useAgentSessions(enabled: boolean): UseAgentSessions {
  const [hosts, setHosts] = useState<AgentHostScan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  // One scan in flight at a time. The poll interval is shorter than a sweep
  // across a slow host takes, so without this a stalled host would pile up
  // overlapping scans — each holding a pooled connection open — until it healed.
  const busy = useRef(false)

  const scan = useCallback(async (retryFailed = false): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setScanning(true)
    try {
      setHosts(await window.api.agentsScan(retryFailed))
      setError(null)
    } catch (e) {
      // Only the sweep itself failing lands here; a single unreachable host is
      // reported inside the result and never throws.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busy.current = false
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void scan()
    const t = setInterval(() => void scan(), POLL_MS)
    return () => clearInterval(t)
  }, [enabled, scan])

  const rescan = useCallback((): void => {
    // Explicitly asking is what clears the main process's memory of hosts
    // that refused us; the ten-second poll must not, or it would be hammering
    // them again by another name.
    void scan(true)
  }, [scan])

  return { hosts, error, scanning, rescan }
}
