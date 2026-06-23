// Tunnel definitions, persisted per-connection to userData/tunnels.json. These
// are just forwarding specs (host/port pairs) — no passwords or secrets here;
// auth is always resolved through the parent connection at start time.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TunnelDef } from '../../shared/types'

const FILE = (): string => join(app.getPath('userData'), 'tunnels.json')

type Store = Record<string, TunnelDef[]> // connectionId -> defs

function load(): Store {
  try {
    if (!existsSync(FILE())) return {}
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return raw && typeof raw === 'object' ? (raw as Store) : {}
  } catch {
    return {}
  }
}

function persist(store: Store): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(store, null, 2), 'utf-8')
}

export const tunnelsStore = {
  get(connectionId: string): TunnelDef[] {
    const list = load()[connectionId]
    return Array.isArray(list) ? list : []
  },

  set(connectionId: string, defs: TunnelDef[]): TunnelDef[] {
    const store = load()
    if (defs.length) store[connectionId] = defs
    else delete store[connectionId]
    persist(store)
    return defs
  },

  /** Drop a connection's tunnels (called when the connection is deleted). */
  remove(connectionId: string): void {
    const store = load()
    if (connectionId in store) {
      delete store[connectionId]
      persist(store)
    }
  }
}
