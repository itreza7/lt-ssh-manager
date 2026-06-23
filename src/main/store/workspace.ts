// The open-tabs workspace, persisted to the app's user folder next to
// settings.json so the previous session is restored on the next launch.
// Passwords and live session ids are never stored here.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_WORKSPACE, type Workspace } from '../../shared/types'

const FILE = (): string => join(app.getPath('userData'), 'workspace.json')

export const workspaceStore = {
  get(): Workspace {
    try {
      if (!existsSync(FILE())) return structuredClone(EMPTY_WORKSPACE)
      const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
      if (!raw || !Array.isArray(raw.tabs)) return structuredClone(EMPTY_WORKSPACE)
      return {
        tabs: raw.tabs,
        active: typeof raw.active === 'number' ? raw.active : -1,
        // pass the tab-bar views through untouched; the renderer validates them on restore
        ...(Array.isArray(raw.views) ? { views: raw.views } : {}),
        ...(typeof raw.activeView === 'number' ? { activeView: raw.activeView } : {})
      }
    } catch {
      return structuredClone(EMPTY_WORKSPACE)
    }
  },
  set(ws: Workspace): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(FILE(), JSON.stringify(ws, null, 2), 'utf-8')
  }
}
