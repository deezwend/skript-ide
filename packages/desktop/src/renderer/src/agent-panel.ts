import type {
  AgentSessionInfo,
  AgentState,
  AgentUiEvent,
  AgentUsage,
  ApiKeySource,
  ApprovalRequest,
  CatalogModel,
  CatalogProvider,
  ContentBlock,
  Message,
  PermissionMode,
  ProblemReport,
  ToolCallBlock
} from '../../shared/ipc'
import { api } from './api'
import { monaco } from './monaco'

import { formatMention, isProblemsMention, parseAttachment, parseMentions } from '@skript-ide/agent/src/mentions'
import { parseGoal } from '@skript-ide/agent/src/goal'
import { PERMISSION_MODES } from '@skript-ide/agent/src/permission'
import { CODEX_PROVIDER_ID } from '@skript-ide/agent/src/codex-catalog'
import { l } from '@skript-ide/i18n'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Tool sonucunun panelde gösterilen en fazla uzunluğu; modele giden sonuç kısaltılmaz. */
const MAX_RESULT_PREVIEW = 4000

/** Hızlı model listesindeki "ayarları aç" seçeneğinin değeri. */
const MORE_MODELS = '__more__'

/** Girişe `/` ile yazılan panel komutu; modele gitmez, panelde işlenir. */
interface SlashCommand {
  name: string
  aliases?: string[]
  /** Argüman varsa kısa gösterimi (`<metin>`); yoksa komut argümansızdır. */
  args?: string
  description: string
  run(arg: string): void | Promise<void>
}

/** Giriş altındaki öneri menüsünün bir satırı (slash komutu ya da `@` dosyası). */
interface MenuItem {
  label: string
  detail?: string
  /** Seçilince girişe yazar. */
  apply(): void
  /** Enter, öneri tam yazılmışsa seçmek yerine mesajı gönderir. */
  complete?: boolean
}

/** `@` listesinde gösterilen en fazla dosya. */
const MAX_MENTION_ITEMS = 50

export interface AgentPanelElements {
  panel: HTMLElement
  modelButton: HTMLButtonElement
  modelSelect: HTMLSelectElement
  effortSelect: HTMLSelectElement
  permissionSelect: HTMLSelectElement
  newButton: HTMLButtonElement
  historyButton: HTMLButtonElement
  sessionsDialog: HTMLDialogElement
  closeButton: HTMLButtonElement
  transcript: HTMLElement
  form: HTMLFormElement
  input: HTMLTextAreaElement
  sendButton: HTMLButtonElement
  status: HTMLElement
  settingsDialog: HTMLDialogElement
}

export interface AgentPanelHooks {
  /** Agent diskteki bir dosyayı değiştirdi. */
  onFileChanged(path: string): void
  /** Onay kartında uyarı göstermek için: dosya açık ve kaydedilmemiş değişiklik içeriyor mu? */
  hasUnsavedChanges(relativePath: string): boolean
  languageForPath(path: string): string
  onVisibilityChange(): void
  /** PROBLEMLER sekmesinin o anki içeriği; `@Problems` etiketiyle modele gönderilir. */
  problems(): ProblemReport[]
}

/**
 * Sağdaki AI agent paneli: konuşma, tool çağrıları, yazma onayları (diff ile) ve model ayarları.
 * Agent'ın kendisi ana süreçte çalışır; panel yalnızca olayları gösterir ve kullanıcı kararlarını iletir.
 */
export class AgentPanel {
  private state: AgentState | null = null
  private providers: CatalogProvider[] | null = null
  private running = false
  private readonly toolRows = new Map<string, HTMLElement>()
  /** Akmakta olan yanıtın geçici görünümü; yanıt tamamlanınca kalıcı haliyle değiştirilir. */
  private live: { root: HTMLElement; reasoning?: HTMLDetailsElement; text?: HTMLElement } | null = null
  private readonly disposers: (() => void)[] = []
  private readonly menu = el('div', 'agent-commands')
  private menuMatches: MenuItem[] = []
  private menuIndex = 0
  /** `@` listesi için proje dosyaları; her yeni `@` yazımında yenilenir. */
  private projectFiles: string[] = []
  private filesRequest = 0
  /** Menü şu an bir `@` etiketini tamamlıyor; liste bu süre boyunca bir kez istenir. */
  private mentionActive = false
  private readonly usageEl = el('div', 'agent-usage')

