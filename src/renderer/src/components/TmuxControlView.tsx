import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { SessionStatus, TmuxControlState, TmuxWindowInfo } from '../../../shared/types'
import type { TerminalSettings } from '../lib/terminalSettings'
import { attachTerminalClipboard } from '../lib/xtermClipboard'
import { applyTerminalSettings, createTerminal, measureCell } from '../lib/xtermSetup'

interface Props {
  sessionId: string
  connectionId: string
  /** This leaf is the focused one — its active pane should hold keyboard focus. */
  active: boolean
  /** This leaf is visible (its pane is shown) — drives client sizing. */
  onScreen: boolean
  password?: string
  command?: string
  retries: number
  settings: TerminalSettings
  onStatus: (sessionId: string, status: SessionStatus) => void
}

/** A registry that routes per-pane output, buffering until a pane mounts. */
type PaneWriter = (data: Uint8Array) => void

/**
 * tmux control-mode (`tmux -CC`) view. One SSH stream multiplexes every tmux
 * window/pane; the main process pushes structured output + a window/pane model
 * here, and we draw each pane as its own xterm — so output streams in as normal
 * terminal bytes (native scrollback + native copy, no tmux mouse mode), while
 * tmux still owns persistence. tmux's own keybindings (prefix C-b …) work because
 * keystrokes are forwarded verbatim, so splits/navigation behave as usual and we
 * just render the resulting layout.
 */
