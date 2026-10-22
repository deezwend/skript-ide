import { api } from '../api'
import { languageForPath, lsp, monaco } from '../monaco'
import type { SemanticTokensLegend } from './theme'
import { pathForUri } from './workspace'

import { getLocale, l } from '@skript-ide/i18n'
type JsonRpcId = string | number

/** LSP istemcisinin kullandığı ham JSON-RPC zarfı. */
export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type ConnectionState =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error: Error | undefined }

interface ChangeEvent<T> {
  readonly value: T
  readonly onChange: (listener: (value: T) => void) => { dispose(): void }
}

/** Monaco'nun beklediği taşıma arayüzü; `lsp.MonacoLspClient` yapısal olarak bunu kullanır. */
export interface IMessageTransport {
  readonly state: ChangeEvent<ConnectionState>
  send(message: JsonRpcMessage): Promise<void>
  setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void
  toString(): string
}

class TransportState implements ChangeEvent<ConnectionState> {
  private current: ConnectionState = { state: 'open' }
  private readonly listeners = new Set<(value: ConnectionState) => void>()

  get value(): ConnectionState {
    return this.current
  }

  set(update: ConnectionState): void {
    this.current = update
    this.listeners.forEach((listener) => listener(update))
  }

  get onChange(): (listener: (value: ConnectionState) => void) => { dispose(): void } {
    return (listener) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
  }
}

export type LspConnectionStatus = 'starting' | 'ready' | 'restarting' | 'error'

export interface TransportOptions {
  createWorker: () => Worker
  onState: (state: LspConnectionStatus, detail?: string) => void
  onLegend: (legend: SemanticTokensLegend) => void
  /**
   * Yeniden adlandırma gibi çok dosyalı düzenlemelerin hedef dosyalarını sekmede açar; böylece
   * düzenleme görünür olur ve kaydedilebilir (arka plan modeline yazılan düzenleme kaybolurdu).
   */
  prepareEditTargets?: (paths: string[]) => Promise<void>
}

const MAX_RESTARTS = 5
/** Tanım hedefleri için ayakta tutulan model sayısı; en eskiler serbest bırakılır. */
const MAX_BACKGROUND_MODELS = 20
/** Zaman aşımına uğrayan isteklerin geç yanıtları bu süre boyunca yutulur. */
const EXPIRED_REQUEST_TTL = 60_000
const LOCATION_METHODS = new Set([
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references'
])

/** Yanıtı `WorkspaceEdit` (ya da düzenleme içeren kod eylemleri) olan istekler. */
const EDIT_METHODS = new Set(['textDocument/rename', 'textDocument/codeAction'])

function notification(method: string, params: unknown): JsonRpcMessage {
  return { jsonrpc: '2.0', method, params }
}

/**
 * Monaco istemcisi `didOpen`/`didChange` için URI'yi küçük harfe çeviriyor, isteklerde ise
 * model URI'sini olduğu gibi gönderiyor. Sunucu belgeleri küçük harfli anahtarla tuttuğu için
 * (bkz. sözleşme) giden tüm belge URI'lerini burada normalize et.
 */
function lowercaseDocumentUris(message: JsonRpcMessage): void {
  const params = message.params as
    | { textDocument?: { uri?: unknown }; uri?: unknown }
    | null
    | undefined
  if (!params || typeof params !== 'object') return
  const textDocument = params.textDocument
  if (textDocument && typeof textDocument === 'object' && typeof textDocument.uri === 'string') {
    textDocument.uri = textDocument.uri.toLowerCase()
  }
  if (typeof params.uri === 'string') params.uri = params.uri.toLowerCase()
}

/**
 * `lsp.createTransportToWorker` çıktısını saran taşıma katmanı.
 *
 * - İstemciden giden tanım/başvuru isteklerini izler; yanıt gelince hedef dosyaların modellerini
 *   oluşturur, böylece Monaco'nun `translateBack` çağrısı "No text model for uri" ile patlamaz.
 * - Anahat paneli ve özel bildirimler için kendi isteklerini benzersiz `skript-ide:*` kimlikleriyle
 *   gönderir ve yanıtlarını istemciye iletmeden yakalar.
 * - Özel bildirimleri ilk `initialize` yanıtına kadar kuyruklar.
 * - Worker çökerse aynı istemciyi koruyarak yeni worker'a initialize + açık modelleri yeniden oynatır.
 */
