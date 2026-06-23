import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SessionStatus } from '../../../shared/types'
import type { TerminalSettings } from '../lib/terminalSettings'
import { attachTerminalClipboard } from '../lib/xtermClipboard'
import { applyTerminalSettings, createTerminal } from '../lib/xtermSetup'

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
    const { term, fit: fitAddon } = createTerminal(settingsRef.current, containerRef.current!, { fit: true })
    const fit = fitAddon!
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData((d) => window.api.sendInput(sessionId, d))

    // Copy-on-select, copy/paste keys, right/middle-click paste, OSC 52 writes.
    const detachClipboard = attachTerminalClipboard(term, containerRef.current!)

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

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.api.resize(sessionId, term.cols, term.rows)
      } catch {
        /* ignore mid-teardown resize */
      }
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      offData()
      offStatus()
      ro.disconnect()
      detachClipboard()
      window.api.closeSession(sessionId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Apply live setting changes (font size / cursor) and refit.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyTerminalSettings(term, settings)
    try {
      fitRef.current?.fit()
      window.api.resize(sessionId, term.cols, term.rows)
    } catch {
      /* ignore */
    }
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
    sessionId
  ])

  // Re-fit and focus when this tab becomes the active one.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.focus()
        if (termRef.current) window.api.resize(sessionId, termRef.current.cols, termRef.current.rows)
      } catch {
        /* ignore */
      }
    })
  }, [active, sessionId])

  const isTmux = command?.includes('tmux') ?? false
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
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
