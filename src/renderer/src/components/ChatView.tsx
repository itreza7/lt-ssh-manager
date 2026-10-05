import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatCommand,
  ChatCommandBody,
  ChatMode,
  ChatStreamData,
  ChatStreamEnd
} from '../../../shared/chatProtocol'
import { initialChatState, reduceEvents, type ChatUiState } from '../lib/chatState'
import { ChatComposer } from './ChatComposer'
import { Button } from './Modal'
import { Select } from './Select'
import { AssistantBlocks, NoteLine, QueuedMessage, UserMessage } from './chat/Blocks'
import { leaf } from './chat/format'
import { RequestCard, type Decision } from './chat/Requests'

interface Props {
  connectionId: string
  password?: string
  chatId: string
  active: boolean
}

// Closer to the bottom than this and a new message keeps the view pinned there.
const NEAR_BOTTOM_PX = 80
// Wait before each stream reconnect attempt (seconds), then stay at the last.
const BACKOFF_S = [1, 2, 4, 8, 10]
const ALIVE_MS = 10_000

const MODES: { value: ChatMode; label: string }[] = [
  { value: 'bypass', label: "Don't ask" },
  { value: 'default', label: 'Ask first' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan' }
]

type Link = 'connecting' | 'live' | 'reconnecting'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The model the session reports is a resolved id (`claude-opus-4-…`) while the
 * list is keyed by alias (`opus`), so match by containment before giving up.
 */
function modelValue(models: ChatUiState['models'], model: string | null): string {
  if (!model) return models[0]?.value ?? ''
  const exact = models.find((m) => m.value === model)
  if (exact) return exact.value
  const alias = models.find((m) => m.value !== 'default' && model.includes(m.value))
  return alias?.value ?? model
}

export function ChatView({ connectionId, password, chatId, active }: Props) {
  const [state, setState] = useState<ChatUiState>(initialChatState)
  const [link, setLink] = useState<Link>('connecting')
  // From chatList: whether the relay's tmux session exists. Null until asked.
  const [alive, setAlive] = useState<boolean | null>(null)
  const [pending, setPending] = useState<{ id: string; text: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  // Bumped to re-open the stream (after a restart) and to re-ask chatList.
  const [linkKey, setLinkKey] = useState(0)

  // Byte offset after the last whole event applied — where a reconnect resumes.
  const offset = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  // The event stream. Everything about it lives in this one effect so cleanup is
  // total: the timer, the subscriptions and the main-side stream all end with it.
  useEffect(() => {
    let cancelled = false
    let streamId: string | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // Data and end notices can reach us before chatStream's own promise has
    // told us the id; keep them until it has.
    const early: ChatStreamData[] = []
    const earlyEnds: ChatStreamEnd[] = []

    const take = (d: ChatStreamData): void => {
      offset.current = d.next
      attempt = 0
      setState((s) => reduceEvents(s, d.events))
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
      try {
        const r = await window.api.chatStream({ connectionId, password, chatId, offset: offset.current })
        if (cancelled) {
          void window.api.chatUnstream({ streamId: r.streamId })
          return
        }
        streamId = r.streamId
        setLink('live')
        for (const d of early.splice(0)) if (d.streamId === r.streamId) take(d)
        if (earlyEnds.splice(0).some((d) => d.streamId === r.streamId)) dropped()
      } catch {
        dropped()
      }
    }
    void open()

    return () => {
      cancelled = true
      clearTimeout(timer)
      offData()
      offEnd()
      if (streamId !== null) void window.api.chatUnstream({ streamId })
    }
  }, [connectionId, password, chatId, linkKey])

  // Is the relay's session still there? Only asked while on screen.
  useEffect(() => {
    if (!active) return
    let off = false
    const ask = async (): Promise<void> => {
      try {
        const list = await window.api.chatList({ connectionId, password })
        if (!off) setAlive(list.find((c) => c.chatId === chatId)?.alive ?? false)
      } catch {
        /* a dropped link says nothing about the relay; keep what we knew */
      }
    }
    void ask()
    const t = setInterval(() => void ask(), ALIVE_MS)
    return () => {
      off = true
      clearInterval(t)
    }
  }, [active, connectionId, password, chatId, linkKey])

  const sendCmd = useCallback(
    async (body: ChatCommandBody): Promise<string> => {
      const cmd = { ...body, id: crypto.randomUUID() } as ChatCommand
      await window.api.chatSend({ connectionId, password, chatId, cmd })
      return cmd.id
    },
    [connectionId, password, chatId]
  )

  const run = (body: ChatCommandBody): void => {
    setError(null)
    sendCmd(body).catch((e) => setError(errText(e)))
  }

  const sendText = (text: string): void => {
    setError(null)
    const id = crypto.randomUUID()
    const cmd = { t: 'user', text, id } as ChatCommand
    // Shown dimmed until the relay echoes it back as a real message.
    setPending((p) => [...p, { id, text }])
    window.api.chatSend({ connectionId, password, chatId, cmd }).catch((e) => {
      setPending((p) => p.filter((x) => x.id !== id))
      setError(errText(e))
    })
  }

  const answer = (reqId: string) => async (d: Decision): Promise<void> => {
    try {
      await sendCmd({ t: 'answer', reqId, ...d })
    } catch (e) {
      setError(errText(e))
      throw e
    }
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setError(null)
    try {
      await window.api.chatRestart({ connectionId, password, chatId })
      setAlive(true)
      setLinkKey((k) => k + 1)
    } catch (e) {
      setError(errText(e))
    } finally {
      setRestarting(false)
    }
  }

  // Queued messages leave the dim list once the relay has echoed them. Echoes
  // are recent, so only the tail of the transcript is searched.
  const echoed = useMemo(() => {
    const ids = new Set<string>()
    for (let i = state.items.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      const it = state.items[i]
      if (it.kind === 'user') ids.add(it.id)
    }
    return ids
  }, [state.items])
  const queued = pending.filter((p) => !echoed.has(p.id))
  useEffect(() => {
    setPending((p) => {
      const rest = p.filter((x) => !echoed.has(x.id))
      return rest.length === p.length ? p : rest
    })
  }, [echoed])

  // Stay pinned to the bottom only if the reader hasn't scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [state.items, state.children, state.requests, queued.length, error])

  // A tab that was hidden may have lost its scroll position.
  useEffect(() => {
    const el = scroller.current
    if (active && el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [active])

  const onScroll = (): void => {
    const el = scroller.current
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  // Links open in the OS browser (http/https only); never navigate the app.
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) window.api.openExternal(href)
  }

  const stopped = state.exited !== null || alive === false
  const running = state.status === 'running' || state.status === 'waiting'
  const shown = stopped ? 'stopped' : link === 'reconnecting' ? 'reconnecting' : state.status === 'starting' ? 'idle' : state.status
  const DOT: Record<string, string> = {
    idle: 'bg-faint',
    running: 'bg-signal dot-glow animate-pulse',
    waiting: 'bg-amber dot-glow',
    stopped: 'bg-danger/60',
    reconnecting: 'bg-sky-400 animate-pulse'
  }

  const cwd = state.cwd ?? ''
  const modelOptions = useMemo(() => {
    const value = modelValue(state.models, state.model)
    const opts = state.models.map((m) => ({ value: m.value, label: m.displayName }))
    // A model the list does not name (still loading, or a custom id) is still the current one.
    return value && !opts.some((o) => o.value === value) ? [{ value, label: value }, ...opts] : opts
  }, [state.models, state.model])

  const ctxPct = state.context ? Math.round((state.context.inputTokens / state.context.contextWindow) * 100) : null
  const limitTip = state.rateLimit?.windows
    ? Object.entries(state.rateLimit.windows)
        .map(([k, w]) => `${k.replace(/_/g, ' ')}: ${Math.round(w.utilization * 100)}%`)
        .join('\n')
    : undefined

  const lastAssistant = (() => {
    for (let i = state.items.length - 1; i >= 0; i--) if (state.items[i].kind === 'assistant') return i
    return -1
  })()

  const empty = state.items.length === 0 && queued.length === 0

  return (
    <div className="chat flex h-full flex-col overflow-hidden border-t border-line bg-ink">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[shown]}`} title={shown} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-medium text-fg" title={cwd || undefined}>
            {cwd ? leaf(cwd) : 'Chat'}
          </div>
        </div>
        {link === 'reconnecting' && (
          <span className="animate-glow shrink-0 rounded-full bg-sky-400/15 px-2.5 py-0.5 text-[11px] text-sky-400">Reconnecting…</span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {state.costUsd > 0 && (
            <span className="shrink-0 font-mono text-[12px] text-muted" title={limitTip}>
              {state.costUsd < 0.01 ? '<$0.01' : `$${state.costUsd.toFixed(2)}`}
            </span>
          )}
          {ctxPct !== null && (
            <span
              className={`shrink-0 font-mono text-[12px] ${ctxPct >= 90 ? 'text-danger' : ctxPct >= 70 ? 'text-amber' : 'text-muted'}`}
              title="Context window in use"
            >
              {ctxPct}%
            </span>
          )}
          {modelOptions.length > 0 && (
            <Select
              value={modelValue(state.models, state.model)}
              options={modelOptions}
              onChange={(m) => run({ t: 'set_model', model: m })}
              width={150}
            />
          )}
          <Select
            value={state.mode ?? 'bypass'}
            options={MODES}
            onChange={(m) => run({ t: 'set_mode', mode: m as ChatMode })}
            width={160}
          />
          {running && (
            <button
              onClick={() => run({ t: 'interrupt' })}
              title="Stop the current turn (Esc)"
              className="shrink-0 rounded-lg border border-danger/40 bg-danger/15 px-2.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/25"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {stopped && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-elevated/60 px-4 py-2">
          <span className="text-sm text-muted">Session stopped{state.exited ? ` — ${state.exited}` : ''}</span>
          <Button className="ml-auto" variant="primary" disabled={restarting} onClick={() => void restart()}>
            {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      )}

      {error && (
        <div className="shrink-0 border-b border-line bg-elevated/60 px-4 py-1.5 text-[12px] text-red-400">{error}</div>
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        onClick={onClick}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
          {empty && (
            <div className="py-16 text-center text-sm text-faint">
              {link === 'connecting' ? 'Connecting…' : 'Ask Claude anything about this project.'}
            </div>
          )}
          {state.items.map((it, i) =>
            it.kind === 'user' ? (
              <UserMessage key={it.id} item={it} />
            ) : it.kind === 'note' ? (
              <NoteLine key={it.id} item={it} />
            ) : (
              <AssistantBlocks
                key={it.msgId}
                item={it}
                live={running && i === lastAssistant}
                results={state.results}
                groups={state.children}
              />
            )
          )}
          {queued.map((p) => (
            <QueuedMessage key={p.id} text={p.text} />
          ))}
          {/* Between the user's message and the first streamed block, nothing
              else says Claude has started. */}
          {running && state.requests.length === 0 && state.items[state.items.length - 1]?.kind === 'user' && (
            <div className="animate-glow text-sm text-faint">Thinking…</div>
          )}
          {state.requests.map((r) => (
            <RequestCard key={r.reqId} req={r} onAnswer={answer(r.reqId)} />
          ))}
        </div>
      </div>

      <ChatComposer
        draftKey={`chat:${chatId}`}
        active={active}
        disabled={stopped}
        running={running}
        slashCommands={state.slashCommands}
        onSend={sendText}
        onInterrupt={() => run({ t: 'interrupt' })}
      />
    </div>
  )
}
