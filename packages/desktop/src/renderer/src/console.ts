import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { api } from './api'

const HISTORY_LIMIT = 100

/**
 * SUNUCU KONSOLU sekmesi. Çıktı xterm.js'e yazılır; komutlar ayrı bir giriş
 * kutusundan gönderilir, böylece terminalde satır düzenleme yazmak gerekmez.
 */
export class ServerConsole {
  private readonly terminal = new Terminal({
    convertEol: true,
    disableStdin: true,
    scrollback: 5000,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
    fontSize: 13,
    theme: { background: '#1e1e1e', foreground: '#cccccc', selectionBackground: '#264f78' }
  })
  private readonly fit = new FitAddon()
  private opened = false
  private readonly history: string[] = []
  private historyIndex = 0

  constructor(
    private readonly host: HTMLElement,
    private readonly input: HTMLInputElement,
    form: HTMLFormElement,
    private readonly onError: (error: Error) => void
  ) {
    this.terminal.loadAddon(this.fit)
    new ResizeObserver(() => this.fitIfVisible()).observe(host)

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.submit()
    })
    input.addEventListener('keydown', (event) => this.onHistoryKey(event))
  }

  /** Önce aboneliği aç, sonra geçmişi çek; arada gelen çıktı kaybolmasın. */
  async connect(): Promise<void> {
    const early: string[] = []
    let live = false
    api.onServerLog((text) => (live ? this.terminal.write(text) : early.push(text)))
    this.terminal.write(await api.getServerLog())
    early.forEach((text) => this.terminal.write(text))
    live = true
  }

  /** Sekme ilk kez görünür olduğunda açılır; gizli bir elemanda xterm ölçü alamıyor. */
  show(): void {
    if (!this.opened) {
      this.terminal.open(this.host)
      this.opened = true
    }
    this.fitIfVisible()
    this.input.focus()
  }

  private fitIfVisible(): void {
    if (this.opened && this.host.offsetParent !== null) this.fit.fit()
  }

  private async submit(): Promise<void> {
    const command = this.input.value.trim()
    if (!command) return
    // Minecraft konsolunda komutlar `/` olmadan yazılır; alışkanlıkla yazılanı da kabul et
    const normalized = command.replace(/^\/+/, '')
    try {
      await api.sendServerCommand(normalized)
      if (this.history[this.history.length - 1] !== normalized) this.history.push(normalized)
      if (this.history.length > HISTORY_LIMIT) this.history.shift()
      this.historyIndex = this.history.length
      this.input.value = ''
      this.terminal.scrollToBottom()
    } catch (error) {
      this.onError(error as Error)
    }
  }

  private onHistoryKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const step = event.key === 'ArrowUp' ? -1 : 1
    this.historyIndex = Math.min(Math.max(this.historyIndex + step, 0), this.history.length)
    this.input.value = this.history[this.historyIndex] ?? ''
  }
}
