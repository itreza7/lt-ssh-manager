/** Renderer-side platform check (the preload doesn't expose process.platform). */
export const isMac = navigator.userAgent.includes('Mac OS X')

/**
 * Render a canonical "Ctrl+Shift+I"-style accelerator for the current platform:
 * on macOS the modifiers become ⌘/⇧/⌥ symbols with no separators, matching the
 * native convention; elsewhere the string is left as-is.
 */
export function fmtAccel(accel: string): string {
  if (!isMac) return accel
  return accel
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Cmd\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
}
