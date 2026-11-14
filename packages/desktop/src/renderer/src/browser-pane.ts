import { l } from '@skript-ide/i18n'
import type { BrowserState } from '../../shared/ipc'
import { api } from './api'

export interface BrowserPaneElements {
  pane: HTMLElement
  tabs: HTMLElement
  form: HTMLFormElement
  address: HTMLInputElement
  back: HTMLButtonElement
  forward: HTMLButtonElement
  reload: HTMLButtonElement
  close: HTMLButtonElement
  content: HTMLElement
}

/**
 * Editör alanının üstünde açılan tarayıcı paneli: sekme şeridi ve adres çubuğu burada, sayfanın kendisi
 * ana süreçteki `WebContentsView`'de çizilir. Panel yalnızca içerik alanının konumunu ana sürece bildirir.
 */
export class BrowserPane {
  private state: BrowserState = { tabs: [], activeId: null, canGoBack: false, canGoForward: false }
  private observer: ResizeObserver

  constructor(private readonly ui: BrowserPaneElements, private readonly onVisibilityChange: (visible: boolean) => void = () => {}) {
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = ui.address.value.trim()
      if (text) void api.browserNavigate(text).catch(() => {})
      ui.address.blur()
    })
    ui.address.addEventListener('focus', () => ui.address.select())
    ui.back.addEventListener('click', () => void api.browserBack())
    ui.forward.addEventListener('click', () => void api.browserForward())
    ui.reload.addEventListener('click', () => void api.browserReload())
    ui.close.addEventListener('click', () => this.setVisible(false))
    this.observer = new ResizeObserver(() => this.sendBounds())
    this.observer.observe(ui.content)
    window.addEventListener('resize', () => this.sendBounds())
    api.onBrowserState((state) => this.render(state))
    api.onBrowserReveal(() => this.setVisible(true))
    void api.browserGetState().then((state) => this.render(state))
  }

  get visible(): boolean {
    return !this.ui.pane.hidden
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.ui.pane.hidden = !visible
    this.onVisibilityChange(visible)
    if (!visible) return api.browserSetBounds(null)
    // İlk açılışta hiç sekme yoksa bir tane aç; sayfa görünümü yerleştikten sonra konumunu bildir
    if (this.state.tabs.length === 0) void api.browserNewTab()
    requestAnimationFrame(() => this.sendBounds())
  }

  private sendBounds(): void {
    if (!this.visible) return
    const rect = this.ui.content.getBoundingClientRect()
    api.browserSetBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  }

  private render(state: BrowserState): void {
    this.state = state
    const { tabs, address, back, forward } = this.ui
    tabs.replaceChildren()
    for (const info of state.tabs) {
      const tab = document.createElement('div')
      tab.className = 'browser-tab' + (info.id === state.activeId ? ' active' : '')
      tab.setAttribute('role', 'tab')
      tab.title = info.url
      const title = document.createElement('span')
      title.className = 'browser-tab-title'
      title.textContent = (info.loading ? '⏳ ' : '') + info.title
      const close = document.createElement('button')
      close.textContent = '✕'
      close.title = l('Sekmeyi kapat', 'Close tab')
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        void api.browserCloseTab(info.id)
      })
      tab.addEventListener('click', () => void api.browserSelectTab(info.id))
      // Orta tık sekmeyi kapatır
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) void api.browserCloseTab(info.id)
      })
      tab.append(title, close)
      tabs.append(tab)
    }
    const add = document.createElement('button')
    add.className = 'browser-new-tab'
    add.textContent = '+'
    add.title = l('Yeni sekme', 'New tab')
    add.addEventListener('click', () => void api.browserNewTab())
    tabs.append(add)
    back.disabled = !state.canGoBack
    forward.disabled = !state.canGoForward
    if (document.activeElement !== address) address.value = state.tabs.find((tab) => tab.id === state.activeId)?.url ?? ''
  }
}
