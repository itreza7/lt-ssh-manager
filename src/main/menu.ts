// macOS application menu.
//
// The app renders its own themed menu in the title bar, so on Windows/Linux we
// still run with no application menu at all — that is what keeps a second,
// native menu bar out of the frameless window. macOS is different: its menu bar
// lives in the system bar rather than the window, and an app without one has
// nothing driving the standard commands. Until this existed ⌘Q could not quit,
// ⌘W could not close, and ⌘M could not minimize.
//
// Accelerators are deliberately split in two. Every chord that something already
// handles — the before-input-event bindings in index.ts (⌘N, ⌘, , zoom, F11,
// ⌘⇧I), the terminal's own key handler (⌘C/⌘V), or Chromium's native editing in
// a text field (⌘X/⌘A/⌘Z) — is declared `registerAccelerator: false`: the chord
// is *displayed* in the menu for discoverability but not claimed from the
// system, so the existing handler keeps receiving the key and nothing fires
// twice. A macOS menu accelerator is matched by AppKit before the key reaches
// the page, so registering these would silently take them away from the
// terminal — the ⌘C/⌘V that 0.8.2 just fixed. Only chords nothing owns today
// (⌘Q, ⌘W, ⌘M, and the app-level roles) are registered for real.
import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { toggleFullScreen } from './ipc'

/** Show the chord in the menu without taking it from whatever handles it today. */
function display(item: MenuItemConstructorOptions): MenuItemConstructorOptions {
  return { ...item, registerAccelerator: false }
}

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null) // we render our own themed menu in the title bar
    return
  }

  const send =
    (channel: string) =>
    (): void =>
      getWindow()?.webContents.send(channel)
  const zoom =
    (delta: number | 'reset') =>
    (): void => {
      const wc = getWindow()?.webContents
      if (!wc) return
      wc.setZoomLevel(delta === 'reset' ? 0 : wc.getZoomLevel() + delta)
    }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        display({ label: 'Settings…', accelerator: 'Command+,', click: send('menu:open-settings') }),
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        display({
          label: 'New Connection…',
          accelerator: 'Command+N',
          click: send('menu:new-connection')
        }),
        { type: 'separator' },
        // Closing the last window quits the app (see index.ts), so this ends every
        // session — the same as the red traffic light, and the chord a Mac user
        // expects. Nothing handled ⌘W before, so it is registered for real.
        { role: 'close', label: 'Close Window' }
      ]
    },
    {
      label: 'Edit',
      // The chords are spelled out rather than left to the role defaults: a role
      // gets its accelerator from AppKit at registration time, so an unregistered
      // one would render with no key hint at all.
      submenu: [
        display({ role: 'undo', accelerator: 'Command+Z' }),
        display({ role: 'redo', accelerator: 'Shift+Command+Z' }),
        { type: 'separator' },
        display({ role: 'cut', accelerator: 'Command+X' }),
        display({ role: 'copy', accelerator: 'Command+C' }),
        display({ role: 'paste', accelerator: 'Command+V' }),
        { type: 'separator' },
        display({ role: 'selectAll', accelerator: 'Command+A' })
      ]
    },
    {
      label: 'View',
      submenu: [
        display({ label: 'Zoom In', accelerator: 'Command+Plus', click: zoom(0.5) }),
        display({ label: 'Zoom Out', accelerator: 'Command+-', click: zoom(-0.5) }),
        display({ label: 'Reset Zoom', accelerator: 'Command+0', click: zoom('reset') }),
        { type: 'separator' },
        display({
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: () => {
            const w = getWindow()
            if (w) toggleFullScreen(w)
          }
        }),
        display({
          label: 'Toggle Dev Tools',
          accelerator: 'Command+Shift+I',
          click: () => getWindow()?.webContents.toggleDevTools()
        })
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
