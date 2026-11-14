import { ipcMain, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { ToolError, type BrowserController } from '@skript-ide/agent'
import { IpcChannel, type BrowserBounds, type BrowserState } from '../shared/ipc'

/** Kalıcı oturum: çerezler uygulama kapansa da saklanır, kullanıcı hesaplarına bir kez giriş yapar. */
const PARTITION = 'persist:agent-browser'
const START_PAGE = 'https://www.google.com/'
const LOAD_TIMEOUT_MS = 20_000
/** Panelin açılıp konumunu bildirmesi için bekleme sınırı. */
const REVEAL_TIMEOUT_MS = 3000
/** Sayfa metni ve öğe listesi modele gitmeden önce kısaltılır. */
const MAX_TEXT = 6000
const MAX_ELEMENTS = 80

/** Sayfada çalışan betik: görünür etkileşimli öğeleri numaralar ve sayfa özetini döndürür. */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch], [role=option], [contenteditable=""], [contenteditable=true], [onclick]'
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
  }
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim()
  const refs = []
  const items = []
  for (const el of document.querySelectorAll(selector)) {
    const isFile = el.tagName === 'INPUT' && el.type === 'file'
    if (el.disabled || (!isFile && !visible(el))) continue
    const r = el.getBoundingClientRect()
    if (!isFile && (r.bottom < 0 || r.top > innerHeight * 3)) continue
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? (el.type || 'text') : ''
    const label = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || '').slice(0, 80)
    const extra = []
    if (tag === 'a') extra.push(new URL(el.href, location.href).href.slice(0, 120))
    if (type === 'password') extra.push('password field')
    else if (tag === 'input' || tag === 'textarea') { if (el.value) extra.push('value=' + JSON.stringify(el.value.slice(0, 60))) }
    if (el.checked) extra.push('checked')
    if (tag === 'select') extra.push('options: ' + [...el.options].slice(0, 8).map((o) => clean(o.text)).join(' | '))
    refs.push(el)
    items.push({ n: refs.length, role: type ? tag + '[' + type + ']' : (el.getAttribute('role') || tag), label, extra: extra.join(', ') })
    if (refs.length >= ${MAX_ELEMENTS}) break
  }
  window.__agentRefs = refs
  const text = clean(document.body ? document.body.innerText : '')
  return { url: location.href, title: document.title, text: text.slice(0, ${MAX_TEXT}), truncated: text.length > ${MAX_TEXT}, items, scrollY: Math.round(scrollY), scrollMax: Math.round(Math.max(0, document.documentElement.scrollHeight - innerHeight)) }
})()`

interface Snapshot {
  url: string
  title: string
  text: string
  truncated: boolean
  items: { n: number; role: string; label: string; extra: string }[]
  scrollY: number
  scrollMax: number
}

interface ElementInfo {
  x: number
  y: number
  role: string
  label: string
  editable: boolean
}

interface Tab {
  id: number
  view: WebContentsView
}

const KEYS: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowdown: 'Down',
  arrowup: 'Up',
  arrowleft: 'Left',
  arrowright: 'Right',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  home: 'Home',
  end: 'End',
  space: 'Space'
}

/** Kullanıcının yazdığı metni adrese çevirir; adres gibi görünmüyorsa web'de arar. */
export function addressFromInput(raw: string): string {
  const text = raw.trim()
  if (!text) return START_PAGE
  if (/^https?:\/\//i.test(text)) return text
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^localhost:\d/i.test(text) && !/^\d+\.\d+\.\d+\.\d+:\d/.test(text)) {
    throw new ToolError('Only http and https addresses can be opened.')
  }
  const looksLikeHost = !/\s/.test(text) && (/^localhost(:\d+)?(\/|$)/i.test(text) || /^[^\s/]+\.[^\s/.]{2,}(:\d+)?(\/|$|\?)/.test(text))
  return looksLikeHost ? `https://${text}` : `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

/**
 * Ana pencerenin içindeki sekmeli tarayıcı. Her sekme kalıcı oturumlu, uygulama arayüzünden yalıtılmış
 * (preload ve node erişimi yok) bir `WebContentsView`'dir; yalnızca etkin sekme, arayüzün bildirdiği
 * dikdörtgende gösterilir. İndirmeler ve izin istekleri (kamera, bildirim...) reddedilir.
 * Agent etkin sekmeyi sürer ve işlem yaparken paneli açtırır.
 */
export class AgentBrowser implements BrowserController {
  private tabs: Tab[] = []
  private activeId: number | null = null
  private nextId = 1
  /** `null`: panel kapalı, görünüm gizli. */
  private bounds: BrowserBounds | null = null
  private attached: WebContentsView | null = null
  private configured = false
  private emitTimer: NodeJS.Timeout | null = null
  private revealWaiters: (() => void)[] = []

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  // --- Pencere ve arayüz ---