export class SkriptLspTransport implements IMessageTransport {
  readonly state = new TransportState()

  private inner: ReturnType<typeof lsp.createTransportToWorker> | null = null
  private worker: Worker | null = null
  private listener: ((message: JsonRpcMessage) => void) | undefined
  private disposed = false
  private ready = false
  private replaying = false
  private attempts = 0
  private restartTimer: number | undefined
  private startupTimer: number | undefined
  private sequence = 0

  private initializeMessage: JsonRpcMessage | null = null
  private initRequestId: string | null = null
  private readonly internalInitIds = new Set<string>()
  private readonly ownRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
  >()
  private readonly locationRequests = new Set<string>()
  private readonly editRequests = new Set<string>()
  private readonly expiredRequests = new Map<string, number>()
  private deferred: JsonRpcMessage[] = []
  /** Tanım/başvuru hedefleri için oluşturulan ve henüz bir sekmeye bağlanmamış modeller. */
  private readonly backgroundModels = new Set<monaco.editor.ITextModel>()

  private customQueue: { method: string; params: unknown }[] = []
  private lastConfiguration: unknown = null
  private lastWorkspaceFiles: unknown = null
  private readonly modelPromises = new Map<string, Promise<void>>()

  constructor(private readonly options: TransportOptions) {
    this.startWorker()
    this.armStartupWatchdog()
    this.options.onState('starting')
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(l('Dil sunucusu kapatıldı', 'Language server was shut down')))

    if (message.method === 'initialize' && message.id !== undefined) {
      // Sunucunun tanı ve hover metinleri arayüz dilinde üretilsin
      if (message.params && typeof message.params === 'object') (message.params as { locale?: string }).locale = getLocale()
      this.initializeMessage = message
      this.initRequestId = String(message.id)
    }
    if (message.method && message.id !== undefined && LOCATION_METHODS.has(message.method)) {
      this.locationRequests.add(String(message.id))
    }
    if (message.method && message.id !== undefined && EDIT_METHODS.has(message.method)) {
      this.editRequests.add(String(message.id))
    }

    if (this.replaying) {
      // Yeniden oynatma sırasında açık belgelerin güncel hâli zaten didOpen ile gönderilecek;
      // artımlı değişiklikleri tekrar uygulamamak için düşürülür.
      if (
        message.method === 'textDocument/didOpen' ||
        message.method === 'textDocument/didChange' ||
        message.method === 'textDocument/didClose' ||
        message.method === 'initialized'
      ) {
        return Promise.resolve()
      }
      this.deferred.push(message)
      return Promise.resolve()
    }