  constructor(
    private readonly ui: AgentPanelElements,
    private readonly hooks: AgentPanelHooks
  ) {
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (this.running) void api.agentCancel()
      else this.submit()
    })
    ui.status.before(this.usageEl)
    this.renderUsage(null)
    this.menu.hidden = true
    ui.form.insertBefore(this.menu, ui.input)
    ui.input.addEventListener('input', () => this.updateMenu())
    ui.input.addEventListener('click', () => this.updateMenu())
    ui.input.addEventListener('blur', () => this.hideMenu())
    ui.input.addEventListener('keydown', (event) => {
      if (this.menuMatches.length > 0 && !event.isComposing) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          this.menuIndex = (this.menuIndex + step + this.menuMatches.length) % this.menuMatches.length
          this.renderMenu()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          this.hideMenu()
          return
        }
        const picked = this.menuMatches[this.menuIndex]
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !picked.complete)) {
          event.preventDefault()
          this.pick(picked)
          return
        }
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        if (!this.running) this.submit()
      }
    })
    ui.newButton.addEventListener('click', () => void this.reset())
    ui.historyButton.addEventListener('click', () => void this.openHistory())
    ui.closeButton.addEventListener('click', () => this.setVisible(false))
    ui.modelButton.addEventListener('click', () => void this.openSettings())
    ui.modelSelect.addEventListener('change', () => void this.onQuickModelChange())
    this.setupModelPicker()
    ui.effortSelect.addEventListener('change', () => void this.onQuickEffortChange())
    ui.permissionSelect.replaceChildren(...PERMISSION_MODES.map((mode) => new Option(permissionLabel(mode), mode)))
    ui.permissionSelect.addEventListener('change', () => void this.onQuickPermissionChange())
    api.onAgentEvent((event) => this.handleEvent(event))
    void this.refreshState(true)
    // Hızlı seçiciler için katalog; indirilemezse yalnızca ayar penceresi çalışır
    api.agentListProviders().then(
      (providers) => {
        this.providers = providers
        // Ortam değişkenindeki anahtarlar katalog yüklenince bilinir
        void this.refreshState()
      },
      () => {}
    )
  }

  // --- Hızlı model / effort seçimi ---

  /**
   * Yerel <select> arama yapamadığından hızlı model seçici aranabilir bir açılır liste ile değiştirilir;
   * <select> gizli veri deposu olarak kalır ve seçim ona yazılıp `change` ile iletilir.
   */
  private setupModelPicker(): void {
    const select = this.ui.modelSelect
    const wrap = el('div', 'model-picker')
    const trigger = el('button', 'model-picker-trigger')
    trigger.type = 'button'
    const popup = el('div', 'model-picker-popup')
    popup.hidden = true
    const search = el('input')
    search.type = 'search'
    search.placeholder = l('Model ara…', 'Search models…')
    search.spellcheck = false
    const list = el('div', 'model-picker-list')
    popup.append(search, list)
    select.hidden = true
    select.before(wrap)
    wrap.append(trigger, popup)

    let active = -1
    const visibleItems = () => [...list.querySelectorAll<HTMLButtonElement>('button')]
    const highlight = (index: number) => {
      const items = visibleItems()
      if (items.length === 0) return
      active = (index + items.length) % items.length
      items.forEach((item, i) => item.classList.toggle('active', i === active))
      items[active].scrollIntoView({ block: 'nearest' })
    }
    const close = () => {
      popup.hidden = true
      document.removeEventListener('mousedown', onOutside, true)
    }
    const choose = (value: string) => {
      close()
      if (value !== select.value || value === MORE_MODELS) {
        select.value = value
        select.dispatchEvent(new Event('change'))
      }
      this.ui.input.focus()
    }
    const onOutside = (event: MouseEvent) => {
      if (!wrap.contains(event.target as Node)) close()
    }
    const fill = () => {
      const query = search.value.trim().toLowerCase()
      list.replaceChildren()
      for (const option of [...select.options]) {
        const special = option.value === MORE_MODELS
        if (!special && query && !option.text.toLowerCase().includes(query) && !option.value.toLowerCase().includes(query)) continue
        const item = el('button', special ? 'model-picker-item more' : 'model-picker-item', option.text)
        item.type = 'button'
        if (option.value === select.value) item.classList.add('selected')
        item.addEventListener('click', () => choose(option.value))
        list.append(item)
      }
      const items = visibleItems()
      highlight(Math.max(0, items.findIndex((item) => item.classList.contains('selected') && !query)))
    }
    const open = () => {
      search.value = ''
      popup.hidden = false
      fill()
      document.addEventListener('mousedown', onOutside, true)
      search.focus()
      list.querySelector('.selected')?.scrollIntoView({ block: 'center' })
    }
    trigger.addEventListener('click', () => (popup.hidden ? open() : close()))
    search.addEventListener('input', fill)
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') highlight(active + 1)
      else if (event.key === 'ArrowUp') highlight(active - 1)
      else if (event.key === 'Enter') visibleItems()[active]?.click()
      else if (event.key === 'Escape') {
        close()
        trigger.focus()
      } else return
      event.preventDefault()
      event.stopPropagation()
    })

    this.syncModelPicker = () => {
      trigger.textContent = select.selectedOptions[0]?.text ?? ''
      trigger.title = trigger.textContent
    }
  }

  private syncModelPicker: () => void = () => {}

  private async onQuickModelChange(): Promise<void> {
    const select = this.ui.modelSelect
    const settings = this.state?.settings
    const picked = parseModelKey(select.value)
    if (select.value === MORE_MODELS || !picked) {
      select.value = currentModelKey(settings)
      await this.openSettings()
      return
    }
    const model = this.providers?.find((p) => p.id === picked.providerId)?.models.find((m) => m.id === picked.modelId)
    const effort = settings?.effort && model?.effortLevels?.includes(settings.effort) ? settings.effort : null
    await this.saveSettings({ ...picked, effort, permissionMode: settings?.permissionMode ?? 'ask-when-needed' })
  }

  /** Hızlı seçicide modelleri listelenen sağlayıcılar: anahtarı olanlar ve seçili olan, katalog sırasıyla. */
  private pickerProviders(): CatalogProvider[] {
    const ids = new Set(this.state?.configuredProviders ?? [])
    if (this.state?.settings.providerId) ids.add(this.state.settings.providerId)
    return (this.providers ?? []).filter((p) => ids.has(p.id))
  }

  private async onQuickEffortChange(): Promise<void> {
    const settings = this.state?.settings
    if (!settings) return
    await this.saveSettings({ ...settings, effort: this.ui.effortSelect.value || null })
  }

  /** Yalnızca açık konuşmanın modunu değiştirir; varsayılan ayar penceresinden seçilir. */
  private async onQuickPermissionChange(): Promise<void> {
    try {
      this.state = await api.agentSetPermissionMode(this.ui.permissionSelect.value as PermissionMode)
    } catch (error) {
      this.renderNote((error as Error).message, 'error')
    }
    this.renderPermissionSelect()
  }

  private renderPermissionSelect(): void {
    const { permissionSelect } = this.ui
    const mode = this.state?.permissionMode ?? 'ask-when-needed'
    permissionSelect.value = mode
    permissionSelect.title = `${l('İzin modu', 'Permission mode')}: ${permissionDescription(mode)}`
    permissionSelect.classList.toggle('warning', mode === 'never-ask')
  }

  private async saveSettings(next: AgentState['settings']): Promise<void> {
    const previous = this.state?.settings
    const hasHistory = (this.state?.messages.length ?? 0) > 0
    try {
      this.state = await api.agentSetSettings(next)
    } catch (error) {
      this.renderNote((error as Error).message, 'error')
      this.renderModelButton()
      return
    }
    this.renderModelButton()
    // Önbellek modele özeldir; effort değişikliği de mesaj önbelleğini geçersiz kılar
    if (hasHistory && previous && cacheKey(previous) !== cacheKey(next)) {
      this.renderNote(
        l(
          'Model ya da effort değişti: bir sonraki mesajda konuşmanın tamamı önbellekten değil, yeniden tam fiyatla işlenecek.',
          'Model or effort changed: the next message reprocesses the whole conversation at full price instead of reading it from cache.'
        )
      )
    }
  }

  private renderQuickSelectors(): void {
    this.renderPermissionSelect()
    const { modelSelect, effortSelect } = this.ui
    const settings = this.state?.settings
    const provider = this.providers?.find((p) => p.id === settings?.providerId)
    const current = currentModelKey(settings)
    const options: HTMLOptionElement[] = []
    for (const p of this.pickerProviders()) {
      options.push(...p.models.map((m) => new Option(modelDisplayName(m.name, p.name), modelKey(p.id, m.id))))
    }
    // Katalogdan kalkmış ama hâlâ seçili olan model de görünsün
    if (current && !options.some((o) => o.value === current)) {
      options.unshift(new Option(modelDisplayName(settings!.modelId!, provider?.name ?? settings!.providerId!), current))
    }
    if (options.length === 0) options.push(new Option(l('Model seç…', 'Choose model…'), ''))
    options.push(new Option(l('Diğer sağlayıcı / ayarlar…', 'Other provider / settings…'), MORE_MODELS))
    modelSelect.replaceChildren(...options)
    modelSelect.value = current
    this.syncModelPicker()

    const levels = provider?.models.find((m) => m.id === settings?.modelId)?.effortLevels ?? []
    effortSelect.replaceChildren(new Option(l('Effort: varsayılan', 'Effort: default'), ''), ...levels.map((level) => new Option(`Effort: ${level}`, level)))
    effortSelect.value = settings?.effort && levels.includes(settings.effort) ? settings.effort : ''
    effortSelect.disabled = levels.length === 0
    effortSelect.title =
      levels.length === 0 ? l('Bu model effort ayarını desteklemiyor', 'This model has no effort setting') : l('Düşünme seviyesi (effort)', 'Reasoning effort')
  }

  get visible(): boolean {
    return !this.ui.panel.hidden
  }

  setVisible(visible: boolean): void {
    this.ui.panel.hidden = !visible
    this.hooks.onVisibilityChange()
    if (visible) this.ui.input.focus()
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  // --- Durum ---

  private async refreshState(rebuild = false): Promise<void> {
    this.state = await api.agentGetState()
    this.setRunning(this.state.running)
    if (rebuild) {
      this.clearTranscript()
      for (const message of this.state.messages) this.renderMessage(message)
      if (this.state.messages.length === 0) this.renderEmpty()
    }
    this.renderUsage(this.state.usage)
    this.renderModelButton()
  }

  private renderModelButton(): void {
    this.renderQuickSelectors()
    const settings = this.state?.settings
    const button = this.ui.modelButton
    if (!settings?.providerId || !settings.modelId) {
      button.textContent = l('Model seç…', 'Choose model…')
      button.classList.add('warning')
      return
    }
    const provider = this.providers?.find((p) => p.id === settings.providerId)
    const model = provider?.models.find((m) => m.id === settings.modelId)
    button.textContent = modelDisplayName(model?.name ?? settings.modelId, provider?.name ?? settings.providerId)
    button.title = `${provider?.name ?? settings.providerId} · ${settings.modelId}${settings.effort ? ` · effort ${settings.effort}` : ''}`
    button.classList.toggle('warning', this.state?.keySource === 'none')
    if (this.state?.keySource === 'none') {
      button.title +=
        settings.providerId === CODEX_PROVIDER_ID
          ? l('\nChatGPT girişi yok', '\nNot signed in to ChatGPT')
          : l('\nAPI anahtarı yok', '\nNo API key')
    }
  }

  /**
   * Sol alttaki sayaç: önbellekli/önbelleksiz girdi, önbelleğe yazılan, çıktı ve son turun
   * isabet oranı, bağlam doluluğu ve maliyet. Konuşma geneli oran `/usage` dökümünde.
   */
  private renderUsage(usage: AgentUsage | null): void {
    const u = usage ?? EMPTY_USAGE
    const cost = u.cost === null ? '–' : formatCost(u.cost)
    const stat = (label: string, value: string, title: string, kind: string) => {
      const node = el('span', `agent-usage-stat ${kind}`)
      node.title = title
      node.append(el('span', 'agent-usage-label', label), el('b', undefined, value))
      return node
    }
    const row = (...nodes: HTMLElement[]) => {
      const node = el('div', 'agent-usage-row')
      node.append(...nodes)
      return node
    }
    // Son turun oranı önbellek davranışını anında gösterir; genel ortalama geçmişi seyreltir
    const hit = u.hitRate === null ? '–' : `${Math.round(u.hitRate)}%`
    const fill = u.contextWindow > 0 ? (u.contextTokens / u.contextWindow) * 100 : null
    const contextValue = fill === null ? '–' : `${fill.toFixed(0)}%/${formatCount(u.contextWindow)}`
    const contextKind = fill !== null && fill > 90 ? 'context danger' : fill !== null && fill > 70 ? 'context warn' : 'context'
    this.usageEl.replaceChildren(
      row(
        stat(l('Yeni', 'Uncached'), formatCount(u.uncached), l('Önbelleğe isabet etmeyen girdi token’ları', 'Input tokens that missed the cache'), 'uncached'),
        stat(l('Önbellek', 'Cached'), formatCount(u.cached), l('Önbellekten okunan girdi token’ları', 'Input tokens read from the cache'), 'cached'),
        // Önbellek yazımını bildirmeyen sağlayıcılarda sıfır göstermek gürültü olur
        ...(u.written > 0
          ? [stat(l('Yazılan', 'Written'), formatCount(u.written), l('Önbelleğe yazılan girdi token’ları', 'Input tokens written to the cache'), 'written')]
          : []),
        stat(l('Çıktı', 'Output'), formatCount(u.output), l('Modelin ürettiği token’lar', 'Tokens generated by the model'), 'output')
      ),
      row(
        stat(l('İsabet', 'Hit'), hit, l('Son turun önbellek isabet oranı: önbellekten gelen girdi / toplam girdi', 'Cache hit rate of the last turn: cached input / total input'), 'hit'),
        stat(l('Bağlam', 'Context'), contextValue, l('Bağlam penceresinin ne kadarı dolu (tahmini)', 'How much of the context window is used (estimated)'), contextKind),
        stat(
          l('Maliyet', 'Cost'),
          cost,
          u.cost === null ? l('Bu modelin fiyatı katalogda yok ya da bir kısmı bilinmiyor', 'Pricing for this model is missing from the catalog') : l('Bu konuşmanın tahmini maliyeti (USD)', 'Estimated cost of this conversation (USD)'),
          'cost'
        )
      )
    )
  }

  /** Önbellek isabetsizliği: yalnızca gözlemlenebilir nedeni söyler, tahmin yürütmez. */
  private renderCacheMiss(event: Extract<AgentUiEvent, { type: 'cache-miss' }>): void {
    const cost = event.missedCost >= 0.01 ? ` (~${formatCost(event.missedCost)})` : ''
    const reBilled = l(
      `${formatCount(event.missedTokens)} token yeniden faturalandı${cost}`,
      `${formatCount(event.missedTokens)} tokens re-billed${cost}`
    )
    const label =
      event.reason === 'model'
        ? l('Model değişti, önbellek tutmadı', 'Cache miss after model switch')
        : event.reason === 'idle'
          ? l(
              `${Math.round(event.idleMs / 60_000)} dk boşluktan sonra önbellek tutmadı`,
              `Cache miss after ${Math.round(event.idleMs / 60_000)}m idle`
            )
          : l('Önbellek tutmadı', 'Cache miss')
    this.renderNote(`${label}: ${reBilled}`, 'warning')
  }

  /** `/usage`: konuşma geneli oran, model dökümü ve yeniden faturalanan token'lar. */
  private showUsage(): void {
    const u = this.state?.usage
    if (!u) {
      this.renderNote(l('Kullanım bilgisi yok.', 'No usage information yet.'))
      return
    }
    const prompt = u.uncached + u.cached + u.written
    const percent = (value: number | null) => (value === null ? '–' : `${value.toFixed(1)}%`)
    const lines = [
      l('Kullanım', 'Usage'),
      l(
        `Girdi: ${formatCount(prompt)} · önbellekten ${formatCount(u.cached)} · yazılan ${formatCount(u.written)} · yeni ${formatCount(u.uncached)}`,
        `Input: ${formatCount(prompt)} · cached ${formatCount(u.cached)} · written ${formatCount(u.written)} · uncached ${formatCount(u.uncached)}`
      ),
      l(
        `Önbellek isabeti: ${percent(u.totalHitRate)} (son tur ${percent(u.hitRate)})`,
        `Cache hit rate: ${percent(u.totalHitRate)} (last turn ${percent(u.hitRate)})`
      ),
      l(`Çıktı: ${formatCount(u.output)}`, `Output: ${formatCount(u.output)}`)
    ]
    if (u.reBilledTokens > 0) {
      const misses = u.reBilledCount === 1 ? l('1 miss', '1 miss') : l(`${u.reBilledCount} miss`, `${u.reBilledCount} misses`)
      lines.push(
        l(
          `Yeniden faturalanan: ${formatCount(u.reBilledTokens)} token, ${misses}${u.reBilledCost >= 0.0001 ? ` (~${formatCost(u.reBilledCost)} fazla)` : ''}`,
          `Re-billed: ${formatCount(u.reBilledTokens)} tokens, ${misses}${u.reBilledCost >= 0.0001 ? ` (~${formatCost(u.reBilledCost)} extra)` : ''}`
        )
      )
    }
    if (u.contextWindow > 0) {
      lines.push(
        l(
          `Bağlam: ${formatCount(u.contextTokens)} / ${formatCount(u.contextWindow)} (%${((u.contextTokens / u.contextWindow) * 100).toFixed(0)})`,
          `Context: ${formatCount(u.contextTokens)} / ${formatCount(u.contextWindow)} (${((u.contextTokens / u.contextWindow) * 100).toFixed(0)}%)`
        )
      )
    }
    if (u.byModel.length > 1) {
      lines.push(l('Model dökümü:', 'By model:'))
      for (const entry of u.byModel) lines.push(`  ${entry.key}: ${formatCost(entry.cost)} (${formatCount(entry.tokens)})`)
    }
    lines.push(l(`Maliyet: ${u.cost === null ? '–' : formatCost(u.cost)}`, `Cost: ${u.cost === null ? '–' : formatCost(u.cost)}`))
    this.renderNote(lines.join('\n'))
  }

  private setRunning(running: boolean): void {
    this.running = running
    this.ui.sendButton.textContent = running ? l('Durdur', 'Stop') : l('Gönder', 'Send')
    this.ui.sendButton.classList.toggle('stop', running)
    this.ui.status.textContent = running ? l('Çalışıyor…', 'Working…') : ''
    this.ui.panel.classList.toggle('running', running)
  }

  // --- Gönderme ---

  private submit(): void {
    const text = this.ui.input.value.trim()
    if (!text) return
    this.hideMenu()
    if (text.startsWith('/')) {
      const [word, ...rest] = text.slice(1).split(/\s+/)
      const command = this.findCommand(word)
      if (command) {
        this.ui.input.value = ''
        void Promise.resolve(command.run(rest.join(' ').trim())).catch((error: Error) => this.renderNote(error.message, 'error'))
        return
      }
      // Bilinen komut değilse (örn. "/etc/hosts dosyasını oku") normal mesaj olarak gider
      if (/^[a-z-]+$/i.test(word) && rest.length === 0) {
        this.renderNote(l(`Bilinmeyen komut: /${word}. Komutlar için /help yaz.`, `Unknown command: /${word}. Type /help for the list.`), 'error')
        return
      }
    }
    this.send(text)
  }

  private send(text: string): void {
    this.ui.input.value = ''
    this.setRunning(true)
    const problems = parseMentions(text).some(isProblemsMention) ? this.hooks.problems() : undefined
    api.agentSend(text, problems).catch((error: Error) => {
      // Başlamadan reddedildi (model seçilmemiş, anahtar yok…): metni geri koy
      this.setRunning(false)
      this.ui.input.value = text
      this.renderNote(error.message, 'error')
      if (!this.state?.settings.modelId || this.state.keySource === 'none') void this.openSettings()
    })
  }

  // --- Slash komutları ---

  private commands(): SlashCommand[] {
    return [
      {
        name: 'help',
        aliases: ['?'],
        description: l('Komutları listeler', 'Lists the commands'),
        run: () => this.showHelp()
      },
      {
        name: 'new',
        aliases: ['clear'],
        description: l('Yeni konuşma başlatır', 'Starts a new conversation'),
        run: () => this.reset()
      },
      {
        name: 'undo',
        description: l('Son mesajı ve agent’ın o turdaki dosya değişikliklerini geri alır', 'Reverts the last message and the file changes the agent made in that turn'),
        run: () => this.undo()
      },
      {
        name: 'goal',
        args: l('[hedef | clear]', '[goal | clear]'),
        description: l('Konuşma boyunca geçerli bir hedef belirler; yalnız yazarsan mevcut hedefi gösterir', 'Sets a goal for the whole conversation; without arguments shows the current goal'),
        run: (arg) => this.goal(arg)
      },
      {
        name: 'model',
        args: l('[model]', '[model]'),
        description: l('Modeli değiştirir; argümansız ayarları açar', 'Switches the model; without arguments opens the settings'),
        run: (arg) => this.model(arg)
      },
      {
        name: 'effort',
        args: l('[seviye | default]', '[level | default]'),
        description: l('Düşünme seviyesini (effort) değiştirir', 'Changes the reasoning effort'),
        run: (arg) => this.effort(arg)
      },
      {
        name: 'history',
        description: l('Konuşma geçmişini açar', 'Opens the conversation history'),
        run: () => this.openHistory()
      },
      {
        name: 'usage',
        description: l(
          'Token kullanımını, önbellek isabetini ve maliyeti gösterir',
          'Shows token usage, cache hit rate and cost'
        ),
        run: () => this.showUsage()
      }
    ]
  }

  private findCommand(word: string): SlashCommand | undefined {
    const name = word.toLowerCase()
    return this.commands().find((c) => c.name === name || c.aliases?.includes(name))
  }

  private updateMenu(): void {
    const input = this.ui.input
    const value = input.value
    const command = /^\/([a-z?-]*)$/i.exec(value)
    if (command) {
      this.mentionActive = false
      const prefix = command[1].toLowerCase()
      this.showMenu(
        this.commands()
          .filter((c) => c.name.startsWith(prefix))
          .map((c) => ({
            label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
            detail: c.description,
            complete: prefix === c.name,
            apply: () => (input.value = `/${c.name}${c.args ? ' ' : ''}`)
          }))
      )
      return
    }
    // İmlecin hemen önündeki `@sorgu` (tırnaklı yazım dahil); yalnızca seçim yokken
    const caret = input.selectionStart ?? value.length
    const mention = input.selectionEnd === caret ? /(?:^|\s)@("?)([^\s"@]*)$/.exec(value.slice(0, caret)) : null
    if (!mention) return this.hideMenu()
    const start = caret - mention[2].length - mention[1].length - 1
    if (!this.mentionActive) {
      this.mentionActive = true
      void this.loadProjectFiles()
    }
    const insert = (mention: string) => {
      // Etiketin bittiği yer: imleçten sonra aynı kelimede kalan kısım da değiştirilir
      const rest = value.slice(caret)
      const end = caret + (/^[^\s]*/.exec(rest)?.[0].length ?? 0)
      const text = `${mention} `
      input.value = value.slice(0, start) + text + value.slice(end).replace(/^\s/, '')
      input.selectionStart = input.selectionEnd = start + text.length
    }
    // PROBLEMLER sekmesi dosyalardan önce gelir; iki dildeki adıyla da bulunur
    const query = mention[2].toLowerCase()
    const problemsName = l('Problemler', 'Problems')
    const problemsItems: MenuItem[] =
      !mention[1] && ['problems', 'problemler'].some((name) => name.startsWith(query))
        ? [
            {
              label: `@${problemsName}`,
              detail: l('PROBLEMLER sekmesindeki sorunlar', 'Issues in the PROBLEMS tab'),
              apply: () => insert(`@${problemsName}`)
            }
          ]
        : []
    this.showMenu([
      ...problemsItems,
      ...rankFiles(this.projectFiles, mention[2]).map((path) => ({ label: path, apply: () => insert(formatMention(path)) }))
    ])
  }

  /** Proje dosyalarını ana süreçten ister; yanıt geldiğinde menü hâlâ açıksa günceller. */
  private async loadProjectFiles(): Promise<void> {
    const request = ++this.filesRequest
    const files = await api.agentListFiles().catch(() => [])
    if (request !== this.filesRequest) return
    this.projectFiles = files
    if (document.activeElement === this.ui.input) this.updateMenu()
  }

  private showMenu(items: MenuItem[]): void {
    this.menuMatches = items
    this.menuIndex = 0
    this.renderMenu()
  }

  private pick(item: MenuItem): void {
    item.apply()
    this.hideMenu()
    this.ui.input.focus()
  }

  private renderMenu(): void {
    this.menu.hidden = this.menuMatches.length === 0
    this.menu.replaceChildren(
      ...this.menuMatches.map((item, index) => {
        const row = el('div', 'agent-command')
        row.classList.toggle('selected', index === this.menuIndex)
        row.append(el('span', 'agent-command-name', item.label))
        if (item.detail) row.append(el('span', 'agent-muted', item.detail))
        // mousedown: blur menüyü kapatmadan önce seçim yapılsın
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          this.pick(item)
        })
        return row
      })
    )
    this.menu.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private hideMenu(): void {
    this.mentionActive = false
    this.menuMatches = []
    this.menu.hidden = true
  }

  private showHelp(): void {
    const lines = this.commands().map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`)
    this.renderNote(lines.join('\n'))
  }

  private async undo(): Promise<void> {
    const result = await api.agentUndo()
    this.state = result.state
    await this.refreshState(true)
    if (result.text === null) {
      this.renderNote(l('Geri alınacak mesaj yok.', 'Nothing to undo.'))
      return
    }
    this.ui.input.value = result.text
    this.ui.input.focus()
    const parts = [l('Son mesaj geri alındı; metni girişe konuldu.', 'Last message undone; its text is back in the input.')]
    if (result.restored.length) parts.push(l(`Geri alınan dosyalar: ${result.restored.join(', ')}`, `Files restored: ${result.restored.join(', ')}`))
    if (result.skipped.length) {
      parts.push(
        l(
          `Sonradan değiştiği için dokunulmadı: ${result.skipped.join(', ')}`,
          `Left untouched because they changed since: ${result.skipped.join(', ')}`
        )
      )
    }
    this.renderNote(parts.join('\n'))
  }

  private async goal(arg: string): Promise<void> {
    const current = this.state?.goal ?? null
    if (!arg) {
      this.renderNote(current ? l(`Hedef: ${current}`, `Goal: ${current}`) : l('Hedef yok. /goal <hedef> ile belirle.', 'No goal set. Use /goal <goal>.'))
      return
    }
    if (/^(clear|off|sil|temizle)$/i.test(arg)) {
      this.state = await api.agentSetGoal(null)
      this.renderNote(l('Hedef temizlendi.', 'Goal cleared.'))
      return
    }
    this.state = await api.agentSetGoal(arg)
    this.renderNote(l(`Hedef belirlendi: ${arg}`, `Goal set: ${arg}`))
    this.send(l(`Şu hedef için çalışmaya başla: ${arg}`, `Start working on this goal: ${arg}`))
  }

  private async model(arg: string): Promise<void> {
    const settings = this.state?.settings
    if (!arg) return this.openSettings()
    // Seçili sağlayıcı önde: aynı adlı model başka sağlayıcıda da varsa o seçilir
    const providers = this.pickerProviders().sort((a, b) => Number(b.id === settings?.providerId) - Number(a.id === settings?.providerId))
    const candidates = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
    const query = arg.toLowerCase()
    const label = (c: (typeof candidates)[number]) => modelDisplayName(c.model.name, c.provider.name).toLowerCase()
    const found =
      candidates.find((c) => c.model.id.toLowerCase() === query || c.model.name.toLowerCase() === query || label(c) === query) ??
      candidates.find((c) => c.model.id.toLowerCase().includes(query) || label(c).includes(query))
    if (!found) {
      this.renderNote(l(`"${arg}" ile eşleşen model yok. Başka sağlayıcı için /model yaz.`, `No model matches "${arg}". Type /model to pick another provider.`), 'error')
      return
    }
    const effort = settings?.effort && found.model.effortLevels?.includes(settings.effort) ? settings.effort : null
    await this.saveSettings({ providerId: found.provider.id, modelId: found.model.id, effort, permissionMode: settings?.permissionMode ?? 'ask-when-needed' })
    this.renderNote(`Model: ${modelDisplayName(found.model.name, found.provider.name)}`)
  }

  private async effort(arg: string): Promise<void> {
    const settings = this.state?.settings
    if (!settings?.modelId) return this.openSettings()
    const levels = this.providers?.find((p) => p.id === settings.providerId)?.models.find((m) => m.id === settings.modelId)?.effortLevels ?? []
    if (levels.length === 0) {
      this.renderNote(l('Bu model effort ayarını desteklemiyor.', 'This model has no effort setting.'))
      return
    }
    const level = arg.toLowerCase()
    if (!arg) {
      this.renderNote(l(`Effort: ${settings.effort ?? 'varsayılan'} (seçenekler: ${levels.join(', ')}, default)`, `Effort: ${settings.effort ?? 'default'} (options: ${levels.join(', ')}, default)`))
      return
    }
    if (level !== 'default' && !levels.includes(level)) {
      this.renderNote(l(`Geçersiz seviye. Seçenekler: ${levels.join(', ')}, default`, `Invalid level. Options: ${levels.join(', ')}, default`), 'error')
      return
    }
    await this.saveSettings({ ...settings, effort: level === 'default' ? null : level })
    this.renderNote(`Effort: ${level}`)
  }

  private async reset(): Promise<void> {
    await api.agentReset()
    this.clearTranscript()
    this.renderEmpty()
    this.setRunning(false)
    this.ui.input.focus()
  }

  // --- Konuşma geçmişi ---

  private async openHistory(): Promise<void> {
    const dialog = this.ui.sessionsDialog
    const title = el('h2', undefined, l('Konuşma geçmişi', 'Conversation history'))
    const list = el('div', 'agent-sessions')
    const close = el('button', undefined, l('Kapat', 'Close'))
    close.addEventListener('click', () => dialog.close())
    const actions = el('div', 'dialog-actions')
    actions.append(el('span', 'spacer'), close)
    dialog.replaceChildren(title, list, actions)
    if (!dialog.open) dialog.showModal()
    await this.refreshState().catch(() => {})

    const render = async () => {
      let sessions: AgentSessionInfo[]
      try {
        sessions = await api.agentListSessions()
      } catch (error) {
        list.replaceChildren(el('p', 'dialog-note error', (error as Error).message))
        return
      }
      if (sessions.length === 0) {
        list.replaceChildren(el('p', 'dialog-note', l('Henüz kayıtlı konuşma yok.', 'No saved conversations yet.')))
        return
      }
      list.replaceChildren(...sessions.map((session) => this.sessionRow(session, dialog, render)))
    }
    await render()
  }

  private sessionRow(session: AgentSessionInfo, dialog: HTMLDialogElement, refresh: () => Promise<void>): HTMLElement {
    const row = el('div', 'agent-session')
    row.classList.toggle('current', session.id === this.state?.sessionId)
    const open = el('button', 'agent-session-open')
    const when = new Date(session.updatedAt).toLocaleString()
    const project = session.projectRoot ? session.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : null
    open.append(
      el('span', 'agent-session-title', session.title),
      el('span', 'agent-muted', [when, l(`${session.turns} mesaj`, `${session.turns} messages`), project].filter(Boolean).join(' · '))
    )
    open.addEventListener('click', () => {
      void api.agentLoadSession(session.id).then(
        (state) => {
          this.state = state
          void this.refreshState(true)
          dialog.close()
          this.ui.input.focus()
        },
        (error: Error) => this.renderNote(error.message, 'error')
      )
    })
    const remove = el('button', 'icon-button', '🗑')
    remove.title = l('Sil', 'Delete')
    remove.addEventListener('click', () => {
      void api.agentDeleteSession(session.id).then(async (state) => {
        const wasCurrent = session.id === this.state?.sessionId
        this.state = state
        if (wasCurrent) {
          this.clearTranscript()
          this.renderEmpty()
          this.setRunning(false)
        }
        await refresh()
      })
    })
    row.append(open, remove)
    return row
  }

  // --- Olaylar ---

  private handleEvent(event: AgentUiEvent): void {
    switch (event.type) {
      case 'user-message':
        this.ui.transcript.querySelector('.agent-empty')?.remove()
        this.renderMessage(event.message)
        break
      case 'delta':
        this.renderDelta(event.delta.kind, event.delta.text)
        break
      case 'assistant-message':
        this.live?.root.remove()
        this.live = null
        this.renderMessage(event.message)
        break
      case 'tool-start':
        this.toolRows.get(event.call.id)?.classList.add('running')
        break
      case 'tool-result':
        this.renderToolResult(event.call.id, event.result.content, event.result.isError === true)
        break
      case 'approval-request':
        this.renderApproval(event.id, event.request)
        break
      case 'usage':
        // `/usage` dökümü aynı nesneden okur; olay geldikçe tazelenmeli
        if (this.state) this.state.usage = event.usage
        this.renderUsage(event.usage)
        break
      case 'cache-miss':
        this.renderCacheMiss(event)
        break
      case 'file-changed':
        this.hooks.onFileChanged(event.path)
        break
      case 'done':
        this.finishLive()
        this.setRunning(false)
        this.disposeApprovals()
        if (event.reason === 'error') this.renderNote(event.error ?? l('Bilinmeyen hata', 'Unknown error'), 'error')
        else if (event.reason === 'cancelled') this.renderNote(l('Durduruldu.', 'Stopped.'))
        else if (event.reason === 'max_tokens') this.renderNote(l('Yanıt uzunluk sınırında kesildi.', 'The response was cut off at the length limit.'))
        else if (event.reason === 'max_turns') this.renderNote(l('Adım sınırına ulaşıldı; devam etmesi için yeniden yaz.', 'Step limit reached; send another message to continue.'))
        else if (event.reason === 'refusal') this.renderNote(l('Model bu isteği yanıtlamayı reddetti.', 'The model declined to answer this request.'))
        break
    }
  }

  // --- Konuşma görünümü ---

  private clearTranscript(): void {
    this.disposeApprovals()
    this.toolRows.clear()
    this.live = null
    this.ui.transcript.replaceChildren()
  }

  private renderEmpty(): void {
    const empty = el('div', 'agent-empty')
    empty.append(
      el('p', undefined, l('Skript betiklerin hakkında soru sor ya da bir değişiklik iste.', 'Ask about your Skript scripts or request a change.')),
      el(
        'p',
        'agent-muted',
        l(
          'Agent proje klasöründeki dosyaları okuyabilir ve arayabilir. Varsayılan olarak dosya değişiklikleri önce sana diff olarak gösterilir, onaylamazsan uygulanmaz; bunu alttaki izin modundan değiştirebilirsin.',
          'The agent can read and search files in the project folder. By default, file changes are shown to you as a diff first and are not applied unless you approve them; change this with the permission mode below.'
        )
      )
    )
    this.ui.transcript.append(empty)
  }

  private renderMessage(message: Message): void {
    for (const block of message.content) {
      const thought = reasoningText(block)
      const attachment = message.role === 'user' && block.type === 'text' ? parseAttachment(block.text) : null
      // Hedef bloğu yalnızca modele gider; `/goal` zaten not olarak gösteriliyor
      if (message.role === 'user' && block.type === 'text' && parseGoal(block.text) !== undefined) continue
      if (thought.trim()) {
        this.append(this.reasoningBox(thought, false))
      } else if (attachment) {
        this.append(this.attachmentChip(attachment.path, attachment.content))
      } else if (block.type === 'text' && block.text.trim()) {
        this.append(message.role === 'user' ? this.userBubble(block.text) : this.assistantText(block.text))
      } else if (block.type === 'tool_call') {
        this.append(this.toolRow(block))
      } else if (block.type === 'tool_result') {
        this.renderToolResult(block.callId, block.content, block.isError === true)
      }
    }
  }

  /** Akan parçayı canlı görünüme ekler: düşünme açık bir kutuda, yanıt metni altında. */
  private renderDelta(kind: 'text' | 'reasoning', text: string): void {
    const transcript = this.ui.transcript
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
    if (!this.live) {
      this.live = { root: el('div', 'agent-live') }
      transcript.append(this.live.root)
    }
    const live = this.live
    if (kind === 'reasoning') {
      if (!live.reasoning) {
        live.reasoning = this.reasoningBox('', true)
        live.root.insertBefore(live.reasoning, live.text?.parentElement ?? null)
      }
      const body = live.reasoning.querySelector('.agent-reasoning-body')!
      body.append(text)
      body.scrollTop = body.scrollHeight
    } else {
      if (!live.text) {
        const container = el('div', 'agent-msg assistant')
        live.text = el('div', 'agent-text')
        container.append(live.text)
        live.root.append(container)
        // Yanıt başladı: düşünme bitti, kutu kapanıp yer açar
        this.closeReasoning(live.reasoning)
      }
      live.text.append(text)
    }
    if (atBottom) transcript.scrollTop = transcript.scrollHeight
  }

  /** Tur bitti ama tam yanıt gelmedi (iptal, hata): akan kısım olduğu gibi kalır. */
  private finishLive(): void {
    this.closeReasoning(this.live?.reasoning)
    this.live = null
  }

  private reasoningBox(text: string, streaming: boolean): HTMLDetailsElement {
    const box = el('details', 'agent-reasoning')
    box.open = streaming
    box.classList.toggle('streaming', streaming)
    box.append(
      el('summary', undefined, streaming ? l('Düşünüyor…', 'Thinking…') : l('Düşünce', 'Thoughts')),
      el('div', 'agent-reasoning-body', text)
    )
    return box
  }

  private closeReasoning(box: HTMLDetailsElement | undefined): void {
    if (!box?.classList.contains('streaming')) return
    box.classList.remove('streaming')
    box.open = false
    box.querySelector('summary')!.textContent = l('Düşünce', 'Thoughts')
  }

  /** `@etiket`ler vurgulanır; geri kalan metin olduğu gibi gösterilir. */
  private userBubble(text: string): HTMLElement {
    const bubble = el('div', 'agent-msg user')
    let last = 0
    for (const match of text.matchAll(/(^|\s)(@(?:"[^"\n]+"|\S+))/g)) {
      const start = match.index + match[1].length
      bubble.append(text.slice(last, start), el('span', 'agent-mention', match[2]))
      last = start + match[2].length
    }
    bubble.append(text.slice(last))
    return bubble
  }

  /** Mesaja eklenen dosya: kapalı bir kutu, açılınca modele giden içerik görünür. */
  private attachmentChip(path: string, content: string): HTMLElement {
    const box = el('details', 'agent-attachment')
    const lines = content.split('\n').length
    box.append(
      el(
        'summary',
        undefined,
        isProblemsMention(path)
          ? `⚠ ${l('Problemler', 'Problems')} · ${content === 'No problems reported.' ? 0 : lines}`
          : `📎 ${path} · ${l(`${lines} satır`, `${lines} lines`)}`
      ),
      el('pre', 'agent-tool-result', content.length > MAX_RESULT_PREVIEW ? `${content.slice(0, MAX_RESULT_PREVIEW)}\n…` : content)
    )
    return box
  }

  /** Kod bloklarını (```) ayırır; geri kalan metin olduğu gibi (satır sonlarıyla) gösterilir. */
  private assistantText(text: string): HTMLElement {
    const container = el('div', 'agent-msg assistant')
    const parts = text.split(/```[^\n]*\n?/)
    parts.forEach((part, index) => {
      if (!part) return
      if (index % 2 === 1) {
        const pre = el('pre', 'agent-code')
        pre.append(el('code', undefined, part.replace(/\n$/, '')))
        container.append(pre)
      } else {
        container.append(el('div', 'agent-text', part.trim()))
      }
    })
    return container
  }

  private toolRow(call: ToolCallBlock): HTMLElement {
    const row = el('details', 'agent-tool')
    const summary = el('summary')
    summary.append(el('span', 'agent-tool-icon', '›'), el('span', 'agent-tool-name', call.name), el('span', 'agent-tool-arg', toolArgument(call)))
    row.append(summary)
    this.toolRows.set(call.id, row)
    return row
  }

  private renderToolResult(callId: string, content: string, isError: boolean): void {
    const row = this.toolRows.get(callId)
    if (!row) return
    row.classList.remove('running')
    row.classList.add(isError ? 'error' : 'ok')
    row.querySelector('.agent-tool-icon')!.textContent = isError ? '✕' : '✓'
    row.querySelector('.agent-tool-result')?.remove()
    const shown = content.length > MAX_RESULT_PREVIEW ? `${content.slice(0, MAX_RESULT_PREVIEW)}\n…` : content
    row.append(el('pre', 'agent-tool-result', shown))
  }

  private renderNote(text: string, kind: 'info' | 'error' | 'warning' = 'info'): void {
    this.append(el('div', `agent-note ${kind}`, text))
  }

  private append(node: HTMLElement): void {
    const transcript = this.ui.transcript
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
    transcript.append(node)
    if (atBottom) transcript.scrollTop = transcript.scrollHeight
  }

  // --- Onaylar ---

  private renderApproval(id: number, request: ApprovalRequest): void {
    const card = el('div', 'agent-approval')
    card.append(el('div', 'agent-approval-title', request.summary))

    let dispose = () => {}
    if (request.change) {
      if (this.hooks.hasUnsavedChanges(request.change.path)) {
        card.append(
          el(
            'div',
            'agent-approval-warning',
            l(
              '⚠ Bu dosyada kaydedilmemiş değişikliklerin var. Agent diskteki sürümü düzenler; sekme yeniden yüklenmez.',
              '⚠ This file has unsaved changes. The agent edits the version on disk; the tab will not be reloaded.'
            )
          )
        )
      }
      const host = el('div', 'agent-diff')
      card.append(host)
      const language = this.hooks.languageForPath(request.change.path)
      const original = monaco.editor.createModel(request.change.before, language)
      const modified = monaco.editor.createModel(request.change.after, language)
      const diff = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        renderSideBySide: false,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        lineNumbers: 'off',
        folding: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 2 },
        fontSize: 12
      })
      diff.setModel({ original, modified })
      dispose = () => {
        diff.dispose()
        original.dispose()
        modified.dispose()
      }
    }

    const actions = el('div', 'agent-approval-actions')
    const reject = el('button', undefined, l('Reddet', 'Reject'))
    const approve = el('button', 'primary', l('Onayla', 'Approve'))
    actions.append(reject, approve)
    card.append(actions)

    const decide = (approved: boolean) => {
      api.agentRespondApproval(id, approved)
      finish(approved ? l('✓ Onaylandı', '✓ Approved') : l('✕ Reddedildi', '✕ Rejected'))
    }
    const finish = (label: string) => {
      dispose()
      card.replaceChildren(el('div', 'agent-approval-title', `${request.summary} — ${label}`))
      card.classList.add('decided')
      const index = this.disposers.indexOf(cancel)
      if (index >= 0) this.disposers.splice(index, 1)
    }
    const cancel = () => finish(l('iptal edildi', 'cancelled'))
    this.disposers.push(cancel)
    reject.addEventListener('click', () => decide(false))
    approve.addEventListener('click', () => decide(true))
    this.append(card)
    approve.focus()
  }

  /** Tur bittiğinde yanıtlanmamış onay kartlarını kapatır (ana süreç onları zaten reddetti). */
  private disposeApprovals(): void {
    for (const dispose of [...this.disposers]) dispose()
  }

  // --- Ayarlar ---

  private async openSettings(): Promise<void> {
    const dialog = this.ui.settingsDialog
    const loading = el('p', 'dialog-note', l("Model kataloğu yükleniyor (models.dev)…", 'Loading the model catalog (models.dev)…'))
    dialog.replaceChildren(el('h2', undefined, l('Agent Ayarları', 'Agent Settings')), loading)
    if (!dialog.open) dialog.showModal()
    try {
      this.providers = await api.agentListProviders()
    } catch (error) {
      loading.textContent = (error as Error).message
      loading.classList.add('error')
      const actions = el('div', 'dialog-actions')
      const close = el('button', undefined, l('Kapat', 'Close'))
      close.addEventListener('click', () => dialog.close())
      actions.append(close)
      dialog.append(actions)
      return
    }
    await this.refreshState()
    this.renderSettings(this.providers)
  }

  private renderSettings(providers: CatalogProvider[], preferredId?: string): void {
    const dialog = this.ui.settingsDialog
    const settings = this.state!.settings
    const form = el('form')
    form.method = 'dialog'

    const providerSelect = el('select')
    for (const provider of providers) providerSelect.append(new Option(provider.name, provider.id))
    const wanted = preferredId ?? settings.providerId
    providerSelect.value =
      wanted && providers.some((p) => p.id === wanted) ? wanted : (providers.find((p) => p.id === 'anthropic') ?? providers[0])?.id ?? ''

    const modelFilter = el('input')
    modelFilter.type = 'search'
    modelFilter.placeholder = l('Model ara…', 'Search models…')
    const modelSelect = el('select')
    modelSelect.size = 8
    const modelInfo = el('p', 'agent-model-info')
    const effortSelect = el('select')
    const effortRow = field(l('Düşünme seviyesi (effort)', 'Reasoning effort'), effortSelect)
    const permissionSelect = el('select')
    permissionSelect.replaceChildren(...PERMISSION_MODES.map((mode) => new Option(permissionLabel(mode), mode)))
    permissionSelect.value = settings.permissionMode
    const permissionInfo = el('p', 'agent-model-info')
    const fillPermissionInfo = () => (permissionInfo.textContent = permissionDescription(permissionSelect.value as PermissionMode))
    permissionSelect.addEventListener('change', fillPermissionInfo)
    fillPermissionInfo()

    const keyInput = el('input')
    keyInput.type = 'password'
    keyInput.autocomplete = 'off'
    keyInput.spellcheck = false
    const keyNote = el('p', 'dialog-note')
    const removeKey = el('button', 'link-button', l('Kayıtlı anahtarı sil', 'Remove stored key'))
    removeKey.type = 'button'
    const addKey = el('button', undefined, l('Ekle', 'Add'))
    addKey.type = 'button'
    addKey.title = l('Anahtarı kaydet; sağlayıcı hızlı model seçiciye eklenir', 'Save the key; the provider is added to the quick model picker')
    const configuredList = el('div', 'agent-provider-chips')

    // ChatGPT aboneliği (Codex) API anahtarı yerine tarayıcıdan giriş ister
    const accountNote = el('p', 'dialog-note')
    const accountRow = el('div', 'agent-key-row')
    const signIn = el('button', undefined, l('ChatGPT ile giriş yap', 'Sign in with ChatGPT'))
    signIn.type = 'button'
    const signOut = el('button', 'link-button', l('Çıkış yap', 'Sign out'))
    signOut.type = 'button'

    const provider = () => providers.find((p) => p.id === providerSelect.value)
    const model = () => provider()?.models.find((m) => m.id === modelSelect.value)

    const fillModels = () => {
      const query = modelFilter.value.trim().toLowerCase()
      const previous = modelSelect.value
      const models = (provider()?.models ?? []).filter(
        (m) => !query || m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
      )
      modelSelect.replaceChildren(...models.map((m) => new Option(modelLabel(m), m.id)))
      const wanted = provider()?.id === settings.providerId ? settings.modelId : null
      modelSelect.value = [previous, wanted].find((id) => id && models.some((m) => m.id === id)) ?? models[0]?.id ?? ''
      fillModelDetails()
    }

    const fillModelDetails = () => {
      const m = model()
      modelInfo.textContent = m ? modelDetails(m) : l('Bu sağlayıcıda eşleşen model yok.', 'No matching models for this provider.')
      const levels = m?.effortLevels ?? []
      effortRow.hidden = levels.length === 0
      const previous = effortSelect.value || settings.effort || ''
      effortSelect.replaceChildren(new Option(l('Varsayılan', 'Default'), ''), ...levels.map((level) => new Option(level, level)))
      effortSelect.value = levels.includes(previous) ? previous : ''
    }

    /** Anahtarı olan sağlayıcılar; tıklayınca o sağlayıcı seçilir. */
    const fillConfigured = () => {
      const ids = new Set(this.state!.configuredProviders)
      const configured = providers.filter((p) => ids.has(p.id))
      configuredList.replaceChildren(
        ...configured.map((p) => {
          const chip = el('button', 'agent-provider-chip', p.name)
          chip.type = 'button'
          chip.classList.toggle('selected', p.id === providerSelect.value)
          chip.addEventListener('click', () => {
            providerSelect.value = p.id
            providerSelect.dispatchEvent(new Event('change'))
          })
          return chip
        })
      )
      if (configured.length === 0) {
        configuredList.append(el('span', 'agent-model-info', l('Henüz yok; aşağıdan sağlayıcı seçip anahtarını ekle.', 'None yet; pick a provider below and add its key.')))
      }
    }

    /** ChatGPT oturumunun durumu; abonelik sağlayıcısı seçiliyken anahtar alanının yerini alır. */
    const fillAccount = () => {
      const account = this.state!.codex
      accountRow.replaceChildren()
      if (account.signedIn) {
        accountNote.textContent = l(
          `${[account.email, account.plan].filter(Boolean).join(' · ') || 'ChatGPT'} — abonelik kullanılıyor; API anahtarı gerekmez.`,
          `${[account.email, account.plan].filter(Boolean).join(' · ') || 'ChatGPT'} — using the subscription; no API key needed.`
        )
        accountRow.append(signOut)
        return
      }
      accountNote.textContent = l(
        'GPT aboneliğini burada kullanmak için ChatGPT hesabınla giriş yap; tarayıcıda OpenAI oturumu açılır.',
        'Sign in with your ChatGPT account to use your GPT subscription here; OpenAI opens in your browser.'
      )
      accountRow.append(signIn)
    }

    /** Abonelik sağlayıcısında API anahtarı alanı yerine hesap alanı gösterilir. */
    const fillAuthMode = () => {
      const subscription = provider()?.login === 'chatgpt'
      keyField.hidden = subscription
      accountField.hidden = !subscription
      if (subscription) fillAccount()
    }

    const fillKey = async () => {
      const p = provider()
      if (!p) return
      fillAuthMode()
      const source: ApiKeySource = await api.agentKeySource(p.id)
      if (providerSelect.value !== p.id) return
      keyInput.value = ''
      keyInput.placeholder =
        source === 'stored' ? l('•••••• (kayıtlı; değiştirmek için yaz)', '•••••• (stored; type to replace)') : l('API anahtarı', 'API key')
      removeKey.hidden = source !== 'stored'
      const env = p.env.length ? p.env.join(', ') : null
      keyNote.textContent =
        source === 'env'
          ? l(`Anahtar ortam değişkeninden okunuyor (${env}).`, `The key is read from an environment variable (${env}).`)
          : !this.state!.encryptionAvailable
            ? l(`Bu sistemde anahtar şifrelenemiyor; ${env ?? 'ortam değişkeni'} ile ver.`, `Keys cannot be encrypted on this system; provide it with ${env ?? 'an environment variable'}.`)
            : l(
                `Anahtar bu bilgisayarda işletim sisteminin şifreleme deposuyla saklanır${env ? ` (alternatif: ${env})` : ''}.`,
                `The key is stored on this computer with the operating system's encryption${env ? ` (alternative: ${env})` : ''}.`
              )
    }

    /** Anahtar değişince listeyi, anahtar alanını ve hızlı seçiciyi yeniler. */
    const afterKeyChange = (next: AgentState) => {
      this.state = next
      fillConfigured()
      this.renderModelButton()
      return fillKey()
    }

    providerSelect.addEventListener('change', () => {
      modelFilter.value = ''
      fillModels()
      fillConfigured()
      void fillKey()
    })
    modelFilter.addEventListener('input', fillModels)
    modelSelect.addEventListener('change', fillModelDetails)
    removeKey.addEventListener('click', () => {
      void api.agentSetApiKey(providerSelect.value, null).then(afterKeyChange)
    })
    addKey.addEventListener('click', () => {
      const key = keyInput.value.trim()
      if (!key) {
        keyInput.focus()
        return
      }
      addKey.disabled = true
      error.hidden = true
      api
        .agentSetApiKey(providerSelect.value, key)
        .then(afterKeyChange, (e: Error) => {
          error.textContent = e.message
          error.hidden = false
        })
        .finally(() => (addKey.disabled = false))
    })
    keyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        addKey.click()
      }
    })

    /** Giriş/çıkıştan sonra model listesi de değişebilir: kataloğu tazeleyip pencereyi yeniden kurar. */
    const afterAccountChange = async (next: AgentState, selected: string) => {
      this.state = next
      this.providers = await api.agentListProviders().catch(() => this.providers ?? [])
      this.renderModelButton()
      this.renderSettings(this.providers ?? [], selected)
    }
    signIn.addEventListener('click', () => {
      signIn.disabled = true
      error.hidden = true
      accountNote.textContent = l(
        'Tarayıcıda ChatGPT girişi açıldı; giriş bitince bu pencere kendini yeniler…',
        'ChatGPT sign-in opened in your browser; this dialog refreshes itself when it finishes…'
      )
      api.agentCodexLogin().then(
        // Girişten sonra abonelik sağlayıcısı seçili gelir: model listesi tazelenmiş olur
        (next) => void afterAccountChange(next, CODEX_PROVIDER_ID),
        (e: Error) => {
          signIn.disabled = false
          error.textContent = e.message
          error.hidden = false
          fillAccount()
        }
      )
    })
    signOut.addEventListener('click', () => {
      signOut.disabled = true
      const selected = providerSelect.value
      api.agentCodexLogout().then(
        (next) => void afterAccountChange(next, selected),
        (e: Error) => {
          signOut.disabled = false
          error.textContent = e.message
          error.hidden = false
        }
      )
    })

    const refresh = el('button', 'link-button', l('Kataloğu yenile', 'Refresh catalog'))
    refresh.type = 'button'
    refresh.addEventListener('click', () => {
      refresh.disabled = true
      api.agentListProviders(true).then(
        (fresh) => {
          this.providers = fresh
          this.renderSettings(fresh, providerSelect.value)
        },
        (error: Error) => {
          refresh.disabled = false
          keyNote.textContent = error.message
        }
      )
    })

    const error = el('p', 'dialog-note error')
    error.hidden = true
    const actions = el('div', 'dialog-actions')
    const cancel = el('button', undefined, l('Vazgeç', 'Cancel'))
    cancel.value = 'cancel'
    cancel.formNoValidate = true
    const save = el('button', 'primary', l('Kaydet', 'Save'))
    save.type = 'button'
    actions.append(refresh, el('span', 'spacer'), cancel, save)

    save.addEventListener('click', () => {
      const p = provider()
      const m = model()
      if (!p || !m) return
      if (p.login === 'chatgpt' && !this.state!.codex.signedIn) {
        error.textContent = l('Önce ChatGPT hesabıyla giriş yap.', 'Sign in with your ChatGPT account first.')
        error.hidden = false
        return
      }
      save.disabled = true
      void (async () => {
        try {
          if (p.login !== 'chatgpt' && keyInput.value.trim()) await api.agentSetApiKey(p.id, keyInput.value)
          this.state = await api.agentSetSettings({
            providerId: p.id,
            modelId: m.id,
            effort: effortSelect.value || null,
            permissionMode: permissionSelect.value as PermissionMode
          })
          this.renderModelButton()
          dialog.close()
          this.ui.input.focus()
        } catch (e) {
          error.textContent = (e as Error).message
          error.hidden = false
          save.disabled = false
        }
      })()
    })

    const keyRow = el('div', 'agent-key-row')
    keyRow.append(keyInput, addKey, removeKey)
    const keyField = field(l('API anahtarı', 'API key'), keyRow, keyNote)
    const accountField = field(l('ChatGPT hesabı', 'ChatGPT account'), accountRow, accountNote)
    form.append(
      el('h2', undefined, l('Agent Ayarları', 'Agent Settings')),
      el('p', 'dialog-note', l('Modeller models.dev kataloğundan gelir; yalnızca tool kullanabilen modeller listelenir.', 'Models come from the models.dev catalog; only models that support tool use are listed.')),
      field(l('Eklenen sağlayıcılar', 'Added providers'), configuredList),
      field(l('Sağlayıcı', 'Provider'), providerSelect),
      field(l('Model', 'Model'), modelFilter, modelSelect, modelInfo),
      effortRow,
      field(l('İzin modu (varsayılan)', 'Permission mode (default)'), permissionSelect, permissionInfo),
      keyField,
      accountField,
      error,
      actions
    )
    dialog.replaceChildren(form)
    fillModels()
    fillConfigured()
    void fillKey()
    modelSelect.focus()
  }
}

function permissionLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'always-ask':
      return l('Her zaman sor', 'Always Ask')
    case 'ask-when-needed':
      return l('Gerektiğinde sor', 'Ask When Needed')
    case 'never-ask':
      return l('Hiç sorma', 'Never Ask')
  }
}

function permissionDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'always-ask':
      return l('Okuma dahil her tool çağrısı onay ister.', 'Every tool call, including reads, asks for approval.')
    case 'ask-when-needed':
      return l('Yalnızca dosya değiştiren işlemler onay ister; okuma ve arama onaysız çalışır.', 'Only actions that change files ask for approval; reads and searches run freely.')
    case 'never-ask':
      return l('Hiçbir işlem onay istemez; dosya değişiklikleri doğrudan uygulanır.', 'Nothing asks for approval; file changes are applied directly.')
  }
}

function field(label: string, ...controls: HTMLElement[]): HTMLElement {
  const wrapper = el('label', 'agent-field')
  wrapper.append(el('span', 'agent-field-label', label), ...controls)
  return wrapper
}

/** Farklı sağlayıcılardaki aynı adlı modeller karışmasın diye ad sağlayıcıyla birlikte gösterilir. */
function modelDisplayName(modelName: string, providerName: string): string {
  return `${modelName} (${providerName})`
}

