// App settings persisted to the app's user folder (%APPDATA%/ssh-manager on
// Windows), next to connections.json — not browser storage.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS, type AppSettings, type SettingsPatch } from '../../shared/types'

const FILE = () => join(app.getPath('userData'), 'settings.json')

function load(): AppSettings {
  try {
    if (!existsSync(FILE())) return structuredClone(DEFAULT_APP_SETTINGS)
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    return {
      ...DEFAULT_APP_SETTINGS,
      ...raw,
      terminal: { ...DEFAULT_APP_SETTINGS.terminal, ...(raw.terminal ?? {}) },
      editor: { ...DEFAULT_APP_SETTINGS.editor, ...(raw.editor ?? {}) }
    }
  } catch {
    return structuredClone(DEFAULT_APP_SETTINGS)
  }
}

function persist(s: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(s, null, 2), 'utf-8')
}

export const settingsStore = {
  getAll(): AppSettings {
    return load()
  },
  update(patch: SettingsPatch): AppSettings {
    const cur = load()
    const merged: AppSettings = {
      ...cur,
      ...patch,
      terminal: { ...cur.terminal, ...(patch.terminal ?? {}) },
      editor: { ...cur.editor, ...(patch.editor ?? {}) }
    }
    persist(merged)
    return merged
  }
}
