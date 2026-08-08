import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClaudeHookStatus, ClaudeRuntime, Connection, ServerStats, TmuxSession } from '../../../shared/types'
import { Button, Modal } from './Modal'
import { isClaudeSession } from '../lib/claude'

interface Props {
  connection: Connection
  openSessions: number
  onOpenTerminal: () => void
  onOpenFiles: () => void
  onOpenTunnels: () => void
  onEdit: () => void
  fetchTmux: () => Promise<TmuxSession[]>
  fetchStats: () => Promise<ServerStats>
  onAttach: (name: string) => void
  onNewSession: (name: string) => void
  onKillSession: (name: string) => Promise<void>
  onRenameSession: (from: string, to: string) => Promise<void>
  /** Resolve this connection's password once, for both reads below. */
  resolvePassword: () => Promise<string | null | undefined>
  fetchHookStatus: (password?: string) => Promise<ClaudeHookStatus>
  applyHook: (action: 'install' | 'uninstall') => Promise<ClaudeHookStatus>
  fetchRuntime: (password?: string) => Promise<ClaudeRuntime>
  onOpenClaude: (dir: string) => void
}

const authLabel: Record<Connection['authMethod'], string> = {
  key: 'SSH key',
  password: 'Password',
  agent: 'SSH agent'
}

// kB → human GB/MB, one decimal.
function fmtKb(kb: number): string {
  const mb = kb / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

// green → amber → red as utilization climbs.
function meterColor(pct: number): string {
  if (pct >= 90) return 'var(--color-danger)'
  if (pct >= 70) return 'var(--color-amber)'
  return 'var(--color-signal)'
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft py-2.5 last:border-0">
      <span className="eyebrow">{label}</span>
      <span className="truncate font-mono text-[13px] text-fg/90">{value}</span>
    </div>
  )
}

