import type {
  AgentMode,
  AgentSessionInfo,
  AgentEvent,
  AgentState,
  AgentSubagentInfo,
  AgentUiEvent,
  AgentUsage,
  ApiKeySource,
  ApprovalRequest,
  CatalogModel,
  CatalogProvider,
  ContentBlock,
  ImageBlock,
  Message,
  PermissionMode,
  ProblemReport,
  ToolCallBlock,
  ToolResultBlock,
  Todo
} from '../../shared/ipc'
import { api } from './api'
import { monaco } from './monaco'

import {
  CONVERSATION_MENTION_PREFIX,
  conversationMention,
  formatMention,
  isProblemsMention,
  parseAttachment,
  parseMentions
} from '@skript-ide/agent/src/mentions'
import { isEditorContext, type EditorContext } from '@skript-ide/agent/src/editor-context'
import { isConversationSummary } from '@skript-ide/agent/src/compaction'
import { parseGoal } from '@skript-ide/agent/src/goal'
import { parseProjectInstructions } from '@skript-ide/agent/src/project-memory'
import { parseMemory } from '@skript-ide/agent/src/memory'
import { PERMISSION_MODES } from '@skript-ide/agent/src/permission'
import { AGENT_MODES } from '@skript-ide/agent/src/mode'
import { changesDiffStat, type DiffStat } from '@skript-ide/agent/src/diff-stat'
import { CODEX_PROVIDER_ID } from '@skript-ide/agent/src/codex-catalog'
import { TpsMeter } from './tps-meter'
import {
  imageDataUrl,
  IMAGE_MEDIA_TYPES,
  isImageMediaType,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGES_PER_MESSAGE
} from '@skript-ide/agent/src/messages'
import { l } from '@skript-ide/i18n'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Değişiklik miktarı: yeşil `+eklenen`, kırmızı `-silinen` satır. */
function diffStatBadge({ added, removed }: DiffStat): HTMLElement {
  const badge = el('span', 'agent-diff-stat')
  badge.title = l(`${added} satır eklendi, ${removed} satır silindi`, `${added} lines added, ${removed} lines removed`)
  badge.append(el('span', 'added', `+${added}`), el('span', 'removed', `-${removed}`))
  return badge
}

/** Görselin uzun kenarı bundan büyükse küçültülür; sağlayıcılar daha büyüğünü zaten küçültüp sayar. */
const MAX_IMAGE_SIDE = 1568

/**
 * Görseli modele gidecek biçime getirir: desteklenmeyen tür, büyük boyut ya da sınırı aşan dosya
 * tuvalde yeniden çizilir (önce PNG, sığmazsa JPEG). Uygunsa olduğu gibi gönderilir (GIF animasyonu korunur).
 */
async function prepareImage(file: Blob): Promise<ImageBlock> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && isImageMediaType(file.type)) {
      const data = await blobBase64(file)
      if (data.length <= MAX_IMAGE_BASE64_LENGTH) return { type: 'image', mediaType: file.type, data }
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const [mediaType, quality] of [['image/png', undefined], ['image/jpeg', 0.85], ['image/jpeg', 0.6]] as const) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, quality))
      if (!blob) continue
      const data = await blobBase64(blob)
      if (data.length <= MAX_IMAGE_BASE64_LENGTH) return { type: 'image', mediaType, data }
    }
    throw new Error(l('Görsel çok büyük.', 'The image is too large.'))
  } finally {
    bitmap.close()
  }
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader'))
    reader.readAsDataURL(blob)
  })
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
  /** Agent çalışırken de Enter ile gönderilebilir (diğer komutlar turun bitmesini bekler). */
  whileRunning?: boolean
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
/** `@` listesinde dosyalardan önce önerilen en fazla konuşma (`@chat:` yazılmadıkça). */
const MAX_CONVERSATION_SUGGESTIONS = 3

