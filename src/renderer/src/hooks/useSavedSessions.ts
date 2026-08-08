import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResumeHostScan } from '../../../shared/types'
import { RESUME_LIMIT } from '../lib/resume'

interface UseSavedSessions {
  saved: ResumeHostScan[] | null
  error: string | null
  scanning: boolean
  /** Re-scan from the first page, clearing any hosts latched as refused — the Rescan button. */
  rescan: () => void
  /** Ask for the next page after what's already loaded — the "Load N more" button. */
  loadMore: () => void
}

/**
 * Fold a newly fetched page into the pages already on screen.
 *
 * Keyed by transcript id and first-wins, which is not defensive tidying: the host
 * orders by mtime, so a live agent writing to its transcript between two page
 * requests moves that row to the top and pushes the boundary down — page two then
 * repeats a row page one already showed. The reverse also happens and is accepted:
 * a row can be stepped over, and it is by definition an older one, which Rescan
 * recovers. Counts and errors come from the newer response, since they describe the
 * host as it is now; rows are kept because they were true when they were read.
 */
function mergeSaved(prev: ResumeHostScan[], next: ResumeHostScan[]): ResumeHostScan[] {
  const before = new Map(prev.map((h) => [h.connectionId, h]))
  return next.map((h) => {
    const had = before.get(h.connectionId)
    if (!had) return h
    const seen = new Set(had.sessions.map((s) => s.id))
    return { ...h, sessions: [...had.sessions, ...h.sessions.filter((s) => !seen.has(s.id))] }
  })
}

/**
 * The saved-session sweep (transcripts on disk, not live processes), owned
 * independently of whether the Home tab happens to be the one on screen — the
 * same lift useAgentSessions already did for the live tmux sweep, so the command
 * palette can show saved sessions even when Home has never been opened.
 *
 * Unlike useAgentSessions this does not poll: a transcript on disk changes when
 * somebody works in it, not every ten seconds, so it scans once when `enabled`
 * first goes true and then only when asked (`rescan`/`loadMore`). The once-only
 * scan is latched on a ref rather than on `saved === null`, since the effect
 * itself is what sets `saved` — reading it here would re-run this on every
 * response and stop only because the value had stopped being null, a latch made
 * out of a coincidence.
 */
export function useSavedSessions(enabled: boolean): UseSavedSessions {
  const [saved, setSaved] = useState<ResumeHostScan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [offset, setOffset] = useState(0)
  const busy = useRef(false)
  const once = useRef(false)

  const scan = useCallback(
    async (opts?: { retryFailed?: boolean; more?: boolean }): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setScanning(true)
      // Rescan starts over rather than reloading every page: the pages are a trail of
      // where the list was, and a fresh look at a host is the thing the button offers.
      const next = opts?.more ? offset + RESUME_LIMIT : 0
      try {
        const page = await window.api.resumeScan({ retryFailed: opts?.retryFailed, offset: next })
        setSaved((prev) => (next > 0 && prev ? mergeSaved(prev, page) : page))
        setOffset(next)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy.current = false
        setScanning(false)
      }
    },
    [offset]
  )

  useEffect(() => {
    if (!enabled || once.current) return
    once.current = true
    void scan()
  }, [enabled, scan])

  const rescan = useCallback((): void => {
    // Explicitly asking is what clears the main process's memory of hosts that
    // refused us; nothing here runs on a timer that would be hammering them
    // again by another name.
    void scan({ retryFailed: true })
  }, [scan])

  const loadMore = useCallback((): void => {
    void scan({ more: true })
  }, [scan])

  return { saved, error, scanning, rescan, loadMore }
}
