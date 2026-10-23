import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { IpcChannel, type ReleaseNotes, type UpdateStatus } from '../shared/ipc'
import { readAppSettings, updateAppSettings } from './app-settings'

/** Sürümler bu depodan yayımlanır; `package.json` → `build.publish` ile aynı olmalı. */
const REPO = 'deezwend/skript-ide'

/** Açılıştan sonra ilk denetime kadar beklenen süre; açılışı yavaşlatmasın diye. */
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface UpdaterHost {
  window: () => BrowserWindow | null
  /** Kaydedilmemiş değişiklik varsa kullanıcıya sorar; çıkılabilirse `true`. */
  confirmQuit: () => boolean
}

export interface Updater {
  check(manual: boolean): void
  readonly autoUpdate: boolean
  setAutoUpdate(enabled: boolean): void
}

/** Otomatik indirme ve periyodik denetim; varsayılan açık. */
function readAutoUpdate(): boolean {
  return readAppSettings()['autoUpdate'] !== false
}

/** electron-updater notları tek metin ya da (farklı sürümlerin birikmiş) liste olarak verebilir. */
function notesHtml(info: UpdateInfo): string | null {
  const notes = info.releaseNotes
  if (!notes) return null
  if (typeof notes === 'string') return notes
  return notes.map((note) => `<h2>${note.version}</h2>${note.note ?? ''}`).join('') || null
}

function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`
}

/**
 * Yayın notları: önce GitHub'dan (HTML olarak işlenmiş gövde), çevrimdışıysa güncelleme indirilirken
 * saklanan notlardan.
 */
async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const url = releaseUrl(version)
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { Accept: 'application/vnd.github.html+json', 'User-Agent': 'Skript-IDE' },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) {
      const release = (await response.json()) as { body_html?: string | null }
      return { version, html: release.body_html?.trim() || null, url }
    }
  } catch {
    // Saklanan notlara düş
  }
  const stored = readAppSettings()['pendingNotes'] as { version?: unknown; html?: unknown } | undefined
  const html = stored?.version === version && typeof stored.html === 'string' ? stored.html : null
  return { version, html, url }
}

export function setupUpdater(host: UpdaterHost): Updater {
  const supported = app.isPackaged
  let status: UpdateStatus = { state: supported ? 'idle' : 'unsupported' }
  let manual = false
  let autoUpdate = readAutoUpdate()
  let timer: NodeJS.Timeout | null = null

  // Güncellendikten sonraki ilk açılış: "Yenilikler" penceresi bir kez gösterilir
  const settings = readAppSettings()
  const previous = typeof settings['lastVersion'] === 'string' ? settings['lastVersion'] : null
  let whatsNew: string | null = null
  if (previous !== app.getVersion()) {
    whatsNew = previous ? app.getVersion() : null
    updateAppSettings({ lastVersion: app.getVersion() })
  }

  const publish = (next: UpdateStatus) => {
    status = manual ? { ...next, manual: true } : next
    // Denetimin sonucu belli olunca sonraki durumlar artık elle başlatılmış sayılmaz
    if (next.state !== 'checking') manual = false
    host.window()?.webContents.send(IpcChannel.updateStatusChanged, status)
  }

  autoUpdater.autoDownload = autoUpdate
  autoUpdater.autoInstallOnAppQuit = true
  // GitHub yayınının gövdesi `releaseNotes` olarak gelsin
  autoUpdater.fullChangelog = false

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => publish({ state: 'not-available' }))
  autoUpdater.on('update-available', (info) => publish({ state: 'available', version: info.version, notes: notesHtml(info) }))
  autoUpdater.on('download-progress', (progress) => {
    const version = 'version' in status ? status.version : ''
    publish({ state: 'downloading', version, percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    const notes = notesHtml(info)
    updateAppSettings({ pendingNotes: { version: info.version, html: notes } })
    publish({ state: 'downloaded', version: info.version, notes })
  })
  autoUpdater.on('error', (error) => {
    // Arka plandaki denetimin ağ hatası kullanıcıyı rahatsız etmesin; yalnızca elle denetimde gösterilir
    if (!manual && status.state === 'checking') {
      status = { state: 'idle' }
      host.window()?.webContents.send(IpcChannel.updateStatusChanged, status)
      return
    }
    publish({ state: 'error', error: error.message })
  })

  const check = (isManual: boolean) => {
    if (!supported) {
      if (isManual) {
        manual = true
        publish({ state: 'unsupported' })
      }
      return
    }
    // İndirilmiş ya da inen güncelleme varken yeniden denetlemek durumu sıfırlar
    if (status.state === 'downloading' || status.state === 'downloaded') {
      if (isManual) {
        manual = true
        publish(status)
      }
      return
    }
    manual = isManual
    autoUpdater.checkForUpdates().catch(() => {
      // Hata 'error' olayıyla bildirilir
    })
  }

  const schedule = () => {
    if (timer) clearInterval(timer)
    timer = null
    if (!supported || !autoUpdate) return
    timer = setInterval(() => check(false), CHECK_INTERVAL_MS)
  }

  if (supported && autoUpdate) setTimeout(() => check(false), FIRST_CHECK_DELAY_MS)
  schedule()

  ipcMain.handle(IpcChannel.updateStatus, () => status)
  ipcMain.handle(IpcChannel.updateCheck, () => check(true))
  ipcMain.handle(IpcChannel.updateDownload, async () => {
    if (status.state !== 'available') return
    const version = status.version
    publish({ state: 'downloading', version, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      publish({ state: 'error', error: (error as Error).message })
    }
  })
  ipcMain.handle(IpcChannel.updateInstall, () => {
    if (status.state !== 'downloaded' || !host.confirmQuit()) return
    // Sessiz kurulum önceki kurulum klasörünü kullanır; bitince uygulama yeniden açılır
    autoUpdater.quitAndInstall(true, true)
  })
  ipcMain.handle(IpcChannel.releaseNotes, (_event, version?: string) =>
    fetchReleaseNotes(typeof version === 'string' && version ? version : app.getVersion())
  )
  ipcMain.handle(IpcChannel.whatsNew, () => {
    const version = whatsNew
    whatsNew = null
    return version
  })
  ipcMain.on(IpcChannel.appVersion, (event) => {
    event.returnValue = app.getVersion()
  })

  return {
    check,
    get autoUpdate() {
      return autoUpdate
    },
    setAutoUpdate(enabled) {
      autoUpdate = enabled
      autoUpdater.autoDownload = enabled
      updateAppSettings({ autoUpdate: enabled })
      schedule()
      if (enabled) check(false)
    }
  }
}