/** Hızlı seçicide sağlayıcı ve modeli tek değerde taşır; sağlayıcı kimliklerinde `:` yok, model kimliklerinde olabilir. */
function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const i = key.indexOf(':')
  return i > 0 ? { providerId: key.slice(0, i), modelId: key.slice(i + 1) } : null
}

function currentModelKey(settings: AgentState['settings'] | undefined): string {
  return settings?.providerId && settings.modelId ? modelKey(settings.providerId, settings.modelId) : ''
}

/** Önbelleği etkileyen ayarlar: biri değişirse konuşma önbellekten okunamaz. */
function cacheKey(settings: AgentState['settings']): string {
  return `${currentModelKey(settings)}|${settings.effort ?? ''}`
}

function modelLabel(model: CatalogModel): string {
  const status = model.status ? ` (${model.status})` : ''
  return `${model.name}${status}`
}

function modelDetails(model: CatalogModel): string {
  const parts = [model.id]
  if (model.contextWindow) parts.push(l(`${formatTokens(model.contextWindow)} bağlam`, `${formatTokens(model.contextWindow)} context`))
  if (model.cost) parts.push(l(`$${model.cost.input} / $${model.cost.output} (1M token girdi/çıktı)`, `$${model.cost.input} / $${model.cost.output} per 1M input/output tokens`))
  if (model.releaseDate) parts.push(model.releaseDate)
  return parts.join(' · ')
}

