import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SessionStatus } from '../../../shared/types'
import { clampOverscroll, type TerminalSettings } from '../lib/terminalSettings'
import { attachTerminalClipboard } from '../lib/xtermClipboard'
import { applyTerminalSettings, createTerminal, LINE_HEIGHT } from '../lib/xtermSetup'

interface Props {
  sessionId: string
  connectionId: string
  retries: number
  active: boolean
  password?: string
  command?: string
  settings: TerminalSettings
  onStatus: (sessionId: string, status: SessionStatus) => void
}

export function TerminalView({
  sessionId,
  connectionId,
  retries,
  active,
  password,
  command,
  settings,
  onStatus
}: Props) {
  // The outer host owns the scroll in overscroll mode; the inner host is where
  // xterm mounts and is sized to overscroll× the visible height.
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // latest settings for the once-mounted creation effect to read
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Latest connect args, so the reconnect button can re-dial with same params.
  const connectArgsRef = useRef({ connectionId, retries, password, command })
  connectArgsRef.current = { connectionId, retries, password, command }
  // When the session ends (e.g. a tmux detach), show a reattach overlay.
  const [ended, setEnded] = useState<{ kind: 'closed' | 'error'; msg: string } | null>(null)

  // Overscroll bookkeeping: whether the view is pinned to the bottom, and a
  // guard so our own programmatic scrolls don't read as the user scrolling away.
  const stuckRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const roRafRef = useRef(0)
  // xterm's grid element, cached after open() to measure the true row height.
  const screenElRef = useRef<HTMLElement | null>(null)

  // xterm's *actual* rendered row height in CSS px. Prefer the render service's
  // exact device-derived value (what xterm laid the grid out with); fall back to
  // measuring the grid element, then to an estimate. A computed
  // ceil(fontSize×lineHeight) drifts a fraction of a pixel per row, which over a
  // tall grid compounds to several rows of pin error.
  const cellHeight = useCallback(() => {
    const term = termRef.current
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const css = (term as any)?._core?._renderService?.dimensions?.css?.cell?.height
    if (typeof css === 'number' && css > 0) return css
    const screen = screenElRef.current
    const rows = term?.rows ?? 0
    if (screen && rows > 0 && screen.offsetHeight > 0) return screen.offsetHeight / rows
    return Math.max(1, Math.ceil(settingsRef.current.fontSize * LINE_HEIGHT))
  }, [])

  // Pin the view to the true bottom of the scroll content (the end of the
  // output). This target is constant — it doesn't depend on where the cursor
  // momentarily sits during a repaint — so streaming output never jumps: the
  // grid just scrolls under a fixed viewport, exactly like a normal terminal.
  // No-op unless overscroll is on and we're pinned.
  const stickToBottom = useCallback((force = false) => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (clampOverscroll(settingsRef.current.overscroll) <= 1) return
    if (!force && !stuckRef.current) return
    const target = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    // Skip sub-pixel corrections so the view never jitters.
    if (Math.abs(scroll.scrollTop - target) <= 1) return
    programmaticScrollRef.current = true
    scroll.scrollTop = target
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  // Size the inner grid to overscroll× the visible height, then refit xterm so
  // the right (tall) row count is computed. Callers push that to the PTY.
  const fitToHeight = useCallback(() => {
    const scroll = scrollRef.current
    const inner = containerRef.current
    const fit = fitRef.current
    if (!scroll || !inner || !fit) return
    const factor = clampOverscroll(settingsRef.current.overscroll)
    inner.style.height = `${Math.max(1, scroll.clientHeight) * factor}px`
    try {
      fit.fit()
    } catch {
      /* ignore mid-teardown fit */
    }
  }, [])

  const layout = useCallback(() => {
    fitToHeight()
    const term = termRef.current
    if (term) {
      try {
        window.api.resize(sessionId, term.cols, term.rows)
      } catch {
        /* ignore mid-teardown resize */
      }
    }
    stickToBottom()
  }, [sessionId, fitToHeight, stickToBottom])

  const reconnect = useCallback(() => {
    const term = termRef.current
    if (!term) return
    setEnded(null)
    // Drop any session still held under this id in the main process before
    // re-dialing, so the fresh connect never races a stale client/stream.
    window.api.closeSession(sessionId)
    term.reset()
    const a = connectArgsRef.current
    void window.api.connect({
      sessionId,
      connectionId: a.connectionId,
      cols: term.cols,
      rows: term.rows,
      retries: a.retries,
      password: a.password,
      command: a.command
    })
    term.focus()
  }, [sessionId])

  // Create the terminal + SSH session exactly once per sessionId.
  useEffect(() => {
    const scroll = scrollRef.current!
    const host = containerRef.current!
    // Give the host its initial (possibly tall) height before opening xterm so
    // the first fit reports the right row count to connect().
    host.style.height = `${Math.max(1, scroll.clientHeight) * clampOverscroll(settingsRef.current.overscroll)}px`

    const { term, fit: fitAddon } = createTerminal(settingsRef.current, host, { fit: true })
    const fit = fitAddon!
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    screenElRef.current = host.querySelector('.xterm-screen')

    term.onData((d) => window.api.sendInput(sessionId, d))
    const offRender = term.onRender(() => stickToBottom())

    // Copy-on-select, copy/paste keys, right/middle-click paste, OSC 52 writes.
    const detachClipboard = attachTerminalClipboard(term, host)

    // Overscroll scroll plumbing. Let the browser scroll the outer host natively
    // (so it keeps its smooth/inertial feel) — we only stop xterm from also
    // seeing the wheel, since in the alt-screen (e.g. under tmux) it would
    // preventDefault and translate the wheel into arrow keys, which both kills
    // the native scroll and leaks keystrokes into tmux. The inner viewport is
    // made non-scrollable in CSS so the native scroll lands on the outer host.
    const onWheel = (e: WheelEvent): void => {
      if (clampOverscroll(settingsRef.current.overscroll) <= 1) return
      e.stopPropagation()
    }
    const onScroll = (): void => {
      if (programmaticScrollRef.current) return
      stuckRef.current = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - cellHeight()
    }
    scroll.addEventListener('wheel', onWheel, { capture: true, passive: true })
    scroll.addEventListener('scroll', onScroll, { passive: true })

    const offData = window.api.onData((sid, data) => {
      if (sid === sessionId) term.write(data)
    })
    const offStatus = window.api.onStatus((sid, status) => {
      if (sid !== sessionId) return
      onStatus(sessionId, status)
      if (status.kind === 'connecting' || status.kind === 'ready') {
        setEnded(null)
      } else if (status.kind === 'retrying') {
        term.writeln(`\r\n\x1b[33m[retrying in ${Math.round(status.delayMs / 1000)}s: ${status.error}]\x1b[0m`)
      } else if (status.kind === 'error') {
        term.writeln(`\r\n\x1b[31m[error: ${status.message}]\x1b[0m`)
        setEnded({ kind: 'error', msg: status.message })
      } else if (status.kind === 'closed') {
        term.writeln(`\r\n\x1b[90m[session closed]\x1b[0m`)
        setEnded({ kind: 'closed', msg: '' })
      }
    })

    void window.api.connect({
      sessionId,
      connectionId,
      cols: term.cols,
      rows: term.rows,
      retries,
      password,
      command
    })

    // Watch the visible host (not the tall inner one) so a window/pane resize
    // re-derives the tall height; rAF-coalesce bursts to limit PTY resize churn.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRafRef.current)
      roRafRef.current = requestAnimationFrame(() => layout())
    })
    ro.observe(scroll)

    return () => {
      offData()
      offStatus()
      offRender.dispose()
      cancelAnimationFrame(roRafRef.current)
      ro.disconnect()
      scroll.removeEventListener('wheel', onWheel, { capture: true })
      scroll.removeEventListener('scroll', onScroll)
      detachClipboard()
      window.api.closeSession(sessionId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Apply live setting changes (font / cursor / overscroll) and re-layout.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyTerminalSettings(term, settings)
    layout()
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
    settings.overscroll,
    sessionId,
    layout
  ])

  // Re-fit and focus when this tab becomes the active one.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      layout()
      termRef.current?.focus()
    })
  }, [active, sessionId, layout])

  const isTmux = command?.includes('tmux') ?? false
  const tall = clampOverscroll(settings.overscroll) > 1
  return (
    <div className="relative h-full w-full">
      <div
        ref={scrollRef}
        className={`absolute inset-0 overflow-x-hidden ${
          tall ? 'overscroll-host overflow-y-auto' : 'overflow-hidden'
        }`}
      >
        <div ref={containerRef} className="w-full" />
      </div>
      {/* z-30: xterm's canvas layers are position:absolute with z-index up to 10 and
          hoist out of the non-stacking .xterm wrapper, so the overlay must sit above
          them (and above pane chrome) or the reattach button can't be clicked. Stays
          below the z-50 host-key / password modals. */}
      {ended && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink/80 backdrop-blur-sm">
          <div className="panel flex max-w-sm flex-col items-center gap-3 p-6 text-center">
            <div className="eyebrow">
              {ended.kind === 'error' ? 'connection error' : isTmux ? 'detached' : 'session ended'}
            </div>
            <p className="text-sm text-muted">
              {ended.kind === 'error'
                ? ended.msg
                : isTmux
                  ? 'Detached from tmux. Your session is still running on the host.'
                  : 'The shell exited.'}
            </p>
            <button
              onClick={reconnect}
              className="mt-1 rounded-lg bg-signal px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
            >
              {isTmux ? 'Reattach ▸' : 'Reconnect ▸'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
