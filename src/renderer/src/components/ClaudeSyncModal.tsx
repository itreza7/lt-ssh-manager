import { useEffect, useState } from 'react'
import type {
  ClaudeSyncCategory,
  ClaudeSyncDirection,
  ClaudeSyncEntry,
  ClaudeSyncManifest,
  ClaudeSyncOp,
  ClaudeSyncOpResult,
  ClaudeSyncState
} from '../../../shared/types'
import { Button, Modal } from './Modal'

interface Props {
  connectionName: string
  onClose: () => void
  scan: () => Promise<ClaudeSyncManifest>
  readFile: (category: ClaudeSyncCategory, relPath: string) => Promise<{ local: string | null; remote: string | null }>
  apply: (ops: ClaudeSyncOp[]) => Promise<ClaudeSyncOpResult[]>
}

const CATEGORY_LABELS: Record<ClaudeSyncCategory, string> = {
  claudeMd: 'CLAUDE.md',
  settings: 'Settings & keybindings',
  mcpServers: 'MCP servers',
  skills: 'Skills',
  agents: 'Agents',
  commands: 'Commands',
  hooks: 'Hooks',
  plugins: 'Plugins'
}

const CATEGORY_ORDER: ClaudeSyncCategory[] = [
  'claudeMd',
  'settings',
  'mcpServers',
  'skills',
  'agents',
  'commands',
  'hooks',
  'plugins'
]

const STATE_LABEL: Record<ClaudeSyncState, string> = {
  same: 'identical',
  'local-only': 'local only',
  'remote-only': 'remote only',
  differ: 'differs'
}

const STATE_TONE: Record<ClaudeSyncState, string> = {
  same: 'text-faint',
  'local-only': 'text-accent',
  'remote-only': 'text-amber',
  differ: 'text-danger'
}

function defaultDirection(state: ClaudeSyncState): ClaudeSyncDirection | null {
  if (state === 'local-only') return 'push'
  if (state === 'remote-only') return 'pull'
  return null
}

const entryKey = (e: { category: string; relPath: string }): string => `${e.category}:${e.relPath}`

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function DiffPane({ label, body }: { label: string; body: string }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <pre className="max-h-56 overflow-auto rounded-lg border border-line bg-ink/60 p-3 font-mono text-xs leading-relaxed whitespace-pre text-fg/85">
        {body}
      </pre>
    </div>
  )
}

