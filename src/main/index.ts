import { app, BrowserWindow, shell, nativeTheme, Menu } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import appIcon from '../../resources/icon.png?asset'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    show: false,
    frame: false, // custom in-app title bar + menu
    backgroundColor: '#0c0f15',
    title: 'SSH Manager',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // keep the custom title bar's maximize/restore button in sync
  const sendMax = (v: boolean): void => mainWindow?.webContents.send('window:maximized', v)
  mainWindow.on('maximize', () => sendMax(true))
  mainWindow.on('unmaximize', () => sendMax(false))

  // tell the renderer to drop all chrome (title bar / sidebar / tab bar) and show
  // only the active tab while full screen — fires however fullscreen was toggled.
  const sendFull = (v: boolean): void => mainWindow?.webContents.send('window:fullscreen', v)
  mainWindow.on('enter-full-screen', () => sendFull(true))
  mainWindow.on('leave-full-screen', () => sendFull(false))

  // open external links in the OS browser, never in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
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
    } else if (ctrl && key === ',') {
      wc?.send('menu:open-settings')
      event.preventDefault()
    } else if (ctrl && input.shift && key === 'i') {
      wc?.toggleDevTools()
      event.preventDefault()
    } else if (key === 'f11') {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
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
  Menu.setApplicationMenu(null) // we render our own themed menu in the title bar
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
