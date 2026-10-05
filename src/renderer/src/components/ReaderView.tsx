import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseTranscript, type ReaderEntry, type ReaderSession } from '../../../shared/claudeTranscript'
import { renderMarkdown } from './MarkdownPreview'
import { Select } from './Select'

interface Props {
  connectionId: string
  password?: string
  /** Show only this directory's transcripts; without it, every project's. */
  dir?: string
  active: boolean
}

const POLL_MS = 1500
const LIST_MS = 10_000
// Closer to the bottom than this and a new message keeps the view pinned there.
const NEAR_BOTTOM_PX = 80

const leaf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

function ago(mtime: number): string {
  const s = Math.max(0, Date.now() / 1000 - mtime)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const firstUser = (entries: ReaderEntry[]): string | undefined => {
  const e = entries.find((x) => x.kind === 'user')
  return e && e.kind === 'user' ? e.text.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined
}

// One message. Memoized so a poll that appends an entry doesn't re-render the
// markdown of every earlier one.
const Message = memo(function Message({ entry }: { entry: ReaderEntry }) {
  const html = useMemo(
    () => (entry.kind === 'tool' ? '' : renderMarkdown(entry.text)),
    [entry]
  )
  if (entry.kind === 'tool') {
    return (
      <div dir="auto" className="truncate px-1 font-mono text-[11px] text-faint">
        {entry.name}
        {entry.summary && ` · ${entry.summary}`}
      </div>
    )
  }
  const user = entry.kind === 'user'
  return (
    <div className={`rounded-lg px-4 py-2.5 ${user ? 'border border-line bg-elevated/60' : ''}`}>
      <div className={`eyebrow ${user ? '' : 'text-accent'}`}>{user ? 'You' : 'Claude'}</div>
      <div dir="auto" className="md-body mt-1" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

export function ReaderView({ connectionId, password, dir, active }: Props) {
  const [sessions, setSessions] = useState<ReaderSession[] | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [entries, setEntries] = useState<ReaderEntry[]>([])
  const [snippets, setSnippets] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  // Bumped whenever the open file changes (or the view's inputs do), so a read
  // that was in flight for the old one is dropped when it lands.
  const gen = useRef(0)
  // Byte offset of the next read; null until the first (tail) read has landed.
  const offset = useRef<number | null>(null)
  const inFlight = useRef(-1)
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  // The transcript list. Newest first, so the head is what "follow" tracks.
  const list = useCallback(async (): Promise<void> => {
    const g = gen.current
    try {
      const next = await window.api.readerSessions({ connectionId, password, dir })
      if (g !== gen.current) return
      setSessions(next)
      setError(null)
    } catch (e) {
      if (g === gen.current) setError(errText(e))
    }
  }, [connectionId, password, dir])

  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    gen.current++
    known.current = null
    setSessions(null)
    setPath(null)
    void list()
  }, [list])

  // Re-list while on screen, for follow-latest and to show new sessions.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => void list(), LIST_MS)
    return () => clearInterval(t)
  }, [active, list])

  // Settle on a file: the newest at first; while following, a session that
  // newly appeared. Not merely the newest mtime — two live agents would trade
  // that every list and the view would flip between them.
  useEffect(() => {
    if (!sessions?.length) return
    const prev = known.current
    known.current = new Set(sessions.map((s) => s.path))
    const fresh = prev ? sessions.find((s) => !prev.has(s.path)) : undefined
    setPath((cur) => (cur === null ? sessions[0].path : follow && fresh ? fresh.path : cur))
  }, [sessions, follow])

  // Open a file: start over from its tail.
  useEffect(() => {
    if (!path) return
    const g = ++gen.current
    offset.current = null
    nearBottom.current = true
    setEntries([])
    setError(null)
    window.api
      .readerRead({ connectionId, password, path, offset: 0, tail: true })
      .then((chunk) => {
        if (g !== gen.current) return
        const parsed = parseTranscript(chunk.text)
        offset.current = chunk.next
        setEntries(parsed)
        const snip = firstUser(parsed)
        if (snip) setSnippets((s) => ({ ...s, [path]: snip }))
      })
      .catch((e) => {
        if (g === gen.current) setError(errText(e))
      })
  }, [connectionId, password, path])

  // Follow the file while it is on screen.
  useEffect(() => {
    if (!active || !path) return
    const poll = async (): Promise<void> => {
      const g = gen.current
      const off = offset.current
      if (off === null || inFlight.current === g) return
      inFlight.current = g
      try {
        const chunk = await window.api.readerRead({ connectionId, password, path, offset: off })
        if (g !== gen.current) return
        offset.current = chunk.next
        setError(null)
        // A file that shrank was read again from the start: replace, don't append
        // — even when nothing complete came back yet.
        const restarted = chunk.size < off
        if (!chunk.text && !restarted) return
        const parsed = parseTranscript(chunk.text)
        setEntries((prev) => (restarted ? parsed : parsed.length ? [...prev, ...parsed] : prev))
      } catch (e) {
        if (g === gen.current) setError(errText(e))
      } finally {
        if (inFlight.current === g) inFlight.current = -1
      }
    }
    const t = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(t)
  }, [active, connectionId, password, path])

  // Stay pinned to the bottom only if the reader hasn't scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [entries])

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

  const options = (sessions ?? []).map((s) => ({
    value: s.path,
    label: `${ago(s.mtime)} · ${snippets[s.path] ?? leaf(s.path)}`
  }))

  const pick = (p: string): void => {
    // Choosing anything but the newest means "stay here", not "follow".
    if (p !== sessions?.[0]?.path) setFollow(false)
    setPath(p)
  }

  return (
    <div className="reader flex h-full flex-col overflow-hidden border-t border-line bg-ink">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 leading-tight">
          <div className="eyebrow">Reader</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-faint" title={dir}>
            {dir ?? 'All projects'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {options.length > 0 && <Select value={path ?? ''} options={options} onChange={pick} width={340} />}
          <button
            onClick={() => setFollow((f) => !f)}
            title="Switch to the newest conversation when one appears"
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
              follow ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted hover:border-faint'
            }`}
          >
            Follow latest
          </button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-line bg-elevated/60 px-4 py-1.5 text-[12px] text-red-400">
          {error}
        </div>
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        onClick={onClick}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {sessions !== null && sessions.length === 0 ? (
            <div className="py-10 text-center text-sm text-faint">
              No Claude Code conversations found on this server{dir ? ' for this folder' : ''}.
            </div>
          ) : (
            entries.map((e, i) => <Message key={i} entry={e} />)
          )}
        </div>
      </div>
    </div>
  )
}
