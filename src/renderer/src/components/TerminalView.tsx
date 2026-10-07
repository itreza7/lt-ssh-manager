import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { CloseReason, SessionStatus, TmuxIntent } from '../../../shared/types'
import { clampOverscroll, type TerminalSettings } from '../lib/terminalSettings'
import { attachAgentSignal, type AgentSignal } from '../lib/xtermAgentSignal'
import { attachTerminal } from '../lib/xtermAttach'
import type { TerminalSearch } from '../lib/xtermSearch'
import { applyTerminalSettings, createTerminal, LINE_HEIGHT, measureCell } from '../lib/xtermSetup'
import { useTerminalFind } from '../lib/useTerminalFind'
import { tmuxReattachCommand } from '../lib/tmux'
import { useDropUpload } from '../lib/useDropUpload'
import { DropUploadLayer } from './DropUploadLayer'
import { ReattachBanner } from './ReattachBanner'
import { TerminalFindBar } from './TerminalFindBar'

interface Props {
  sessionId: string
  connectionId: string
  retries: number
  active: boolean
  password?: string
  command?: string
  /** Set when `command` attaches to tmux; enables the automatic reattach. */
  tmux?: TmuxIntent
  settings: TerminalSettings
  onStatus: (sessionId: string, status: SessionStatus) => void
  /** The remote set its window title — used as the tab's live label. */
  onTitle?: (sessionId: string, title: string) => void
  /**
   * Something in this session asked for a human. `onScreen` is the tmux-control
   * case and is left unset here: a plain terminal *is* its leaf, so if the leaf
   * is showing, so is the thing that rang.
   */
  onAgentSignal?: (sessionId: string, signal: AgentSignal, onScreen?: boolean) => void
}

