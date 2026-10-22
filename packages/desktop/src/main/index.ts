import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { getLocale, l, type Locale } from '@skript-ide/i18n'
import { IpcChannel } from '../shared/ipc'
import { setupAgent } from './agent'
import { initLocale, saveLocale } from './locale'
import { buildAppMenu } from './menu'
import { setupValidator } from './validator'
import { allowPath, listDirectory, readTextFile, writeTextFile } from './workspace'

// Menü, iletişim kutuları ve doğrulama sunucusunun mesajları bu dilde üretilir
initLocale()

let mainWindow: BrowserWindow | null = null
let hasUnsavedChanges = false

/** Başlık çubuğu yüksekliği ve rengi; arayüzdeki `#titlebar` ile aynı olmalı. */
const TITLEBAR_HEIGHT = 32
const TITLEBAR_COLOR = '#1f1f1f'
const TITLEBAR_SYMBOL_COLOR = '#cccccc'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Skript IDE',
    icon: join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#1e1e1e',
    // Sistem başlık çubuğu yerine arayüzdeki `#titlebar` kullanılır. Windows/Linux'ta küçült/büyüt/kapat
    // düğmeleri sistemden gelir (titleBarOverlay); macOS'ta trafik ışıkları başlığın soluna yerleşir.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarOverlay: { color: TITLEBAR_COLOR, symbolColor: TITLEBAR_SYMBOL_COLOR, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Uygulama içinde başka sayfaya gidilmesin; dış bağlantılar tarayıcıda açılsın
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.on('close', (event) => {
    if (!hasUnsavedChanges || !mainWindow) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: [l('Kaydetmeden Çık', 'Quit Without Saving'), l('İptal', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      title: 'Skript IDE',
      message: l('Kaydedilmemiş değişiklikler var.', 'There are unsaved changes.'),
      detail: l('Şimdi çıkarsan bu değişiklikler kaybolacak.', 'If you quit now, these changes will be lost.')
    })
    if (choice === 1) event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.openFolderDialog, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: l('Klasör Aç', 'Open Folder'),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    allowPath(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannel.openFileDialog, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: l('Dosya Aç', 'Open File'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Skript', extensions: ['sk'] },
        { name: l('Tüm Dosyalar', 'All Files'), extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    result.filePaths.forEach(allowPath)
    return result.filePaths
  })

  ipcMain.handle(IpcChannel.saveFileDialog, async (_event, suggestedName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: l('Farklı Kaydet', 'Save As'),
      defaultPath: suggestedName,
      filters: [
        { name: 'Skript', extensions: ['sk'] },
        { name: l('Tüm Dosyalar', 'All Files'), extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    allowPath(result.filePath)
    return result.filePath
  })

  ipcMain.handle(IpcChannel.readDir, (_event, dir: string) => listDirectory(dir))
  ipcMain.handle(IpcChannel.readFile, (_event, path: string) => readTextFile(path))
  ipcMain.handle(IpcChannel.writeFile, (_event, path: string, content: string) => writeTextFile(path, content))
  ipcMain.on(IpcChannel.setDirty, (_event, dirty: boolean) => {
    hasUnsavedChanges = dirty
  })

  // Arayüz modülleri ilk yüklenirken dili bilmeli; bu yüzden eşzamanlı
  ipcMain.on(IpcChannel.locale, (event) => {
    event.returnValue = getLocale()
  })

  ipcMain.handle(IpcChannel.menuLabels, () => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [])
  ipcMain.handle(IpcChannel.menuPopup, (event, index: number, x: number, y: number) => {
    const submenu = Menu.getApplicationMenu()?.items[index]?.submenu
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!submenu || !window) return
    return new Promise<void>((resolve) => {
      // Arayüz CSS pikseli gönderir; popup pencere koordinatı (DIP) bekler, yakınlaştırma farkı burada düzelir.
      const zoom = event.sender.getZoomFactor()
      submenu.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: () => resolve() })
    })
  })
}

/**
 * Dil seçimini kaydeder ve yeniden başlatmayı önerir. Arayüzün tüm metinleri açılışta bir kez
 * üretildiği için yeni dil ancak yeniden başlatınca uygulanır. Sorular seçilen dilde sorulur.
 */
function selectLocale(locale: Locale): void {
  if (locale === getLocale()) return
  saveLocale(locale)
  const en = locale === 'en'
  const window = mainWindow ?? undefined
  const options = {
    type: 'question' as const,
    buttons: en ? ['Restart Now', 'Later'] : ['Şimdi Yeniden Başlat', 'Sonra'],
    defaultId: 0,
    cancelId: 1,
    title: 'Skript IDE',
    message: en ? 'The language will change after a restart.' : 'Dil, uygulama yeniden başlatılınca değişecek.',
    detail: en ? 'Restart Skript IDE now?' : "Skript IDE'yi şimdi yeniden başlatmak ister misin?"
  }
  if ((window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options)) !== 0) return

  if (hasUnsavedChanges && window) {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: en ? ['Restart Without Saving', 'Cancel'] : ['Kaydetmeden Yeniden Başlat', 'İptal'],
      defaultId: 1,
      cancelId: 1,
      title: 'Skript IDE',
      message: en ? 'There are unsaved changes.' : 'Kaydedilmemiş değişiklikler var.',
      detail: en ? 'If you restart now, these changes will be lost.' : 'Şimdi yeniden başlatırsan bu değişiklikler kaybolacak.'
    })
    if (choice !== 0) return
    // Pencere kapanırken aynı soru bir daha sorulmasın
    hasUnsavedChanges = false
  }
  app.relaunch()
  app.quit()
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildAppMenu(selectLocale))
  registerIpcHandlers()
  const server = setupValidator(() => mainWindow)
  setupAgent(() => mainWindow, server)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
