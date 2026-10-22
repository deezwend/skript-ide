import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { SkriptServer } from '@skript-ide/runtime-validator'
import { IpcChannel, type ValidateRequest } from '../shared/ipc'
import { setupProject } from './project'

const LOG_FLUSH_MS = 50

/**
 * Doğrulama sunucusunu ana süreçte yönetir. Arayüz yalnızca içerik gönderir;
 * sunucu yalnızca kendi `userData/runtime` klasörüne yazar, kullanıcının dosyalarına dokunmaz.
 */
export function setupValidator(getWindow: () => BrowserWindow | null): SkriptServer {
  let pendingLog = ''
  let flushTimer: NodeJS.Timeout | null = null

  const send = (channel: string, value: unknown) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, value)
  }

  const server = new SkriptServer({
    rootDir: join(app.getPath('userData'), 'runtime'),
    onStatus: (status) => send(IpcChannel.serverStatusChanged, status),
    // Sunucu açılırken saniyede yüzlerce satır basabiliyor; IPC'yi boğmamak için topla
    onLog: (text) => {
      pendingLog += text
      flushTimer ??= setTimeout(() => {
        send(IpcChannel.serverLogOutput, pendingLog)
        pendingLog = ''
        flushTimer = null
      }, LOG_FLUSH_MS)
    }
  })

  /** Hata arayüze `start()` yerine durum olarak yansır; burada yutulabilir. */
  const startInBackground = () => void server.start().catch(() => {})

  ipcMain.handle(IpcChannel.serverStatus, () => server.currentStatus)
  ipcMain.handle(IpcChannel.serverLog, () => server.recentLog)
  ipcMain.handle(IpcChannel.serverStart, () => server.start())
  ipcMain.handle(IpcChannel.serverAcceptEula, async () => {
    await server.acceptEula()
    startInBackground()
  })
  ipcMain.handle(IpcChannel.serverCommand, (_event, command: string) => server.sendCommand(String(command)))
  ipcMain.handle(IpcChannel.serverValidate, (_event, request: ValidateRequest) =>
    server.validate(String(request.source), String(request.fileName), String(request.content))
  )

  // Sıcak tutmak için hemen başlat; EULA kabul edilmemişse durum "eula-required" olur.
  // Proje farklı bir Skript sürümü isterse `project.ts` sunucuyu o sürüme geçirir.
  startInBackground()
  setupProject(server, startInBackground)

  // Pencereler kapandıktan sonra sunucuyu `stop` ile kapat, sonra çık
  let stopped = false
  app.on('will-quit', (event) => {
    if (stopped || !server.isRunning) return
    event.preventDefault()
    void server.stop().finally(() => {
      stopped = true
      app.quit()
    })
  })

  return server
}
