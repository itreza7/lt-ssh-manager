import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ChatAnswer,
  ChatEvent,
  ChatKeysResult,
  ChatMode,
  ChatSession,
  ChatStreamData,
  ChatStreamEnd,
  TuiFooter,
  TuiPrompt
} from '../../../shared/chatProtocol'
import { createTranscriptMapper, type TranscriptMapper } from '../../../shared/transcriptEvents'
import { EFFORT_LEVELS, parseUsage, type UsageLimit } from '../../../shared/tuiKeys'
import { initialChatState, prependState, reduceEvents, type AssistantItem, type ChatItem, type ChatUiState, type ToolResult, type UiBlock } from '../lib/chatState'
import { ChatComposer, type UsageInfo } from './ChatComposer'
import { ModeSwitch } from './ModeSwitch'
import { Button, Modal } from './Modal'
import { AssistantBlocks, NoteLine, OutputCard, QueuedMessage, ToolGroup, UserMessage } from './chat/Blocks'
import { chatLabel, chatStatusOf, leaf, statusLabel, type ChatStatus } from './chat/format'
import { ActionsMenu, BUILTIN_COMMANDS, ModeMenu, PickMenu, type CommandInfo } from './chat/Menus'
import { PromptCard } from './chat/Requests'
import { TasksPanel } from './chat/Tasks'

interface Props {
  connectionId: string
  password?: string
  sessionId: string
  /** The directory the session ran in: where "Resume in tmux" starts Claude. */
  cwd: string
  active: boolean
  /** Just started or resumed here: Claude has not written its status file yet, so "no Claude" is not "ended". */
  starting?: boolean
  /** Claude's status file has shown up: `starting` is over. */
  onStarted?: () => void
  /** Show the terminal on this tmux session in this pane (opening one if needed): the Chat / Terminal switch. */
  onOpenTerminal: (tmuxSession: string) => void
  /** Resume started a different session id: the tab should follow it. */
  onResumed: (sessionId: string) => void
  /** The header is the window's title bar (the app bar is hidden): it drags the window. */
  titleBar?: boolean
}

// Closer to the bottom than this and a new message keeps the view pinned there.
const NEAR_BOTTOM_PX = 80
// Closer to the top than this and earlier messages are shown (or read from the host).
const NEAR_TOP_PX = 300
// Segments rendered at first, and added each time the reader nears the top.
const WINDOW = 60
// A first load paints once it has the whole tail; this long with no data, it paints what it has.
// Generous: the ssh exec takes a while to start, and a chunk can lag on a slow link.
const BOOT_QUIET_MS = 3000
// Wait before each stream reconnect attempt (seconds), then stay at the last.
const BACKOFF_S = [1, 2, 4, 8, 10]
// How often the screen is read for the open dialog and the footer chips: each read is an ssh exec.
const SCREEN_MS = 2000
// How often Claude's status file is read while the tab exists: each read is an ssh exec.
const STATUS_MS = 2000
const STATUS_HIDDEN_MS = 10_000
// After sending, how long an idle status may still be "about to go busy".
const SEND_GRACE_MS = 8000
// How long a fresh start may take to show up as a live Claude.
const START_GRACE_MS = 30_000

const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

// Below this width the Background tasks panel leaves its column and sits above the composer.
const SIDE_MIN_PX = 1000
// The context window: 1M for a "[1m]" model, else 200k.
const WINDOW_SMALL = 200_000
const WINDOW_LARGE = 1_000_000