export function TmuxControlView({
  sessionId,
  connectionId,
  active,
  onScreen,
  password,
  command,
  retries,
  settings,
  onStatus
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TmuxControlState | null>(null)
  const [ended, setEnded] = useState<{ kind: 'closed' | 'error'; msg: string } | null>(null)

  // Per-pane output routing. Output can arrive before a pane mounts (the attach
  // repaint), so buffer by pane id until its writer registers.
  const writers = useRef(new Map<string, PaneWriter>())
  const buffers = useRef(new Map<string, Uint8Array[]>())

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onScreenRef = useRef(onScreen)
  onScreenRef.current = onScreen
  const connectArgsRef = useRef({ connectionId, retries, password, command })
  connectArgsRef.current = { connectionId, retries, password, command }
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  const registerPane = useCallback((paneId: string, write: PaneWriter): (() => void) => {
    writers.current.set(paneId, write)
    const queued = buffers.current.get(paneId)
    if (queued) {
      buffers.current.delete(paneId)
      for (const d of queued) write(d)
    }
    return () => {
      if (writers.current.get(paneId) === write) writers.current.delete(paneId)
    }
  }, [])

  // Measure the pane area, convert to a tmux cell grid, and push it as this
  // client's size (only while on-screen, to avoid churn when parked hidden).
  const pushSize = useCallback(() => {
    const el = areaRef.current
    if (!el || !onScreenRef.current) return
    const { cw, ch } = measureCell(settingsRef.current)
    const cols = Math.max(1, Math.floor(el.clientWidth / cw))
    const rows = Math.max(1, Math.floor(el.clientHeight / ch))
    if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return
    lastSizeRef.current = { cols, rows }
    window.api.resize(sessionId, cols, rows)
  }, [sessionId])

  const reconnect = useCallback(() => {
    setEnded(null)
    setState(null)
    writers.current.clear()
    buffers.current.clear()
    lastSizeRef.current = { cols: 0, rows: 0 }
    window.api.closeSession(sessionId)
    const a = connectArgsRef.current
    const el = areaRef.current
    const { cw, ch } = measureCell(settingsRef.current)
    const cols = el ? Math.max(1, Math.floor(el.clientWidth / cw)) : 80
    const rows = el ? Math.max(1, Math.floor(el.clientHeight / ch)) : 24
    void window.api.connect({
      sessionId,
      connectionId: a.connectionId,
      cols,
      rows,
      retries: a.retries,
      password: a.password,
      command: a.command,
      control: true
    })
  }, [sessionId])

  // Subscribe + connect exactly once per sessionId.
  useEffect(() => {
    const offOutput = window.api.onTmuxOutput((sid, paneId, data) => {
      if (sid !== sessionId) return
      const w = writers.current.get(paneId)
      if (w) {
        w(data)
        return
      }
      const queued = buffers.current.get(paneId)
      if (queued) queued.push(data)
      else buffers.current.set(paneId, [data])
    })
    const offWindows = window.api.onTmuxWindows((sid, next) => {
      if (sid === sessionId) setState(next)
    })
    const offStatus = window.api.onStatus((sid, status) => {
      if (sid !== sessionId) return
      onStatus(sessionId, status)
      if (status.kind === 'connecting' || status.kind === 'ready') setEnded(null)
      else if (status.kind === 'error') setEnded({ kind: 'error', msg: status.message })
      else if (status.kind === 'closed') setEnded({ kind: 'closed', msg: '' })
    })

    const el = areaRef.current
    const { cw, ch } = measureCell(settingsRef.current)
    const cols = el && el.clientWidth ? Math.max(1, Math.floor(el.clientWidth / cw)) : 80
    const rows = el && el.clientHeight ? Math.max(1, Math.floor(el.clientHeight / ch)) : 24
    lastSizeRef.current = { cols, rows }
    void window.api.connect({
      sessionId,
      connectionId,
      cols,
      rows,
      retries,
      password,
      command,
      control: true
    })

    const ro = new ResizeObserver(() => pushSize())
    if (areaRef.current) ro.observe(areaRef.current)

    return () => {
      offOutput()
      offWindows()
      offStatus()
      ro.disconnect()
      window.api.closeSession(sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-push size when shown or when the font metrics change.
  useEffect(() => {
    if (onScreen) requestAnimationFrame(pushSize)
  }, [onScreen, settings.fontFamily, settings.fontSize, pushSize])

  const windows = state?.windows ?? []
  const activeWindowId = state?.activeWindow
  const activeWindow = windows.find((w) => w.windowId === activeWindowId) ?? windows.find((w) => w.active)
  const focusedPane = activeWindow?.activePane

  // Render every pane across every window (kept mounted so content persists), but
  // only the active window's panes are visible.
  const allPanes = useMemo(
    () => windows.flatMap((w) => w.panes.map((p) => ({ win: w, pane: p }))),
    [windows]
  )

  const isReady = windows.length > 0

  return (
    <div className="flex h-full w-full flex-col bg-ink">
      <WindowStrip
        windows={windows}
        activeId={activeWindow?.windowId}
        onSelect={(id) => window.api.tmuxSelectWindow(sessionId, id)}
        onNew={() => window.api.tmuxNewWindow(sessionId)}
      />
      <div ref={areaRef} className="relative min-h-0 flex-1">
        {allPanes.map(({ win, pane }) => {
          const visible = win.windowId === activeWindow?.windowId
          const isActivePane = visible && pane.paneId === focusedPane
          const cols = win.cols || 1
          const rows = win.rows || 1
          return (
            <div
              key={pane.paneId}
              className="absolute p-px"
              style={{
                left: `${(100 * pane.x) / cols}%`,
                top: `${(100 * pane.y) / rows}%`,
                width: `${(100 * pane.w) / cols}%`,
                height: `${(100 * pane.h) / rows}%`,
                visibility: visible ? 'visible' : 'hidden'
              }}
            >
              <div
                className={`h-full w-full overflow-hidden rounded-sm ring-1 ${
                  isActivePane ? 'ring-signal/70' : 'ring-line/50'
                }`}
              >
                <TmuxPane
                  sessionId={sessionId}
                  paneId={pane.paneId}
                  cols={pane.w}
                  rows={pane.h}
                  focused={active && isActivePane}
                  settings={settings}
                  register={registerPane}
                  onSelect={() => window.api.tmuxSelectPane(sessionId, pane.paneId)}
                />
              </div>
            </div>
          )
        })}

        {!isReady && !ended && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            Attaching tmux (control mode)…
          </div>
        )}
      </div>

      {ended && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink/80 backdrop-blur-sm">
          <div className="panel flex max-w-sm flex-col items-center gap-3 p-6 text-center">
            <div className="eyebrow">{ended.kind === 'error' ? 'connection error' : 'detached'}</div>
            <p className="text-sm text-muted">
              {ended.kind === 'error'
                ? ended.msg
                : 'Detached from tmux. Your session is still running on the host.'}
            </p>
            <button
              onClick={reconnect}
              className="mt-1 rounded-lg bg-signal px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
            >
              Reattach ▸
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function WindowStrip({
  windows,
  activeId,
  onSelect,
  onNew
}: {
  windows: TmuxWindowInfo[]
  activeId?: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  if (!windows.length) return null
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-2 py-1">
      {windows.map((w) => (
        <button
          key={w.windowId}
          onClick={() => onSelect(w.windowId)}
          className={`shrink-0 rounded px-2.5 py-1 text-xs transition-colors ${
            w.windowId === activeId ? 'bg-signal/20 text-signal' : 'text-muted hover:bg-elevated/60 hover:text-fg'
          }`}
          title={w.windowId}
        >
          {w.name || w.windowId}
        </button>
      ))}
      <button
        onClick={onNew}
        className="ml-0.5 shrink-0 rounded px-2 py-1 text-xs text-faint hover:bg-elevated/60 hover:text-fg"
        title="New window"
      >
        +
      </button>
    </div>
  )
}

function TmuxPane({
  sessionId,
  paneId,
  cols,
  rows,
  focused,
  settings,
  register,
  onSelect
}: {
  sessionId: string
  paneId: string
  cols: number
  rows: number
  focused: boolean
  settings: TerminalSettings
  register: (paneId: string, write: PaneWriter) => () => void
  onSelect: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Create the xterm for this pane exactly once.
  useEffect(() => {
    const { term } = createTerminal(settingsRef.current, containerRef.current!)
    termRef.current = term
    term.onData((d) => window.api.tmuxSendKeys(sessionId, paneId, d))
    const detachClipboard = attachTerminalClipboard(term, containerRef.current!)
    const unregister = register(paneId, (data) => term.write(data))
    return () => {
      unregister()
      detachClipboard()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, paneId])

  // Match the xterm grid to tmux's reported cell size for this pane (tmux owns
  // the layout in control mode, so we never FitAddon — we follow tmux).
  useEffect(() => {
    const term = termRef.current
    if (!term || cols < 1 || rows < 1) return
    try {
      term.resize(cols, rows)
    } catch {
      /* ignore mid-teardown resize */
    }
  }, [cols, rows])

  useEffect(() => {
    if (termRef.current) applyTerminalSettings(termRef.current, settings)
  }, [settings.fontFamily, settings.fontSize, settings.cursorStyle, settings.cursorBlink, settings.scrollback, settings])

  // Focus this pane's terminal when it's the focused leaf's active pane.
  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  return <div ref={containerRef} className="h-full w-full" onMouseDown={onSelect} />
}