export interface AgentPanelElements {
  panel: HTMLElement
  modelButton: HTMLButtonElement
  modelSelect: HTMLSelectElement
  effortSelect: HTMLSelectElement
  permissionSelect: HTMLSelectElement
  modeSelect: HTMLSelectElement
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
  /** Etkin sekme, imleç ve seçim; açık belge yoksa `null`. */
  editorContext(): EditorContext | null
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
  /** `@chat:` etiketi için kayıtlı konuşmalar; menü açılınca yenilenir. */
  private savedSessions: AgentSessionInfo[] = []
  private filesRequest = 0
  /** Menü şu an bir `@` etiketini tamamlıyor; liste bu süre boyunca bir kez istenir. */
  private mentionActive = false
  private readonly usageEl = el('div', 'agent-usage')
  /** Durum yazısının yanındaki üretim hızı (token/saniye). */
  private readonly tps = new TpsMeter(el('span', 'agent-tps'))
  /** Agent'ın `update_todos` planı; sohbetin üstünde kompakt bir liste. */
  private readonly todoList = el('div', 'agent-todos')
  /** Bir sonraki mesajla gidecek görseller (yapıştırma, sürükleme ya da dosya seçimiyle eklenir). */
  private pendingImages: ImageBlock[] = []
  private readonly imageStrip = el('div', 'agent-image-strip')
  private btwSeq = 0
  /** Açık `/btw` kutuları: soru kimliği → kutu ve yanıtın aktığı gövde. */
  private readonly btwBoxes = new Map<number, { box: HTMLElement; body: HTMLElement; streamed: boolean }>()
  /** Turu arka planda süren diğer konuşmalar; geçmiş düğmesinde sayısı görünür. */
  private readonly backgroundRuns = new Set<string>()
  /** Açık konuşmanın alt agent'ları: `run_subagent` çağrı kimliği → son durum ve transkriptteki kartı. */
  private readonly subagents = new Map<string, AgentSubagentInfo>()
  private readonly subagentCards = new Map<string, HTMLElement>()
  /** `/subagent` listelerindeki satırlar: alt agent'ın durumu değiştikçe kartlarla birlikte güncellenir. */
  private readonly subagentRows = new Map<string, HTMLElement[]>()
  /** Girişin asıl ipucu; alt agent konuşmasında yerine başka bir yazı gösterilir. */
  private inputPlaceholder = ''

