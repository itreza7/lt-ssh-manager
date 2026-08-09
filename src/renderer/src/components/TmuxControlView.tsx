import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type {
  CloseReason,
  SessionStatus,
  TmuxControlState,
  TmuxIntent,
  TmuxWindowInfo
} from '../../../shared/types'
import type { TerminalSettings } from '../lib/terminalSettings'
import { attachAgentSignal, type AgentSignal } from '../lib/xtermAgentSignal'
import { attachTerminal, sendComposed } from '../lib/xtermAttach'
import type { FindTarget } from '../lib/useTerminalFind'
import { useTerminalFind } from '../lib/useTerminalFind'
import { applyTerminalSettings, createTerminal, measureCell } from '../lib/xtermSetup'
import { tmuxReattachCommand } from '../lib/tmux'
import { useDropUpload } from '../lib/useDropUpload'
import { DropHint, DropStatusBar } from './DropUploadLayer'
import { PromptComposer } from './PromptComposer'
import { ReattachBanner } from './ReattachBanner'
import { TerminalFindBar } from './TerminalFindBar'

interface Props {
  sessionId: string
  connectionId: string
  /** This leaf is the focused one — its active pane should hold keyboard focus. */
  active: boolean
  /** This leaf is visible (its pane is shown) — drives client sizing. */
  onScreen: boolean
  password?: string
  command?: string
  /** Which tmux session this is attached to; enables the automatic reattach. */
  tmux?: TmuxIntent
  retries: number
  settings: TerminalSettings
  onStatus: (sessionId: string, status: SessionStatus) => void
  /**
   * A pane in this tab asked for a human. `onScreen` is false when that pane
   * sits in a tmux window the user isn't currently looking at.
   */
  onAgentSignal?: (sessionId: string, signal: AgentSignal, onScreen?: boolean) => void
  /** Stable across a reconnect *and* a restart — keys the persisted per-pane drafts on disk. */
  draftKey: string
  /** The per-pane drafts last persisted for this tab, loaded before mount so they aren't lost on restart. */
  initialDrafts?: Record<string, string>
}

/** A registry that routes per-pane output, buffering until a pane mounts. */
type PaneWriter = (data: Uint8Array) => void

/**
 * What a mounted pane hands back to the view. The terminal itself is part of it
 * because sending isn't only "write bytes to the wire": bracketed paste is a
 * mode xterm tracks per instance, and the composer needs the pane's own terminal
 * both to wrap its text correctly and to hand focus back afterwards.
 */