function Fact({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className={`truncate text-sm text-fg/90 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}

function Meter({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const color = meterColor(clamped)
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-[12px] text-fg/80">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/40 ring-1 ring-line-soft">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${clamped}%`, backgroundColor: color, boxShadow: `0 0 10px -1px ${color}` }}
        />
      </div>
      <div className="mt-1 text-right font-mono text-[11px] text-faint">{Math.round(clamped)}%</div>
    </div>
  )
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
  danger
}: {
  children: ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-7 w-7 place-items-center rounded-md border border-line text-xs text-muted transition-colors disabled:opacity-40 ${
        danger ? 'hover:border-danger/50 hover:text-danger' : 'hover:border-accent/40 hover:text-accent'
      }`}
    >
      {children}
    </button>
  )
}

/** Add to `~/.tmux.conf`, or run against a live server as `tmux set -g …`. */
const TMUX_PASSTHROUGH = 'set -g allow-passthrough all'

/**
 * Offered for copying, never run for you. Installing software on someone's server
 * is not a thing a dashboard button should do quietly, and the shape of the right
 * install differs per host — this is the one the docs give, and the user is the
 * one who knows whether it is right for theirs.
 */
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

/** A remote file's contents, verbatim — what we read, or what we're about to write. */
function JsonBlock({ label, body, tone }: { label: string; body: string; tone?: 'accent' | 'danger' }) {
  const edge = tone === 'accent' ? 'border-accent/30' : tone === 'danger' ? 'border-danger/30' : 'border-line'
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <pre
        className={`max-h-56 overflow-auto rounded-lg border ${edge} bg-ink/60 p-3 font-mono text-xs leading-relaxed whitespace-pre text-fg/85`}
      >
        {body}
      </pre>
    </div>
  )
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
    >
      <span className={loading ? 'animate-glow' : ''}>⟳</span>
      {loading ? 'syncing' : 'refresh'}
    </button>
  )
}

export function Dashboard({
  connection: c,
  openSessions,
  onOpenTerminal,
  onOpenFiles,
  onOpenTunnels,
  onEdit,
  fetchTmux,
  fetchStats,
  onAttach,
  onNewSession,
  onKillSession,
  onRenameSession,
  resolvePassword,
  fetchHookStatus,
  applyHook,
  fetchRuntime,
  onOpenClaude
}: Props) {
  const [tmux, setTmux] = useState<TmuxSession[] | null>(null)
  const [tmuxLoading, setTmuxLoading] = useState(false)
  const [tmuxError, setTmuxError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const [stats, setStats] = useState<ServerStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  // Deliberately *not* loaded with the two above: it reads a file over SFTP, and
  // most hosts have no ~/.claude at all. It also keeps the panel to one password
  // prompt at a time — two concurrent prompts would clobber each other.
  const [hook, setHook] = useState<ClaudeHookStatus | null>(null)
  const [claudeLoading, setClaudeLoading] = useState(false)
  const [hookError, setHookError] = useState<string | null>(null)
  const [hookAction, setHookAction] = useState<'install' | 'uninstall' | null>(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [passCopied, setPassCopied] = useState(false)

  const [runtime, setRuntime] = useState<ClaudeRuntime | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [installCopied, setInstallCopied] = useState(false)

  const loadTmux = useCallback(async () => {
    setTmuxLoading(true)
    setTmuxError(null)
    try {
      setTmux(await fetchTmux())
    } catch (e) {
      setTmuxError(e instanceof Error ? e.message : String(e))
      setTmux(null)
    } finally {
      setTmuxLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await fetchStats())
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
      setStats(null)
    } finally {
      setStatsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id])

  // One button for the whole panel, and the two halves run one after the other —
  // never together. Both resolve a password, and askPassword holds a single
  // pending request: a second concurrent call replaces the first, whose promise
  // then never settles and whose caller spins forever with nothing to show.
  //
  // They also fail independently. A host with Claude Code installed but no
  // ~/.claude yet is normal, and so is the reverse, so one error must not blank
  // the other's answer.
  const loadClaude = useCallback(async () => {
    setClaudeLoading(true)
    setRuntimeError(null)
    setHookError(null)
    // Once, for both. Resolving inside each read prompted twice for the same
    // password, and the two prompts must never be able to overlap regardless.
    let password: string | undefined
    try {
      const pw = await resolvePassword()
      if (pw === null) throw new Error('Password required to check Claude Code.')
      password = pw ?? undefined
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRuntimeError(msg)
      setRuntime(null)
      setHookError(msg)
      setHook(null)
      setClaudeLoading(false)
      return
    }
    try {
      setRuntime(await fetchRuntime(password))
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e))
      setRuntime(null)
    }
    try {
      setHook(await fetchHookStatus(password))
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e))
      setHook(null)
      // The pending action was planned against the status we just threw away —
      // leaving it set would re-open the confirm modal over the next good read.
      setHookAction(null)
    } finally {
      setClaudeLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id])

  useEffect(() => {
    setTmux(null)
    setStats(null)
    setEditing(null)
    setHook(null)
    setHookError(null)
    setHookAction(null)
    setRuntime(null)
    setRuntimeError(null)
    void loadTmux()
    void loadStats()
  }, [loadTmux, loadStats])

  // Write the planned file, then show what's actually there now — main re-plans
  // from a fresh read, so the returned status is the file as it stands, not a
  // guess assembled from the plan we showed.
  const confirmHook = async (): Promise<void> => {
    if (!hookAction) return
    setHookBusy(true)
    setHookError(null)
    try {
      setHook(await applyHook(hookAction))
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e))
    } finally {
      setHookBusy(false)
      setHookAction(null)
    }
  }

  // Run a one-shot tmux mutation, surface its error, then refresh the list.
  const runTmux = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setTmuxError(null)
    try {
      await fn()
      await loadTmux()
    } catch (e) {
      setTmuxError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const createSession = (): void => {
    onNewSession(newName.trim() || 'main')
    setNewName('')
    // The new session registers on the remote a beat later; refresh to show it.
    setTimeout(() => void loadTmux(), 1200)
  }

  const commitRename = (from: string): void => {
    const to = editValue.trim()
    setEditing(null)
    if (!to || to === from) return
    void runTmux(() => onRenameSession(from, to))
  }

  const memPct =
    stats?.memTotalKb && stats?.memUsedKb !== undefined
      ? (stats.memUsedKb / stats.memTotalKb) * 100
      : null
  const loadRatio =
    stats?.load && stats?.cpus ? Math.min(100, (stats.load[0] / stats.cpus) * 100) : null

  return (
    <div className="h-full overflow-y-auto px-10 py-9">
      <div className="mx-auto max-w-3xl">
        {/* hero */}
        <div className="animate-rise mb-8 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow mb-2 flex items-center gap-2.5">
              Connection
              {!statsError && stats && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent dot-glow" />
                  online
                  {stats.probeMs !== undefined && <span className="text-accent/60">· {stats.probeMs}ms</span>}
                </span>
              )}
              {statsError && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/12 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-danger">
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                  unreachable
                </span>
              )}
            </div>
            <h1 className="truncate text-3xl font-bold tracking-tight text-fg">{c.name}</h1>
            <p className="mt-1.5 font-mono text-sm text-muted">
              {c.username ? `${c.username}@` : ''}
              {c.host}
              <span className="text-accent">:{c.port}</span>
              {stats?.hostname && stats.hostname !== c.host && (
                <span className="text-faint"> · {stats.hostname}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={onEdit}>Edit</Button>
            <Button onClick={onOpenTunnels}>Tunnels</Button>
            <Button onClick={onOpenFiles}>Browse Files</Button>
            {/* Only once the probe has reported a real $HOME. The session name is
                hashed from the absolute directory, so launching against a guessed
                `~` would name a different session than a Files launch on the very
                same directory — two agents, one home. */}
            {runtime?.home && (
              <Button onClick={() => onOpenClaude(runtime.home as string)}>Claude here ▸</Button>
            )}
            <Button variant="primary" onClick={onOpenTerminal}>
              Open Terminal ▸
            </Button>
          </div>
        </div>

        {openSessions > 0 && (
          <div
            className="animate-rise mb-6 flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent-soft/30 px-4 py-2.5 text-sm text-accent"
            style={{ animationDelay: '40ms' }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent dot-glow" />
            {openSessions} live terminal session{openSessions > 1 ? 's' : ''} on this host.
          </div>
        )}

        {/* system vitals */}
        <div className="panel animate-rise mb-4 p-5" style={{ animationDelay: '60ms' }}>
          <div className="mb-4 flex items-center justify-between">
            <span className="eyebrow">System</span>
            <RefreshButton loading={statsLoading} onClick={() => void loadStats()} />
          </div>

          {statsError && (
            <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {statsError}
            </p>
          )}

          {!statsError && statsLoading && stats === null && (
            <p className="py-2 font-mono text-xs text-faint">reading host vitals…</p>
          )}

          {!statsError && stats && (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Fact label="OS" value={stats.os ?? '—'} />
                <Fact label="Kernel" value={stats.kernel ?? '—'} mono />
                <Fact label="Arch" value={stats.arch ?? '—'} mono />
                <Fact label="Uptime" value={stats.uptime ?? '—'} />
                <Fact
                  label="CPU"
                  value={
                    stats.cpus
                      ? `${stats.cpus} core${stats.cpus === 1 ? '' : 's'}`
                      : stats.cpuModel ?? '—'
                  }
                />
                <Fact
                  label="Load avg"
                  value={stats.load ? stats.load.map((n) => n.toFixed(2)).join('  ') : '—'}
                  mono
                />
              </div>

              {stats.cpuModel && stats.cpus && (
                <p className="mt-3 truncate border-t border-line-soft pt-3 font-mono text-[11px] text-faint">
                  {stats.cpuModel}
                </p>
              )}

              {(memPct !== null || stats.diskPct !== undefined || loadRatio !== null) && (
                <div className="mt-4 grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-3">
                  {memPct !== null && (
                    <Meter
                      label="Memory"
                      pct={memPct}
                      detail={`${fmtKb(stats.memUsedKb!)} / ${fmtKb(stats.memTotalKb!)}`}
                    />
                  )}
                  {stats.diskPct !== undefined && (
                    <Meter
                      label="Disk /"
                      pct={stats.diskPct}
                      detail={
                        stats.diskUsed && stats.diskSize ? `${stats.diskUsed} / ${stats.diskSize}` : ''
                      }
                    />
                  )}
                  {loadRatio !== null && (
                    <Meter
                      label="CPU load"
                      pct={loadRatio}
                      detail={`${stats.load![0].toFixed(2)} · ${stats.cpus} cores`}
                    />
                  )}
                </div>
              )}

              {stats.users !== undefined && (
                <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-faint">
                  {stats.users} user{stats.users === 1 ? '' : 's'} logged in
                </p>
              )}
            </>
          )}
        </div>

        {/* tmux */}
        <div className="panel animate-rise mb-4 p-5" style={{ animationDelay: '100ms' }}>
          <div className="mb-3.5 flex items-center justify-between">
            <span className="eyebrow">tmux sessions</span>
            <RefreshButton loading={tmuxLoading} onClick={() => void loadTmux()} />
          </div>

          {/* create-or-attach a named session */}
          <div className="mb-3 flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createSession()}
              placeholder="new session name  ·  blank = main"
              className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-xs text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            />
            <Button variant="primary" onClick={createSession}>
              New ▸
            </Button>
          </div>

          {tmuxError && (
            <p className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {tmuxError}
            </p>
          )}

          {!tmuxError && tmuxLoading && tmux === null && (
            <p className="py-2 font-mono text-xs text-faint">scanning host…</p>
          )}

          {!tmuxError && tmux !== null && tmux.length === 0 && (
            <p className="py-2 text-sm text-faint">No tmux sessions running on this host.</p>
          )}

          {tmux && tmux.length > 0 && (
            <div className="space-y-1.5">
              {tmux.map((s, i) => (
                <div
                  key={s.name}
                  style={{ animationDelay: `${i * 30}ms` }}
                  className="animate-rise flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-black/20 px-3.5 py-2.5 transition-colors hover:border-line"
                >
                  <div className="min-w-0 flex-1">
                    {editing === s.name ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(s.name)
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        onBlur={() => commitRename(s.name)}
                        className="w-full rounded-md border border-accent/50 bg-ink/80 px-2 py-1 font-mono text-sm text-fg outline-none"
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-sm text-fg">{s.name}</span>
                          {/* Derived from the name's own shape, so it survives an
                              app restart with no bookkeeping. Display only: the
                              Attach ▸ already here is the way back to the agent. */}
                          {isClaudeSession(s.name) && (
                            <span className="rounded-full bg-fg/10 px-2 py-0.5 text-[10px] font-medium text-fg/70">
                              agent
                            </span>
                          )}
                          {s.attached && (
                            <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
                              <span className="h-1 w-1 rounded-full bg-accent" />
                              attached
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-faint">
                          {s.windows} window{s.windows === 1 ? '' : 's'}
                        </div>
                      </>
                    )}
                  </div>
                  {editing !== s.name && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <IconButton
                        title="Rename session"
                        disabled={busy}
                        onClick={() => {
                          setEditValue(s.name)
                          setEditing(s.name)
                        }}
                      >
                        ✎
                      </IconButton>
                      <IconButton
                        title="Kill session"
                        danger
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Kill tmux session “${s.name}”? Running programs are terminated.`))
                            void runTmux(() => onKillSession(s.name))
                        }}
                      >
                        ✕
                      </IconButton>
                      <Button variant="primary" onClick={() => onAttach(s.name)}>
                        Attach ▸
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* claude code runtime + attention hook */}
        <div className="panel animate-rise mb-4 p-5" style={{ animationDelay: '120ms' }}>
          <div className="mb-3.5 flex items-center justify-between">
            <span className="eyebrow">Claude Code</span>
            {/* Also on the error states, not just the good ones. A failed check
                sets an error and leaves both answers null, and gating this on
                the answers alone left the panel with two red boxes and no way
                to try again — on the single most likely first click, an
                unreachable host or a cancelled password prompt. */}
            {(runtime || hook || runtimeError || hookError) && (
              <RefreshButton loading={claudeLoading} onClick={() => void loadClaude()} />
            )}
          </div>

          {runtimeError && (
            <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {runtimeError}
            </p>
          )}

          {!runtime && (
            <div className="mb-4 flex items-center justify-between gap-4">
              <p className="min-w-0 text-sm leading-relaxed text-fg/75">
                {claudeLoading
                  ? 'Looking for the CLI…'
                  : runtimeError
                    ? 'Nothing was learned about this host.'
                    : 'Find out which Claude Code this host has, and whether it is signed in.'}
              </p>
              <Button variant="primary" disabled={claudeLoading} onClick={() => void loadClaude()}>
                {runtimeError ? 'Try again ▸' : 'Check ▸'}
              </Button>
            </div>
          )}

          {runtime && (
            <div className="mb-4">
              {runtime.path ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Fact label="Version" value={runtime.version ?? 'unknown'} mono />
                  <Fact
                    label="Sign-in"
                    value={
                      runtime.loggedIn === true ? (
                        <span className="text-accent">
                          signed in{runtime.authMethod ? ` · ${runtime.authMethod}` : ''}
                        </span>
                      ) : runtime.loggedIn === false ? (
                        <span className="text-amber">not signed in</span>
                      ) : (
                        // Tri-state, and this is the third: the CLI gave no answer
                        // we could parse. Saying "not signed in" here would send
                        // someone to re-authenticate a session that works fine.
                        <span className="text-faint">
                          unknown{runtime.credsFile ? ' · credentials file present' : ''}
                        </span>
                      )
                    }
                  />
                  <Fact label="Binary" value={runtime.path} mono />
                </div>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-fg/75">
                    No <span className="font-mono text-[12px] text-fg/90">claude</span> on this host — not on{' '}
                    <span className="font-mono text-[12px]">$PATH</span>, not in the usual places, and not in a login
                    shell. If it lives behind a version manager (nvm, asdf, mise, bun), set its full path under Edit ▸
                    Claude binary.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-ink/60 px-2 py-1 font-mono text-[11px] text-fg/70">
                      {CLAUDE_INSTALL}
                    </code>
                    <Button
                      onClick={() => {
                        void navigator.clipboard.writeText(CLAUDE_INSTALL)
                        setInstallCopied(true)
                        window.setTimeout(() => setInstallCopied(false), 1500)
                      }}
                    >
                      {installCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </>
              )}

              {runtime.loggedIn === false && (
                <p className="mt-3 text-[12px] leading-relaxed text-faint">
                  Open a terminal here and run <span className="font-mono">/login</span> inside Claude Code to sign in.
                </p>
              )}
              {runtime.loggedIn === true && (
                <p className="mt-3 text-[12px] leading-relaxed text-faint">
                  “Signed in” means credentials are on the host, not that they still work — an expired plan looks the
                  same from here.
                </p>
              )}
            </div>
          )}

          <div className="mb-3.5 border-t border-line-soft pt-3.5">
            <span className="eyebrow">Attention hook</span>
          </div>

          <p className="text-sm leading-relaxed text-fg/75">
            Install a Notification hook in <span className="font-mono text-[12px] text-fg/90">~/.claude/settings.json</span>{' '}
            on this host and Claude Code will mark its tab — and, if you turn on notifications in Settings ▸ Terminal,
            raise a system notification — whenever it stops to ask you something.
          </p>

          {hookError && (
            <p className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {hookError}
            </p>
          )}

          {!hook && !hookError && claudeLoading && (
            <p className="mt-3 font-mono text-xs text-faint">reading remote settings…</p>
          )}

          <div className="mt-4 flex items-center justify-between gap-4">
            <div className="min-w-0 font-mono text-xs">
              {!hook && <span className="text-faint">not checked</span>}
              {hook?.installed && <span className="text-accent">● hook installed</span>}
              {hook && !hook.installed && hook.present && (
                <span className="text-amber">● older hook installed — update it</span>
              )}
              {hook && !hook.present && <span className="text-faint">○ not installed</span>}
            </div>
            {/* No Check ▸ of its own — the panel's single one reads both halves,
                because each resolves a password and two at once clobber each
                other. These appear only once there is a status to act on. */}
            {hook && (
              <div className="flex shrink-0 items-center gap-2">
                {hook.present && (
                  <Button variant="danger" disabled={hookBusy} onClick={() => setHookAction('uninstall')}>
                    Uninstall
                  </Button>
                )}
                <Button
                  variant="primary"
                  disabled={hookBusy || hook.installed}
                  onClick={() => setHookAction('install')}
                >
                  {hook.present ? 'Update ▸' : 'Install ▸'}
                </Button>
              </div>
            )}
          </div>

          <div className="mt-3 border-t border-line-soft pt-3">
            <p className="text-[12px] leading-relaxed text-faint">
              Under tmux you get the tab dot, but not the notification text: tmux drops the sequence carrying it
              unless the server allows passthrough — off by default since tmux 3.3. Control mode (
              <span className="font-mono">tmux -CC</span>) tabs and plain shells are unaffected.
            </p>
            {/* Copied rather than applied for you. allow-passthrough is a tmux
                *server* option: it changes every session and every client on the
                host, and the Uninstall above could never honestly take it back,
                since we can't know whether you'd set it yourself. The dot works
                without it — only the notification text is at stake. */}
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-ink/60 px-2 py-1 font-mono text-[11px] text-fg/70">
                {TMUX_PASSTHROUGH}
              </code>
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(TMUX_PASSTHROUGH)
                  setPassCopied(true)
                  window.setTimeout(() => setPassCopied(false), 1500)
                }}
              >
                {passCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        {/* details */}
        <div className="panel animate-rise p-5" style={{ animationDelay: '140ms' }}>
          <div className="eyebrow mb-1.5">Connection details</div>
          <Row label="Host" value={c.host} />
          <Row label="Port" value={String(c.port)} />
          <Row label="Username" value={c.username || '—'} />
          <Row label="Auth method" value={authLabel[c.authMethod]} />
          {c.authMethod === 'key' && <Row label="Private key" value={c.keyPath || '—'} />}
        </div>

        {c.notes && (
          <div className="panel animate-rise mt-4 p-5" style={{ animationDelay: '180ms' }}>
            <div className="eyebrow mb-2">Notes</div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg/75">{c.notes}</p>
          </div>
        )}
      </div>

      {/* Nothing is written until this is confirmed, and it shows the file both
          ways round first — it's the user's config, and it may hold hooks of
          their own that we're merging alongside. */}
      {hook && hookAction && (
        <Modal
          width={720}
          title={hookAction === 'install' ? 'Install attention hook' : 'Remove attention hook'}
          onClose={() => !hookBusy && setHookAction(null)}
          footer={
            <>
              <Button onClick={() => setHookAction(null)} disabled={hookBusy}>
                Cancel
              </Button>
              <Button
                variant={hookAction === 'install' ? 'primary' : 'danger'}
                disabled={hookBusy}
                onClick={() => void confirmHook()}
              >
                {hookBusy ? 'Writing…' : hookAction === 'install' ? 'Write file' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className="mb-4 font-mono text-xs text-muted">{hook.path}</p>
          <div className="grid grid-cols-2 gap-4">
            <JsonBlock label="Now" body={hook.before} />
            <JsonBlock
              label="After"
              tone={hookAction === 'install' ? 'accent' : 'danger'}
              body={hookAction === 'install' ? hook.install : hook.uninstall}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
