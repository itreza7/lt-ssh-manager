// Prompt composer draft persistence: a flat JSON file in the app's userData
// dir. Keyed by a tab's stable tabKey so a draft survives disconnects,
// crashes, and full app restarts — cleared only on explicit send, discard,
// or tab close.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (): string => join(app.getPath('userData'), 'drafts.json')

function load(): Record<string, string> {
  try {
    if (!existsSync(FILE())) return {}
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function persist(drafts: Record<string, string>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(drafts), 'utf-8')
}

export const draftStore = {
  all(): Record<string, string> {
    return load()
  },

  set(key: string, value: string): void {
    const drafts = load()
    if (value) drafts[key] = value
    else delete drafts[key]
    persist(drafts)
  }
}
