import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SessionStatus } from '../../../shared/types'
import { resolveFontStack, type TerminalSettings } from '../lib/terminalSettings'

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
    const term = new XTerm({
      fontFamily: resolveFontStack(settingsRef.current.fontFamily),
      fontSize: settingsRef.current.fontSize,
      lineHeight: 1.2,
      cursorBlink: settingsRef.current.cursorBlink,
      cursorStyle: settingsRef.current.cursorStyle,
      scrollback: settingsRef.current.scrollback,
      allowProposedApi: true,
      theme: {
        background: '#0c0f15',
        foreground: '#e8edf3',
        cursor: '#46d98a',
        cursorAccent: '#0c0f15',
        selectionBackground: 'rgba(124, 160, 214, 0.40)',
        selectionInactiveBackground: 'rgba(124, 160, 214, 0.22)',
        black: '#0b0e14',
        brightBlack: '#5a6473'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Ctrl + left-click opens a URL in the OS browser (validated http/https in
    // main). Plain clicks and right-clicks never open it.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey && event.button === 0) window.api.openExternal(uri)
      })
    )
    term.open(containerRef.current!)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* WebGL unavailable — falls back to canvas/DOM renderer */
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData((d) => window.api.sendInput(sessionId, d))

    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) window.api.clipboardWrite(sel)
    }
    const paste = (): void => {
      const text = window.api.clipboardRead()
      if (text) term.paste(text) // bracketed-paste aware: multi-line stays inert
    }

    // Copy-on-select — selecting text (drag, or Shift+drag inside mouse-mode
    // apps like htop) copies it to the clipboard automatically.
    term.onSelectionChange(copySelection)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      // Ctrl+Shift+C / Ctrl+Shift+V — explicit copy / paste.
      if (e.ctrlKey && e.shiftKey && k === 'c') {
        copySelection()
        return false
      }
      if (e.ctrlKey && e.shiftKey && k === 'v') {
        paste()
        return false
      }
      // Ctrl+C: copy if text is selected, otherwise let it through as SIGINT.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c' && term.hasSelection()) {
        copySelection()
        term.clearSelection() // so the next Ctrl+C interrupts as usual
        return false
      }
      return true
    })

    const el = containerRef.current!
    // Right-click and middle-click paste (the selection is already auto-copied).
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      paste()
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 1) {
        e.preventDefault()
        paste()
      }
    }
    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('mousedown', onMouseDown)

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
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('mousedown', onMouseDown)
      window.api.closeSession(sessionId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Apply live setting changes (font size / cursor) and refit.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = resolveFontStack(settings.fontFamily)
    term.options.fontSize = settings.fontSize
    term.options.cursorStyle = settings.cursorStyle
    term.options.cursorBlink = settings.cursorBlink
    term.options.scrollback = settings.scrollback
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
      {ended && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink/80 backdrop-blur-sm">
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
