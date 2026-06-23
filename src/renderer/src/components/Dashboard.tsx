import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Connection, ServerStats, TmuxSession } from '../../../shared/types'
import { Button } from './Modal'

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
        danger ? 'hover:border-danger/50 hover:text-danger' : 'hover:border-signal/40 hover:text-signal'
      }`}
    >
      {children}
    </button>
  )
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-40"
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
  onRenameSession
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

  useEffect(() => {
    setTmux(null)
    setStats(null)
    setEditing(null)
    void loadTmux()
    void loadStats()
  }, [loadTmux, loadStats])

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
                <span className="inline-flex items-center gap-1.5 rounded-full bg-signal/12 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-signal">
                  <span className="h-1.5 w-1.5 rounded-full bg-signal dot-glow" />
                  online
                  {stats.probeMs !== undefined && <span className="text-signal/60">· {stats.probeMs}ms</span>}
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
              <span className="text-signal">:{c.port}</span>
              {stats?.hostname && stats.hostname !== c.host && (
                <span className="text-faint"> · {stats.hostname}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={onEdit}>Edit</Button>
            <Button onClick={onOpenTunnels}>Tunnels</Button>
            <Button onClick={onOpenFiles}>Browse Files</Button>
            <Button variant="primary" onClick={onOpenTerminal}>
              Open Terminal ▸
            </Button>
          </div>
        </div>

        {openSessions > 0 && (
          <div
            className="animate-rise mb-6 flex items-center gap-2.5 rounded-lg border border-signal/25 bg-signal-soft/30 px-4 py-2.5 text-sm text-signal"
            style={{ animationDelay: '40ms' }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-signal dot-glow" />
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
              className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-xs text-fg outline-none transition-colors placeholder:text-faint focus:border-signal/60 focus:ring-2 focus:ring-signal/15"
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
                        className="w-full rounded-md border border-signal/50 bg-ink/80 px-2 py-1 font-mono text-sm text-fg outline-none"
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-sm text-fg">{s.name}</span>
                          {s.attached && (
                            <span className="flex items-center gap-1 rounded-full bg-signal/15 px-2 py-0.5 text-[10px] font-medium text-signal">
                              <span className="h-1 w-1 rounded-full bg-signal" />
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
    </div>
  )
}