function EntryRow({
  entry,
  direction,
  onSetDirection,
  expanded,
  onToggleExpanded,
  diff,
  diffLoading,
  diffError
}: {
  entry: ClaudeSyncEntry
  direction: ClaudeSyncDirection | null
  onSetDirection: (d: ClaudeSyncDirection | null) => void
  expanded: boolean
  onToggleExpanded: () => void
  diff: { local: string | null; remote: string | null } | undefined
  diffLoading: boolean
  diffError: string | null
}) {
  return (
    <div className="border-t border-line-soft py-2.5 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onToggleExpanded}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg/85 hover:text-fg"
          title={entry.relPath}
        >
          {entry.relPath}
        </button>
        <span className={`shrink-0 font-mono text-[11px] ${STATE_TONE[entry.state]}`}>
          {STATE_LABEL[entry.state]}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {fmtBytes(entry.localSize)} / {fmtBytes(entry.remoteSize)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onSetDirection(direction === 'push' ? null : 'push')}
            disabled={entry.state === 'same'}
            title="Push local → remote"
            className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
              direction === 'push'
                ? 'border-accent/50 bg-accent-soft/40 text-accent'
                : 'border-line text-faint hover:text-fg'
            }`}
          >
            Push ▸
          </button>
          <button
            onClick={() => onSetDirection(direction === 'pull' ? null : 'pull')}
            disabled={entry.state === 'same'}
            title="Pull remote → local"
            className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
              direction === 'pull'
                ? 'border-accent/50 bg-accent-soft/40 text-accent'
                : 'border-line text-faint hover:text-fg'
            }`}
          >
            ◂ Pull
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2.5">
          {diffLoading && <p className="font-mono text-xs text-faint">reading…</p>}
          {diffError && (
            <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {diffError}
            </p>
          )}
          {diff && !diffLoading && !diffError && (
            <div className="grid grid-cols-2 gap-3">
              <DiffPane label="Local" body={diff.local ?? '(missing)'} />
              <DiffPane label="Remote" body={diff.remote ?? '(missing)'} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ClaudeSyncModal({ connectionName, onClose, scan, readFile, apply }: Props) {
  const [manifest, setManifest] = useState<ClaudeSyncManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [directions, setDirections] = useState<Map<string, ClaudeSyncDirection | null>>(new Map())
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Map<string, { local: string | null; remote: string | null }>>(new Map())
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [stage, setStage] = useState<'scan' | 'review' | 'result'>('scan')
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<ClaudeSyncOpResult[] | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const m = await scan()
      setManifest(m)
      const next = new Map<string, ClaudeSyncDirection | null>()
      for (const e of m.entries) next.set(entryKey(e), defaultDirection(e.state))
      setDirections(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setManifest(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleExpanded = (e: ClaudeSyncEntry): void => {
    const key = entryKey(e)
    if (expandedKey === key) {
      setExpandedKey(null)
      return
    }
    setExpandedKey(key)
    if (!diffs.has(key)) {
      setDiffLoading(key)
      setDiffError(null)
      readFile(e.category, e.relPath)
        .then((d) => setDiffs((prev) => new Map(prev).set(key, d)))
        .catch((err) => setDiffError(err instanceof Error ? err.message : String(err)))
        .finally(() => setDiffLoading(null))
    }
  }

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    entries: (manifest?.entries ?? []).filter((e) => e.category === category && e.state !== 'same')
  })).filter((g) => g.entries.length > 0)

  const sameCount = (manifest?.entries ?? []).filter((e) => e.state === 'same').length

  const setAll = (state: ClaudeSyncState, direction: ClaudeSyncDirection): void => {
    setDirections((prev) => {
      const next = new Map(prev)
      for (const e of manifest?.entries ?? []) {
        if (e.state === state) next.set(entryKey(e), direction)
      }
      return next
    })
  }

  const pendingOps: ClaudeSyncOp[] = (manifest?.entries ?? [])
    .map((e) => ({ category: e.category, relPath: e.relPath, direction: directions.get(entryKey(e)) ?? null }))
    .filter((op): op is ClaudeSyncOp => op.direction !== null)

  const confirmApply = async (): Promise<void> => {
    setApplying(true)
    try {
      const res = await apply(pendingOps)
      setResults(res)
      setStage('result')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      width={820}
      title={`Sync Claude Config — ${connectionName}`}
      onClose={() => {
        if (applying) return
        onClose()
      }}
      footer={
        stage === 'scan' ? (
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button onClick={() => setAll('local-only', 'push')} disabled={loading}>
                Push all local-only
              </Button>
              <Button onClick={() => setAll('remote-only', 'pull')} disabled={loading}>
                Pull all remote-only
              </Button>
            </div>
            <Button variant="primary" disabled={loading || pendingOps.length === 0} onClick={() => setStage('review')}>
              Review {pendingOps.length > 0 ? `${pendingOps.length} change${pendingOps.length > 1 ? 's' : ''} ` : ''}▸
            </Button>
          </div>
        ) : stage === 'review' ? (
          <>
            <Button onClick={() => setStage('scan')} disabled={applying}>
              Back
            </Button>
            <Button variant="primary" disabled={applying} onClick={() => void confirmApply()}>
              {applying ? 'Writing…' : `Apply ${pendingOps.length} change${pendingOps.length > 1 ? 's' : ''}`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => void load().then(() => setStage('scan'))}>Rescan</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {loading && <p className="font-mono text-xs text-faint">scanning ~/.claude on both sides…</p>}
      {error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      {!loading && !error && stage === 'scan' && manifest && (
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {grouped.length === 0 && (
            <p className="text-sm text-muted">
              {sameCount > 0
                ? `Everything matches — ${sameCount} file${sameCount > 1 ? 's are' : ' is'} identical on both sides.`
                : 'No Claude config found on either side.'}
            </p>
          )}
          {grouped.map(({ category, entries }) => (
            <div key={category}>
              <div className="eyebrow mb-1.5">{CATEGORY_LABELS[category]}</div>
              {entries.map((e) => (
                <EntryRow
                  key={entryKey(e)}
                  entry={e}
                  direction={directions.get(entryKey(e)) ?? null}
                  onSetDirection={(d) => setDirections((prev) => new Map(prev).set(entryKey(e), d))}
                  expanded={expandedKey === entryKey(e)}
                  onToggleExpanded={() => toggleExpanded(e)}
                  diff={diffs.get(entryKey(e))}
                  diffLoading={diffLoading === entryKey(e)}
                  diffError={diffLoading === entryKey(e) ? null : diffError}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && !error && stage === 'review' && (
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
          <p className="mb-3 text-sm text-fg/75">
            This will overwrite the destination file for each entry below. Nothing is written until you confirm.
          </p>
          {pendingOps.map((op) => (
            <div
              key={entryKey(op)}
              className="flex items-center justify-between gap-3 border-t border-line-soft py-2 first:border-0"
            >
              <span className="min-w-0 truncate font-mono text-xs text-fg/85">{op.relPath}</span>
              <span className="shrink-0 font-mono text-[11px] text-accent">
                {op.direction === 'push' ? 'local → remote' : 'remote → local'}
              </span>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && stage === 'result' && results && (
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
          {results.map((r) => (
            <div
              key={entryKey(r)}
              className="flex items-center justify-between gap-3 border-t border-line-soft py-2 first:border-0"
            >
              <span className="min-w-0 truncate font-mono text-xs text-fg/85">{r.relPath}</span>
              {r.ok ? (
                <span className="shrink-0 font-mono text-[11px] text-accent">done</span>
              ) : (
                <span className="shrink-0 truncate font-mono text-[11px] text-danger" title={r.error}>
                  failed — {r.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