    if (!this.inner) return Promise.reject(new Error(l('Dil sunucusu yeniden başlatılıyor', 'Language server is restarting')))
    return this.sendRaw(message)
  }

  setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
    this.listener = listener
  }

  toString(): string {
    return `SkriptLspTransport(${this.worker ? 'worker' : 'closed'})`
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.restartTimer)
    window.clearTimeout(this.startupTimer)
    for (const pending of this.ownRequests.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(l('Dil sunucusu kapatıldı', 'Language server was shut down')))
    }
    this.ownRequests.clear()
    for (const timer of this.expiredRequests.values()) window.clearTimeout(timer)
    this.expiredRequests.clear()
    this.releaseBackgroundModels()
    this.deferred = []
    this.customQueue = []
    this.cleanupWorker()
    this.state.set({ state: 'closed', error: undefined })
  }

  /** Sekmede açılan bir modeli arka plan listesinden çıkarır; artık dispose edilmez. */
  adoptModel(model: monaco.editor.ITextModel): void {
    this.backgroundModels.delete(model)
  }

  /** Uygulamadan gelen özel bildirim. `initialize` yanıtından önce kuyruklanır. */
  notify(method: string, params: unknown): void {
    if (method === 'workspace/didChangeConfiguration') {
      this.lastConfiguration = params
    } else if (method === 'skript/workspaceFiles') {
      const snapshot = params as { files?: { uri: string; text: string }[]; complete?: boolean }
      this.lastWorkspaceFiles = {
        files: Array.isArray(snapshot.files) ? [...snapshot.files] : [],
        complete: snapshot.complete === true
      }
    } else if (method === 'skript/workspaceFileChanged') {
      this.updateWorkspaceSnapshot(params as { uri?: unknown; text?: unknown })
    }

    if (this.ready && !this.replaying && this.inner) {
      void this.sendRaw(notification(method, params))
      return
    }
    // Aynı türden eski kuyruk girdisini değiştir; dosya değişikliği bildirimleri birikebilir.
    if (method !== 'skript/workspaceFileChanged') {
      this.customQueue = this.customQueue.filter((item) => item.method !== method)
    }
    this.customQueue.push({ method, params })
    if (this.customQueue.length > 500) this.customQueue.splice(0, this.customQueue.length - 500)
  }

  /** Yeniden başlatmada eski içerik gönderilmesin diye kaydedilenler dosya anlık görüntüsüne işlenir. */
  private updateWorkspaceSnapshot(entry: { uri?: unknown; text?: unknown }): void {
    if (typeof entry.uri !== 'string') return
    const snapshot = this.lastWorkspaceFiles as { files: { uri: string; text: string }[]; complete: boolean } | null
    if (!snapshot) return
    const uri = entry.uri.toLowerCase()
    const index = snapshot.files.findIndex((file) => file.uri.toLowerCase() === uri)
    if (entry.text === null) {
      if (index >= 0) snapshot.files.splice(index, 1)
      return
    }
    if (typeof entry.text !== 'string') return
    if (index >= 0) snapshot.files[index] = { uri: entry.uri, text: entry.text }
    else snapshot.files.push({ uri: entry.uri, text: entry.text })
  }

  /** Kendi isteğimiz (ör. anahat için documentSymbol); yanıt istemciye iletilmez. */
  async request<T>(method: string, params: unknown, timeoutMs = 5000): Promise<T | null> {
    if (!(await this.waitUntilReady(timeoutMs))) return null
    if (!this.inner) return null

    const id = `skript-ide:request:${++this.sequence}`
    return new Promise<T | null>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.ownRequests.delete(id)
        this.expireRequest(id)
        resolve(null)
      }, timeoutMs)
      this.ownRequests.set(id, {
        timer,
        resolve: (value) => {
          window.clearTimeout(timer)
          resolve((value ?? null) as T | null)
        },
        reject: (error) => {
          window.clearTimeout(timer)
          reject(error)
        }
      })
      void this.sendRaw({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        if (!this.ownRequests.delete(id)) return
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Zaman aşımına uğrayan isteğin kimliği bir süre tutulur; geç yanıtı istemciye iletilmez. */
  private expireRequest(id: string): void {
    window.clearTimeout(this.expiredRequests.get(id))
    const timer = window.setTimeout(() => this.expiredRequests.delete(id), EXPIRED_REQUEST_TTL)
    this.expiredRequests.set(id, timer)
  }

  restart(): void {
    if (this.disposed) return
    window.clearTimeout(this.restartTimer)
    this.attempts = 0
    this.restartWorker()
  }

  private startWorker(): void {
    const worker = this.options.createWorker()
    this.worker = worker
    worker.addEventListener('error', (event) => {
      event.preventDefault()
      this.crash(new Error(event.message || l("Dil sunucusu worker'ı çöktü", 'Language server worker crashed')))
    })
    worker.addEventListener('messageerror', () => this.crash(new Error(l('Worker mesajı okunamadı', 'Could not read worker message'))))

    const inner = lsp.createTransportToWorker(worker)
    this.inner = inner
    inner.setListener((message) => void this.handleMessage(message as unknown as JsonRpcMessage))
  }

  /** Worker yüklenip initialize yanıtı gelmezse sonsuza kadar "yükleniyor" kalmasın. */
  private armStartupWatchdog(): void {
    window.clearTimeout(this.startupTimer)
    this.startupTimer = window.setTimeout(() => {
      if (!this.ready && !this.disposed) this.crash(new Error(l('Dil sunucusu zamanında yanıt vermedi', 'Language server did not respond in time')))
    }, 15000)
  }

  private cleanupWorker(): void {
    this.worker?.terminate()
    this.worker = null
    this.inner = null
  }

  private sendRaw(message: JsonRpcMessage): Promise<void> {
    const inner = this.inner
    if (!inner) return Promise.reject(new Error(l('Dil sunucusu bağlı değil', 'Language server is not connected')))
    lowercaseDocumentUris(message)
    const payload = message as unknown as Parameters<typeof inner.send>[0]
    return inner.send(payload).catch((error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error))
    })
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (this.disposed) return

    if (message.method) {
      if (message.method === 'client/registerCapability') {
        const legend = legendFromRegistrations(message.params)
        if (legend) this.options.onLegend(legend)
      }
      this.listener?.(message)
      return
    }

    if (message.id === undefined || message.id === null) return
    const key = String(message.id)

    if (this.initRequestId === key) {
      this.initRequestId = null
      const internal = this.internalInitIds.delete(key)
      if (message.error) {
        const error = new Error(message.error.message)
        if (internal) {
          this.replaying = false
          this.crash(error)
          return
        }
        this.options.onState('error', error.message)
      } else {
        this.markReady(message)
      }
      if (!internal) this.listener?.(message)
      return
    }

    const own = this.ownRequests.get(key)
    if (own) {
      this.ownRequests.delete(key)
      if (message.error) own.reject(new Error(message.error.message))
      else own.resolve(message.result ?? null)
      return
    }

    const expiredTimer = this.expiredRequests.get(key)
    if (expiredTimer !== undefined) {
      window.clearTimeout(expiredTimer)
      this.expiredRequests.delete(key)
      return
    }

    if (this.editRequests.has(key)) {
      this.editRequests.delete(key)
      try {
        message.result = await this.prepareEdits(message.result)
      } catch (error) {
        console.warn('Düzenleme hedefleri hazırlanamadı:', error)
      }
      this.listener?.(message)
      return
    }

    if (this.locationRequests.has(key)) {
      this.locationRequests.delete(key)
      try {
        message.result = await this.prepareLocations(message.result)
      } catch (error) {
        console.warn('Tanım hedefi dosyaları hazırlanamadı:', error)
      }
      this.listener?.(message)
      return
    }

    this.listener?.(message)
  }

  private markReady(message: JsonRpcMessage): void {
    const wasReplaying = this.replaying
    window.clearTimeout(this.startupTimer)
    this.ready = true
    this.replaying = false
    this.attempts = 0
    this.state.set({ state: 'open' })

    const legend = legendFromInitialize(message.result)
    if (legend) this.options.onLegend(legend)

    // Yeniden oynatmada initialize yanıtını bekleyip `initialized` ve açık belgeleri gönder (LSP sırası).
    if (wasReplaying) {
      void this.sendRaw(notification('initialized', {}))
      for (const model of monaco.editor.getModels()) {
        void this.sendRaw({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri: model.uri.toString(true).toLowerCase(),
              languageId: model.getLanguageId(),
              version: model.getVersionId(),
              text: model.getValue()
            }
          }
        })
      }
    }

    this.options.onState('ready')
    this.flushQueue()

    const deferred = this.deferred
    this.deferred = []
    for (const pending of deferred) void this.sendRaw(pending)
  }

  private flushQueue(): void {
    if (!this.inner) return
    const sent = new Set<string>()
    if (this.lastConfiguration) {
      void this.sendRaw(notification('workspace/didChangeConfiguration', this.lastConfiguration))
      sent.add('workspace/didChangeConfiguration')
    }
    if (this.lastWorkspaceFiles) {
      void this.sendRaw(notification('skript/workspaceFiles', this.lastWorkspaceFiles))
      sent.add('skript/workspaceFiles')
    }
    const queue = this.customQueue
    this.customQueue = []
    for (const item of queue) {
      if (sent.has(item.method)) continue
      void this.sendRaw(notification(item.method, item.params))
    }
  }

  private waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const started = Date.now()
      const check = (): void => {
        if (this.disposed) return resolve(false)
        if (this.ready) return resolve(true)
        if (Date.now() - started >= timeoutMs) return resolve(false)
        window.setTimeout(check, 100)
      }
      check()
    })
  }

  private restartWorker(): void {
    this.cleanupWorker()
    // Yeni worker initialize edilene kadar istekler kuyrukta bekler
    this.ready = false
    this.options.onState('restarting')
    this.replaying = true
    try {
      this.startWorker()
      this.armStartupWatchdog()
      this.replay()
    } catch (error) {
      this.replaying = false
      this.crash(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private replay(): void {
    const params = this.initializeMessage?.params ?? { processId: null, rootUri: null, capabilities: {} }
    const id = `skript-ide:init:${++this.sequence}`
    this.internalInitIds.add(id)
    this.initRequestId = id
    void this.sendRaw({ jsonrpc: '2.0', id, method: 'initialize', params })
  }

  private crash(error: Error): void {
    if (this.disposed) return
    window.clearTimeout(this.startupTimer)
    this.cleanupWorker()
    this.ready = false
    this.replaying = false
    this.state.set({ state: 'closed', error })
    for (const pending of this.ownRequests.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.ownRequests.clear()
    this.locationRequests.clear()
    this.deferred = []

    this.attempts++
    if (this.attempts > MAX_RESTARTS) {
      this.options.onState('error', l(`${error.message} (yeniden başlatma denemeleri tükendi)`, `${error.message} (out of restart attempts)`))
      return
    }
    this.options.onState('error', l(`${error.message} — yeniden başlatılıyor (${this.attempts}/${MAX_RESTARTS})`, `${error.message} — restarting (${this.attempts}/${MAX_RESTARTS})`))
    const delay = Math.min(400 * 2 ** (this.attempts - 1), 4000)
    window.clearTimeout(this.restartTimer)
    this.restartTimer = window.setTimeout(() => this.restartWorker(), delay)
  }

  /** Tanım/başvuru sonucundaki dosyaları okur; erişilemeyen konumları sonuçtan çıkarır. */
  private async prepareLocations(result: unknown): Promise<unknown> {
    if (result == null) return result
    const uris = collectLocationUris(result)
    if (uris.size === 0) return result

    // Yeni hedefler oluşturulmadan önce eski arka plan modelleri temizlenir
    this.pruneBackgroundModels()
    const available = new Set<string>()
    await Promise.all(
      [...uris].map(async (uri) => {
        if (await this.ensureModel(uri)) available.add(uri.toLowerCase())
      })
    )

    const keep = (value: unknown): boolean => {
      const uri = locationUri(value)
      return uri === null || available.has(uri.toLowerCase())
    }

    if (Array.isArray(result)) return result.filter(keep)
    if (typeof result === 'object') return keep(result) ? result : null
    return result
  }

  /**
   * `WorkspaceEdit` (ya da kod eylemi listesi) içindeki dosyaları sekmede açar ve anahtarları
   * modelin gerçek URI'sine çevirir: sunucu küçük harfli URI kullanır, Monaco ise modeli birebir
   * URI ile arar. Modeli bulunamayan dosyaların düzenlemeleri çıkarılır.
   */
  private async prepareEdits(result: unknown): Promise<unknown> {
    if (result == null) return result
    const edits: { changes?: Record<string, unknown> }[] = []
    if (Array.isArray(result)) {
      for (const action of result) {
        const edit = (action as { edit?: unknown } | null)?.edit
        if (edit && typeof edit === 'object') edits.push(edit as { changes?: Record<string, unknown> })
      }
    } else if (typeof result === 'object') {
      edits.push(result as { changes?: Record<string, unknown> })
    }
    const uris = new Set<string>()
    for (const edit of edits) for (const uri of Object.keys(edit.changes ?? {})) uris.add(uri)
    if (uris.size === 0) return result

    const missing = [...uris].filter((uri) => uri.toLowerCase().startsWith('file:') && !this.isOpenInTab(uri.toLowerCase()))
    if (missing.length > 0 && this.options.prepareEditTargets) {
      await this.options.prepareEditTargets(missing.map((uri) => pathForUri(uri)))
    }
    for (const edit of edits) {
      if (!edit.changes) continue
      const changes: Record<string, unknown> = {}
      for (const [uri, value] of Object.entries(edit.changes)) {
        const model = this.findModel(uri.toLowerCase())
        if (model) changes[model.uri.toString()] = value
      }
      edit.changes = changes
    }
    return result
  }

  private isOpenInTab(lowercaseUri: string): boolean {
    const model = this.findModel(lowercaseUri)
    return model !== null && !this.backgroundModels.has(model)
  }

  private async ensureModel(uri: string): Promise<boolean> {
    const key = uri.toLowerCase()
    if (this.findModel(key)) return true
    if (!key.startsWith('file:')) return false

    let pending = this.modelPromises.get(key)
    if (!pending) {
      pending = (async () => {
        let path: string
        try {
          path = pathForUri(uri)
        } catch {
          return
        }
        if (!path) return
        let text: string
        try {
          text = await api.readFile(path)
        } catch {
          return
        }
        if (text.length > 2 * 1024 * 1024) return
        // Okuma sırasında belge açılmış olabilir
        if (this.findModel(key)) return
        this.trackBackgroundModel(monaco.editor.createModel(text, languageForPath(path), monaco.Uri.file(path)))
      })()
      this.modelPromises.set(key, pending)
      void pending.finally(() => this.modelPromises.delete(key))
    }
    await pending
    return this.findModel(key) !== null
  }

  /** Tanım hedefi için oluşturulan model, bir sekme sahiplenene kadar LRU listesinde tutulur. */
  private trackBackgroundModel(model: monaco.editor.ITextModel): void {
    this.backgroundModels.add(model)
  }

  /** En eski modeller bırakılır; yanıtın kendi hedefleri bu temizlikten sonra oluşturulur. */
  private pruneBackgroundModels(): void {
    for (const tracked of [...this.backgroundModels]) {
      if (tracked.isDisposed()) this.backgroundModels.delete(tracked)
    }
    while (this.backgroundModels.size > MAX_BACKGROUND_MODELS) {
      const oldest = this.backgroundModels.values().next().value
      if (!oldest) break
      this.backgroundModels.delete(oldest)
      if (!this.isModelInUse(oldest)) oldest.dispose()
    }
  }

  private releaseBackgroundModels(): void {
    for (const model of this.backgroundModels) {
      if (!model.isDisposed()) model.dispose()
    }
    this.backgroundModels.clear()
  }

  private isModelInUse(model: monaco.editor.ITextModel): boolean {
    if (model.isDisposed()) return false
    return monaco.editor.getEditors().some((editor) => editor.getModel() === model)
  }

  private findModel(lowercaseUri: string): monaco.editor.ITextModel | null {
    const model =
      monaco.editor.getModels().find((candidate) => candidate.uri.toString(true).toLowerCase() === lowercaseUri) ??
      null
    if (model && this.backgroundModels.delete(model)) this.backgroundModels.add(model)
    return model
  }
}

function locationUri(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.uri === 'string') return record.uri
  if (typeof record.targetUri === 'string') return record.targetUri
  const location = record.location
  if (location && typeof location === 'object' && typeof (location as Record<string, unknown>).uri === 'string') {
    return (location as Record<string, unknown>).uri as string
  }
  return null
}

function collectLocationUris(result: unknown): Set<string> {
  const uris = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const uri = locationUri(value)
    if (uri) uris.add(uri)
  }
  visit(result)
  return uris
}

function legendFromInitialize(result: unknown): SemanticTokensLegend | null {
  const capabilities = (result as { capabilities?: { semanticTokensProvider?: { legend?: unknown } } } | null)
    ?.capabilities
  return legendFromValue(capabilities?.semanticTokensProvider?.legend)
}

function legendFromRegistrations(params: unknown): SemanticTokensLegend | null {
  const registrations = (params as { registrations?: unknown[] } | null)?.registrations
  if (!Array.isArray(registrations)) return null
  for (const registration of registrations) {
    if (!registration || typeof registration !== 'object') continue
    const record = registration as { method?: unknown; registerOptions?: { legend?: unknown } }
    if (record.method !== 'textDocument/semanticTokens/full') continue
    const legend = legendFromValue(record.registerOptions?.legend)
    if (legend) return legend
  }
  return null
}

function legendFromValue(value: unknown): SemanticTokensLegend | null {
  if (!value || typeof value !== 'object') return null
  const legend = value as { tokenTypes?: unknown; tokenModifiers?: unknown }
  if (!Array.isArray(legend.tokenTypes) || !Array.isArray(legend.tokenModifiers)) return null
  return {
    tokenTypes: legend.tokenTypes.filter((type): type is string => typeof type === 'string'),
    tokenModifiers: legend.tokenModifiers.filter((modifier): modifier is string => typeof modifier === 'string')
  }
}
