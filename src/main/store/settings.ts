// App settings persisted to the app's user folder (%APPDATA%/ssh-manager on
// Windows), next to connections.json — not browser storage.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_APP_SETTINGS,
  SETTINGS_VERSION,
  type AppSettings,
  type SettingsPatch
} from '../../shared/types'

const FILE = () => join(app.getPath('userData'), 'settings.json')

/**
 * Bring a saved file up to SETTINGS_VERSION. Each step runs exactly once per
 * install — the new version is written back immediately — so a user who re-picks
 * the old value afterwards keeps it.
 */
function migrate(s: AppSettings, from: number): AppSettings {
  // v1: the terminal cursor used to blink by default. That blink is the app's
  // largest idle power draw (a full WebGL redraw plus a compositor frame, twice a
  // second, for as long as the app is open), and it was a default nobody chose,
  // so clear it. It's one toggle away in Settings for anyone who wants it back.
  if (from < 1) s = { ...s, terminal: { ...s.terminal, cursorBlink: false } }
  return s
}

function load(): AppSettings {
  try {
    if (!existsSync(FILE())) return structuredClone(DEFAULT_APP_SETTINGS)
    const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
    const merged: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      ...raw,
      terminal: { ...DEFAULT_APP_SETTINGS.terminal, ...(raw.terminal ?? {}) },
      editor: { ...DEFAULT_APP_SETTINGS.editor, ...(raw.editor ?? {}) }
    }
    const from = typeof raw.version === 'number' ? raw.version : 0
    if (from >= SETTINGS_VERSION) return merged
    const migrated: AppSettings = { ...migrate(merged, from), version: SETTINGS_VERSION }
    try {
      persist(migrated)
    } catch {
      /* couldn't record the new version — the step just runs again next launch */
    }
    return migrated
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