  private configure(): void {
    if (this.configured) return
    this.configured = true
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.on('will-download', (event) => event.preventDefault())
  }

  private emitSoon(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const win = this.getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.browserState, this.state())
    }, 40)
  }

  state(): BrowserState {
    const active = this.activeTab()
    const history = active?.view.webContents.navigationHistory
    return {
      tabs: this.tabs.map(({ id, view }) => ({
        id,
        title: view.webContents.getTitle() || view.webContents.getURL() || 'New tab',
        url: view.webContents.getURL(),
        loading: view.webContents.isLoading()
      })),
      activeId: this.activeId,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false
    }
  }

  /** Etkin sekmeyi, panel açıksa konumuna yerleştirir; değilse gizler. */
  private layout(): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const target = this.bounds ? (this.activeTab()?.view ?? null) : null
    if (this.attached && this.attached !== target) {
      win.contentView.removeChildView(this.attached)
      this.attached = null
    }
    if (!target || !this.bounds) return
    if (this.attached !== target) {
      win.contentView.addChildView(target)
      this.attached = target
    }
    target.setBounds({
      x: Math.round(this.bounds.x),
      y: Math.round(this.bounds.y),
      width: Math.max(0, Math.round(this.bounds.width)),
      height: Math.max(0, Math.round(this.bounds.height))
    })
  }

  setBounds(bounds: BrowserBounds | null): void {
    this.bounds = bounds
    this.layout()
    if (bounds) {
      const waiters = this.revealWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  /** Arayüze paneli açtırır ve konumunu bildirmesini bekler (görünmeyen sayfa girdi almaz). */
  private async reveal(): Promise<void> {
    if (this.bounds) return
    const win = this.getWindow()
    if (!win || win.isDestroyed()) throw new ToolError('The app window is not available.')
    win.webContents.send(IpcChannel.browserReveal)
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      this.revealWaiters.push(done)
      setTimeout(done, REVEAL_TIMEOUT_MS)
    })
  }

  show(): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
    if (!this.bounds) win.webContents.send(IpcChannel.browserReveal)
  }

  // --- Sekmeler ---

  private activeTab(): Tab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId)
  }

  createTab(input?: string): Tab {
    this.configure()
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.setBackgroundColor('#ffffff')
    const tab: Tab = { id: this.nextId++, view }
    const contents = view.webContents
    // target=_blank ve window.open yeni sekmede açılır
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.createTab(url)
      return { action: 'deny' }
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(event as 'did-navigate', () => this.emitSoon())
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.layout()
    this.emitSoon()
    void contents.loadURL(addressFromInput(input ?? START_PAGE)).catch(() => {})
    return tab
  }

  selectTabById(id: number): void {
    if (!this.tabs.some((tab) => tab.id === id)) throw new ToolError(`There is no tab ${id}.`)
    this.activeId = id
    this.layout()
    this.emitSoon()
  }

  closeTabById(id: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) throw new ToolError(`There is no tab ${id}.`)
    const [tab] = this.tabs.splice(index, 1)
    if (this.activeId === id) this.activeId = (this.tabs[index] ?? this.tabs[index - 1])?.id ?? null
    this.layout()
    if (this.attached === tab.view) this.attached = null
    this.getWindow()?.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.emitSoon()
  }

  /** Etkin sekmenin içeriği; hiç sekme yoksa bir tane açar. */
  private contents(): WebContents {
    return (this.activeTab() ?? this.createTab()).view.webContents
  }

  // --- Kullanıcı eylemleri (arayüzden) ---

  navigateActive(input: string): void {
    const url = addressFromInput(input)
    const contents = this.contents()
    void contents.loadURL(url).catch(() => {})
  }

  goBack(): void {
    this.activeTab()?.view.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.activeTab()?.view.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.activeTab()?.view.webContents.reload()
  }

  // --- Agent (BrowserController) ---

  currentUrl(): string | null {
    const url = this.activeTab()?.view.webContents.getURL()
    return url && url !== 'about:blank' ? url : null
  }

  listTabs(): string {
    if (this.tabs.length === 0) return 'No tabs are open.'
    return this.tabs
      .map(({ id, view }) => `${id === this.activeId ? '*' : ' '} [${id}] ${view.webContents.getTitle() || '(untitled)'} — ${view.webContents.getURL() || 'about:blank'}`)
      .join('\n')
  }

  /** Sayfa yüklenmesini bekler; zaman aşımında olduğu haliyle devam eder. */
  private settle(contents: WebContents, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout
      const finish = () => {
        clearTimeout(timer)
        contents.off('did-stop-loading', onStop)
        signal.removeEventListener('abort', finish)
        // Tek sayfalık uygulamalar yükleme bittikten sonra da çizim yapar
        setTimeout(resolve, 600)
      }
      const onStop = () => finish()
      timer = setTimeout(finish, LOAD_TIMEOUT_MS)
      signal.addEventListener('abort', finish, { once: true })
      // Tıklamanın başlattığı gezinme biraz sonra başlar: kısa bir süre sonra hâlâ yüklenmiyorsa bitmiştir
      setTimeout(() => {
        if (!contents.isLoading()) return finish()
        contents.on('did-stop-loading', onStop)
      }, 250)
    })
  }

  private async load(contents: WebContents, url: string, signal: AbortSignal): Promise<void> {
    try {
      await contents.loadURL(url)
    } catch (error) {
      // Yönlendirme ya da iptal hataları sayfa yine de yüklenmiş olabilir; ağ hatasında bildir
      const message = (error as Error).message
      if (!/ERR_ABORTED/.test(message)) throw new ToolError(`Could not load ${url}: ${message}`)
    }
    await this.settle(contents, signal)
  }

  async navigate(raw: string, signal: AbortSignal): Promise<string> {
    const url = this.agentUrl(raw)
    await this.reveal()
    await this.load(this.contents(), url, signal)
    return this.snapshot()
  }

  /** Agent yalnızca http(s) adresi açar; arama metni açmaz. */
  private agentUrl(raw: string): string {
    let url: URL
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    } catch {
      throw new ToolError(`"${raw}" is not a valid address.`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('Only http and https addresses can be opened.')
    return url.href
  }

  async newTab(raw: string | undefined, signal: AbortSignal): Promise<string> {
    const url = raw ? this.agentUrl(raw) : undefined
    await this.reveal()
    const tab = this.createTab(url ?? 'about:blank')
    if (url) await this.settle(tab.view.webContents, signal)
    return this.currentUrl() ? this.snapshot() : `Opened tab ${tab.id} (blank). Use browser_open to load a page in it.`
  }

  async selectTab(id: number): Promise<string> {
    this.selectTabById(id)
    await this.reveal()
    return this.currentUrl() ? this.snapshot() : `Switched to tab ${id} (blank).`
  }

  async closeTab(id: number): Promise<string> {
    this.closeTabById(id)
    return `Closed tab ${id}.\n${this.listTabs()}`
  }

  async snapshot(): Promise<string> {
    if (!this.currentUrl()) throw new ToolError('No page is open yet. Call browser_open first.')
    await this.reveal()
    const contents = this.contents()
    const page = (await contents.executeJavaScript(SNAPSHOT_SCRIPT)) as Snapshot
    const lines = [`Tab: ${this.activeId} of ${this.tabs.length}`, `URL: ${page.url}`, `Title: ${page.title}`]
    const more = page.scrollMax - page.scrollY
    lines.push(`Scroll: ${page.scrollY}px${more > 20 ? `, about ${more}px more below` : ' (bottom)'}`)
    lines.push('', 'Page text:', page.text || '(empty)')
    if (page.truncated) lines.push('(text truncated; scroll or use elements below)')
    lines.push('', 'Interactive elements:')
    if (page.items.length === 0) lines.push('(none)')
    for (const item of page.items) {
      lines.push(`[${item.n}] ${item.role}${item.label ? ` "${item.label}"` : ''}${item.extra ? ` (${item.extra})` : ''}`)
    }
    return lines.join('\n')
  }

  /** Öğeyi görünür alana kaydırır ve merkezini/rolünü döndürür; numara eskidiyse hata verir. */
  private async locate(ref: number): Promise<ElementInfo> {
    await this.reveal()
    const info = (await this.contents().executeJavaScript(`(() => {
      const el = (window.__agentRefs || [])[${ref - 1}]
      if (!el || !el.isConnected) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      const tag = el.tagName.toLowerCase()
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
      const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), role: el.getAttribute('role') || tag, label, editable }
    })()`)) as ElementInfo | null
    if (!info) throw new ToolError(`Element ${ref} is no longer on the page. Call browser_snapshot and use the new numbers.`)
    return info
  }

  async describe(ref: number): Promise<string> {
    const info = await this.locate(ref)
    return `${info.role}${info.label ? ` "${info.label}"` : ''} [${ref}]`
  }

  async click(ref: number, signal: AbortSignal): Promise<string> {
    const contents = this.contents()
    const info = await this.locate(ref)
    const base = { x: info.x, y: info.y, button: 'left' as const, clickCount: 1 }
    contents.sendInputEvent({ type: 'mouseMove', x: info.x, y: info.y })
    contents.sendInputEvent({ type: 'mouseDown', ...base })
    contents.sendInputEvent({ type: 'mouseUp', ...base })
    await this.settle(contents, signal)
    return this.snapshot()
  }

  async type(ref: number, text: string, options: { clear: boolean; submit: boolean }, signal: AbortSignal): Promise<string> {
    const contents = this.contents()
    const info = await this.locate(ref)
    if (!info.editable) throw new ToolError(`Element ${ref} (${info.role}) cannot take text. Pick an input, textarea or editable element.`)
    const type = (await contents.executeJavaScript(`(window.__agentRefs[${ref - 1}].type || '')`)) as string
    if (type === 'password') {
      throw new ToolError('This is a password field. Do not type passwords: call browser_show and ask the user to enter it themselves.')
    }
    await contents.executeJavaScript(`(() => { const el = window.__agentRefs[${ref - 1}]; el.focus(); ${options.clear ? 'if (el.select) el.select(); else document.execCommand("selectAll")' : ''} })()`)
    if (options.clear && text === '') contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    if (text) await contents.insertText(text)
    if (options.submit) this.key(contents, 'Enter')
    await this.settle(contents, signal)
    return this.snapshot()
  }

  private key(contents: WebContents, keyCode: string): void {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
  }

  async upload(ref: number, files: readonly string[], signal: AbortSignal): Promise<string> {
    await this.reveal()
    const contents = this.contents()
    const isFile = (await contents.executeJavaScript(
      `(() => { const el = (window.__agentRefs || [])[${ref - 1}]; return !!el && el.isConnected && el.tagName === 'INPUT' && el.type === 'file' })()`
    )) as boolean
    if (!isFile) throw new ToolError(`Element ${ref} is not a file input (input[file]). Call browser_snapshot and pick an input[file] element.`)
    // Yerel dosya seçme penceresi sürülemez: dosyalar DevTools protokolüyle doğrudan öğeye verilir
    const debuggerApi = contents.debugger
    const attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    try {
      const { result } = (await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: `window.__agentRefs[${ref - 1}]`
      })) as { result: { objectId?: string } }
      if (!result.objectId) throw new ToolError(`Element ${ref} is no longer on the page. Call browser_snapshot and use the new numbers.`)
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [...files], objectId: result.objectId })
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
    await this.settle(contents, signal)
    return this.snapshot()
  }

  async press(key: string, signal: AbortSignal): Promise<string> {
    const keyCode = KEYS[key.toLowerCase()]
    if (!keyCode) throw new ToolError(`Unsupported key "${key}". Use one of: ${[...new Set(Object.values(KEYS))].join(', ')}.`)
    await this.reveal()
    const contents = this.contents()
    this.key(contents, keyCode)
    await this.settle(contents, signal)
    return this.snapshot()
  }

  async scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<string> {
    await this.reveal()
    const contents = this.contents()
    await contents.executeJavaScript(`window.scrollBy({ top: ${direction === 'up' ? '-' : ''}Math.round(innerHeight * 0.85), behavior: 'instant' })`)
    await this.settle(contents, signal)
    return this.snapshot()
  }

  async back(signal: AbortSignal): Promise<string> {
    const contents = this.contents()
    if (!contents.navigationHistory.canGoBack()) throw new ToolError('There is no earlier page in the history.')
    contents.navigationHistory.goBack()
    await this.settle(contents, signal)
    return this.snapshot()
  }

  /** Uygulama kapanırken sekmeleri kapatır. */
  dispose(): void {
    for (const tab of this.tabs) {
      try {
        tab.view.webContents.close()
      } catch {
        // Pencere zaten kapanmış olabilir
      }
    }
    this.tabs = []
    this.attached = null
  }
}

