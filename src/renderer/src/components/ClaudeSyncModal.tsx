import { useEffect, useState } from 'react'
import type {
  ClaudeSyncBulkOp,
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
  bulk: (op: ClaudeSyncBulkOp) => Promise<void>
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

// These categories are directory trees (skills/agents/commands/hooks/plugins)
// and can run into the thousands of files (a marketplace clone under
// plugins/marketplaces, say) — rendered as a collapsible folder tree instead
// of a flat list. The other three categories are always 1-2 whole files, so
// a flat list stays fine for them.
const DIR_CATEGORIES = new Set<ClaudeSyncCategory>(['skills', 'agents', 'commands', 'hooks', 'plugins'])

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

interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: TreeItem[]
  fileCount: number
  // Every entry reaching buildTree already has state !== 'same' (the caller
  // filters those out), so these just ask: does this subtree contain
  // anything a bulk push, resp. pull, would actually touch?
  hasPush: boolean
  hasPull: boolean
}
interface TreeFile {
  kind: 'file'
  entry: ClaudeSyncEntry
}
type TreeItem = TreeFolder | TreeFile

/** Turns a flat list of entries (relPath like "plugins/marketplaces/foo/bar.md") into a nested folder tree. */
function buildTree(entries: ClaudeSyncEntry[]): TreeFolder {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [], fileCount: 0, hasPush: false, hasPull: false }
  const folders = new Map<string, TreeFolder>([['', root]])

  for (const entry of entries) {
    const parts = entry.relPath.split('/')
    let parent = root
    let parentPath = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parentPath ? `${parentPath}/${parts[i]}` : parts[i]
      let folder = folders.get(path)
      if (!folder) {
        folder = { kind: 'folder', name: parts[i], path, children: [], fileCount: 0, hasPush: false, hasPull: false }
        folders.set(path, folder)
        parent.children.push(folder)
      }
      parent = folder
      parentPath = path
    }
    parent.children.push({ kind: 'file', entry })
  }

  const finalize = (node: TreeFolder): void => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      const an = a.kind === 'folder' ? a.name : a.entry.relPath
      const bn = b.kind === 'folder' ? b.name : b.entry.relPath
      return an.localeCompare(bn)
    })
    for (const c of node.children) {
      if (c.kind === 'file') {
        node.fileCount += 1
        if (c.entry.state === 'local-only' || c.entry.state === 'differ') node.hasPush = true
        if (c.entry.state === 'remote-only' || c.entry.state === 'differ') node.hasPull = true
      } else {
        finalize(c)
        node.fileCount += c.fileCount
        node.hasPush = node.hasPush || c.hasPush
        node.hasPull = node.hasPull || c.hasPull
      }
    }
  }
  finalize(root)

  // Collapse a chain of single-child folders into one row — the same trick
  // VS Code's "compact folders" uses. Without it, every plugins/marketplaces
  // entry nests three redundant single-item rows (plugins ▸ marketplaces ▸
  // <name>) before reaching anything worth expanding.
  const compactChains = (node: TreeFolder): void => {
    while (node.children.length === 1 && node.children[0].kind === 'folder') {
      const only = node.children[0]
      node.name = node.name ? `${node.name}/${only.name}` : only.name
      node.path = only.path
      node.children = only.children
      node.hasPush = only.hasPush
      node.hasPull = only.hasPull
      node.fileCount = only.fileCount
    }
    for (const c of node.children) if (c.kind === 'folder') compactChains(c)
  }
  compactChains(root)

  return root
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
  displayName,
  depth = 0,
  direction,
  onSetDirection,
  expanded,
  onToggleExpanded,
  diff,
  diffLoading,
  diffError
}: {
  entry: ClaudeSyncEntry
  displayName?: string
  depth?: number
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
          style={{ paddingLeft: depth * 16 }}
          title={entry.relPath}
        >
          {displayName ?? entry.relPath}
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

interface TreeRenderProps {
  category: ClaudeSyncCategory
  depth: number
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  directions: Map<string, ClaudeSyncDirection | null>
  onSetDirection: (e: ClaudeSyncEntry, d: ClaudeSyncDirection | null) => void
  expandedKey: string | null
  onToggleExpanded: (e: ClaudeSyncEntry) => void
  diffs: Map<string, { local: string | null; remote: string | null }>
  diffLoading: string | null
  diffError: string | null
  bulkBusyPath: string | null
  bulkErrors: Map<string, string>
  onBulk: (folder: TreeFolder, direction: ClaudeSyncDirection) => void
}

function FolderRow({
  folder,
  ...rest
}: TreeRenderProps & { folder: TreeFolder }) {
  const { category, depth, expandedFolders, onToggleFolder, bulkBusyPath, bulkErrors, onBulk } = rest
  const expanded = expandedFolders.has(folder.path)
  const busy = bulkBusyPath === folder.path
  const err = bulkErrors.get(folder.path)
  return (
    <div className="border-t border-line-soft py-2 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => onToggleFolder(folder.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left font-mono text-xs text-fg/85 hover:text-fg"
          style={{ paddingLeft: depth * 16 }}
          title={folder.path}
        >
          <span className="shrink-0 text-faint">{expanded ? '▾' : '▸'}</span>
          <span className="truncate">{folder.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">
            ({folder.fileCount} file{folder.fileCount === 1 ? '' : 's'})
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onBulk(folder, 'push')}
            disabled={!folder.hasPush || busy}
            title="Push this whole folder, local → remote"
            className="rounded-md border border-line px-2 py-1 text-xs text-faint transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            {busy ? '…' : 'Push folder ▸'}
          </button>
          <button
            onClick={() => onBulk(folder, 'pull')}
            disabled={!folder.hasPull || busy}
            title="Pull this whole folder, remote → local"
            className="rounded-md border border-line px-2 py-1 text-xs text-faint transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            {busy ? '…' : '◂ Pull folder'}
          </button>
        </div>
      </div>
      {err && (
        <p className="mt-1.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 font-mono text-[11px] text-danger" style={{ marginLeft: depth * 16 }}>
          {err}
        </p>
      )}
      {expanded && (
        <div>
          {folder.children.map((child) =>
            child.kind === 'folder' ? (
              <FolderRow key={child.path} folder={child} {...rest} category={category} depth={depth + 1} />
            ) : (
              <EntryRow
                key={entryKey(child.entry)}
                entry={child.entry}
                displayName={child.entry.relPath.split('/').pop()}
                depth={depth + 1}
                direction={rest.directions.get(entryKey(child.entry)) ?? null}
                onSetDirection={(d) => rest.onSetDirection(child.entry, d)}
                expanded={rest.expandedKey === entryKey(child.entry)}
                onToggleExpanded={() => rest.onToggleExpanded(child.entry)}
                diff={rest.diffs.get(entryKey(child.entry))}
                diffLoading={rest.diffLoading === entryKey(child.entry)}
                diffError={rest.diffLoading === entryKey(child.entry) ? null : rest.diffError}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

export function ClaudeSyncModal({ connectionName, onClose, scan, readFile, apply, bulk }: Props) {
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
  // Folder tree (skills/agents/commands/hooks/plugins): collapsed by default,
  // keyed by the folder's path so state survives a rescan as long as the
  // folder itself still exists.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [bulkBusyPath, setBulkBusyPath] = useState<string | null>(null)
  const [bulkErrors, setBulkErrors] = useState<Map<string, string>>(new Map())

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

  const toggleFolder = (path: string): void => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const bulkFolder = (category: ClaudeSyncCategory, folder: TreeFolder, direction: ClaudeSyncDirection): void => {
    const verb = direction === 'push' ? 'Push' : 'Pull'
    const arrow = direction === 'push' ? 'local → remote' : 'remote → local'
    if (
      !confirm(
        `${verb} “${folder.path}” (${folder.fileCount} file${folder.fileCount === 1 ? '' : 's'}), ${arrow}?\n\n` +
          `This overwrites the destination's copy of every file in this folder in one shot — it does not go through the review step below.`
      )
    ) {
      return
    }
    setBulkBusyPath(folder.path)
    setBulkErrors((prev) => {
      const next = new Map(prev)
      next.delete(folder.path)
      return next
    })
    bulk({ category, relDir: folder.path, direction })
      .then(() => load())
      .catch((e) => {
        setBulkErrors((prev) => new Map(prev).set(folder.path, e instanceof Error ? e.message : String(e)))
      })
      .finally(() => setBulkBusyPath(null))
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
          {grouped.map(({ category, entries }) =>
            DIR_CATEGORIES.has(category) ? (
              <div key={category}>
                <div className="eyebrow mb-1.5">{CATEGORY_LABELS[category]}</div>
                {buildTree(entries).children.map((child) =>
                  child.kind === 'folder' ? (
                    <FolderRow
                      key={child.path}
                      folder={child}
                      category={category}
                      depth={0}
                      expandedFolders={expandedFolders}
                      onToggleFolder={toggleFolder}
                      directions={directions}
                      onSetDirection={(e, d) => setDirections((prev) => new Map(prev).set(entryKey(e), d))}
                      expandedKey={expandedKey}
                      onToggleExpanded={toggleExpanded}
                      diffs={diffs}
                      diffLoading={diffLoading}
                      diffError={diffError}
                      bulkBusyPath={bulkBusyPath}
                      bulkErrors={bulkErrors}
                      onBulk={(folder, direction) => bulkFolder(category, folder, direction)}
                    />
                  ) : (
                    <EntryRow
                      key={entryKey(child.entry)}
                      entry={child.entry}
                      direction={directions.get(entryKey(child.entry)) ?? null}
                      onSetDirection={(d) => setDirections((prev) => new Map(prev).set(entryKey(child.entry), d))}
                      expanded={expandedKey === entryKey(child.entry)}
                      onToggleExpanded={() => toggleExpanded(child.entry)}
                      diff={diffs.get(entryKey(child.entry))}
                      diffLoading={diffLoading === entryKey(child.entry)}
                      diffError={diffLoading === entryKey(child.entry) ? null : diffError}
                    />
                  )
                )}
              </div>
            ) : (
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
            )
          )}
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
