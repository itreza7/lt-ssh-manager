import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentHostScan,
  ClaudeHookStatus,
  ClaudeStatusLineStatus,
  ClaudeTmuxPassthroughStatus,
  Connection,
  ServerStats,
  SftpEntry,
  TmuxSession,
  WorktreeScan
} from '../../../shared/types'
import { Button, Modal } from './Modal'
import { isClaudeSession } from '../lib/claude'
import { agentStatus } from '../lib/agents'
import type { AgentStatus } from '../lib/agents'

interface Props {
  connection: Connection | null
  hasConnections: boolean
  onOpenSettings: () => void
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
  /** Resolve this connection's password once, for all the reads below. */
  resolvePassword: () => Promise<string | null | undefined>
  fetchHookStatus: (password?: string) => Promise<ClaudeHookStatus>
  applyHook: (action: 'install' | 'uninstall') => Promise<ClaudeHookStatus>
  fetchStatusLineStatus: (password?: string) => Promise<ClaudeStatusLineStatus>
  applyStatusLine: (action: 'install' | 'uninstall') => Promise<ClaudeStatusLineStatus>
  fetchTmuxPassthroughStatus: (password?: string) => Promise<ClaudeTmuxPassthroughStatus>
  applyTmuxPassthrough: (action: 'install' | 'uninstall') => Promise<ClaudeTmuxPassthroughStatus>
  /** The live-agent sweep, owned by useAgentSessions and lifted to App.tsx so it
   *  can keep polling in the background regardless of which tab is visible.
   *  Filtered down to the active connection below — every other host in the
   *  scan is irrelevant now that only one connection is ever active. */
  agentHosts: AgentHostScan[] | null
  agentScanError: string | null
  agentScanning: boolean
  rescanAgents: () => void
  /** Launch a brand-new agent in this directory on the active connection.
   *  Returns false (without other side effects) if the directory isn't
   *  absolute, so the form can say so instead of silently closing. */
  onNewAgent: (dir: string) => boolean
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

interface DiffStatus {
  path: string
  before: string
  install: string
  uninstall: string
  installed: boolean
  present: boolean
}

function SetupItem({
  title,
  description,
  note,
  status,
  error,
  action,
  busy,
  installedLabel,
  presentLabel,
  onSetAction,
  onCancel,
  onConfirm
}: {
  title: string
  description: string
  note?: string
  status: DiffStatus | null
  error: string | null
  action: 'install' | 'uninstall' | null
  busy: boolean
  installedLabel: string
  presentLabel: string
  onSetAction: (action: 'install' | 'uninstall') => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="border-t border-line-soft pt-4 first:border-0 first:pt-0">
      <div className="eyebrow mb-1.5">{title}</div>
      <p className="text-sm leading-relaxed text-fg/75">{description}</p>
      {note && <p className="mt-2 text-[12px] leading-relaxed text-faint">{note}</p>}

      {error && (
        <p className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      {!status && !error && <p className="mt-3 font-mono text-xs text-faint">reading remote config…</p>}

      {status && action === null && (
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="min-w-0 font-mono text-xs">
            {status.installed && <span className="text-accent">● {installedLabel}</span>}
            {!status.installed && status.present && (
              <span className="text-amber">● {presentLabel} — update it</span>
            )}
            {!status.present && <span className="text-faint">○ not installed</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status.present && (
              <Button variant="danger" disabled={busy} onClick={() => onSetAction('uninstall')}>
                Uninstall
              </Button>
            )}
            <Button variant="primary" disabled={busy || status.installed} onClick={() => onSetAction('install')}>
              {status.present ? 'Update ▸' : 'Install ▸'}
            </Button>
          </div>
        </div>
      )}

      {status && action !== null && (
        <div className="mt-3">
          <p className="mb-3 font-mono text-xs text-muted">{status.path}</p>
          <div className="grid grid-cols-2 gap-4">
            <JsonBlock label="Now" body={status.before} />
            <JsonBlock
              label="After"
              tone={action === 'install' ? 'accent' : 'danger'}
              body={action === 'install' ? status.install : status.uninstall}
            />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant={action === 'install' ? 'primary' : 'danger'} disabled={busy} onClick={onConfirm}>
              {busy ? 'Writing…' : action === 'install' ? 'Write' : 'Remove'}
            </Button>
          </div>
        </div>
      )}
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

const STATUS_LABEL: Record<AgentStatus, string> = {
  waiting: 'Waiting for you',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Unknown'
}

const STATUS_DOT: Record<AgentStatus, string> = {
  waiting: 'bg-amber dot-glow',
  working: 'bg-signal dot-glow animate-pulse',
  idle: 'bg-faint',
  unknown: 'bg-muted/40'
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  waiting: 'text-amber',
  working: 'text-signal',
  idle: 'text-faint',
  unknown: 'text-faint'
}

/** Keep the last two path segments — plenty to identify a working directory. */
function shortDirName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

/**
 * Directory input with Tab-triggered completion (via sftpList) and a picker
 * for starting an agent from an existing git worktree (via gitWorktrees).
 *
 * Both need an SFTP channel / a resolved password; neither is opened until
 * the user actually reaches for them — most agents are started by typing a
 * path outright.
 */
function NewAgentForm({
  connectionId,
  resolvePassword,
  onSubmit
}: {
  connectionId: string
  resolvePassword: () => Promise<string | null | undefined>
  onSubmit: (dir: string) => boolean
}) {
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)

  const sftpReadyRef = useRef(false)
  const [suggestions, setSuggestions] = useState<string[] | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [worktreeScan, setWorktreeScan] = useState<WorktreeScan | null>(null)
  const [worktreeLoading, setWorktreeLoading] = useState(false)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (sftpReadyRef.current) window.api.sftpClose(connectionId)
    }
  }, [connectionId])

  const ensureSftp = async (): Promise<void> => {
    if (sftpReadyRef.current) return
    const password = await resolvePassword()
    if (password === null) throw new Error('Password required to browse directories.')
    await window.api.sftpOpen({ connectionId, password: password ?? undefined })
    sftpReadyRef.current = true
  }

  const loadSuggestions = useCallback(
    async (value: string) => {
      setSuggestLoading(true)
      setSuggestError(null)
      try {
        await ensureSftp()
        const lastSlash = value.lastIndexOf('/')
        const base = lastSlash >= 0 ? value.slice(0, lastSlash + 1) : ''
        const partial = lastSlash >= 0 ? value.slice(lastSlash + 1) : value
        const res = await window.api.sftpList({ connectionId, path: base || '.' })
        const root = res.path.replace(/\/$/, '')
        const dirs = res.entries.filter(
          (e: SftpEntry) => e.type === 'directory' || (e.type === 'symlink' && e.target === 'directory')
        )
        const matches = dirs
          .filter((e) => e.name.toLowerCase().startsWith(partial.toLowerCase()))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${root}/${e.name}/`)
        setSuggestions(matches)
        setActiveIndex(0)
      } catch (e) {
        setSuggestError(e instanceof Error ? e.message : String(e))
        setSuggestions(null)
      } finally {
        setSuggestLoading(false)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [connectionId]
  )

  const pick = (s: string): void => {
    setDir(s)
    setSuggestions(null)
    setSuggestError(null)
  }

  const submit = (): void => {
    const d = dir.trim()
    if (!d) return
    if (!d.startsWith('/')) {
      setError('Directory must be absolute — start it with /')
      return
    }
    if (!onSubmit(d)) {
      setError('Could not start an agent there — check the directory exists.')
      return
    }
    setError(null)
    setDir('')
    setSuggestions(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      if (suggestions && suggestions.length > 0) {
        pick(suggestions[activeIndex])
      } else {
        void loadSuggestions(dir)
      }
      return
    }
    if (suggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Escape') {
        setSuggestions(null)
        return
      }
    }
    if (e.key === 'Enter') submit()
  }

  const toggleWorktrees = async (): Promise<void> => {
    if (worktreesOpen) {
      setWorktreesOpen(false)
      return
    }
    if (!dir.trim()) return
    setWorktreesOpen(true)
    setWorktreeLoading(true)
    setWorktreeError(null)
    try {
      const password = await resolvePassword()
      if (password === null) throw new Error('Password required to list worktrees.')
      const scan = await window.api.gitWorktrees({
        connectionId,
        dir: dir.trim(),
        password: password ?? undefined
      })
      setWorktreeScan(scan)
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : String(e))
      setWorktreeScan(null)
    } finally {
      setWorktreeLoading(false)
    }
  }

  const pickWorktree = (path: string): void => {
    setDir(path)
    setWorktreesOpen(false)
    setError(null)
  }

  return (
    <div className="mb-4 rounded-lg border border-line/70 bg-elevated/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">New agent</span>
        <button
          onClick={() => void toggleWorktrees()}
          disabled={!worktreesOpen && !dir.trim()}
          title={!worktreesOpen && !dir.trim() ? 'Type a repository path first' : undefined}
          className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-40 ${
            worktreesOpen
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-line text-muted hover:border-accent/40 hover:text-accent'
          }`}
        >
          Start from worktree ▸
        </button>
      </div>

      <div className="relative">
        <input
          value={dir}
          onChange={(e) => {
            setDir(e.target.value)
            setError(null)
            setSuggestions(null)
          }}
          onKeyDown={onKeyDown}
          placeholder="/absolute/path  ·  Tab to complete"
          className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-xs text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
        />
        {suggestions && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-elevated shadow-lg">
            {suggestions.slice(0, 20).map((s, i) => (
              <button
                key={s}
                onClick={() => pick(s)}
                className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[11px] ${
                  i === activeIndex ? 'bg-accent/15 text-accent' : 'text-fg/80 hover:bg-elevated/70'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={!dir.trim()}>
          Start ▸
        </Button>
        {suggestLoading && <span className="font-mono text-[10px] text-faint">listing…</span>}
        <p className={`font-mono text-[10px] ${error || suggestError ? 'text-danger' : 'text-faint'}`}>
          {error ?? suggestError ?? 'Directory must be absolute · Tab completes, ↑↓ to move, Enter to start.'}
        </p>
      </div>

      {worktreesOpen && (
        <div className="mt-3 border-t border-line-soft pt-3">
          {worktreeLoading && <p className="font-mono text-[11px] text-faint">scanning worktrees…</p>}
          {worktreeError && (
            <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
              {worktreeError}
            </p>
          )}
          {!worktreeLoading && !worktreeError && worktreeScan && worktreeScan.root === null && (
            <p className="font-mono text-[11px] text-faint">
              No git repository found there — type a path inside one first.
            </p>
          )}
          {!worktreeLoading && !worktreeError && worktreeScan && worktreeScan.worktrees.length === 0 && (
            <p className="font-mono text-[11px] text-faint">No worktrees for this repository yet.</p>
          )}
          {!worktreeLoading && worktreeScan && worktreeScan.worktrees.length > 0 && (
            <div className="space-y-1">
              {worktreeScan.worktrees.map((w) => (
                <button
                  key={w.path}
                  onClick={() => pickWorktree(w.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-elevated/50"
                >
                  <span className="truncate font-mono text-[11px] text-fg/85">{shortDirName(w.path)}</span>
                  {w.branch && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">{w.branch}</span>
                  )}
                  {w.locked !== null && (
                    <span className="shrink-0 rounded border border-amber/40 px-1 py-px font-mono text-[9px] tracking-wider text-amber">
                      LOCKED
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function SummaryView({
  connection: c,
  hasConnections,
  onOpenSettings,
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
  fetchStatusLineStatus,
  applyStatusLine,
  fetchTmuxPassthroughStatus,
  applyTmuxPassthrough,
  agentHosts,
  agentScanError,
  agentScanning,
  rescanAgents,
  onNewAgent
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

  const [setupOpen, setSetupOpen] = useState(false)
  const [hook, setHook] = useState<ClaudeHookStatus | null>(null)
  const [claudeLoading, setClaudeLoading] = useState(false)
  const [hookError, setHookError] = useState<string | null>(null)
  const [hookAction, setHookAction] = useState<'install' | 'uninstall' | null>(null)
  const [hookBusy, setHookBusy] = useState(false)

  const [statusLine, setStatusLine] = useState<ClaudeStatusLineStatus | null>(null)
  const [statusLineError, setStatusLineError] = useState<string | null>(null)
  const [statusLineAction, setStatusLineAction] = useState<'install' | 'uninstall' | null>(null)
  const [statusLineBusy, setStatusLineBusy] = useState(false)

  const [tmuxPassthrough, setTmuxPassthrough] = useState<ClaudeTmuxPassthroughStatus | null>(null)
  const [tmuxPassthroughError, setTmuxPassthroughError] = useState<string | null>(null)
  const [tmuxPassthroughAction, setTmuxPassthroughAction] = useState<'install' | 'uninstall' | null>(null)
  const [tmuxPassthroughBusy, setTmuxPassthroughBusy] = useState(false)

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
  }, [c?.id])

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
  }, [c?.id])

  const loadClaude = useCallback(async () => {
    setClaudeLoading(true)
    setHookError(null)
    setStatusLineError(null)
    setTmuxPassthroughError(null)
    let password: string | undefined
    try {
      const pw = await resolvePassword()
      if (pw === null) throw new Error('Password required to check Claude Code.')
      password = pw ?? undefined
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setHookError(msg)
      setHook(null)
      setStatusLineError(msg)
      setStatusLine(null)
      setTmuxPassthroughError(msg)
      setTmuxPassthrough(null)
      setClaudeLoading(false)
      return
    }
    try {
      setHook(await fetchHookStatus(password))
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e))
      setHook(null)
      setHookAction(null)
    }
    try {
      setStatusLine(await fetchStatusLineStatus(password))
    } catch (e) {
      setStatusLineError(e instanceof Error ? e.message : String(e))
      setStatusLine(null)
      setStatusLineAction(null)
    }
    try {
      setTmuxPassthrough(await fetchTmuxPassthroughStatus(password))
    } catch (e) {
      setTmuxPassthroughError(e instanceof Error ? e.message : String(e))
      setTmuxPassthrough(null)
      setTmuxPassthroughAction(null)
    } finally {
      setClaudeLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id])

  useEffect(() => {
    if (!c) return
    setTmux(null)
    setStats(null)
    setEditing(null)
    setSetupOpen(false)
    setHook(null)
    setHookError(null)
    setHookAction(null)
    setStatusLine(null)
    setStatusLineError(null)
    setStatusLineAction(null)
    setTmuxPassthrough(null)
    setTmuxPassthroughError(null)
    setTmuxPassthroughAction(null)
    void loadTmux()
    void loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id])

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

  const confirmStatusLine = async (): Promise<void> => {
    if (!statusLineAction) return
    setStatusLineBusy(true)
    setStatusLineError(null)
    try {
      setStatusLine(await applyStatusLine(statusLineAction))
    } catch (e) {
      setStatusLineError(e instanceof Error ? e.message : String(e))
    } finally {
      setStatusLineBusy(false)
      setStatusLineAction(null)
    }
  }

  const confirmTmuxPassthrough = async (): Promise<void> => {
    if (!tmuxPassthroughAction) return
    setTmuxPassthroughBusy(true)
    setTmuxPassthroughError(null)
    try {
      setTmuxPassthrough(await applyTmuxPassthrough(tmuxPassthroughAction))
    } catch (e) {
      setTmuxPassthroughError(e instanceof Error ? e.message : String(e))
    } finally {
      setTmuxPassthroughBusy(false)
      setTmuxPassthroughAction(null)
    }
  }

  const openSetup = (): void => {
    setSetupOpen(true)
    if (!hook && !statusLine && !tmuxPassthrough && !hookError && !statusLineError && !tmuxPassthroughError) {
      void loadClaude()
    }
  }

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
    setTimeout(() => void loadTmux(), 1200)
  }

  const commitRename = (from: string): void => {
    const to = editValue.trim()
    setEditing(null)
    if (!to || to === from) return
    void runTmux(() => onRenameSession(from, to))
  }

  const memPct =
    stats?.memTotalKb && stats?.memUsedKb !== undefined ? (stats.memUsedKb / stats.memTotalKb) * 100 : null
  const loadRatio = stats?.load && stats?.cpus ? Math.min(100, (stats.load[0] / stats.cpus) * 100) : null

  // This host's slice of the live-agent sweep, keyed by session name so each
  // tmux row below can show whether it's waiting/working/idle — a status the
  // plain tmux list has no way to know on its own.
  const agentStatusByName = useMemo(() => {
    const m = new Map<string, AgentStatus>()
    if (!c) return m
    const host = (agentHosts ?? []).find((h) => h.connectionId === c.id)
    for (const s of host?.sessions ?? []) m.set(s.session, agentStatus(s))
    return m
  }, [agentHosts, c])

  if (!c) {
    return (
      <div className="flex h-full items-center justify-center px-10">
        <div className="max-w-sm text-center">
          <div className="eyebrow mb-3">Summary</div>
          <p className="text-sm leading-relaxed text-muted">
            {hasConnections
              ? 'No server is active. Pick one in Settings to see its summary and start an agent.'
              : 'No servers configured yet. Add one in Settings to get started.'}
          </p>
          <Button variant="primary" onClick={onOpenSettings}>
            Open Settings ▸
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-10 py-9">
      <div className="mx-auto max-w-5xl">
        {/* hero */}
        <div className="animate-rise mb-8 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow mb-2 flex items-center gap-2.5">
              Connection
              {!statsError && stats && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-3 py-1 text-[10px] font-medium normal-case tracking-normal text-accent">
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
            <Button onClick={openSetup}>Set up Claude Code ▸</Button>
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

        {agentScanError && (
          <p className="animate-rise mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {agentScanError}
          </p>
        )}

        {/* new agent */}
        <div className="animate-rise" style={{ animationDelay: '20ms' }}>
          <NewAgentForm connectionId={c.id} resolvePassword={resolvePassword} onSubmit={onNewAgent} />
        </div>

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
                  value={stats.cpus ? `${stats.cpus} core${stats.cpus === 1 ? '' : 's'}` : stats.cpuModel ?? '—'}
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
                      detail={stats.diskUsed && stats.diskSize ? `${stats.diskUsed} / ${stats.diskSize}` : ''}
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

        {/* tmux + live agents */}
        <div className="panel animate-rise mb-4 p-5" style={{ animationDelay: '100ms' }}>
          <div className="mb-3.5 flex items-center justify-between">
            <span className="eyebrow">tmux sessions</span>
            <RefreshButton
              loading={tmuxLoading || agentScanning}
              onClick={() => {
                void loadTmux()
                rescanAgents()
              }}
            />
          </div>

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
              {tmux.map((s, i) => {
                const status = agentStatusByName.get(s.name)
                return (
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
                            {status && (
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                                title={STATUS_LABEL[status]}
                              />
                            )}
                            <span className="truncate font-mono text-sm text-fg">{s.name}</span>
                            {isClaudeSession(s.name) && (
                              <span className="rounded-full bg-fg/10 px-2 py-0.5 text-[10px] font-medium text-fg/70">
                                agent
                              </span>
                            )}
                            {status && (
                              <span className={`text-[10px] ${STATUS_TEXT[status]}`}>{STATUS_LABEL[status]}</span>
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
                )
              })}
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

      {setupOpen && (
        <Modal
          width={760}
          title="Set up Claude Code"
          onClose={() => {
            if (hookBusy || statusLineBusy || tmuxPassthroughBusy) return
            setSetupOpen(false)
            setHookAction(null)
            setStatusLineAction(null)
            setTmuxPassthroughAction(null)
          }}
          footer={
            (hook || statusLine || tmuxPassthrough || hookError || statusLineError || tmuxPassthroughError) && (
              <RefreshButton loading={claudeLoading} onClick={() => void loadClaude()} />
            )
          }
        >
          <div className="space-y-4">
            <SetupItem
              title="Attention hook"
              description="Installs a Notification hook in ~/.claude/settings.json on this host. Claude Code marks its tab — and, with notifications on in Settings ▸ Terminal, raises a system notification — whenever it stops to ask you something."
              note="Under tmux this needs the passthrough line below — without it, tmux drops the signal before it reaches you."
              status={hook}
              error={hookError}
              action={hookAction}
              busy={hookBusy}
              installedLabel="hook installed"
              presentLabel="older hook installed"
              onSetAction={setHookAction}
              onCancel={() => setHookAction(null)}
              onConfirm={() => void confirmHook()}
            />
            <SetupItem
              title="Status line"
              description="Installs a statusLine command in ~/.claude/settings.json on this host, so Claude Code's own status line — the row it already renders at the bottom of the terminal — shows the model, directory, worktree, effort, context usage, and rate limits."
              note="ANSI-colored text on stdout, not an OSC escape sequence — this one needs no tmux passthrough and works the same with or without it."
              status={statusLine}
              error={statusLineError}
              action={statusLineAction}
              busy={statusLineBusy}
              installedLabel="status line installed"
              presentLabel="older status line installed"
              onSetAction={setStatusLineAction}
              onCancel={() => setStatusLineAction(null)}
              onConfirm={() => void confirmStatusLine()}
            />
            <SetupItem
              title="tmux passthrough"
              description="Adds allow-passthrough to ~/.tmux.conf, and turns it on for any tmux server already running, so the attention hook above can reach you under tmux."
              status={tmuxPassthrough}
              error={tmuxPassthroughError}
              action={tmuxPassthroughAction}
              busy={tmuxPassthroughBusy}
              installedLabel="passthrough on"
              presentLabel="passthrough line present"
              onSetAction={setTmuxPassthroughAction}
              onCancel={() => setTmuxPassthroughAction(null)}
              onConfirm={() => void confirmTmuxPassthrough()}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
