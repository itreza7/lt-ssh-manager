import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { GitChange, GitFileDiff, GitReview } from '../../../shared/types'
import { resolveFontStack } from '../lib/terminalSettings'
import type { EditorSettings } from '../lib/terminalSettings'

// Monaco is the bulk of the renderer bundle and most sessions never open a diff.
const DiffEditor = lazy(() => import('./DiffEditor').then((m) => ({ default: m.DiffEditor })))

interface Props {
  connectionId: string
  password?: string
  /** Any directory inside the repository; the server resolves the root. */
  dir: string
  active: boolean
  settings: EditorSettings
}

const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
const dirName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : ''
}
const short = (sha: string): string => sha.slice(0, 7)

/**
 * Colour for one status letter.
 *
 * Green for content that appeared, red for content that went away, amber for
 * content that changed in place — the same three meanings the diff body uses, so
 * the list and the diff agree at a glance. `U` (unmerged) is red because a
 * conflict is the one state here you cannot review your way out of.
 */
function letterClass(ch: string): string {
  if (ch === 'A' || ch === '?') return 'text-signal'
  if (ch === 'D' || ch === 'U') return 'text-danger'
  if (ch === 'M' || ch === 'T') return 'text-amber'
  if (ch === 'R' || ch === 'C') return 'text-muted'
  return 'text-faint'
}

/** Long-form of a status pair, for the row's tooltip. */
function describe(c: GitChange): string {
  const one = (ch: string, where: string): string | null => {
    const word = {
      M: 'modified',
      A: 'added',
      D: 'deleted',
      R: 'renamed',
      C: 'copied',
      U: 'unmerged',
      T: 'type changed'
    }[ch]
    return word ? `${word} ${where}` : null
  }
  if (c.untracked) return 'untracked'
  return [one(c.x, 'in the index'), one(c.y, 'in the working tree')].filter(Boolean).join(', ')
}

type Status = 'loading' | 'ready' | 'error'

