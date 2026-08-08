import { app, BrowserWindow, shell, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import { registerIpc, toggleFullScreen } from './ipc'
import { installAppMenu } from './menu'
import { windowBoundsStore, type WindowBounds } from './store/windowBounds'
import appIcon from '../../resources/icon.png?asset'

let mainWindow: BrowserWindow | null = null

// A saved position can go stale — the external monitor it was on got
// unplugged, the laptop's own resolution changed — so only trust it if it
// still lands on some display; otherwise fall back to the centered default
// rather than opening a window nobody can see or reach.
function isOnScreen(b: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
  })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const saved = windowBoundsStore.get()
  const restorable = saved && isOnScreen(saved) ? saved : null
  mainWindow = new BrowserWindow({
    ...(restorable
      ? { x: restorable.x, y: restorable.y, width: restorable.width, height: restorable.height }
      : { width: 1100, height: 720 }),
    minWidth: 800,
    minHeight: 500,
    show: false,
    // Custom in-app title bar + menu. On macOS keep the native traffic lights
    // (hidden title bar) instead of a fully frameless window; elsewhere go frameless.
    // Vibrancy is the native blur-behind-the-window material a sidebar sits on
    // in a real Mac app; the renderer meets it halfway by making body
    // transparent there and repainting an opaque backdrop for everything that
    // isn't the sidebar (see html.mac in index.css).
    ...(isMac
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 14, y: 12 },
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const
        }
      : { frame: false }),
    // Opaque everywhere but macOS, where an opaque native backing would paint
    // over the vibrancy layer before the (transparent) page ever loads.
    backgroundColor: isMac ? '#00000000' : '#0c0f15',
    title: 'Claude SSH Manager',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // First launch (nothing restorable yet) still opens maximized — a sane
    // full-size default. After that, whatever the user left it as, including
    // maximized, which the constructor's width/height alone can't express.
    if (!restorable || restorable.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })

  // keep the custom title bar's maximize/restore button in sync, and persist
  // the frame so the next launch can restore it. getBounds() while maximized
  // reports the maximized rectangle, not the one to restore into, so a
  // maximized save reuses whatever normal rect was last recorded.
  const sendMax = (v: boolean): void => mainWindow?.webContents.send('window:maximized', v)
  const saveBounds = (maximized: boolean): void => {
    if (!mainWindow || mainWindow.isFullScreen()) return
    const rect = mainWindow.isMaximized() ? (windowBoundsStore.get() ?? mainWindow.getBounds()) : mainWindow.getBounds()
    const bounds: WindowBounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, maximized }
    windowBoundsStore.set(bounds)
  }
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSaveBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveBounds(false), 400)
  }
  mainWindow.on('maximize', () => {
    sendMax(true)
    saveBounds(true)
  })
  mainWindow.on('unmaximize', () => {
    sendMax(false)
    saveBounds(false)
  })
  // Only a genuinely windowed resize/move belongs here — the maximize/unmaximize
  // handlers above already cover the maximized transition itself.
  mainWindow.on('resize', () => {
    if (!mainWindow?.isMaximized()) scheduleSaveBounds()
  })
  mainWindow.on('move', () => {
    if (!mainWindow?.isMaximized()) scheduleSaveBounds()
  })
  mainWindow.on('close', () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveBounds(mainWindow?.isMaximized() ?? false)
  })

  // notify the renderer of native fullscreen transitions (macOS uses simple
  // fullscreen, which doesn't emit these — the chrome stays put either way).
  const sendFull = (v: boolean): void => mainWindow?.webContents.send('window:fullscreen', v)
  mainWindow.on('enter-full-screen', () => sendFull(true))
  mainWindow.on('leave-full-screen', () => sendFull(false))

  // open external links in the OS browser, never in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Nothing in this app ever navigates — the UI is one React tree that lives for
  // the life of the window — so any navigation is something going wrong, and the
  // usual cause is a file dropped somewhere the renderer didn't handle it.
  // Chromium's default for that is to load `file:///…` in place, which unmounts
  // the app and takes every live SSH session with it. Same-URL navigations are
  // let through so the dev server's reload still works.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  // Without a native menu we keep the useful accelerators ourselves.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    const key = input.key.toLowerCase()
    const wc = mainWindow?.webContents
    if (ctrl && key === 'n') {
      wc?.send('menu:new-connection')
      event.preventDefault()
    } else if (input.meta && key === 'k') {
      // Cmd-only (not Ctrl+K) — Ctrl+K is readline's kill-line, used constantly
      // inside the remote shells this app exists to host.
      wc?.send('menu:command-palette')
      event.preventDefault()
    } else if (ctrl && key === ',') {
      wc?.send('menu:open-settings')
      event.preventDefault()
    } else if (ctrl && input.shift && key === 'i') {
      wc?.toggleDevTools()
      event.preventDefault()
    } else if (key === 'f11') {
      if (mainWindow) toggleFullScreen(mainWindow)
      event.preventDefault()
    } else if (ctrl && (key === '=' || key === '+')) {
      wc?.setZoomLevel((wc.getZoomLevel() ?? 0) + 0.5)
      event.preventDefault()
    } else if (ctrl && key === '-') {
      wc?.setZoomLevel((wc.getZoomLevel() ?? 0) - 0.5)
      event.preventDefault()
    } else if (ctrl && key === '0') {
      wc?.setZoomLevel(0)
      event.preventDefault()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  registerIpc(() => mainWindow)
  // macOS gets a real application menu (the standard commands have nothing else
  // driving them there); every other platform keeps none. See menu.ts.
  installAppMenu(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit once the last window closes on every platform, including macOS — the app
// has a single window, so there's nothing to keep the process alive for.
app.on('window-all-closed', () => {
  app.quit()
})
