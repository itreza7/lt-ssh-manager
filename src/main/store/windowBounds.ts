// The main window's last position/size, persisted to the app's user folder so
// launch restores the previous frame instead of always maximizing.
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const FILE = (): string => join(app.getPath('userData'), 'window-bounds.json')

export const windowBoundsStore = {
  get(): WindowBounds | null {
    try {
      if (!existsSync(FILE())) return null
      const raw = JSON.parse(readFileSync(FILE(), 'utf-8'))
      if (
        typeof raw?.x !== 'number' ||
        typeof raw?.y !== 'number' ||
        typeof raw?.width !== 'number' ||
        typeof raw?.height !== 'number'
      )
        return null
      return { x: raw.x, y: raw.y, width: raw.width, height: raw.height, maximized: !!raw.maximized }
    } catch {
      return null
    }
  },
  set(bounds: WindowBounds): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(FILE(), JSON.stringify(bounds), 'utf-8')
  }
}
