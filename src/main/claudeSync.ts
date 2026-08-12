// Global Claude Code config sync between this computer and a remote host's
// `~/.claude` (plus the `mcpServers` subtree of `~/.claude.json`, which lives
// one level up). Read-modify-write logic only — the actual filesystem/SFTP IO
// lives in ipc.ts, which supplies file listings and file bytes to the pure
// functions here and writes back whatever they decide.
//
// Two things this must never do, both load-bearing for existing features:
//  - Sync `~/.claude.json` wholesale. It carries an OAuth session and machine
//    identity alongside `mcpServers`; only that one key is ever touched.
//  - Let a `settings.json` sync clobber the marker-tagged hook/statusLine
//    entries the "Set up Claude Code" flow (claudeHooks.ts) installs per host.
//    Those entries always come from whichever side is being *written to*,
//    never from the side being copied *from*.

import { HOOK_MARKER, STATUSLINE_MARKER } from './claudeHooks'

export type ClaudeSyncCategory =
  | 'claudeMd'
  | 'settings'
  | 'mcpServers'
  | 'skills'
  | 'agents'
  | 'commands'
  | 'hooks'
  | 'plugins'

export type SyncDirection = 'push' | 'pull'

/** 'same' | 'local-only' | 'remote-only' | 'differ', from comparing raw content. */
export type SyncState = 'same' | 'local-only' | 'remote-only' | 'differ'

export interface ManifestEntry {
  category: ClaudeSyncCategory
  /** Path relative to `~/.claude` (or, for mcpServers, a fixed pseudo-name). */
  relPath: string
  state: SyncState
  localSize: number | null
  remoteSize: number | null
  /** Preserve the exec bit when writing this file (any x bit set on the source). */
  executable: boolean
}

export interface SyncManifest {
  localHome: string
  remoteHome: string
  entries: ManifestEntry[]
}

export interface SyncOp {
  category: ClaudeSyncCategory
  relPath: string
  direction: SyncDirection
}

export interface SyncOpResult extends SyncOp {
  ok: boolean
  error?: string
}

// ---- whole-file categories, relative to `~/.claude` ----

export const CLAUDE_MD_RELPATH = 'CLAUDE.md'
export const SETTINGS_RELPATH = 'settings.json'
export const KEYBINDINGS_RELPATH = 'keybindings.json'
export const MCP_SERVERS_PSEUDO_RELPATH = 'mcpServers'
export const MARKETPLACES_RELPATH = 'plugins/known_marketplaces.json'

/** Directory-tree categories, relative to `~/.claude`. */
export const SYNC_DIR_CATEGORIES: { category: ClaudeSyncCategory; relDir: string }[] = [
  { category: 'skills', relDir: 'skills' },
  { category: 'agents', relDir: 'agents' },
  { category: 'commands', relDir: 'commands' },
  { category: 'hooks', relDir: 'hooks' },
  { category: 'plugins', relDir: 'plugins/marketplaces' }
]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJsonObject(raw: string | null): Record<string, unknown> {
  const text = raw === null ? '' : raw.trim()
  if (text === '') return {}
  const doc = JSON.parse(text)
  if (!isRecord(doc)) throw new Error('expected a JSON object')
  return doc
}