export function ReviewView({ connectionId, password, dir, active, settings }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<GitReview | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** Set when a refresh finds HEAD somewhere else than the pass it replaced. */
  const [movedFrom, setMovedFrom] = useState<string | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [inline, setInline] = useState(false)

  // Guards the diff fetch: clicking down a list faster than the round trip would
  // otherwise let an earlier reply land after a later one and show the wrong file.
  const reqRef = useRef(0)

  const load = async (isRefresh: boolean): Promise<void> => {
    if (isRefresh) setRefreshing(true)
    try {
      const next = await window.api.gitReview({ connectionId, dir, password })
      setReview((prev) => {
        setMovedFrom(prev && prev.base && prev.base !== next.base ? prev.base : null)
        return next
      })
      setStatus('ready')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // A failed refresh keeps the pass already on screen: a stale diff you can
      // still read beats an empty pane, as long as the failure is visible.
      if (!isRefresh) setStatus('error')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, dir])

  const files = review?.files ?? []
  const current = useMemo(() => files.find((f) => f.path === selected) ?? null, [files, selected])

  // Select the first file once a pass lands, and drop a selection that the new
  // pass no longer lists (the agent reverted it, or committed it).
  useEffect(() => {
    if (!review) return
    if (selected && review.files.some((f) => f.path === selected)) return
    setSelected(review.files[0]?.path ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review])

  // Fetch on every selection rather than caching by path. The working tree may be
  // under active edit — that is the whole reason this pane exists — so a cached
  // right-hand side would quietly show what the file looked like a minute ago.
  useEffect(() => {
    if (!review || !current) {
      setDiff(null)
      return
    }
    const seq = ++reqRef.current
    setDiffLoading(true)
    setDiffError(null)
    void (async () => {
      try {
        const res = await window.api.gitFile({
          connectionId,
          root: review.root,
          base: current.untracked ? '' : review.base,
          path: current.path,
          basePath: current.from,
          password
        })
        if (reqRef.current !== seq) return
        setDiff(res)
      } catch (e) {
        if (reqRef.current !== seq) return
        setDiff(null)
        setDiffError(e instanceof Error ? e.message : String(e))
      } finally {
        if (reqRef.current === seq) setDiffLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path, review])

  // Cmd/Ctrl+R refreshes, only while this tab is active.
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (!refreshing) void load(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshing])

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        <span className="animate-glow mr-2 text-signal">⟳</span> Reading {dir}…
      </div>
    )
  }
  if (status === 'error' || !review) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-sm text-danger">Could not review this directory.</div>
        <div className="max-w-md font-mono text-xs text-faint">{error}</div>
      </div>
    )
  }

  const blocked =
    diff && (diff.base.note === 'binary' || diff.work.note === 'binary')
      ? 'binary'
      : diff && (diff.base.note === 'too-large' || diff.work.note === 'too-large')
        ? 'too-large'
        : null

  return (
    <div className="flex h-full flex-col bg-ink">
      {/* header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm text-fg">{baseName(review.root)}</span>
          <span className="shrink-0 rounded-full border border-line bg-elevated/60 px-2 py-0.5 font-mono text-[10px] text-muted">
            {review.branch || `detached @ ${short(review.base)}`}
          </span>
          {review.base ? (
            <span
              className="shrink-0 font-mono text-[11px] text-faint"
              title={`Every diff compares against commit ${review.base}`}
            >
              vs {short(review.base)}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-faint">no commits yet</span>
          )}
          <span className="shrink-0 text-[11px] text-faint">
            {files.length} file{files.length === 1 ? '' : 's'}
            {review.truncated && ' (truncated)'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error && <span className="font-mono text-xs text-danger">{error}</span>}
          <div className="flex rounded-lg border border-line p-0.5 text-xs">
            {(
              [
                ['split', false],
                ['inline', true]
              ] as const
            ).map(([label, v]) => (
              <button
                key={label}
                onClick={() => setInline(v)}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  inline === v ? 'bg-signal/20 text-signal' : 'text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {movedFrom && (
        <div className="shrink-0 border-b border-line bg-amber/10 px-4 py-1.5 text-[11px] text-amber">
          HEAD moved since the last look — {short(movedFrom)} → {short(review.base)}. Diffs now
          compare against the new commit.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* file list */}
        <div className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface/30">
          {files.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-faint">
              Nothing has changed since {review.base ? short(review.base) : 'the repo was created'}.
            </div>
          ) : (
            files.map((f) => {
              const on = f.path === selected
              return (
                <button
                  key={f.path}
                  onClick={() => setSelected(f.path)}
                  title={`${f.path}\n${describe(f)}`}
                  className={`flex w-full items-baseline gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
                    on
                      ? 'border-signal bg-signal/10'
                      : 'border-transparent hover:bg-elevated/40'
                  }`}
                >
                  <span className="shrink-0 font-mono text-[11px]">
                    <span className={letterClass(f.x)}>{f.x === ' ' ? '·' : f.x}</span>
                    <span className={letterClass(f.y)}>{f.y === ' ' ? '·' : f.y}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate font-mono text-xs ${on ? 'text-fg' : 'text-muted'}`}
                    >
                      {baseName(f.path)}
                    </span>
                    {/* The old path, when renamed — otherwise the containing
                        directory, which is what tells two same-named files apart. */}
                    {(f.from || dirName(f.path)) && (
                      <span className="block truncate font-mono text-[10px] text-faint">
                        {f.from ? `← ${f.from}` : dirName(f.path)}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
          {review.truncated && (
            <div className="border-t border-line px-3 py-2 text-[10px] text-faint">
              Only the first {files.length} changes are shown — this tree has more.
            </div>
          )}
        </div>

        {/* diff */}
        <div className="min-w-0 flex-1">
          {!current ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              No changes to review.
            </div>
          ) : diffLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              <span className="animate-glow mr-2 text-signal">⟳</span> Loading {baseName(current.path)}…
            </div>
          ) : diffError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <div className="text-sm text-danger">Could not read this file.</div>
              <div className="max-w-md font-mono text-xs text-faint">{diffError}</div>
            </div>
          ) : blocked ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <div className="text-sm text-muted">
                {blocked === 'binary' ? 'This file is binary.' : 'This file is too large to diff.'}
              </div>
              <div className="max-w-md font-mono text-xs text-faint">{current.path}</div>
            </div>
          ) : diff ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted">
                  <span className="animate-glow mr-2 text-signal">⟳</span> Loading diff…
                </div>
              }
            >
              <DiffEditor
                name={current.path}
                original={diff.base.text}
                modified={diff.work.text}
                inline={inline}
                fontFamily={resolveFontStack(settings.fontFamily)}
                fontSize={settings.fontSize}
                wordWrap={settings.wordWrap}
              />
            </Suspense>
          ) : null}
        </div>
      </div>

      {/* status bar */}
      <div className="flex shrink-0 items-center gap-4 border-t border-line bg-surface/60 px-4 py-1 font-mono text-[11px] text-faint">
        <span className="truncate text-muted">{review.root}</span>
        <div className="flex-1" />
        {current && diff && (
          <>
            {diff.base.note === 'absent' && <span className="text-signal">new file</span>}
            {diff.work.note === 'absent' && <span className="text-danger">deleted</span>}
            <span className="truncate">{current.path}</span>
          </>
        )}
        <span>read-only</span>
      </div>
    </div>
  )
}