export function TerminalView({
  sessionId,
  connectionId,
  retries,
  active,
  password,
  command,
  tmux,
  settings,
  onStatus,
  onTitle,
  onAgentSignal
}: Props) {
  // The outer host owns the scroll in overscroll mode; the inner host is where
  // xterm mounts and is sized to overscroll× the visible height.
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<TerminalSearch | null>(null)
  // latest settings for the once-mounted creation effect to read
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Latest connect args, so the reconnect button can re-dial with same params.
  const connectArgsRef = useRef({ connectionId, retries, password, command, tmux })
  connectArgsRef.current = { connectionId, retries, password, command, tmux }
  // When the session ends (e.g. a tmux detach), show a reattach overlay.
  const [ended, setEnded] = useState<{
    kind: 'closed' | 'error'
    msg: string
    reason?: CloseReason
  } | null>(null)
  // Set while the main process is reattaching a dropped tmux session by itself.
  const [reattach, setReattach] = useState<{
    attempt: number
    delayMs: number
    error: string
  } | null>(null)
  // Read from event handlers that must not re-subscribe when it changes.
  const reattachingRef = useRef(false)

  // Drop-to-upload. Behind a ref for the same reason as the connect args: the
  // mount-once effect below hands these to attachTerminal and would otherwise
  // pin whichever closures existed at mount.
  const upload = useDropUpload(connectionId, password)
  const uploadRef = useRef(upload)
  uploadRef.current = upload

  // Overscroll bookkeeping: whether the view is pinned to the bottom, and a
  // guard so our own programmatic scrolls don't read as the user scrolling away.
  const stuckRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const roRafRef = useRef(0)
  // Last size sent to the PTY, and the timer that debounces the next one. Ink
  // TUIs (Claude Code) miscount their erase-and-redraw across width changes, so
  // the PTY must see one settled size, not every intermediate layout.
  const lastSentRef = useRef({ cols: 0, rows: 0 })
  const resizeTimerRef = useRef(0)
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

  // Bring a search match into view.
  //
  // Only overscroll needs this. The search addon scrolls xterm's *viewport* to
  // the match, which is the whole story at overscroll 1 — but in overscroll mode
  // the viewport is the tall inner host and the outer host is what scrolls, so
  // xterm can put the match on row 300 of a grid whose visible window is rows
  // 40-70 and consider the job done. Translate the match's row into the outer
  // host's scroll, and only when it is actually off screen, so stepping through
  // matches on one page doesn't drag the view around.
  const revealMatch = useCallback(() => {
    const term = termRef.current
    const scroll = scrollRef.current
    if (!term || !scroll) return
    if (clampOverscroll(settingsRef.current.overscroll) <= 1) return
    const pos = term.getSelectionPosition()
    if (!pos) return
    const h = cellHeight()
    const top = (pos.start.y - term.buffer.active.viewportY) * h
    if (top >= scroll.scrollTop && top + h <= scroll.scrollTop + scroll.clientHeight) return
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    programmaticScrollRef.current = true
    scroll.scrollTop = Math.max(0, Math.min(top - (scroll.clientHeight - h) / 2, max))
    // Reading a match is not watching the tail: unpin, or the next frame of
    // output would yank the view back to the bottom mid-read. Scrolling back
    // down re-pins through the scroll listener, exactly as a manual scroll does.
    stuckRef.current = false
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [cellHeight])

  // Find-in-terminal. One terminal per view, so the target never moves.
  const find = useTerminalFind(
    useCallback(() => {
      const term = termRef.current
      const search = searchRef.current
      return term && search ? { term, search } : null
    }, []),
    revealMatch
  )
  const startFind = find.start
  // Read by the focus effect, which must not re-run when the bar opens.
  const findingRef = useRef(find.open)
  findingRef.current = find.open

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
    // A parked pane is `display: none` and so has no box at all. Measuring one
    // would fit the grid to nothing and push that size to the PTY, reflowing the
    // remote shell's output; skip it. Revealing the pane resizes its box, which
    // fires the ResizeObserver again and lays out at the real size.
    const scroll = scrollRef.current
    if (!scroll || scroll.clientWidth === 0 || scroll.clientHeight === 0) return
    fitToHeight()
    const term = termRef.current
    if (term) {
      const { cols, rows } = term
      const last = lastSentRef.current
      if (cols !== last.cols || rows !== last.rows) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = window.setTimeout(() => {
          const t = termRef.current
          if (!t) return
          const cur = lastSentRef.current
          if (t.cols === cur.cols && t.rows === cur.rows) return
          lastSentRef.current = { cols: t.cols, rows: t.rows }
          try {
            window.api.resize(sessionId, t.cols, t.rows)
          } catch {
            /* ignore mid-teardown resize */
          }
        }, 120)
      }
    }
    stickToBottom()
  }, [sessionId, fitToHeight, stickToBottom])

  const reconnect = useCallback(
    (mode: 'attach' | 'create') => {
      const term = termRef.current
      if (!term) return
      setEnded(null)
      setReattach(null)
      reattachingRef.current = false
      // Drop any session still held under this id in the main process before
      // re-dialing, so the fresh connect never races a stale client/stream.
      window.api.closeSession(sessionId)
      term.reset()
      const a = connectArgsRef.current
      // `a.command` is the tab's original create-or-attach (`tmux new -A`), which is
      // only what the user asked for under the 'gone' overlay's "Start it again".
      // A reattach must not be able to create: running `new -A` against a session
      // that was killed resurrects it as an empty one under the same name, which
      // looks like recovery while silently discarding what was there.
      const command =
        mode === 'attach' && a.tmux ? (tmuxReattachCommand(a.tmux) ?? a.command) : a.command
      // A new pty starts at the size passed here; forget what the old one had.
      window.clearTimeout(resizeTimerRef.current)
      lastSentRef.current = { cols: term.cols, rows: term.rows }
      void window.api.connect({
        sessionId,
        connectionId: a.connectionId,
        cols: term.cols,
        rows: term.rows,
        retries: a.retries,
        password: a.password,
        command,
        tmux: a.tmux
      })
      term.focus()
    },
    [sessionId]
  )

  // Create the terminal + SSH session exactly once per sessionId.
  useEffect(() => {
    const scroll = scrollRef.current!
    const host = containerRef.current!
    // Give the host its initial (possibly tall) height before opening xterm so
    // the first fit reports the right row count to connect().
    host.style.height = `${Math.max(1, scroll.clientHeight) * clampOverscroll(settingsRef.current.overscroll)}px`

    // onFontsReady, not a bare fit(): a corrected local grid is useless if the
    // remote PTY is never told about it, and only layout() (fit + the resize
    // IPC call + stickToBottom) does both. See xtermSetup's createTerminal.
    const { term, fit: fitAddon, search } = createTerminal(settingsRef.current, host, {
      fit: true,
      onFontsReady: () => layout()
    })
    const fit = fitAddon!
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    screenElRef.current = host.querySelector('.xterm-screen')

    // Keystrokes typed while a reattach is in flight are dropped by the main
    // process (no session is held under this id yet). That is deliberate: buffering
    // them would replay a burst into whatever pane tmux happens to restore focus to.
    const send = (d: string): void => window.api.sendInput(sessionId, d)
    term.onData(send)
    const offRender = term.onRender(() => stickToBottom())

    // Clipboard, Shift+Enter encoding, remote-set title, file drops. `send` is shared with onData above so synthesized keys take the
    // same path as typed ones.
    const detachTerminal = attachTerminal(term, host, {
      sendData: send,
      settings: () => settingsRef.current,
      onTitle: (t) => onTitle?.(sessionId, t),
      onFind: startFind,
      onDragFiles: (o) => uploadRef.current.setOver(o),
      onDropFiles: (paths) => uploadRef.current.drop(paths, termRef.current),
      onPasteUpload: () => uploadRef.current.pasteUpload(termRef.current)
    })

    // Attention signals. Separate from attachTerminal because it is purely
    // inbound and control-mode panes want it too, where most of the above
    // doesn't apply.
    const detachSignal = attachAgentSignal(term, (s) => onAgentSignal?.(sessionId, s))

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
      if (status.kind === 'connecting') {
        setEnded(null)
      } else if (status.kind === 'ready') {
        setEnded(null)
        if (reattachingRef.current) {
          reattachingRef.current = false
          setReattach(null)
          // The pane is still showing the pre-drop frame, drawn by a tmux that is
          // now gone. Reset only what would fight the new client — scroll region,
          // pending DEC private modes, active SGR — and let tmux repaint over it.
          // term.reset() would clear the screen to black first, i.e. a visible
          // flash of nothing where the reattach is supposed to be seamless.
          term.write('\x1b[!p\x1b[r\x1b[0m')
          requestAnimationFrame(() => layout())
        }
      } else if (status.kind === 'retrying') {
        term.writeln(`\r\n\x1b[33m[retrying in ${Math.round(status.delayMs / 1000)}s: ${status.error}]\x1b[0m`)
      } else if (status.kind === 'reattaching') {
        // No writeln: see ReattachBanner.
        reattachingRef.current = true
        setEnded(null)
        setReattach({ attempt: status.attempt, delayMs: status.delayMs, error: status.error })
      } else if (status.kind === 'error') {
        setReattach(null)
        reattachingRef.current = false
        term.writeln(`\r\n\x1b[31m[error: ${status.message}]\x1b[0m`)
        setEnded({ kind: 'error', msg: status.message })
      } else if (status.kind === 'closed') {
        const wasReattaching = reattachingRef.current
        setReattach(null)
        reattachingRef.current = false
        // Only annotate the screen for a session that ended while the user was
        // watching it; a failed reattach is explained by the overlay instead.
        if (!wasReattaching) term.writeln(`\r\n\x1b[90m[session closed]\x1b[0m`)
        setEnded({ kind: 'closed', msg: status.detail ?? '', reason: status.reason })
      }
    })

    // Defence in depth against opening the PTY at a size nobody measured. If this
    // pane had no layout box when it mounted, fit() could not have run and
    // term.cols/rows are xterm's construction defaults — and a tmux session sizes
    // itself to its smallest client, so a bogus size here reflows a session the
    // user may be watching in another tab. Derive a size from the window instead,
    // which is at worst close; the ResizeObserver corrects it the moment the pane
    // is laid out. See wrapperStyle() in App.tsx for the parking rule.
    //
    // Wait for the web font first: before it loads, cell sizes are the fallback
    // font's, so the connect size would be wrong and a corrected resize would
    // follow straight away — the double size an Ink TUI redraws badly across.
    let live = true
    void document.fonts.ready.then(() => {
      if (!live) return
      const measured = scroll.clientWidth > 0 && scroll.clientHeight > 0
      if (measured) fitToHeight()
      const { cw, ch } = measureCell(settingsRef.current)
      const cols = measured ? term.cols : Math.max(20, Math.floor(window.innerWidth / cw))
      const rows = measured ? term.rows : Math.max(5, Math.floor(window.innerHeight / ch))
      lastSentRef.current = { cols, rows }
      void window.api.connect({
        sessionId,
        connectionId,
        cols,
        rows,
        retries,
        password,
        command,
        tmux
      })
    })

    // Watch the visible host (not the tall inner one) so a window/pane resize
    // re-derives the tall height; rAF-coalesce bursts to limit PTY resize churn.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRafRef.current)
      roRafRef.current = requestAnimationFrame(() => layout())
    })
    ro.observe(scroll)

    return () => {
      live = false
      window.clearTimeout(resizeTimerRef.current)
      offData()
      offStatus()
      offRender.dispose()
      cancelAnimationFrame(roRafRef.current)
      ro.disconnect()
      scroll.removeEventListener('wheel', onWheel, { capture: true })
      scroll.removeEventListener('scroll', onScroll)
      detachTerminal()
      detachSignal()
      search.dispose()
      searchRef.current = null
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

  // Re-fit and focus when this tab becomes the active one. A parked tab is
  // `display: none`, which drops focus entirely, so coming back has to restore it
  // to *something*: the find bar if it is open, else the terminal.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      layout()
      if (findingRef.current) startFind()
      else termRef.current?.focus()
    })
  }, [active, sessionId, layout, startFind])

  const isTmux = !!tmux
  const tall = clampOverscroll(settings.overscroll) > 1
  // Whether an attach-only recovery is even expressible for this session. It isn't
  // for a legacy name containing '.' or ':' (tmux target separators), and rather
  // than quietly falling back to a command that can create, the overlay says
  // "Start it again" so the label matches what the button will really do.
  const canAttach = !!(tmux && tmuxReattachCommand(tmux))
  // What the overlay says depends on why the session ended: a detach means the
  // work is still on the host, but a session that is *gone* can't be reattached to
  // — offering "Reattach" there would create an empty one under the same name.
  const overlay = ended && {
    eyebrow:
      ended.kind === 'error'
        ? 'connection error'
        : ended.reason === 'gone'
          ? 'session gone'
          : ended.reason === 'unreachable'
            ? 'disconnected'
            : isTmux && ended.reason !== 'exited'
              ? 'detached'
              : 'session ended',
    body:
      ended.kind === 'error'
        ? ended.msg
        : ended.reason === 'gone'
          ? `That tmux session is no longer running on the host.${ended.msg ? ` (${ended.msg})` : ''}`
          : ended.reason === 'unreachable'
            ? `Lost the connection${ended.msg ? `: ${ended.msg}` : ''}.`
            : isTmux && ended.reason !== 'exited'
              ? 'Detached from tmux. Your session is still running on the host.'
              : 'The shell exited.',
    action:
      ended.reason === 'gone' || (isTmux && !canAttach)
        ? 'Start it again ▸'
        : isTmux
          ? 'Reattach ▸'
          : 'Reconnect ▸',
    // 'gone' is the one state where creating is the point; everywhere else a tmux
    // tab recovers with attach-only. A plain shell has no session to preserve, so
    // 'create' there just means "run the tab's command again".
    mode: (ended.reason === 'gone' || !isTmux ? 'create' : 'attach') as 'attach' | 'create'
  }
  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
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
        {overlay && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink/80 backdrop-blur-sm">
            <div className="panel flex max-w-sm flex-col items-center gap-3 p-6 text-center">
              <div className="eyebrow">{overlay.eyebrow}</div>
              <p className="text-sm text-muted">{overlay.body}</p>
              <button
                onClick={() => reconnect(overlay.mode)}
                className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
              >
                {overlay.action}
              </button>
            </div>
          </div>
        )}
        {reattach && <ReattachBanner sessionId={sessionId} {...reattach} />}
        <DropUploadLayer over={upload.over} status={upload.status} onDismiss={upload.dismiss} />
        {find.open && (
          <TerminalFindBar
            focusKey={find.focusKey}
            query={find.query}
            onQuery={find.setQuery}
            flags={find.flags}
            onFlags={find.setFlags}
            results={find.results}
            badPattern={find.badPattern}
            altScreen={find.altScreen}
            onFind={find.find}
            onClose={find.close}
            onBlur={find.blur}
          />
        )}
      </div>
    </div>
  )
}
