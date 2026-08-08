import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteWorktree, WorktreeScan } from '../../../shared/types'
import type { WorktreeInspect } from '../../../shared/worktrees'
import {
  WORKTREE_DIR,
  checkedOutBranches,
  isBusy,
  mainWorktree,
  refNameError,
  worktreeBase,
  worktreeNameError
} from '../../../shared/worktrees'

interface Props {
  connectionId: string
  password?: string
  /** Any directory inside the repository; the server resolves the root. */
  dir: string
  active: boolean
  /** Start Claude Code in a worktree, in its own tab. */
  onOpenClaude: (dir: string) => void
}

type Status = 'loading' | 'ready' | 'error'

const leaf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export function WorktreeView({
  connectionId,
  password,
  dir,
  active,
  onOpenClaude
}: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [scan, setScan] = useState<WorktreeScan | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // The create form, closed until asked for.
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('')
  // Whether the user has edited the branch field themselves. Until they do it
  // tracks the name, which is what you want when the two are the same word and
  // deeply annoying once they aren't.
  const [branchTouched, setBranchTouched] = useState(false)
  const [from, setFrom] = useState('')
  const [existing, setExisting] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  // What the open confirm found in the tree it is about to delete. Only one
  // confirm is open at a time, so this does not need to be keyed by path.
  const [inspect, setInspect] = useState<WorktreeInspect | null>(null)
  const [inspecting, setInspecting] = useState(false)

  const load = useCallback(
    async (quiet = false): Promise<void> => {
      if (!quiet) setStatus('loading')
      setRefreshing(true)
      try {
        const next = await window.api.gitWorktrees({ connectionId, dir, password })
        setScan(next)
        setError(next.error ?? null)
        setStatus(next.error ? 'error' : 'ready')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      } finally {
        setRefreshing(false)
      }
    },
    [connectionId, dir, password]
  )

  // Loads when the pane first comes on screen, and never polls. A worktree list
  // changes when somebody changes it, which is rare and always deliberate — a
  // timer here would be a repeating dial for an answer that almost never moves.
  useEffect(() => {
    if (active && status === 'loading') void load()
  }, [active, status, load])

  const main = useMemo(() => (scan ? mainWorktree(scan) : null), [scan])
  const base = useMemo(() => (scan ? worktreeBase(scan) : null), [scan])
  const taken = useMemo(() => (scan ? checkedOutBranches(scan) : new Set<string>()), [scan])
  const free = useMemo(
    () => (scan?.branches ?? []).filter((b) => !taken.has(b)),
    [scan, taken]
  )

  // Sort: the repo itself first, then whoever is busy, then by name. The main
  // tree pins to the top because everything else is described relative to it.
  const rows = useMemo(() => {
    const list = [...(scan?.worktrees ?? [])]
    return list.sort((a, b) => {
      if (a === main) return -1
      if (b === main) return 1
      const busy = Number(isBusy(b)) - Number(isBusy(a))
      return busy || a.path.localeCompare(b.path)
    })
  }, [scan, main])

  const openForm = (): void => {
    setCreating(true)
    setFormError(null)
    setName('')
    setBranch('')
    setBranchTouched(false)
    setMode('new')
    setExisting(free[0] ?? '')
    // Start from wherever the repository itself is, which is what "branch off
    // main" means to someone looking at this list.
    setFrom(main?.branch ?? 'HEAD')
  }

  const effectiveBranch = mode === 'new' ? (branchTouched ? branch : name) : existing

  const submit = async (): Promise<void> => {
    if (!main) return
    const nameErr = worktreeNameError(name)
    if (nameErr) return setFormError(nameErr)
    const branchErr = refNameError(effectiveBranch)
    if (branchErr) return setFormError(branchErr)
    if (mode === 'new') {
      const fromErr = refNameError(from, 'start point')
      if (fromErr) return setFormError(fromErr)
    }
    setFormError(null)
    setWorking('create')
    try {
      await window.api.gitWorktreeAdd({
        connectionId,
        repoRoot: main.path,
        name,
        start:
          mode === 'new'
            ? { kind: 'new', branch: effectiveBranch, from }
            : { kind: 'existing', branch: effectiveBranch },
        password
      })
      setCreating(false)
      await load(true)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(null)
    }
  }

  // Opening the confirm is itself a remote read. git deletes a worktree's ignored
  // files without ever refusing — verified — so the confirm cannot honestly offer
  // the button until it knows whether this tree is holding an `.env`.
  const askRemove = async (w: RemoteWorktree): Promise<void> => {
    setConfirmRemove(w.path)
    setInspect(null)
    setInspecting(true)
    try {
      setInspect(await window.api.gitWorktreeInspect({ connectionId, path: w.path, password }))
    } catch (e) {
      setInspect({
        dirty: 0,
        ignored: [],
        truncated: false,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setInspecting(false)
    }
  }

  const remove = async (w: RemoteWorktree): Promise<void> => {
    if (!main) return
    setConfirmRemove(null)
    setWorking(w.path)
    try {
      await window.api.gitWorktreeRemove({
        connectionId,
        repoRoot: main.path,
        path: w.path,
        password
      })
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(null)
    }
  }

  const busyCount = rows.filter(isBusy).length

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-line bg-ink">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 leading-tight">
          <div className="eyebrow">Worktrees</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-faint" title={main?.path ?? dir}>
            {main ? main.path : dir}
            {rows.length > 0 && (
              <>
                {' · '}
                {rows.length} tree{rows.length === 1 ? '' : 's'}
                {busyCount > 0 && <span className="text-signal"> · {busyCount} busy</span>}
              </>
            )}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={() => (creating ? setCreating(false) : openForm())}
            disabled={!main || status === 'loading'}
            className="rounded-md border border-signal/40 bg-signal/10 px-2.5 py-1 text-[11px] text-signal transition-colors hover:bg-signal/20 disabled:opacity-40"
          >
            {creating ? 'Cancel' : 'New worktree'}
          </button>
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-50"
          >
            {refreshing ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {status === 'loading' && (
          <p className="px-3 py-10 text-center text-xs text-faint">Reading the repository…</p>
        )}

        {error && (
          <p className="mx-2 mb-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        {creating && main && (
          <div className="animate-rise mx-2 mb-3 rounded-lg border border-line bg-elevated/40 p-3">
            <div className="eyebrow mb-2">New worktree</div>

            <label className="mb-2 block">
              <span className="mb-1 block text-[11px] text-muted">Folder name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="dt4"
                className="w-full rounded-md border border-line bg-ink px-2 py-1 font-mono text-xs text-fg outline-none focus:border-signal/50"
              />
              {/* Shown up front, because where a worktree lands is the one thing
                  this form decides that the user cannot undo by editing a field. */}
              <span className="mt-1 block truncate font-mono text-[10px] text-faint">
                {base}/{name || '…'}
              </span>
            </label>

            <div className="mb-2 flex gap-3 text-[11px]">
              <label className="flex cursor-pointer items-center gap-1.5 text-muted">
                <input
                  type="radio"
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                  className="accent-signal"
                />
                New branch
              </label>
              <label
                className={`flex items-center gap-1.5 ${free.length === 0 ? 'text-faint' : 'cursor-pointer text-muted'}`}
                title={
                  free.length === 0
                    ? 'Every branch in this repo is already checked out in a worktree'
                    : undefined
                }
              >
                <input
                  type="radio"
                  checked={mode === 'existing'}
                  disabled={free.length === 0}
                  onChange={() => setMode('existing')}
                  className="accent-signal"
                />
                Existing branch
              </label>
            </div>

            {mode === 'new' ? (
              <div className="mb-2 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted">Branch</span>
                  <input
                    value={effectiveBranch}
                    onChange={(e) => {
                      setBranchTouched(true)
                      setBranch(e.target.value)
                    }}
                    placeholder="feature/thing"
                    className="w-full rounded-md border border-line bg-ink px-2 py-1 font-mono text-xs text-fg outline-none focus:border-signal/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted">Starting from</span>
                  <input
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    placeholder="main"
                    list="lt-wt-branches"
                    className="w-full rounded-md border border-line bg-ink px-2 py-1 font-mono text-xs text-fg outline-none focus:border-signal/50"
                  />
                  <datalist id="lt-wt-branches">
                    {(scan?.branches ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </label>
              </div>
            ) : (
              <label className="mb-2 block">
                <span className="mb-1 block text-[11px] text-muted">
                  Branch · {free.length} available
                </span>
                <select
                  value={existing}
                  onChange={(e) => setExisting(e.target.value)}
                  className="w-full rounded-md border border-line bg-ink px-2 py-1 font-mono text-xs text-fg outline-none focus:border-signal/50"
                >
                  {free.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                {/* Named rather than hidden: "where did my branch go" is the
                    question this answers, and git's rule is not obvious. */}
                {taken.size > 0 && (
                  <span className="mt-1 block text-[10px] text-faint">
                    {taken.size} branch{taken.size === 1 ? ' is' : 'es are'} not listed — git allows
                    a branch in only one worktree at a time.
                  </span>
                )}
              </label>
            )}

            {formError && (
              <p className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-[11px] text-danger">
                {formError}
              </p>
            )}

            <button
              onClick={() => void submit()}
              disabled={working === 'create' || !name}
              className="rounded-md border border-signal/40 bg-signal/10 px-3 py-1 text-[11px] text-signal transition-colors hover:bg-signal/20 disabled:opacity-40"
            >
              {working === 'create' ? 'Creating…' : 'Create worktree'}
            </button>
          </div>
        )}

        {status === 'ready' && rows.length === 0 && (
          <p className="px-3 py-10 text-center text-xs text-faint">
            This repository has no worktrees.
          </p>
        )}

        {rows.map((w, i) => {
          const isMain = w === main
          const busy = isBusy(w)
          return (
            <div
              key={w.path}
              style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
              className="animate-rise group mb-1 rounded-lg px-3 py-2.5 transition-colors hover:bg-elevated/50"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${busy ? 'bg-signal dot-glow animate-pulse' : 'bg-faint'}`}
                />
                <span className="shrink-0 text-sm font-medium text-fg/90">{leaf(w.path)}</span>
                {isMain && (
                  <span
                    className="shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-faint"
                    title="The repository itself, not a linked worktree"
                  >
                    REPO
                  </span>
                )}
                {w.detached && (
                  <span className="shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-amber">
                    DETACHED
                  </span>
                )}
                {w.prunable !== null && (
                  <span
                    className="shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-amber"
                    title={w.prunable || 'git considers this worktree stale'}
                  >
                    STALE
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                  {w.head.slice(0, 7)}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-muted" title={w.path}>
                  {w.branch ?? (w.detached ? 'detached HEAD' : '—')}
                </span>
                <div className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {!isMain && (
                    <button
                      onClick={() => void askRemove(w)}
                      disabled={busy || working === w.path}
                      title={
                        busy
                          ? `An agent is working here — ${w.locked || 'the worktree is locked'}`
                          : 'Remove this worktree (the branch is kept)'
                      }
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-line disabled:hover:text-muted"
                    >
                      {working === w.path ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                  <button
                    onClick={() => onOpenClaude(w.path)}
                    className="rounded-md border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] text-signal transition-colors hover:bg-signal/20"
                    title="Start Claude Code in this worktree"
                  >
                    Claude here
                  </button>
                </div>
              </div>

              {/* The lock reason, verbatim. It is the only thing that says which
                  agent holds this tree, and paraphrasing it would lose the name
                  and pid that make it actionable. */}
              {busy && w.locked && (
                <div className="mt-1 truncate font-mono text-[10px] text-signal/70" title={w.locked}>
                  {w.locked}
                </div>
              )}

              {confirmRemove === w.path && (
                <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2">
                  <p className="text-[11px] leading-relaxed text-danger">
                    Remove <span className="font-mono">{leaf(w.path)}</span>? The branch{' '}
                    <span className="font-mono">{w.branch ?? 'checked out here'}</span> is kept —
                    only the checkout goes. git refuses if there is uncommitted work.
                  </p>

                  {inspecting && (
                    <p className="mt-1.5 text-[11px] text-muted">Checking what is in it…</p>
                  )}

                  {/* The pre-flight could not run. Say so rather than letting the
                      silence read as "nothing here" — git's own refusals still
                      apply, but they do not cover ignored files. */}
                  {inspect?.error && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-amber">
                      Could not check the contents ({inspect.error}) — if this worktree holds
                      ignored files such as <span className="font-mono">.env</span>, they go too.
                    </p>
                  )}

                  {inspect && !inspect.error && inspect.dirty > 0 && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-amber">
                      {inspect.dirty} uncommitted {inspect.dirty === 1 ? 'change' : 'changes'} here
                      — git will refuse, and this app will not force it.
                    </p>
                  )}

                  {/* The reason this pre-flight exists at all. A worktree whose
                      only extra content is ignored reports a clean status and is
                      deleted with exit 0, `.env` and all. */}
                  {inspect && !inspect.error && inspect.ignored.length > 0 && (
                    <div className="mt-1.5 text-[11px] leading-relaxed text-amber">
                      These ignored {inspect.ignored.length === 1 ? 'path is' : 'paths are'} deleted
                      with it, and git will not warn:
                      <div className="mt-1 flex flex-wrap gap-1">
                        {inspect.ignored.slice(0, 8).map((p) => (
                          <span
                            key={p}
                            className="rounded border border-amber/30 bg-amber/10 px-1 py-px font-mono text-[10px]"
                          >
                            {p}
                          </span>
                        ))}
                        {inspect.ignored.length > 8 && (
                          <span className="px-1 py-px text-[10px] text-muted">
                            +{inspect.ignored.length - 8} more
                            {inspect.truncated ? ' (at least)' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => void remove(w)}
                      disabled={inspecting}
                      className="rounded-md border border-danger/40 bg-danger/10 px-2 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => setConfirmRemove(null)}
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg"
                    >
                      Keep
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {status === 'ready' && rows.length > 0 && (
          <p className="px-3 py-3 text-[10px] leading-relaxed text-faint">
            New worktrees are created under{' '}
            <span className="font-mono">{WORKTREE_DIR}</span>, where this repository already keeps
            them.
          </p>
        )}
      </div>
    </div>
  )
}
