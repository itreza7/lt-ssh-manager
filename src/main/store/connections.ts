// Connection persistence: a JSON file in the app's userData dir. Passwords are
// NEVER stored here — see secrets.ts (OS-encrypted via Electron safeStorage).
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Connection, ConnectionDraft } from '../../shared/types'

const FILE = () => join(app.getPath('userData'), 'connections.json')

function load(): Connection[] {
  try {
    if (!existsSync(FILE())) return []
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function persist(list: Connection[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(list, null, 2), 'utf-8')
}

export const connectionStore = {
  list(): Connection[] {
    return load()
  },

  get(id: string): Connection | undefined {
    return load().find((c) => c.id === id)
  },

  upsert(draft: ConnectionDraft): Connection {
    const list = load()
    const id = draft.id ?? randomUUID().slice(0, 8)
    const existing = list.find((c) => c.id === id)
    const conn: Connection = {
      id,
      name: draft.name?.trim() || 'Unnamed',
      host: draft.host.trim(),
      port: draft.port || 22,
      username: draft.username.trim(),
      authMethod: draft.authMethod,
      keyPath: draft.keyPath?.trim() || undefined,
      sftpPath: draft.sftpPath?.trim() || undefined,
      // editing a connection must not wipe the remembered browse location
      lastSftpPath: draft.lastSftpPath ?? existing?.lastSftpPath,
      notes: draft.notes?.trim() || undefined,
      tmux: draft.tmux || undefined,
      tmuxSession: draft.tmuxSession?.trim() || undefined,
      tmuxDetachOthers: draft.tmuxDetachOthers || undefined
    }
    const idx = list.findIndex((c) => c.id === conn.id)
    if (idx >= 0) list[idx] = conn
    else list.push(conn)
    persist(list)
    return conn
  },

  setLastSftpPath(id: string, path: string): void {
    const list = load()
    const conn = list.find((c) => c.id === id)
    if (!conn || conn.lastSftpPath === path) return
    conn.lastSftpPath = path
    persist(list)
  },

  remove(id: string): void {
    persist(load().filter((c) => c.id !== id))
  }
}