/**
 * `@` listesinin sıralaması: önce dosya adı sorguyla başlayanlar, sonra adında geçenler, sonra yolunda geçenler;
 * her grupta `.sk` dosyaları önde. Boş sorguda `.sk` dosyaları önde, tümü.
 */
function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = !q || name.startsWith(q) || lower.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1
    if (score >= 0) scored.push({ path, score: score * 2 + (lower.endsWith('.sk') ? 0 : 1) })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, MAX_MENTION_ITEMS)
    .map((item) => item.path)
}

/** Sayaç ilk açılışta ve konuşma sıfırlanınca boş görünür. */
const EMPTY_USAGE: AgentUsage = {
  uncached: 0,
  cached: 0,
  written: 0,
  output: 0,
  cost: 0,
  hitRate: null,
  totalHitRate: null,
  contextTokens: 0,
  contextWindow: 0,
  reBilledTokens: 0,
  reBilledCost: 0,
  reBilledCount: 0,
  byModel: []
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 10_000) return `${(count / 1000).toFixed(1)}K`
  return count.toLocaleString()
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

function formatTokens(count: number): string {
  return count >= 1_000_000 ? `${count / 1_000_000}M` : `${Math.round(count / 1000)}K`
}

/** Tool satırında gösterilen kısa argüman (dosya yolu, arama metni…). */
/** Bloktaki gösterilebilir düşünme metni (Anthropic `thinking` blokları dahil); yoksa boş. */
function reasoningText(block: ContentBlock): string {
  if (block.type === 'reasoning') return block.text
  if (block.type === 'provider_data') {
    const data = block.data as { type?: unknown; thinking?: unknown } | null
    if (data?.type === 'thinking' && typeof data.thinking === 'string') return data.thinking
  }
  return ''
}

function toolArgument(call: ToolCallBlock): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  if (typeof input.path === 'string') return input.path
  if (typeof input.query === 'string') return `"${input.query}"`
  if (call.name === 'list_dir') return '.'
  const json = JSON.stringify(call.input)
  return json.length > 60 ? `${json.slice(0, 60)}…` : json
}