const render = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`

/** Two contents boiled down to the one state a scan needs to show. */
export function diffState(local: string | null, remote: string | null): SyncState {
  if (local === null && remote === null) return 'same'
  if (local === null) return 'remote-only'
  if (remote === null) return 'local-only'
  return local === remote ? 'same' : 'differ'
}

// ---- settings.json: whole-file copy, except our own marker-tagged entries ----

interface HookCommand extends Record<string, unknown> {
  command?: string
}
interface HookEntry extends Record<string, unknown> {
  hooks?: HookCommand[]
}

const isOurHook = (c: unknown): boolean =>
  isRecord(c) && typeof c.command === 'string' && c.command.includes(HOOK_MARKER)

const isOurStatusLine = (v: unknown): boolean =>
  isRecord(v) && typeof v.command === 'string' && v.command.includes(STATUSLINE_MARKER)

/**
 * Merge `sourceRaw` (the settings.json being copied *from*) on top of
 * `destRaw` (the settings.json being written *to*), except: whatever
 * marker-tagged hook/statusLine state already exists at the destination is
 * always kept, never replaced by the source's. A host's own attention-hook /
 * status-line install is local state, installed and updated through its own
 * flow — a broad settings sync copying CLAUDE.md-adjacent preferences across
 * machines must not silently toggle it off (or onto a stale command) on the
 * other end.
 *
 * Throws on invalid JSON in either side — better than silently discarding a
 * file neither side could actually parse.
 */
export function planSettingsMerge(sourceRaw: string | null, destRaw: string | null): string {
  const source = parseJsonObject(sourceRaw)
  const dest = parseJsonObject(destRaw)
  const result: Record<string, unknown> = { ...source }

  // hooks.Notification: drop any marker-tagged entries that came along with
  // the source, then re-attach whatever the destination already had (if any).
  const sourceHooks = isRecord(source.hooks) ? source.hooks : {}
  const destHooks = isRecord(dest.hooks) ? dest.hooks : {}
  const sourceNotif = Array.isArray(sourceHooks.Notification) ? (sourceHooks.Notification as HookEntry[]) : []
  const destNotif = Array.isArray(destHooks.Notification) ? (destHooks.Notification as HookEntry[]) : []

  const strippedSource = sourceNotif
    .map((e) => (Array.isArray(e?.hooks) ? { ...e, hooks: e.hooks.filter((c) => !isOurHook(c)) } : e))
    .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0)
  const destOurs = destNotif.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks.filter(isOurHook) : []))

  const nextNotif = destOurs.length > 0 ? [...strippedSource, { hooks: destOurs }] : strippedSource
  const nextHooks: Record<string, unknown> = { ...sourceHooks }
  if (nextNotif.length > 0) nextHooks.Notification = nextNotif
  else delete nextHooks.Notification
  if (Object.keys(nextHooks).length > 0) result.hooks = nextHooks
  else delete result.hooks

  // statusLine: the destination's own marker-tagged command (or lack of one)
  // always wins over whatever the source carries.
  if (isOurStatusLine(source.statusLine)) {
    if (dest.statusLine !== undefined) result.statusLine = dest.statusLine
    else delete result.statusLine
  }
  // A foreign (non-ours) statusLine on the source is just a regular setting
  // and passes through via the initial spread, same as everything else below.

  return render(result)
}

// ---- ~/.claude.json: only the `mcpServers` subtree is ever touched ----

/** Extracts just `mcpServers`, pretty-printed, for scan-time diffing. */
export function extractMcpServers(raw: string | null): string | null {
  const doc = parseJsonObject(raw)
  const servers = isRecord(doc.mcpServers) ? doc.mcpServers : {}
  if (Object.keys(servers).length === 0) return null
  return render(servers)
}

/**
 * Merge just the `mcpServers` key from `sourceRaw` (a whole `~/.claude.json`)
 * into `destRaw` (the destination's whole `~/.claude.json`), leaving every
 * other key at the destination — OAuth account, machine ID, project state,
 * telemetry — untouched. Returns the destination's full file, rewritten.
 */
export function planMcpServersMerge(sourceRaw: string | null, destRaw: string | null): string {
  const source = parseJsonObject(sourceRaw)
  const dest = parseJsonObject(destRaw)
  const sourceServers = isRecord(source.mcpServers) ? source.mcpServers : {}
  const result: Record<string, unknown> = { ...dest }
  if (Object.keys(sourceServers).length > 0) result.mcpServers = sourceServers
  else delete result.mcpServers
  return render(result)
}

/** Exec bit on the source implies the destination write should carry it too. */
export function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0
}