/** Arayüzün tarayıcı panelini yöneten IPC kanalları. */
export function setupBrowserIpc(browser: AgentBrowser): void {
  ipcMain.handle(IpcChannel.browserGetState, () => browser.state())
  ipcMain.handle(IpcChannel.browserNewTab, (_event, input: unknown) => {
    browser.createTab(typeof input === 'string' && input.trim() ? input : undefined)
  })
  ipcMain.handle(IpcChannel.browserCloseTab, (_event, id: unknown) => {
    if (typeof id === 'number') browser.closeTabById(id)
  })
  ipcMain.handle(IpcChannel.browserSelectTab, (_event, id: unknown) => {
    if (typeof id === 'number') browser.selectTabById(id)
  })
  ipcMain.handle(IpcChannel.browserNavigate, (_event, input: unknown) => {
    if (typeof input === 'string') browser.navigateActive(input)
  })
  ipcMain.handle(IpcChannel.browserBack, () => browser.goBack())
  ipcMain.handle(IpcChannel.browserForward, () => browser.goForward())
  ipcMain.handle(IpcChannel.browserReload, () => browser.reload())
  ipcMain.on(IpcChannel.browserSetBounds, (_event, bounds: unknown) => {
    const b = bounds as Partial<BrowserBounds> | null
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    browser.setBounds(ok ? (b as BrowserBounds) : null)
  })
}
