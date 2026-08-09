// Composer prompt history: a flat JSON file in the app's userData dir, one
// array of sent prompts shared across every pane and session. Unlike drafts,
// this is never cleared by the app itself — entries only fall off the front
// once the list passes MAX_ENTRIES.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (): string => join(app.getPath('userData'), 'prompt-history.json')
const MAX_ENTRIES = 1000

function load(): string[] {
  try {
    if (!existsSync(FILE())) return []
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function persist(entries: string[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(entries), 'utf-8')
}

export const promptHistoryStore = {
  all(): string[] {
    return load()
  },

  add(text: string): string[] {
    const entries = load()
    // A repeat of the very last entry (re-sending the same prompt) isn't a
    // new history item.
    if (entries[entries.length - 1] === text) return entries
    entries.push(text)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    persist(entries)
    return entries
  }
}
