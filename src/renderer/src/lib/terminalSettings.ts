// UI-side helpers for settings. The settings themselves are persisted on disk
// by the main process (see main/store/settings.ts), not in the browser.
export type {
  AppSettings,
  CursorStyle,
  EditorSettings,
  SettingsPatch,
  TerminalSettings
} from '../../../shared/types'
import { DEFAULT_APP_SETTINGS } from '../../../shared/types'

export const DEFAULTS = DEFAULT_APP_SETTINGS

export const TAB_SIZES = [2, 4, 8] as const

export const FONT_MIN = 8
export const FONT_MAX = 28
export const SCROLLBACK_MIN = 200
export const SCROLLBACK_MAX = 100000
export const RETRIES_MIN = 1
export const RETRIES_MAX = 10

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)))

export const clampFont = (n: number): number => clamp(n, FONT_MIN, FONT_MAX)
export const clampScrollback = (n: number): number => clamp(n, SCROLLBACK_MIN, SCROLLBACK_MAX)
export const clampRetries = (n: number): number => clamp(n, RETRIES_MIN, RETRIES_MAX)

// Terminal font choices. The first two are bundled (offline); the rest fall
// back to OS-installed monospace fonts. `stack` is the CSS font-family.
const MONO = 'ui-monospace, "Cascadia Code", Consolas, monospace'
export interface TerminalFont {
  id: string
  label: string
  stack: string
  bundled?: boolean
}
export const TERMINAL_FONTS: TerminalFont[] = [
  { id: 'jetbrains', label: 'JetBrains Mono', stack: `"JetBrains Mono Variable", ${MONO}`, bundled: true },
  { id: 'fira', label: 'Fira Code', stack: `"Fira Code Variable", ${MONO}`, bundled: true },
  { id: 'cascadia', label: 'Cascadia Code', stack: `"Cascadia Code", "Cascadia Mono", ${MONO}` },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { id: 'courier', label: 'Courier New', stack: '"Courier New", monospace' }
]

export const resolveFontStack = (id: string): string =>
  TERMINAL_FONTS.find((f) => f.id === id)?.stack ?? TERMINAL_FONTS[0].stack