// The header's status dot: idle is a hollow ring, the live states are amber.
const HEADER_DOT: Record<ChatStatus, string> = {
  idle: 'border border-faint',
  busy: 'bg-amber animate-pulse',
  waiting: 'bg-amber',
  ended: 'bg-danger/50'
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

type Link = 'connecting' | 'live' | 'reconnecting'

type ToolBlock = Extract<UiBlock, { type: 'tool_use' }>

/** A message to render as it is, or a run of tool calls to render as one group. */
/** `i` is the index in `items` of the (first) item the segment shows. */
type Segment = { kind: 'item'; item: ChatItem; i: number } | { kind: 'tools'; id: string; i: number; blocks: ToolBlock[] }

// Calls that keep their own card: they say more than a count can.
const STANDALONE_TOOLS = new Set(['TodoWrite', 'Task', 'Agent'])

/**
 * The calls of an assistant message that holds nothing but tool calls and may be
 * grouped, or null. A failed call, and a call still waiting on its result while the
 * turn is live, stay in view on their own.
 */
function groupableCalls(it: AssistantItem, results: Record<string, ToolResult>, live: boolean): ToolBlock[] | null {
  const calls: ToolBlock[] = []
  for (const b of it.blocks) {
    if (b.type === 'text' && !b.text) continue
    if (b.type !== 'tool_use') return null
    const r = results[b.id]
    if (STANDALONE_TOOLS.has(b.name) || r?.isError || (!r && live)) return null
    calls.push(b)
  }
  return calls.length ? calls : null
}

/** Consecutive groupable messages become one `tools` segment when they hold 2 or more calls. */
function segmentsOf(items: ChatItem[], results: Record<string, ToolResult>, live: boolean): Segment[] {
  const out: Segment[] = []
  const run: { item: AssistantItem; i: number }[] = []
  const calls: ToolBlock[] = []
  const flush = (): void => {
    if (calls.length >= 2) out.push({ kind: 'tools', id: run[0].item.msgId, i: run[0].i, blocks: [...calls] })
    else for (const r of run) out.push({ kind: 'item', item: r.item, i: r.i })
    run.length = 0
    calls.length = 0
  }
  items.forEach((it, i) => {
    const c = it.kind === 'assistant' ? groupableCalls(it, results, live) : null
    if (it.kind === 'assistant' && c) {
      run.push({ item: it, i })
      calls.push(...c)
      return
    }
    flush()
    out.push({ kind: 'item', item: it, i })
  })
  flush()
  return out
}

/** What is said above the composer after typing into the pane did not go through. */
type Notice = { kind: 'draft' } | { kind: 'screen' } | { kind: 'text'; text: string }

// Typed from the composer, these run through chatCommand (the first four, and /effort with a level, for sure).
const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name))
const EFFORT_ARG = /^\s*(low|medium|high|xhigh|max)\s*$/
const SLASH = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/

// The plan limits are the account's, not the chat's: one /usage read per connection serves every chat for a minute.
const USAGE_FRESH_MS = 60_000
const usageCache = new Map<string, { at: number; limits: UsageLimit[] }>()

const itemKey = (it: ChatItem): string => (it.kind === 'assistant' ? it.msgId : it.id)

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The model the transcript reports is a resolved id (`claude-opus-4-…`); the picker is keyed by alias. */
function modelValue(model: string | null): string {
  if (!model) return 'default'
  return MODELS.find((m) => m.value !== 'default' && model.includes(m.value))?.value ?? model
}