  constructor(
    private readonly ui: AgentPanelElements,
    private readonly hooks: AgentPanelHooks
  ) {
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (this.running) void api.agentCancel()
      else this.submit()
    })
    this.inputPlaceholder = ui.input.placeholder
    ui.status.before(this.usageEl)
    ui.status.after(this.tps.element)
    this.tps.element.title = l(
      'Üretim hızı: akarken tahmini anlık değer, çağrı bitince kesin ortalama',
      'Generation speed: live estimate while streaming, exact average once the call finishes'
    )
    this.renderUsage(null)
    this.todoList.hidden = true
    ui.form.before(this.todoList)
    this.menu.hidden = true
    ui.form.insertBefore(this.menu, ui.input)
    this.setupImageInput()
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
        if (!this.running || this.typedCommand()?.whileRunning) this.submit()
      }
      // Esc en son açılan `/btw` kutusunu kapatır
      if (event.key === 'Escape' && this.btwBoxes.size > 0) {
        event.preventDefault()
        this.closeBtw([...this.btwBoxes.keys()].at(-1)!)
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
    ui.modeSelect.replaceChildren(...AGENT_MODES.map((mode) => new Option(modeLabel(mode), mode)))
    ui.modeSelect.addEventListener('change', () => void this.onModeChange())
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
        item.title = option.text
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

  private async onModeChange(): Promise<void> {
    try {
      this.state = await api.agentSetAgentMode(this.ui.modeSelect.value as AgentMode)
    } catch (error) {
      this.renderNote((error as Error).message, 'error')
    }
    this.renderModeSelect()
  }

  /** Mod sistem istemini belirler; önbellek bozulmasın diye konuşma başlayınca kilitlenir. */
  private renderModeSelect(): void {
    const { modeSelect } = this.ui
    const mode = this.state?.agentMode ?? 'standard'
    const locked = (this.state?.messages.length ?? 0) > 0
    modeSelect.value = mode
    modeSelect.disabled = locked
    modeSelect.title =
      `${l('Agent modu', 'Agent mode')}: ${modeDescription(mode)}` +
      (locked ? l('\nModu değiştirmek için yeni konuşma başlat.', '\nStart a new conversation to change the mode.') : '')
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
    this.renderModeSelect()
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
    const previous = this.state
    this.state = await api.agentGetState()
    if (previous && previous.sessionId !== this.state.sessionId) this.switchedFrom(previous)
    if (rebuild) this.tps.clear()
    this.setRunning(this.state.running)
    this.renderTodos(this.state.todos)
    if (rebuild) {
      this.clearTranscript()
      for (const info of this.state.subagents) this.subagents.set(info.callId, info)
      if (this.state.parent) this.append(this.subagentBanner(this.state))
      for (const message of this.state.messages) this.renderMessage(message)
      if (this.state.messages.length === 0) this.renderEmpty()
      if (this.state.running) this.resumeRun(this.state)
    }
    this.renderUsage(this.state.usage)
    this.renderModelButton()
  }

  /** Başka konuşmaya geçildi: eskisinin turu sürüyorsa arka planda sayılır, yenisi artık arka planda değil. */
  private switchedFrom(previous: AgentState): void {
    if (previous.sessionId && this.running) this.backgroundRuns.add(previous.sessionId)
    if (this.state?.sessionId) this.backgroundRuns.delete(this.state.sessionId)
    this.renderBackgroundRuns()
  }

  /** Turu süren konuşmaya dönüldü: akmakta olan yanıt, çalışan tool'lar ve bekleyen onaylar yeniden çizilir. */
  private resumeRun(state: AgentState): void {
    const answered = new Set(
      state.messages.flatMap((message) => message.content.flatMap((block) => (block.type === 'tool_result' ? [block.callId] : [])))
    )
    for (const [id, row] of this.toolRows) if (!answered.has(id)) row.classList.add('running')
    if (state.streaming?.reasoning) this.renderDelta('reasoning', state.streaming.reasoning)
    if (state.streaming?.text) this.renderDelta('text', state.streaming.text)
    for (const approval of state.approvals ?? []) this.renderApproval(approval.id, approval.request)
  }

  private renderBackgroundRuns(): void {
    const count = this.backgroundRuns.size
    const button = this.ui.historyButton
    button.classList.toggle('has-background', count > 0)
    button.dataset.count = count > 0 ? String(count) : ''
    button.title =
      count > 0
        ? l(`Konuşma geçmişi · ${count} konuşma arka planda çalışıyor`, `Conversation history · ${count} running in the background`)
        : l('Konuşma geçmişi', 'Conversation history')
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
    this.usageEl.replaceChildren(...this.usageRows(usage ?? EMPTY_USAGE))
  }

  /** Sayaç satırları; alt agent kartı da aynısını kullanır. */
  private usageRows(u: AgentUsage): HTMLElement[] {
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
    return [
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
    ]
  }

  // --- Alt agent'lar ---

  /** Alt agent konuşması yalnızca izlenir: giriş kapalı, ana konuşmaya dönüş düğmesi bannerda. */
  private renderSubagentMode(): void {
    const readOnly = this.state?.parent != null
    this.ui.input.disabled = readOnly
    this.ui.input.placeholder = readOnly
      ? l('Alt agent konuşması yalnızca izlenebilir.', 'Subagent conversations are read-only.')
      : this.inputPlaceholder
    this.ui.sendButton.disabled = readOnly && !this.running
  }

  private subagentBanner(state: AgentState): HTMLElement {
    const banner = el('div', 'agent-subagent-banner')
    const back = el('button', 'agent-subagent-open', l('← Ana konuşmaya dön', '← Back to main conversation'))
    back.type = 'button'
    const parentId = state.parent!.id
    back.addEventListener('click', () => void this.openSession(parentId))
    const model = state.subagentModel
    const provider = model && this.providers?.find((p) => p.id === model.providerId)
    const modelName = model ? (provider?.models.find((m) => m.id === model.modelId)?.name ?? model.modelId) : ''
    banner.append(
      el('span', 'agent-subagent-tag', l('Alt agent', 'Subagent')),
      el('span', 'agent-subagent-title', state.parent!.title),
      el('span', 'agent-muted', [modelName, model?.effort ? `effort ${model.effort}` : ''].filter(Boolean).join(' · ')),
      back
    )
    return banner
  }

  private async openSession(id: string): Promise<void> {
    try {
      await api.agentLoadSession(id)
      await this.refreshState(true)
    } catch (error) {
      this.renderNote((error as Error).message, 'error')
    }
  }

  /** `run_subagent` satırının altındaki kart: model, durum, kullanım ve oturumu açma düğmesi. */
  private subagentCard(callId: string): HTMLElement {
    const card = el('div', 'agent-subagent')
    this.subagentCards.set(callId, card)
    this.renderSubagentCard(callId)
    return card
  }

  private renderSubagentCard(callId: string): void {
    const card = this.subagentCards.get(callId)
    if (!card) return
    const info = this.subagents.get(callId)
    // Alt agent başlamadan (model bulunamadı vb.) biten çağrının kartı yok
    card.hidden = !info
    if (!info) return
    card.className = `agent-subagent ${info.status}`
    const usage = el('div', 'agent-usage')
    usage.append(...this.usageRows(info.usage))
    card.replaceChildren(this.subagentHead(info), usage)
  }

  /** Alt agent kartının başlık satırı: durum, başlık, model ve oturumu açma düğmesi. */
  private subagentHead(info: AgentSubagentInfo): HTMLElement {
    const status = {
      running: l('çalışıyor', 'running'),
      done: l('bitti', 'done'),
      error: l('hata', 'error'),
      cancelled: l('durduruldu', 'stopped')
    }[info.status]
    const open = el('button', 'agent-subagent-open', l('Oturumu aç →', 'Open session →'))
    open.type = 'button'
    open.addEventListener('click', () => void this.openSession(info.sessionId))
    const head = el('div', 'agent-subagent-head')
    head.append(
      el('span', 'agent-subagent-status', status),
      el('span', 'agent-subagent-title', info.title),
      el(
        'span',
        'agent-muted',
        [info.modelName, info.effort ? `effort ${info.effort}` : '', l(`${info.toolCalls} tool`, `${info.toolCalls} tools`)]
          .filter(Boolean)
          .join(' · ')
      ),
      open
    )
    return head
  }

  private renderSubagentRow(row: HTMLElement, info: AgentSubagentInfo): void {
    row.className = `agent-subagent ${info.status}`
    row.replaceChildren(this.subagentHead(info))
  }

  /** `/subagent`: açık konuşmanın çalışan alt agent'larını (`all` ile hepsini) listeler. */
  private listSubagents(arg: string): void {
    const all = arg.toLowerCase() === 'all'
    if (arg && !all) {
      this.renderNote(l('Kullanım: /subagent [all]', 'Usage: /subagent [all]'))
      return
    }
    const infos = [...this.subagents.values()]
    const shown = all ? infos : infos.filter((info) => info.status === 'running')
    const finished = infos.length - infos.filter((info) => info.status === 'running').length
    if (shown.length === 0) {
      const hint = !all && finished > 0 ? l(` Bitenler için /subagent all (${finished}).`, ` Use /subagent all for finished ones (${finished}).`) : ''
      this.renderNote(
        all ? l('Bu konuşmada alt agent yok.', 'No subagents in this conversation.') : l(`Çalışan alt agent yok.${hint}`, `No subagents are running.${hint}`)
      )
      return
    }
    const list = el('div', 'agent-subagent-list')
    const title = all
      ? l(`Alt agent'lar (${shown.length})`, `Subagents (${shown.length})`)
      : l(`Çalışan alt agent'lar (${shown.length})`, `Running subagents (${shown.length})`)
    list.append(el('div', 'agent-subagent-list-title', title))
    for (const info of shown) {
      const row = el('div')
      this.subagentRows.set(info.callId, [...(this.subagentRows.get(info.callId) ?? []), row])
      list.append(row)
      this.renderSubagentRow(row, info)
    }
    if (!all && finished > 0) {
      list.append(el('div', 'agent-muted', l(`${finished} biten alt agent için /subagent all.`, `/subagent all shows ${finished} finished.`)))
    }
    this.append(list)
  }

  /** Plan listesi: madde durumuna göre işaret; liste boşsa gizlenir. */
  private renderTodos(todos: readonly Todo[]): void {
    this.todoList.hidden = todos.length === 0
    this.todoList.replaceChildren(
      ...todos.map((todo) => {
        const row = el('div', `agent-todo ${todo.status}`)
        const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : '○'
        row.append(el('span', 'agent-todo-mark', mark), el('span', 'agent-todo-text', todo.content))
        return row
      })
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
    if (running && !this.running) this.tps.start(this.state?.usage.output ?? null)
    else if (!running) this.tps.stop()
    this.running = running
    this.ui.sendButton.textContent = running ? l('Durdur', 'Stop') : l('Gönder', 'Send')
    this.ui.sendButton.classList.toggle('stop', running)
    this.ui.status.textContent = running ? l('Çalışıyor…', 'Working…') : ''
    this.ui.panel.classList.toggle('running', running)
    this.renderSubagentMode()
  }

  // --- Görseller ---

  private setupImageInput(): void {
    const { ui } = this
    this.imageStrip.hidden = true
    ui.form.insertBefore(this.imageStrip, ui.input)
    const picker = el('input')
    picker.type = 'file'
    picker.accept = IMAGE_MEDIA_TYPES.join(',')
    picker.multiple = true
    picker.hidden = true
    picker.addEventListener('change', () => {
      void this.addImages([...(picker.files ?? [])])
      picker.value = ''
    })
    const attach = el('button', 'agent-attach', '🖼')
    attach.type = 'button'
    attach.title = l('Görsel ekle (yapıştırarak ya da sürükleyerek de eklenebilir)', 'Attach an image (you can also paste or drop one)')
    attach.addEventListener('click', () => picker.click())
    ui.status.before(attach, picker)
    ui.input.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
      if (files.length === 0) return
      event.preventDefault()
      void this.addImages(files)
    })
    ui.form.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      ui.form.classList.add('dragging')
    })
    ui.form.addEventListener('dragleave', () => ui.form.classList.remove('dragging'))
    ui.form.addEventListener('drop', (event) => {
      ui.form.classList.remove('dragging')
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'))
      if (files.length === 0) return
      event.preventDefault()
      void this.addImages(files)
    })
  }

  private async addImages(files: File[]): Promise<void> {
    for (const file of files) {
      if (this.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        this.renderNote(
          l(`Bir mesaja en fazla ${MAX_IMAGES_PER_MESSAGE} görsel eklenebilir.`, `At most ${MAX_IMAGES_PER_MESSAGE} images per message.`),
          'error'
        )
        break
      }
      try {
        this.pendingImages.push(await prepareImage(file))
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        this.renderNote(l(`Görsel eklenemedi: ${file.name} ${reason}`, `Could not attach image: ${file.name} ${reason}`).trim(), 'error')
      }
    }
    this.renderImageStrip()
    this.ui.input.focus()
  }

  private setPendingImages(images: ImageBlock[]): void {
    this.pendingImages = images
    this.renderImageStrip()
  }

  private renderImageStrip(): void {
    this.imageStrip.hidden = this.pendingImages.length === 0
    this.imageStrip.replaceChildren(
      ...this.pendingImages.map((image, index) => {
        const item = el('div', 'agent-image-thumb')
        const img = el('img')
        img.src = imageDataUrl(image)
        const remove = el('button', undefined, '✕')
        remove.type = 'button'
        remove.title = l('Görseli kaldır', 'Remove image')
        remove.addEventListener('click', () => {
          this.pendingImages.splice(index, 1)
          this.renderImageStrip()
        })
        item.append(img, remove)
        return item
      })
    )
  }

  // --- Gönderme ---

  private submit(): void {
    const text = this.ui.input.value.trim()
    if (!text && this.pendingImages.length === 0) return
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
    const images = this.pendingImages
    this.ui.input.value = ''
    this.setPendingImages([])
    this.setRunning(true)
    const problems = parseMentions(text).some(isProblemsMention) ? this.hooks.problems() : undefined
    api.agentSend(text, problems, this.hooks.editorContext(), images).catch((error: Error) => {
      // Başlamadan reddedildi (model seçilmemiş, anahtar yok, model görsel almıyor…): metni ve görselleri geri koy
      this.setRunning(false)
      this.ui.input.value = text
      this.setPendingImages(images)
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
        name: 'btw',
        args: l('<soru>', '<question>'),
        description: l(
          'Konuşmayı bölmeden hızlı bir yan soru sorar; yanıt geçmişe eklenmez, agent çalışırken de kullanılabilir',
          'Asks a quick side question without interrupting; the answer is not added to the history and works while the agent is running'
        ),
        whileRunning: true,
        run: (arg) => this.btw(arg)
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
        name: 'compact',
        description: l(
          'Konuşmanın eski kısmını özetleyerek bağlamı hemen küçültür; önceki turlar artık geri alınamaz',
          'Compacts the older part of the conversation into a summary; earlier turns can no longer be undone'
        ),
        run: () => this.compact()
      },
      {
        name: 'subagent',
        aliases: ['subagents'],
        args: '[all]',
        description: l(
          'Bu konuşmada çalışan alt agent’ları listeler; all ile bitenleri de gösterir',
          'Lists the subagents running in this conversation; all also shows finished ones'
        ),
        whileRunning: true,
        run: (arg) => this.listSubagents(arg)
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

  /** Girişte yazılı olan slash komutu; yoksa `undefined`. */
  private typedCommand(): SlashCommand | undefined {
    const match = /^\/(\S+)/.exec(this.ui.input.value.trim())
    return match ? this.findCommand(match[1]) : undefined
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
    // `@chat:` yazılınca yalnızca konuşmalar; aksi halde başlığı eşleşen birkaç konuşma dosyalardan önce
    const chatOnly = !mention[1] && query.startsWith(CONVERSATION_MENTION_PREFIX)
    const conversationItems: MenuItem[] = mention[1]
      ? []
      : rankSessions(
          this.savedSessions.filter((session) => session.id !== this.state?.sessionId),
          chatOnly ? query.slice(CONVERSATION_MENTION_PREFIX.length) : query,
          chatOnly ? MAX_MENTION_ITEMS : MAX_CONVERSATION_SUGGESTIONS
        ).map((session) => ({
          label: `💬 ${session.title}`,
          detail: [new Date(session.updatedAt).toLocaleDateString(), l(`${session.turns} mesaj`, `${session.turns} messages`)].join(' · '),
          apply: () => insert(conversationMention(session.id))
        }))
    this.showMenu([
      ...problemsItems,
      ...conversationItems,
      ...(chatOnly
        ? []
        : rankFiles(this.projectFiles, mention[2]).map((path) => ({ label: path, apply: () => insert(formatMention(path)) })))
    ])
  }

  /** Proje dosyalarını ve kayıtlı konuşmaları ana süreçten ister; yanıt geldiğinde menü hâlâ açıksa günceller. */
  private async loadProjectFiles(): Promise<void> {
    const request = ++this.filesRequest
    const [files, sessions] = await Promise.all([
      api.agentListFiles().catch(() => []),
      api.agentListSessions().catch(() => [])
    ])
    if (request !== this.filesRequest) return
    this.projectFiles = files
    this.savedSessions = sessions
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
    this.setPendingImages(result.images)
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

  /** `/compact`: geçmişin eski kısmını hemen özetletir; önceki turların /undo noktaları geçersizleşir. */
  private async compact(): Promise<void> {
    if (!this.state?.messages.length) {
      this.renderNote(l('Sıkıştırılacak konuşma yok.', 'There is no conversation to compact.'))
      return
    }
    this.renderNote(l('Konuşma sıkıştırılıyor…', 'Compacting the conversation…'))
    const result = await api.agentCompact()
    this.state = result.state
    await this.refreshState(true)
    if (result.summarizedMessages === 0) {
      this.renderNote(l('Özetlenecek eski mesaj yok.', 'There are no older messages to summarize.'))
      return
    }
    this.renderNote(
      l(
        `Konuşma sıkıştırıldı: ${result.summarizedMessages} eski mesaj özetlendi. Bu turdan önceki adımlar artık /undo ile geri alınamaz.`,
        `Conversation compacted: ${result.summarizedMessages} older messages were summarized. Earlier turns can no longer be undone.`
      )
    )
  }

  /** Yan soru kutusu: yanıt akarken dolar, kapatılınca (✕ ya da Esc) istek iptal edilir ve kutu kalkar. */
  private async btw(question: string): Promise<void> {
    if (!question) {
      this.renderNote(l('Kullanım: /btw <soru>', 'Usage: /btw <question>'))
      return
    }
    this.ui.transcript.querySelector('.agent-empty')?.remove()
    const id = ++this.btwSeq
    const box = el('div', 'agent-btw')
    const head = el('div', 'agent-btw-head')
    const close = el('button', 'icon-button', '✕')
    close.type = 'button'
    close.title = l('Kapat (Esc)', 'Dismiss (Esc)')
    close.addEventListener('click', () => this.closeBtw(id))
    head.append(el('span', 'agent-btw-label', '/btw'), el('span', 'agent-btw-question', question), close)
    const body = el('div', 'agent-btw-body agent-muted', l('Yanıtlıyor…', 'Answering…'))
    box.append(head, body)
    this.btwBoxes.set(id, { box, body, streamed: false })
    this.append(box)
    try {
      const answer = await api.agentBtw(id, question)
      if (!this.btwBoxes.has(id)) return
      body.className = 'agent-btw-body'
      body.replaceChildren(...this.assistantText(answer.trim() || l('(boş yanıt)', '(empty answer)')).childNodes)
    } catch (error) {
      if (!this.btwBoxes.has(id)) return
      body.className = 'agent-btw-body agent-note error'
      body.textContent = (error as Error).message
    }
  }

  private closeBtw(id: number): void {
    const entry = this.btwBoxes.get(id)
    if (!entry) return
    this.btwBoxes.delete(id)
    entry.box.remove()
    void api.agentBtwCancel(id)
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
    // Yeni konuşma kayıtlı varsayılan izin moduna ve son seçilen agent moduna döner
    await this.refreshState()
    this.clearTranscript()
    this.renderTodos([])
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
    const status =
      session.status === 'approval'
        ? el('span', 'agent-session-status approval', l('onay bekliyor', 'awaiting approval'))
        : session.status === 'running'
          ? el('span', 'agent-session-status', l('çalışıyor', 'running'))
          : null
    const title = el('span', 'agent-session-title', session.title)
    if (status) title.prepend(status)
    open.append(
      title,
      el('span', 'agent-muted', [when, l(`${session.turns} mesaj`, `${session.turns} messages`), project].filter(Boolean).join(' · '))
    )
    open.addEventListener('click', () => {
      void api.agentLoadSession(session.id).then(
        () => {
          // Durum yeniden okunur: eski konuşmanın turu sürüyorsa arka planda sayılsın
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
        this.backgroundRuns.delete(session.id)
        this.renderBackgroundRuns()
        if (wasCurrent) {
          this.clearTranscript()
          this.renderTodos([])
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

  private handleEvent(event: AgentEvent): void {
    if (event.sessionId !== this.state?.sessionId) {
      this.handleBackgroundEvent(event)
      return
    }
    switch (event.type) {
      case 'user-message':
        this.ui.transcript.querySelector('.agent-empty')?.remove()
        // Konuşma başladı: mod artık bu konuşmaya bağlı
        this.ui.modeSelect.disabled = true
        this.renderMessage(event.message)
        break
      case 'delta':
        this.tps.delta(event.delta.text)
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
        this.renderToolResult(event.result)
        break
      case 'approval-request':
        this.renderApproval(event.id, event.request)
        break
      case 'usage':
        // `/usage` dökümü aynı nesneden okur; olay geldikçe tazelenmeli
        if (this.state) this.state.usage = event.usage
        this.renderUsage(event.usage)
        this.tps.usage(event.usage.output)
        break
      case 'cache-miss':
        this.renderCacheMiss(event)
        break
      case 'file-changed':
        this.hooks.onFileChanged(event.path)
        break
      case 'btw-delta': {
        const entry = this.btwBoxes.get(event.id)
        if (!entry) break
        if (!entry.streamed) {
          entry.streamed = true
          entry.body.className = 'agent-btw-body agent-text'
          entry.body.textContent = ''
        }
        entry.body.append(event.text)
        break
      }
      case 'context-trimmed':
        this.renderNote(
          l(
            `Bağlam dolmak üzereydi; ${event.trimmed} eski tool çıktısı modelin geçmişinden çıkarıldı.`,
            `The context was nearly full; ${event.trimmed} old tool outputs were removed from the model's history.`
          )
        )
        break
      case 'context-compacted':
        this.renderNote(
          l(
            `Bağlam sıkıştırıldı: ${event.summarizedMessages} eski mesaj özetlendi. Bu turdan önceki adımlar artık /undo ile geri alınamaz.`,
            `Conversation compacted: ${event.summarizedMessages} older messages were summarized. Earlier turns can no longer be undone.`
          )
        )
        break
      case 'todos':
        if (this.state) this.state.todos = event.todos
        this.renderTodos(event.todos)
        break
      case 'subagent':
        this.subagents.set(event.info.callId, event.info)
        this.renderSubagentCard(event.info.callId)
        for (const row of this.subagentRows.get(event.info.callId) ?? []) this.renderSubagentRow(row, event.info)
        break
      case 'done':
        this.finishLive()
        this.setRunning(false)
        this.disposeApprovals()
        if (event.reason === 'error') this.renderNote(event.error ?? l('Bilinmeyen hata', 'Unknown error'), 'error')
        else if (event.reason === 'cancelled') this.renderNote(l('Durduruldu.', 'Stopped.'))
        else if (event.reason === 'max_tokens') this.renderNote(l('Yanıt uzunluk sınırında kesildi.', 'The response was cut off at the length limit.'))
        else if (event.reason === 'context_full')
          this.renderNote(
            l(
              'Konuşma modelin bağlam penceresine sığmıyor; yeni bir konuşma başlat.',
              "The conversation no longer fits in the model's context window; start a new conversation."
            ),
            'error'
          )
        else if (event.reason === 'max_turns') this.renderNote(l('Adım sınırına ulaşıldı; devam etmesi için yeniden yaz.', 'Step limit reached; send another message to continue.'))
        else if (event.reason === 'refusal') this.renderNote(l('Model bu isteği yanıtlamayı reddetti.', 'The model declined to answer this request.'))
        break
    }
  }

  /**
   * Panelde açık olmayan konuşmanın olayı: transkripte çizilmez. Dosya değişiklikleri yine de
   * editöre yansır; onay isteği ve tur sonu kısa bir notla bildirilir.
   */
  private handleBackgroundEvent(event: AgentEvent): void {
    if (event.type === 'file-changed') this.hooks.onFileChanged(event.path)
    // Alt agent'ın ilerlemesi başlatan konuşmadaki kartında görünür; onayları da orada istenir
    if (event.parentId) return
    if (event.type === 'done') this.backgroundRuns.delete(event.sessionId)
    else this.backgroundRuns.add(event.sessionId)
    this.renderBackgroundRuns()
    if (event.type !== 'approval-request' && event.type !== 'done') return
    void api.agentListSessions().then(
      (sessions) => {
        const title = sessions.find((session) => session.id === event.sessionId)?.title ?? l('Arka plandaki konuşma', 'A background conversation')
        if (event.type === 'approval-request') {
          this.renderNote(l(`“${title}” onay bekliyor; geçmişten açıp yanıtla.`, `“${title}” is waiting for approval; open it from the history to respond.`), 'warning')
        } else if (event.reason === 'error') {
          this.renderNote(l(`“${title}” hatayla durdu: ${event.error ?? ''}`, `“${title}” stopped with an error: ${event.error ?? ''}`), 'error')
        } else if (event.reason !== 'cancelled') {
          this.renderNote(l(`“${title}” arka planda tamamlandı.`, `“${title}” finished in the background.`))
        }
      },
      () => {}
    )
  }

  // --- Konuşma görünümü ---

  private clearTranscript(): void {
    for (const id of [...this.btwBoxes.keys()]) this.closeBtw(id)
    this.disposeApprovals()
    this.toolRows.clear()
    this.subagents.clear()
    this.subagentCards.clear()
    this.subagentRows.clear()
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
      // Proje talimatları ve sıkıştırma özeti de yalnızca modele gider
      if (message.role === 'user' && block.type === 'text' && parseProjectInstructions(block.text) !== undefined) continue
      if (message.role === 'user' && block.type === 'text' && parseMemory(block.text) !== undefined) continue
      if (message.role === 'user' && block.type === 'text' && isConversationSummary(block.text)) continue
      // Editör bağlamı da yalnızca modele gider
      if (message.role === 'user' && block.type === 'text' && isEditorContext(block.text)) continue
      if (thought.trim()) {
        this.append(this.reasoningBox(thought, false))
      } else if (attachment) {
        this.append(this.attachmentChip(attachment.path, attachment.content, attachment.conversation?.title))
      } else if (block.type === 'text' && block.text.trim()) {
        this.append(message.role === 'user' ? this.userBubble(block.text) : this.assistantText(block.text))
      } else if (block.type === 'image') {
        this.append(this.imageBubble(block))
      } else if (block.type === 'tool_call') {
        this.append(this.toolRow(block))
        if (block.name === 'run_subagent') this.append(this.subagentCard(block.id))
      } else if (block.type === 'tool_result') {
        this.renderToolResult(block)
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

  /** Mesaja eklenen görsel; tıklanınca tam boyutta açılıp kapanır. */
  private imageBubble(image: ImageBlock): HTMLElement {
    const img = el('img', 'agent-image')
    img.src = imageDataUrl(image)
    img.addEventListener('click', () => img.classList.toggle('expanded'))
    return img
  }

  /** Mesaja eklenen dosya: kapalı bir kutu, açılınca modele giden içerik görünür. */
  private attachmentChip(path: string, content: string, conversationTitle?: string): HTMLElement {
    const box = el('details', 'agent-attachment')
    const lines = content.split('\n').length
    box.append(
      el(
        'summary',
        undefined,
        conversationTitle !== undefined
          ? `💬 ${conversationTitle}`
          : isProblemsMention(path)
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

  private renderToolResult({ callId, content, isError = false, diff }: ToolResultBlock): void {
    const row = this.toolRows.get(callId)
    if (!row) return
    row.querySelector('.agent-diff-stat')?.remove()
    if (diff) row.querySelector('summary')!.append(diffStatBadge(diff))
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
    const title = el('div', 'agent-approval-title', request.summary)
    if (request.changes?.length) title.append(diffStatBadge(changesDiffStat(request.changes)))
    card.append(title)

    const disposers: (() => void)[] = []
    const dispose = () => disposers.splice(0).forEach((fn) => fn())
    const changes = request.changes ?? []
    // Taşımada eski yolun silinmesi ayrıca gösterilmez; yeni yolun satırı taşımayı anlatır
    const movedFrom = new Set(changes.flatMap((change) => (change.movedFrom ? [change.movedFrom] : [])))
    for (const change of changes) {
      if (change.deleted && movedFrom.has(change.path)) continue
      if (changes.length > 1 || change.deleted || change.movedFrom) {
        const label = change.movedFrom
          ? `${change.movedFrom} → ${change.path}`
          : change.deleted
            ? l(`${change.path} silinecek`, `${change.path} will be deleted`)
            : change.created
              ? l(`${change.path} (yeni)`, `${change.path} (new)`)
              : change.path
        card.append(el('div', 'agent-approval-file', label))
      }
      if (this.hooks.hasUnsavedChanges(change.path)) {
        card.append(
          el(
            'div',
            'agent-approval-warning',
            l(
              '⚠ Bu dosyada kaydedilmemiş değişikliklerin var. Agent diskteki sürümü düzenler; sekme bu sürümle değişir, kendi değişikliklerini Ctrl+Z ile geri alabilirsin.',
              '⚠ This file has unsaved changes. The agent edits the version on disk; the tab is replaced with it, and Ctrl+Z brings your changes back.'
            )
          )
        )
      }
      // Silinen ve olduğu gibi taşınan dosyanın içeriği değişmez; diff gösterilmez
      if (change.deleted || change.movedFrom) continue
      const host = el('div', 'agent-diff')
      card.append(host)
      const language = this.hooks.languageForPath(change.path)
      const original = monaco.editor.createModel(change.before, language)
      const modified = monaco.editor.createModel(change.after, language)
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
      disposers.push(() => {
        diff.dispose()
        original.dispose()
        modified.dispose()
      })
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

function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case 'quick':
      return l('Hızlı', 'Quick')
    case 'standard':
      return l('Standart', 'Standard')
    case 'thorough':
      return l('Kapsamlı', 'Thorough')
  }
}

function modeDescription(mode: AgentMode): string {
  switch (mode) {
    case 'quick':
      return l(
        'İstenen küçük değişikliği en az adımla yapar; sunucu, test ve örnek araçları kapalı.',
        'Makes the requested small change in as few steps as possible; server, test and example tools are off.'
      )
    case 'standard':
      return l(
        'Değişikliği yapar, gerektiğinde doğrular.',
        'Makes the change and verifies it when needed.'
      )
    case 'thorough':
      return l(
        'Değişikliği sunucuda doğrular ve mümkünse test eder; özellik eklemez, daha çok kontrol eder.',
        'Verifies the change on the server and tests it when possible; checks more, does not add more.'
      )
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

/**
 * `@` listesindeki konuşmalar: boş sorguda en yeniler, aksi halde başlığı ya da kimliği sorguyla başlayanlar
 * önde, başlığında sorgu geçenler sonra; eşitlikte yeni olan önde.
 */
function rankSessions(sessions: AgentSessionInfo[], query: string, limit: number): AgentSessionInfo[] {
  const q = query.toLowerCase()
  const scored: { session: AgentSessionInfo; score: number }[] = []
  for (const session of sessions) {
    const title = session.title.toLowerCase()
    const score = !q || title.startsWith(q) || session.id.startsWith(q) ? 0 : title.includes(q) ? 1 : -1
    if (score >= 0) scored.push({ session, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || b.session.updatedAt - a.session.updatedAt)
    .slice(0, limit)
    .map((item) => item.session)
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
  // `run_subagent` başlığı
  if (typeof input.description === 'string') return input.description
  // `remember` / `forget` notu ve `read_conversation` kimliği
  const note = input.text ?? input.match ?? input.id
  if (typeof note === 'string') return note.length > 60 ? `${note.slice(0, 60)}…` : note
  if (call.name === 'list_dir') return '.'
  const json = JSON.stringify(call.input)
  return json.length > 60 ? `${json.slice(0, 60)}…` : json
}
