// Prompt snippet persistence: a flat JSON file in the app's userData dir,
// same shape as connections.ts. Snippets are global — not per-connection.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Snippet, SnippetDraft } from '../../shared/types'

const FILE = () => join(app.getPath('userData'), 'snippets.json')

function load(): Snippet[] {
  try {
    if (!existsSync(FILE())) return []
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function persist(list: Snippet[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(list, null, 2), 'utf-8')
}

export const snippetStore = {
  list(): Snippet[] {
    return load()
  },

  upsert(draft: SnippetDraft): Snippet {
    const list = load()
    const id = draft.id ?? randomUUID().slice(0, 8)
    const snippet: Snippet = {
      id,
      name: draft.name.trim() || 'Untitled',
      body: draft.body
    }
    const idx = list.findIndex((s) => s.id === snippet.id)
    if (idx >= 0) list[idx] = snippet
    else list.push(snippet)
    persist(list)
    return snippet
  },

  remove(id: string): void {
    persist(load().filter((s) => s.id !== id))
  }
}