export function ChatView({ connectionId, password, sessionId, cwd, active, starting, onStarted, onOpenTerminal, onResumed, titleBar }: Props) {
  const [state, setState] = useState<ChatUiState>(initialChatState)
  const [link, setLink] = useState<Link>('connecting')
  // From chatStatus: the live Claude. Undefined until asked (or while a fresh start boots), null = none.
  const [session, setSession] = useState<ChatSession | null | undefined>(undefined)
  const [pending, setPending] = useState<{ id: string; text: string }[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [resuming, setResuming] = useState(false)
  // The first load has painted. Until then its events wait in `bootEvents`, so the chat
  // appears once, at the bottom, instead of filling from the top batch by batch.
  const [loaded, setLoaded] = useState(false)
  // Byte offset where what we hold begins; above 0, earlier messages can be read on scroll up.
  const startOffset = useRef(0)
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingOlderRef = useRef(false)
  // The first item rendered, by key: only segments from it down are in the DOM. Null = the last WINDOW.
  const [firstKey, setFirstKey] = useState<string | null>(null)
  // Distance from the bottom to hold while earlier content is put above the view.
  const anchor = useRef<number | null>(null)
  // Earlier messages were just read: show some of them once they are in the state.
  const expandNext = useRef(false)
  // The dialog on the TUI's screen. Claude Code writes none of them to the transcript until answered.
  const [prompt, setPrompt] = useState<TuiPrompt | null>(null)
  // The TUI's footer under the input box: the statusLine segments and the mode line.
  const [footer, setFooter] = useState<TuiFooter | null>(null)
  // Skills and commands on the host, loaded the first time the Actions menu or a "/" asks.
  const [commands, setCommands] = useState<CommandInfo[] | null>(null)
  const commandsAsked = useRef(false)
  // Text a dialog command (/usage) read off the screen, shown until dismissed.
  const [snapshot, setSnapshot] = useState<{ title: string; text: string } | null>(null)
  const [insert, setInsert] = useState<{ id: number; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  // A command or mode change is typing into the pane: the screen poll waits, so it does not read a half-finished screen.
  const cmdBusy = useRef(false)
  const [cmdRunning, setCmdRunning] = useState(false)
  // The level last picked here; the TUI does not say what it is.
  const [effort, setEffort] = useState<string | null>(null)
  // Wide enough for the Background tasks column.
  const [wide, setWide] = useState(true)
  // Tasks the user closed the panel on: it comes back when one that is not in here shows up.
  const [closedTasks, setClosedTasks] = useState<string[]>([])
  const [usage, setUsage] = useState<UsageInfo>({ state: 'idle', limits: [] })
  const root = useRef<HTMLDivElement>(null)

  // Byte offset after the last whole record applied — where a reconnect resumes.
  const offset = useRef(-1)
  const mapper = useRef<TranscriptMapper>(createTranscriptMapper())
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const target = { connectionId, password }
  // The last live Claude seen, to tell a /clear or /resume in the TUI (same pid, new session id) from its end.
  const lastSession = useRef<ChatSession | null>(null)
  const sentAt = useRef(0)
  const mountedAt = useRef(Date.now())
  // Read by the status poll, which must not restart when they change.
  const startingRef = useRef(starting)
  const onStartedRef = useRef(onStarted)
  const onResumedRef = useRef(onResumed)
  startingRef.current = starting
  onStartedRef.current = onStarted
  onResumedRef.current = onResumed
  const [, setTick] = useState(0)

  // The transcript stream. Everything about it lives in this one effect so cleanup
  // is total: the timer, the subscriptions and the main-side stream all end with it.
  useEffect(() => {
    let cancelled = false
    let streamId: string | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // Data and end notices can reach us before chatStream's own promise has
    // told us the id; keep them until it has.
    const early: ChatStreamData[] = []
    const earlyEnds: ChatStreamEnd[] = []

    // The first load: events held back until the tail read at open is all here.
    let boot: { events: ChatEvent[]; size: number } | null = null
    let quiet: ReturnType<typeof setTimeout> | undefined
    const paint = (): void => {
      clearTimeout(quiet)
      if (!boot || cancelled) return
      const events = boot.events
      boot = null
      setState((s) => reduceEvents(s, events))
      setLoaded(true)
    }

    const take = (d: ChatStreamData): void => {
      offset.current = d.next
      attempt = 0
      const events: ChatEvent[] = mapper.current.push(d.records)
      if (!boot) {
        setState((s) => reduceEvents(s, events))
        return
      }
      boot.events.push(...events)
      clearTimeout(quiet)
      if (d.next >= boot.size) paint()
      else quiet = setTimeout(paint, BOOT_QUIET_MS)
    }

    const dropped = (): void => {
      if (cancelled) return
      streamId = null
      setLink('reconnecting')
      const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]
      attempt++
      timer = setTimeout(() => void open(), wait * 1000)
    }

    const offData = window.api.onChatData((d) => {
      if (streamId === null) early.push(d)
      else if (d.streamId === streamId) take(d)
    })
    // Whatever ends our stream — an error, or main closing it — means reopen.
    // (A clean end of our own doing only happens in cleanup, which cancels.)
    const offEnd = window.api.onChatEnd((d) => {
      if (streamId === null) earlyEnds.push(d)
      else if (d.streamId === streamId) dropped()
    })

    const open = async (): Promise<void> => {
      // Anything buffered so far belongs to other chats or to an attempt that failed.
      early.length = 0
      earlyEnds.length = 0
      // A first load starts over; a resume from an offset keeps what the mapper has seen.
      if (offset.current < 0) mapper.current = createTranscriptMapper()
      try {
        const r = await window.api.chatStream({ connectionId, password, sessionId, offset: offset.current })
        if (cancelled) {
          void window.api.chatUnstream({ streamId: r.streamId })
          return
        }
        streamId = r.streamId
        if (offset.current < 0) {
          startOffset.current = r.start
          setHasOlder(r.start > 0)
          boot = { events: [], size: r.size }
          // Nothing past the start (or a line still being written): paint now, or soon.
          if (r.size <= r.start) paint()
          else quiet = setTimeout(paint, BOOT_QUIET_MS)
        }
        setLink('live')
        for (const d of early.splice(0)) if (d.streamId === r.streamId) take(d)
        if (earlyEnds.splice(0).some((d) => d.streamId === r.streamId)) dropped()
      } catch (e) {
        // A new chat has no transcript until its first message: wait for it, quietly.
        if (/Transcript not found/.test(errText(e))) {
          if (!cancelled) timer = setTimeout(() => void open(), 2000)
          return
        }
        dropped()
      }
    }
    void open()

    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(quiet)
      offData()
      offEnd()
      if (streamId !== null) void window.api.chatUnstream({ streamId })
    }
  }, [connectionId, password, sessionId])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      // A hidden tab measures 0: that says nothing about the layout.
      if (w > 0) setWide(w >= SIDE_MIN_PX)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Claude Code's own status: the live process, its tmux pane, busy/waiting.
  useEffect(() => {
    let off = false
    let lastJson = ''
    let lastStatus = ''
    let started = false
    const ask = async (): Promise<void> => {
      try {
        const s = await window.api.chatStatus({ connectionId, password, sessionId })
        if (off) return
        if (s === null && startingRef.current && Date.now() - mountedAt.current < START_GRACE_MS) return
        if (s === null && lastSession.current) {
          // After /clear or /resume inside the TUI the same pid writes a new session id.
          const known = lastSession.current
          const live = await window.api.chatList({ connectionId, password })
          if (off) return
          const moved = live.find((c) => c.pid === known.pid && c.sessionId !== sessionId)
          if (moved) {
            onResumedRef.current(moved.sessionId)
            return
          }
          lastSession.current = null
        }
        if (s) {
          lastSession.current = s
          if (!started) {
            started = true
            onStartedRef.current?.()
          }
        }
        const json = JSON.stringify(s)
        if (json !== lastJson) {
          lastJson = json
          setSession(s)
        }
        // The reducer hears of the status only when it changes, so a turn that left no
        // end marker is not re-opened by every poll.
        const status: ChatStatus = chatStatusOf(s)
        const waitingFor = s?.status === 'waiting' ? s.waitingFor : undefined
        const key = `${status}\0${waitingFor ?? ''}`
        if (key === lastStatus) return
        lastStatus = key
        setState((prev) => reduceEvents(prev, [{ t: 'status', status, waitingFor }]))
      } catch {
        /* a dropped link says nothing about Claude; keep what we knew */
      }
    }
    void ask()
    const t = setInterval(() => void ask(), active ? STATUS_MS : STATUS_HIDDEN_MS)
    return () => {
      off = true
      clearInterval(t)
    }
  }, [connectionId, password, sessionId, active])

  const pane = session?.tmux?.pane
  const tmuxSession = session?.tmux?.session
  const ended = session === null
  const drivable = !!session?.drivable && !!pane
  // An idle status can lag a send by a moment: only then does an open turn count as busy.
  const busy = state.status === 'busy' || (state.turn && state.status === 'idle' && Date.now() - sentAt.current < SEND_GRACE_MS)
  const waiting = state.status === 'waiting'

  // Read the screen while the tab is on screen: the open dialog (shown as a card
  // only while Claude waits) and the footer chips. Once at once, then every 2 s.
  const polling = active && drivable
  useEffect(() => {
    if (!polling || !pane) {
      setPrompt(null)
      return
    }
    let off = false
    const ask = async (): Promise<void> => {
      if (cmdBusy.current) return
      try {
        const r = await window.api.chatPrompt({ connectionId, password, pane })
        if (off) return
        setPrompt((prev) => (JSON.stringify(prev) === JSON.stringify(r.prompt) ? prev : r.prompt))
        // A screen with no footer (a dialog is open) says nothing about the footer: keep the last.
        if (r.footer) setFooter((prev) => (JSON.stringify(prev) === JSON.stringify(r.footer) ? prev : r.footer))
      } catch {
        /* keep what we knew */
      }
    }
    void ask()
    const t = setInterval(() => void ask(), SCREEN_MS)
    return () => {
      off = true
      clearInterval(t)
    }
  }, [polling, pane, connectionId, password])

  // Types into the pane; says why when it did not go through.
  const keys = async (send: (pane: string) => Promise<ChatKeysResult>): Promise<boolean> => {
    if (!pane) {
      setNotice({ kind: 'text', text: 'Claude is not in a tmux pane.' })
      return false
    }
    let r: ChatKeysResult
    try {
      r = await send(pane)
    } catch (e) {
      setNotice({ kind: 'text', text: errText(e) })
      return false
    }
    if (r.ok) {
      setNotice(null)
      return true
    }
    setNotice(
      r.reason === 'draft' || r.reason === 'screen'
        ? ({ kind: r.reason } as Notice)
        : { kind: 'text', text: r.reason === 'no-pane' ? 'Claude is not in a tmux pane.' : r.message || 'Could not type into the terminal.' }
    )
    return false
  }

  const loadCommands = (): void => {
    if (commandsAsked.current) return
    commandsAsked.current = true
    window.api.chatCommands({ ...target, cwd }).then(
      (list) => setCommands([...BUILTIN_COMMANDS, ...list.filter((c) => !BUILTIN_NAMES.has(c.name))]),
      () => {
        // Allow another try; the built-ins still work meanwhile.
        commandsAsked.current = false
        setCommands((c) => c ?? BUILTIN_COMMANDS)
      }
    )
  }

  // One command or mode change at a time: they type into the same pane.
  const exclusive = async (fn: () => Promise<boolean>): Promise<boolean> => {
    if (cmdBusy.current) return false
    cmdBusy.current = true
    setCmdRunning(true)
    try {
      return await fn()
    } finally {
      cmdBusy.current = false
      setCmdRunning(false)
    }
  }

  // A slash command: typed for us, and when it opens a dialog (/usage), its text comes back.
  const runCommand = (command: string): Promise<boolean> =>
    exclusive(async () => {
      const out: { r?: ChatKeysResult & { text?: string } } = {}
      const ok = await keys(async (p) => (out.r = await window.api.chatCommand({ ...target, pane: p, command, cwd })))
      if (ok && out.r?.ok && out.r.text) setSnapshot({ title: command, text: out.r.text })
      return ok
    })

  const sendText = async (text: string): Promise<boolean> => {
    const m = SLASH.exec(text)
    if (m) {
      const [, name, arg] = m
      const known =
        !/[\r\n]/.test(text) &&
        (name === 'effort' ? EFFORT_ARG.test(arg ?? '') : BUILTIN_NAMES.has(name) || !!commands?.some((c) => c.name === name))
      if (known) {
        // A skill starts a turn; the built-ins do not.
        if (!BUILTIN_NAMES.has(name)) {
          sentAt.current = Date.now()
          setTimeout(() => setTick((n) => n + 1), SEND_GRACE_MS + 100)
        }
        return runCommand(text)
      }
      // A bare /effort would open the TUI's slider, which the chat cannot close.
      if (name === 'effort') {
        setNotice({ kind: 'text', text: 'Pick a level: /effort low|medium|high|xhigh|max' })
        return false
      }
    }
    sentAt.current = Date.now()
    // Re-render once the grace is over, or an idle status would keep showing "Working…".
    setTimeout(() => setTick((n) => n + 1), SEND_GRACE_MS + 100)
    const ok = await keys((p) => window.api.chatSend({ ...target, pane: p, text }))
    // Shown dimmed until the transcript echoes it back. A slash command never does.
    if (ok && !text.startsWith('/')) setPending((p) => [...p, { id: crypto.randomUUID(), text }])
    return ok
  }

  const pollPrompt = async (): Promise<void> => {
    if (!pane) return
    try {
      const r = await window.api.chatPrompt({ ...target, pane })
      setPrompt((prev) => (JSON.stringify(prev) === JSON.stringify(r.prompt) ? prev : r.prompt))
      if (r.footer) setFooter(r.footer)
    } catch {
      /* a dropped link says nothing about the prompt; keep what we knew */
    }
  }

  const answer = async (a: ChatAnswer): Promise<void> => {
    let r: ChatKeysResult | undefined
    const ok = await keys(async (p) => (r = await window.api.chatAnswer({ ...target, pane: p, answer: a })))
    if (!ok) {
      // A card that no longer matches the screen: show what is there now.
      if (r && !r.ok && r.reason === 'screen') void pollPrompt()
      throw new Error('not sent')
    }
    setTimeout(() => void pollPrompt(), 400)
  }

  const interrupt = (): void => void keys((p) => window.api.chatInterrupt({ ...target, pane: p }))
  // The transcript names the new model only with Claude's next reply; show it now.
  const setModel = async (m: string): Promise<void> => {
    if (await keys((p) => window.api.chatModel({ ...target, pane: p, model: m })))
      setState((prev) => reduceEvents(prev, [{ t: 'model', model: m }]))
  }
  const setMode = (m: ChatMode): Promise<boolean> =>
    exclusive(async () => {
      const ok = await keys((p) => window.api.chatMode({ ...target, pane: p, mode: m }))
      if (ok) {
        setFooter((f) => (f ? { ...f, mode: m } : f))
        setState((prev) => reduceEvents(prev, [{ t: 'mode', mode: m }]))
      }
      return ok
    })
  const openTerminal = tmuxSession ? () => onOpenTerminal(tmuxSession) : undefined
  // For the context ring's popover: /usage read off the screen, without the card runCommand would show.
  const loadUsage = (): void => {
    const hit = usageCache.get(connectionId)
    if (hit && Date.now() - hit.at < USAGE_FRESH_MS) {
      setUsage({ state: 'ok', limits: hit.limits })
      return
    }
    if (!drivable || !pane) {
      setUsage((u) => ({ ...u, state: 'failed' }))
      return
    }
    setUsage((u) => ({ ...u, state: 'loading' }))
    void exclusive(async () => {
      try {
        const r = await window.api.chatCommand({ ...target, pane, command: '/usage', cwd })
        const limits = r.ok && r.text ? parseUsage(r.text) : []
        if (limits.length) {
          usageCache.set(connectionId, { at: Date.now(), limits })
          setUsage({ state: 'ok', limits })
        } else setUsage((u) => ({ ...u, state: 'failed' }))
        return r.ok
      } catch {
        setUsage((u) => ({ ...u, state: 'failed' }))
        return false
      }
    }).then((ran) => {
      // Another command was typing into the pane.
      if (!ran) setUsage((u) => (u.state === 'loading' ? { ...u, state: 'failed' } : u))
    })
  }
  const pickEffort = async (l: string): Promise<void> => {
    if (await runCommand(`/effort ${l}`)) setEffort(l)
  }

  const resume = async (): Promise<void> => {
    setResuming(true)
    setNotice(null)
    try {
      const r = await window.api.chatResume({ ...target, sessionId, cwd })
      if (r.sessionId !== sessionId) onResumed(r.sessionId)
    } catch (e) {
      setNotice({ kind: 'text', text: errText(e) })
    } finally {
      setResuming(false)
    }
  }

  // Queued messages leave the dim list once the transcript has echoed them. Echoes
  // are recent, so only the tail is searched.
  const echoed = useMemo(() => {
    const texts = new Set<string>()
    for (let i = state.items.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      const it = state.items[i]
      if (it.kind === 'user') texts.add(it.text.trim())
    }
    return texts
  }, [state.items])
  const queued = pending.filter((p) => !echoed.has(p.text.trim()))
  useEffect(() => {
    setPending((p) => {
      const rest = p.filter((x) => !echoed.has(x.text.trim()))
      return rest.length === p.length ? p : rest
    })
  }, [echoed])

  // Stay pinned to the bottom only if the reader hasn't scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [state.items, state.children, prompt, state.status, queued.length, notice, snapshot])

  // A tab that was hidden may have lost its scroll position.
  useEffect(() => {
    const el = scroller.current
    if (active && el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [active])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    if (el.scrollTop < NEAR_TOP_PX) showEarlier()
  }

  // Links open in the OS browser (http/https only); never navigate the app.
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) window.api.openExternal(href)
  }

  const shown: ChatStatus = ended ? 'ended' : busy ? 'busy' : state.status
  const label = session === undefined && starting ? 'Starting…' : statusLabel(shown, state.waitingFor ?? undefined)

  const model = modelValue(state.model ?? footer?.model?.toLowerCase() ?? null)
  const modelOptions = MODELS.some((m) => m.value === model) ? MODELS : [{ value: model, label: model }, ...MODELS]
  // The user's statusLine segments, shown small in the composer. The model has its own picker, and the
  // one that only repeats the tab's own name says nothing here, and the context ring shows ctx.
  const norm = (x: string | undefined): string => (x ?? '').trim().toLowerCase()
  const own = new Set([norm(tmuxSession), norm(session?.name), norm(leaf(cwd))].filter(Boolean))
  const ctx = state.context
    ? { tokens: state.context.inputTokens, window: /1m/i.test(`${state.model ?? ''} ${footer?.model ?? ''}`) ? WINDOW_LARGE : WINDOW_SMALL }
    : null
  const segs = footer?.segments ?? []
  const chipModel = footer ? (footer.model ?? segs[0]) : undefined
  const isEffort = (x: string): boolean => (EFFORT_LEVELS as readonly string[]).includes(norm(x))
  const shownEffort = effort ?? norm(segs.find(isEffort)) ?? ''
  const chips = segs.filter((x) => x !== chipModel && !own.has(norm(x)) && !isEffort(x) && !(ctx && /^ctx\b/i.test(x)))
  const footerMode = footer?.mode ?? null
  // The statusLine's "5h 21%" and "7d 63%", for the popover until /usage is read.
  const usageFallback: UsageLimit[] = segs.flatMap((x) => {
    const m = /^(5h|7d)\s+(\d+(?:\.\d+)?)%$/.exec(x.trim())
    return m ? [{ label: m[1] === '5h' ? 'Session' : 'Weekly · all models', percent: Number(m[2]) }] : []
  })
  const folder = session ? chatLabel(session) : leaf(cwd)

  // A call with no result yet is still running while the turn is live (busy, or waiting on a dialog).
  const segments = useMemo(() => segmentsOf(state.items, state.results, busy || waiting), [state.items, state.results, busy, waiting])
  // Only segments from `from` down are rendered; firstKey pins it to an item, so messages
  // arriving below (or read in above) never move what is on screen.
  const from = (() => {
    const at = firstKey === null ? -1 : state.items.findIndex((it) => itemKey(it) === firstKey)
    if (at < 0) return Math.max(0, segments.length - WINDOW)
    const k = segments.findIndex((seg) => seg.i >= at)
    return k < 0 ? 0 : k
  })()
  const hidden = from > 0
  const shownSegments = hidden ? segments.slice(from) : segments

  // Freeze the window once the first load has painted.
  useLayoutEffect(() => {
    if (loaded && firstKey === null && segments.length) setFirstKey(itemKey(state.items[segments[from].i]))
  }, [loaded, firstKey, segments, from, state.items])

  // Earlier content went in above the view: keep the same distance from the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current
      anchor.current = null
    }
  }, [from, state.items])

  /** Show WINDOW more segments above, reading earlier transcript first when none are left. */
  function showEarlier(): void {
    const el = scroller.current
    if (!el || !loaded) return
    if (hidden) {
      anchor.current = el.scrollHeight - el.scrollTop
      setFirstKey(itemKey(state.items[segments[Math.max(0, from - WINDOW)].i]))
      // Few left above: read the earlier part now, so it is there when the reader gets to it.
      if (from < 2 * WINDOW) readOlder(false)
      return
    }
    readOlder(true)
  }

  /** Read the transcript part before what we hold and put it in front; `show` = render some of it right away. */
  function readOlder(show: boolean): void {
    if (startOffset.current <= 0) return
    if (show) {
      expandNext.current = true
      setLoadingOlder(true)
    }
    // A read already under way (a prefetch) shows its messages when it lands, if asked to by now.
    if (loadingOlderRef.current) return
    loadingOlderRef.current = true
    void (async () => {
      try {
        const r = await window.api.chatOlder({ connectionId, password, sessionId, before: startOffset.current })
        // A fresh mapper: the records are earlier than anything the stream's mapper saw.
        const older = reduceEvents(initialChatState, createTranscriptMapper(`o${r.start}-`).push(r.records))
        startOffset.current = r.start
        setHasOlder(r.start > 0)
        const box = scroller.current
        if (box) anchor.current = box.scrollHeight - box.scrollTop
        setState((s) => prependState(older, s))
      } catch {
        // The next scroll to the top tries again.
        expandNext.current = false
      } finally {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    })()
  }

  // After earlier messages were read in, or when the window does not fill the view
  // (nothing to scroll, so no scroll event), show more.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !loaded) return
    const short = el.scrollHeight <= el.clientHeight + NEAR_TOP_PX
    if (expandNext.current && hidden) {
      expandNext.current = false
      showEarlier()
    } else if (short && (hidden || hasOlder)) showEarlier()
  })
  const tasks = Object.values(state.tasks).filter((t) => !t.hidden)
  const showTasks = !ended && tasks.some((t) => !closedTasks.includes(t.toolUseId))
  const closeTasks = (): void => setClosedTasks(tasks.map((t) => t.toolUseId))
  const title = session?.name?.trim() || folder

  const lastAssistant = (() => {
    for (let i = state.items.length - 1; i >= 0; i--) if (state.items[i].kind === 'assistant') return i
    return -1
  })()

  const empty = state.items.length === 0 && queued.length === 0
  const readOnlyHint = ended
    ? 'Session ended'
    : session === undefined
      ? 'Connecting…'
      : session?.tmux
        ? 'Not a TUI — read only'
        : 'Not in tmux — read only'

  const actions = (variant: 'chevron' | 'dots') => (
    <ActionsMenu
      variant={variant}
      disabled={!drivable || cmdRunning}
      commands={commands}
      onNeedCommands={loadCommands}
      onCompact={() => void runCommand('/compact')}
      onClear={() => setConfirmClear(true)}
      onEffort={(l) => void pickEffort(l)}
      onContext={() => void runCommand('/context')}
      onUsage={() => void runCommand('/usage')}
      onPick={(name) => setInsert({ id: Date.now(), text: `/${name} ` })}
      onOpenTerminal={openTerminal}
    />
  )

  return (
    <div ref={root} className="chat flex h-full overflow-hidden bg-ink">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className={`${titleBar ? 'drag ' : ''}flex h-11 shrink-0 items-center gap-2 bg-ink px-4`}>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${HEADER_DOT[shown]}`}
          title={cmdRunning ? 'Typing into the terminal…' : label}
        />
        <div className="min-w-0 truncate text-[14px] font-medium text-title" title={cwd}>
          {title}
        </div>
        {actions('chevron')}
        {title !== folder && (
          <span className="no-drag max-w-[40%] shrink-0 truncate rounded-md bg-elevated px-1.5 py-0.5 text-[12px] leading-4 text-muted" title={cwd}>
            {folder}
          </span>
        )}
        {link === 'reconnecting' && (
          <span className="animate-glow shrink-0 rounded-full bg-sky-400/15 px-2.5 py-0.5 text-[11px] text-sky-400">Reconnecting…</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {tasks.length > 0 && !showTasks && !ended && (
            <button
              onClick={() => setClosedTasks([])}
              title="Show the Background tasks panel"
              className="no-drag mr-1 shrink-0 rounded-lg bg-elevated px-2 py-1 text-[12.5px] leading-4 text-muted transition-colors hover:text-title"
            >
              Tasks {tasks.length}
            </button>
          )}
          {openTerminal && <ModeSwitch mode="chat" onTerminal={openTerminal} className="mr-1" />}
          {actions('dots')}
        </div>
      </div>

      {ended && (
        <div className="flex shrink-0 items-center gap-3 bg-panel px-4 py-2">
          <span className="text-sm text-muted">Session ended. This is a read-only copy of its transcript.</span>
          <Button className="ml-auto" variant="primary" disabled={resuming} onClick={() => void resume()}>
            {resuming ? 'Resuming…' : 'Resume in tmux'}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={onScroll}
          onClick={onClick}
          className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          <div className="mx-auto flex max-w-[740px] flex-col gap-6">
            {loadingOlder && <div className="animate-glow text-center text-[12px] text-faint">Loading earlier messages…</div>}
            {empty && (
              <div className="py-16 text-center text-sm text-faint">
                {link === 'connecting' || starting ? 'Connecting…' : link === 'live' && !loaded ? 'Loading…' : 'Nothing in this session yet.'}
              </div>
            )}
            {shownSegments.map((seg) =>
              seg.kind === 'tools' ? (
                <ToolGroup key={`tools-${seg.id}`} blocks={seg.blocks} results={state.results} groups={state.children} />
              ) : seg.item.kind === 'user' ? (
                <UserMessage key={seg.item.id} item={seg.item} />
              ) : seg.item.kind === 'note' ? (
                <NoteLine key={seg.item.id} item={seg.item} />
              ) : (
                <AssistantBlocks
                  key={seg.item.msgId}
                  item={seg.item}
                  live={busy && seg.i === lastAssistant}
                  results={state.results}
                  groups={state.children}
                />
              )
            )}
            {queued.map((p) => (
              <QueuedMessage key={p.id} text={p.text} />
            ))}
            {snapshot && <OutputCard title={snapshot.title} text={snapshot.text} onDismiss={() => setSnapshot(null)} />}
            {waiting && polling && prompt && <PromptCard key={`${prompt.kind}\0${prompt.body}`} prompt={prompt} onAnswer={answer} onTerminal={openTerminal} />}
            {busy && !waiting && <div className="animate-glow text-sm text-faint">Working…</div>}
          </div>
        </div>

        {showTasks && !wide && <TasksPanel tasks={tasks} target={target} active={active} onClose={closeTasks} />}

        {notice && (
          <div className="flex shrink-0 items-center gap-3 bg-panel px-4 py-1.5 text-[12px] text-amber">
            <span className="min-w-0 flex-1">
              {notice.kind === 'draft'
                ? 'The terminal has unsent text.'
                : notice.kind === 'screen'
                  ? 'The terminal is not showing that prompt.'
                  : notice.text}
            </span>
            {openTerminal && notice.kind !== 'text' && (
              <button onClick={openTerminal} className="shrink-0 text-fg underline-offset-2 hover:underline">
                {notice.kind === 'screen' ? 'Answer in terminal' : 'Open in terminal'}
              </button>
            )}
          </div>
        )}

        <ChatComposer
          draftKey={`chat:${sessionId}`}
          active={active}
          disabled={!drivable}
          disabledHint={readOnlyHint}
          busy={busy}
          onSend={sendText}
          onInterrupt={interrupt}
          commands={commands ?? BUILTIN_COMMANDS}
          onNeedCommands={loadCommands}
          insert={insert}
          leftControls={
            !ended && (footerMode ?? state.mode) ? (
              <ModeMenu up mode={footerMode ?? state.mode} disabled={!drivable || cmdRunning} onPick={(m) => void setMode(m)} />
            ) : null
          }
          rightControls={
            !ended && drivable ? (
              <>
                <PickMenu title="Model" value={model} options={modelOptions} onPick={(m) => void setModel(m)} />
                <PickMenu
                  title="Effort"
                  value={shownEffort}
                  placeholder="Effort"
                  options={EFFORT_LEVELS.map((l) => ({ value: l, label: cap(l) }))}
                  disabled={cmdRunning}
                  onPick={(l) => void pickEffort(l)}
                />
              </>
            ) : null
          }
          chips={[...chips, ...(footer?.modeExtras ?? [])]}
          ctx={ctx}
          autoCompactLeft={footer?.autoCompactLeft}
          usage={usage}
          usageFallback={usageFallback}
          onContextOpen={loadUsage}
          onCompact={!ended && drivable ? () => void runCommand('/compact') : undefined}
          compactBusy={cmdRunning}
          folder={folder}
          branch={state.branch}
        />
      </div>
      </div>
      {showTasks && wide && <TasksPanel side tasks={tasks} target={target} active={active} onClose={closeTasks} />}

      {confirmClear && (
        <Modal
          title="Clear conversation"
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmClear(false)
                  void runCommand('/clear')
                }}
              >
                Clear
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg/85">Clear the conversation? Claude starts a fresh session in the same terminal.</p>
        </Modal>
      )}
    </div>
  )
}