interface PaneHandle {
  write: PaneWriter
  term: XTerm
}

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
  tmux,
  retries,
  settings,
  onStatus,
  onAgentSignal,
  draftKey,
  initialDrafts
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TmuxControlState | null>(null)
  const [ended, setEnded] = useState<{
    kind: 'closed' | 'error'
    msg: string
    reason?: CloseReason
  } | null>(null)
  // Set while the main process reattaches a dropped session on its own.
  const [reattach, setReattach] = useState<{
    attempt: number
    delayMs: number
    error: string
  } | null>(null)
  const reattachingRef = useRef(false)

  // Per-pane output routing. Output can arrive before a pane mounts (the attach
  // repaint), so buffer by pane id until its writer registers.
  const writers = useRef(new Map<string, PaneHandle>())
  const buffers = useRef(new Map<string, Uint8Array[]>())

  // Prompt composer. `target` is the pane being drafted for and doubles as the
  // open flag; drafts are kept per pane, so moving between panes never hands one
  // pane's half-written prompt to another.
  const [target, setTarget] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts ?? {})
  const [bracketed, setBracketed] = useState(true)

  // Local autosave, independent of the SSH connection: all panes' drafts are
  // serialized as one JSON blob under this tab's key (an empty record persists
  // as '', which the store treats as "delete"). Survives disconnects, crashes,
  // and restarts; cleared on send/discard (which empty a pane's entry) or on
  // explicit tab close (handled by the caller via draftsSet(draftKey, '')).
  useEffect(() => {
    const t = setTimeout(() => {
      const value = Object.keys(drafts).length ? JSON.stringify(drafts) : ''
      void window.api.draftsSet(draftKey, value)
    }, 300)
    return () => clearTimeout(t)
  }, [drafts, draftKey])
  // See TerminalView: bumped on every request to compose so the textarea is
  // re-focused even when the panel was already open. Stable dispatch, because
  // openComposer is captured by each pane's mount-once effect.
  const [focusKey, bumpFocus] = useReducer((n: number) => n + 1, 0)

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onScreenRef = useRef(onScreen)
  onScreenRef.current = onScreen
  const connectArgsRef = useRef({ connectionId, retries, password, command, tmux })
  connectArgsRef.current = { connectionId, retries, password, command, tmux }
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  const registerPane = useCallback((paneId: string, handle: PaneHandle): (() => void) => {
    writers.current.set(paneId, handle)
    const queued = buffers.current.get(paneId)
    if (queued) {
      buffers.current.delete(paneId)
      for (const d of queued) handle.write(d)
    }
    return () => {
      if (writers.current.get(paneId) === handle) writers.current.delete(paneId)
    }
  }, [])

  const openComposer = useCallback((paneId: string) => {
    // Sampled per pane at open time: one window can hold a shell and an agent,
    // and only one of them keeps the newlines.
    setBracketed(writers.current.get(paneId)?.term.modes.bracketedPasteMode ?? false)
    setTarget(paneId)
    bumpFocus()
  }, [])

  const closeComposer = useCallback((paneId: string | null) => {
    setTarget(null)
    if (paneId) writers.current.get(paneId)?.term.focus()
  }, [])

  // Drop-to-upload. The status is per tab (one batch at a time), but the hover
  // affordance is per pane — a tab can show four terminals at once and "drop
  // here" has to mean one of them. Behind a ref because each pane's mount-once
  // effect captures these and would otherwise pin the closures from mount.
  const upload = useDropUpload(connectionId, password)
  const uploadRef = useRef(upload)
  uploadRef.current = upload
  const [overPane, setOverPane] = useState<string | null>(null)

  const onPaneDragFiles = useCallback((paneId: string, over: boolean) => {
    // Guarded on identity: leaving pane A after entering pane B arrives out of
    // order often enough to clear the wrong one.
    setOverPane((cur) => (over ? paneId : cur === paneId ? null : cur))
  }, [])

  const onPaneDropFiles = useCallback(
    (paneId: string, paths: string[]) => {
      // A drop fires no mousedown, so nothing else tells tmux which pane the
      // user just aimed at — and the path is about to be typed into it.
      window.api.tmuxSelectPane(sessionId, paneId)
      uploadRef.current.drop(paths, writers.current.get(paneId)?.term ?? null)
    },
    [sessionId]
  )

  const onPanePasteImage = useCallback((paneId: string) => {
    uploadRef.current.pasteImage(writers.current.get(paneId)?.term ?? null)
  }, [])

  // Collapse every pane's signals onto this tab. Which pane rang is knowable but
  // not showable: the tab strip has one dot per leaf, and a tmux tab is a leaf.
  //
  // Whether it was *visible* does have to travel, though. Every window's panes
  // stay mounted and keep parsing output, so a pane in a tmux window you aren't
  // looking at can ring while this tab is front and centre — and that is exactly
  // the case the dot exists for. Without this bit the caller would read "tab on
  // screen" as "you've seen it" and drop the signal on the floor.
  const onAgentSignalRef = useRef(onAgentSignal)
  onAgentSignalRef.current = onAgentSignal
  const shownPanesRef = useRef<ReadonlySet<string>>(new Set())
  const onPaneAgentSignal = useCallback((paneId: string, signal: AgentSignal) => {
    onAgentSignalRef.current?.(sessionId, signal, shownPanesRef.current.has(paneId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const reconnect = useCallback((mode: 'attach' | 'create') => {
    setEnded(null)
    setReattach(null)
    reattachingRef.current = false
    setState(null)
    writers.current.clear()
    buffers.current.clear()
    lastSizeRef.current = { cols: 0, rows: 0 }
    window.api.closeSession(sessionId)
    const a = connectArgsRef.current
    const el = areaRef.current
    const { cw, ch } = measureCell(settingsRef.current)
    // Same window-derived fallback as the mount path: a fixed 80x24 would clamp
    // the session, since tmux sizes a window to its smallest attached client.
    const cols = el?.clientWidth
      ? Math.max(1, Math.floor(el.clientWidth / cw))
      : Math.max(20, Math.floor(window.innerWidth / cw))
    const rows = el?.clientHeight
      ? Math.max(1, Math.floor(el.clientHeight / ch))
      : Math.max(5, Math.floor(window.innerHeight / ch))
    // See TerminalView.reconnect: attach-only unless the user asked to start the
    // session again, so this button can never resurrect a killed session as an
    // empty one.
    const command =
      mode === 'attach' && a.tmux ? (tmuxReattachCommand(a.tmux) ?? a.command) : a.command
    void window.api.connect({
      sessionId,
      connectionId: a.connectionId,
      cols,
      rows,
      retries: a.retries,
      password: a.password,
      command,
      control: true,
      tmux: a.tmux
    })
  }, [sessionId])

  // Subscribe + connect exactly once per sessionId.
  useEffect(() => {
    const offOutput = window.api.onTmuxOutput((sid, paneId, data) => {
      if (sid !== sessionId) return
      const w = writers.current.get(paneId)
      if (w) {
        w.write(data)
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
      if (status.kind === 'connecting') {
        setEnded(null)
      } else if (status.kind === 'ready') {
        setEnded(null)
        if (reattachingRef.current) {
          reattachingRef.current = false
          setReattach(null)
          // The new control client hasn't been told our size yet, and lastSizeRef
          // was cleared below so this actually sends.
          requestAnimationFrame(pushSize)
          // Mark the seam in each pane's scrollback. Unlike the drawn view there's
          // no alternate buffer here — each pane is a plain xterm we append to — so
          // a line of text is both safe and the clearest signal that what follows
          // came from a new client.
          for (const h of writers.current.values())
            h.write(new TextEncoder().encode('\r\n\x1b[90m── reconnected ──\x1b[0m\r\n'))
        }
      } else if (status.kind === 'reattaching') {
        reattachingRef.current = true
        setEnded(null)
        setReattach({ attempt: status.attempt, delayMs: status.delayMs, error: status.error })
        // Drop output queued for panes that never mounted — it belongs to the dead
        // client's repaint. `state` and `writers` are deliberately kept: clearing
        // state unmounts every TmuxPane, disposing the xterms that hold the only
        // copy of the pane content this whole feature exists to preserve.
        buffers.current.clear()
        lastSizeRef.current = { cols: 0, rows: 0 }
      } else if (status.kind === 'error') {
        setReattach(null)
        reattachingRef.current = false
        setEnded({ kind: 'error', msg: status.message })
      } else if (status.kind === 'closed') {
        setReattach(null)
        reattachingRef.current = false
        setEnded({ kind: 'closed', msg: status.detail ?? '', reason: status.reason })
      }
    })

    const el = areaRef.current
    const { cw, ch } = measureCell(settingsRef.current)
    // Falling back to a fixed 80x24 was actively harmful: tmux sizes a window to
    // its smallest attached client, so a pane that happened to mount without a
    // layout box would clamp — or with `-D`, steal — a session the user is
    // watching elsewhere. The window is a far better guess, and pushSize()
    // corrects it as soon as the pane is laid out.
    const cols =
      el && el.clientWidth
        ? Math.max(1, Math.floor(el.clientWidth / cw))
        : Math.max(20, Math.floor(window.innerWidth / cw))
    const rows =
      el && el.clientHeight
        ? Math.max(1, Math.floor(el.clientHeight / ch))
        : Math.max(5, Math.floor(window.innerHeight / ch))
    lastSizeRef.current = { cols, rows }
    void window.api.connect({
      sessionId,
      connectionId,
      cols,
      rows,
      retries,
      password,
      command,
      control: true,
      tmux
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
  // Read by onPaneAgentSignal, which is mount-stable and so can't close over this.
  shownPanesRef.current = new Set(activeWindow?.panes.map((p) => p.paneId) ?? [])

  // Render every pane across every window (kept mounted so content persists), but
  // only the active window's panes are visible.
  const allPanes = useMemo(
    () => windows.flatMap((w) => w.panes.map((p) => ({ win: w, pane: p }))),
    [windows]
  )

  // The composer is drafting for `target` when open, and shows the focused
  // pane's saved draft as a strip when it isn't.
  const draftPane = target ?? focusedPane ?? null
  const draft = (draftPane && drafts[draftPane]) || ''

  const setDraft = useCallback(
    (v: string) => {
      if (draftPane) setDrafts((d) => ({ ...d, [draftPane]: v }))
    },
    [draftPane]
  )

  const sendDraft = useCallback(
    (submit: boolean) => {
      const term = target ? writers.current.get(target)?.term : undefined
      const body = ((target && drafts[target]) || '').replace(/\s+$/, '')
      if (!target || !term || !body) return
      sendComposed(term, body, submit)
      setDrafts(({ [target]: _sent, ...rest }) => rest)
      setTarget(null)
      term.focus()
    },
    [target, drafts]
  )

  // A pane can be killed from the remote — by tmux itself, or from another
  // client — while its composer is open. Close rather than leave a drafting
  // panel pointed at a pane that no longer exists.
  useEffect(() => {
    if (target && !allPanes.some((p) => p.pane.paneId === target)) setTarget(null)
  }, [target, allPanes])

  // Coming back to a parked tab. App hides a leaf with `display: none`, which
  // drops DOM focus altogether, and no pane will take it back while the composer
  // is up (`focused` is false for all of them) — so the composer has to ask for
  // it, or the user returns to a draft that swallows every keystroke.
  useEffect(() => {
    if (active && target) bumpFocus()
  }, [active, target])

  const isReady = windows.length > 0
  // See TerminalView: a session that is *gone* must not offer "Reattach", since
  // reattaching there means running the create-or-attach command again.
  const recreate = ended?.reason === 'gone' || ended?.reason === 'exited'
  const canAttach = !!(tmux && tmuxReattachCommand(tmux))
  const overlay = ended && {
    eyebrow:
      ended.kind === 'error'
        ? 'connection error'
        : ended.reason === 'gone'
          ? 'session gone'
          : ended.reason === 'unreachable'
            ? 'disconnected'
            : ended.reason === 'exited'
              ? 'session ended'
              : 'detached',
    body:
      ended.kind === 'error'
        ? ended.msg
        : ended.reason === 'gone'
          ? `That tmux session is no longer running on the host.${ended.msg ? ` (${ended.msg})` : ''}`
          : ended.reason === 'unreachable'
            ? `Lost the connection${ended.msg ? `: ${ended.msg}` : ''}.`
            : ended.reason === 'exited'
              ? 'The tmux session ended.'
              : 'Detached from tmux. Your session is still running on the host.',
    // 'exited' joins 'gone' here: both mean there is no session left to attach to,
    // so the honest offer is to start one, not to "reattach" to nothing.
    action: recreate || !canAttach ? 'Start it again ▸' : 'Reattach ▸',
    mode: (recreate || !canAttach ? 'create' : 'attach') as 'attach' | 'create'
  }

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
                // `display: none`, not `visibility: hidden` — xterm gates its
                // renderer on an IntersectionObserver, which still counts an
                // invisible-but-laid-out pane as on screen and keeps painting it.
                // Panes are sized from tmux's own cell grid, not measured, so
                // taking them out of layout costs nothing.
                display: visible ? undefined : 'none'
              }}
            >
              <div
                className={`relative h-full w-full overflow-hidden rounded-sm ring-1 ${
                  isActivePane ? 'ring-accent/70' : 'ring-line/50'
                }`}
              >
                <TmuxPane
                  sessionId={sessionId}
                  paneId={pane.paneId}
                  cols={pane.w}
                  rows={pane.h}
                  // Not focused while the composer is up, or the pane would take
                  // keyboard focus back from the textarea on the next re-render.
                  focused={active && isActivePane && !target}
                  settings={settings}
                  register={registerPane}
                  onCompose={openComposer}
                  onDragFiles={onPaneDragFiles}
                  onDropFiles={onPaneDropFiles}
                  onPasteImage={onPanePasteImage}
                  onAgentSignal={onPaneAgentSignal}
                  onSelect={() => window.api.tmuxSelectPane(sessionId, pane.paneId)}
                />
                {overPane === pane.paneId && <DropHint />}
              </div>
            </div>
          )
        })}

        {!isReady && !ended && !reattach && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            Attaching tmux (control mode)…
          </div>
        )}
        {reattach && <ReattachBanner sessionId={sessionId} {...reattach} />}
        <DropStatusBar status={upload.status} onDismiss={upload.dismiss} />
        {/* Inside the pane area and overlaid on it. Docking it below would shrink
            areaRef, and this view turns that box straight into the tmux client
            size — every other client attached to the session would see the
            windows reflow because someone here opened a text box. */}
        <PromptComposer
          open={!!target}
          focusKey={focusKey}
          draft={draft}
          onDraft={setDraft}
          onSend={sendDraft}
          onOpen={() => draftPane && openComposer(draftPane)}
          onClose={() => closeComposer(draftPane)}
          onDiscard={() => draftPane && setDrafts(({ [draftPane]: _dropped, ...rest }) => rest)}
          target={activeWindow && activeWindow.panes.length > 1 ? (draftPane ?? undefined) : undefined}
          bracketed={bracketed}
          connectionId={connectionId}
        />
      </div>

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
            w.windowId === activeId ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated/60 hover:text-fg'
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
  onCompose,
  onDragFiles,
  onDropFiles,
  onPasteImage,
  onAgentSignal,
  onSelect
}: {
  sessionId: string
  paneId: string
  cols: number
  rows: number
  focused: boolean
  settings: TerminalSettings
  register: (paneId: string, handle: PaneHandle) => () => void
  /** Stable across renders — the mount-once effect closes over it. */
  onCompose: (paneId: string) => void
  /** Stable across renders, as above. */
  onDragFiles: (paneId: string, over: boolean) => void
  /** Stable across renders, as above. */
  onDropFiles: (paneId: string, paths: string[]) => void
  /** Stable across renders, as above. */
  onPasteImage: (paneId: string) => void
  /** Stable across renders, as above. */
  onAgentSignal: (paneId: string, signal: AgentSignal) => void
  onSelect: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Find-in-pane. Per pane rather than per tab, unlike the composer above: a
  // draft is a paragraph aimed at one pane you picked, but a search is tied to
  // the buffer you are already reading, and a tab-level bar would have to keep
  // asking which of four panes that is. No overscroll here — tmux owns the
  // layout and each pane scrolls its own xterm viewport — so the addon's own
  // scroll-to-match is the whole story.
  const findRef = useRef<FindTarget | null>(null)
  const find = useTerminalFind(useCallback(() => findRef.current, []))
  const startFind = find.start

  // Create the xterm for this pane exactly once.
  useEffect(() => {
    const { term, search } = createTerminal(settingsRef.current, containerRef.current!)
    termRef.current = term
    findRef.current = { term, search }
    const send = (d: string): void => window.api.tmuxSendKeys(sessionId, paneId, d)
    term.onData(send)
    // No onTitle: a control-mode tab holds many panes, and tmux reports window
    // names itself (%window-renamed) — the window bar above already shows them.
    const detachTerminal = attachTerminal(term, containerRef.current!, {
      sendData: send,
      settings: () => settingsRef.current,
      onCompose: () => onCompose(paneId),
      onFind: startFind,
      onDragFiles: (over) => onDragFiles(paneId, over),
      onDropFiles: (paths) => onDropFiles(paneId, paths),
      onPasteImage: () => onPasteImage(paneId)
    })
    // Every pane in this tab reports to the same leaf: the dot lives on the tab,
    // and a tab is one tmux session no matter how many panes it holds.
    const detachSignal = attachAgentSignal(term, (s) => onAgentSignal(paneId, s))
    const unregister = register(paneId, { write: (data) => term.write(data), term })
    return () => {
      unregister()
      detachTerminal()
      detachSignal()
      search.dispose()
      findRef.current = null
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

  // Focus this pane's terminal when it's the focused leaf's active pane —
  // unless its find bar is up, which is where the keyboard already was. Behind
  // a ref so opening the bar doesn't re-run this and fight itself for focus.
  const findingRef = useRef(find.open)
  findingRef.current = find.open
  useEffect(() => {
    if (!focused) return
    if (findingRef.current) startFind()
    else termRef.current?.focus()
  }, [focused, startFind])

  return (
    <>
      <div ref={containerRef} className="h-full w-full" onMouseDown={onSelect} />
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
    </>
  )
}
