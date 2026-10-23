import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  attachedConversationText,
  conversationMentionRef,
  conversationTools,
  coreTools,
  createSkriptTools,
  addUsage,
  calculateCost,
  codexCatalogProvider,
  codexModelsUrl,
  CODEX_FALLBACK_MODELS,
  CODEX_PROVIDER_ID,
  compactMessages,
  createProvider,
  emptyUsage,
  DEFAULT_AGENT_MODE,
  DEFAULT_PERMISSION_MODE,
  estimateContextTokens,
  estimateTextTokens,
  fetchCatalog,
  EDITOR_CONTEXT_INSTRUCTIONS,
  GEOMETRY_INSTRUCTIONS,
  geometryTools,
  editorContextText,
  GOAL_INSTRUCTIONS,
  goalUpdate,
  PROJECT_MEMORY_INSTRUCTIONS,
  SKRIPT_GUIDE,
  SUBAGENT_TOOL_NAMES,
  subagentTools,
  todoTool,
  isAgentMode,
  isConversationSummary,
  isEditorContext,
  isPermissionMode,
  isProblemsMention,
  latestTodos,
  listProjectFiles,
  loadMemory,
  loadProjectMemory,
  MEMORY_INSTRUCTIONS,
  memoryTools,
  memoryUpdate,
  modeInstructions,
  needsRefresh,
  parseAttachment,
  parseCodexModels,
  parseEditorContextInput,
  parseGoal,
  parseImageInput,
  parseMemory,
  parseMentions,
  parseProjectInstructions,
  problemsAttachmentText,
  projectMemoryUpdate,
  promptTokens,
  ProviderError,
  readMentions,
  refreshTokens,
  resolveConversation,
  runAgent,
  scanCacheMisses,
  SCOPE_INSTRUCTIONS,
  textMessage,
  toolAllowedInMode,
  ToolError,
  ToolRegistry,
  toolCalls,
  type AgentMode,
  type ApprovalRequest,
  type EditorContext,
  type FileChange,
  type ImageBlock,
  type CallUsage,
  type CatalogModel,
  type CatalogProvider,
  type CodexTokens,
  type ConversationArchive,
  type Message,
  type PermissionMode,
  type PriceRates,
  type ProblemReport,
  type SubagentModel,
  type SubagentRequest,
  type ToolContext,
  type TokenUsage,
  type ToolResultBlock,
  type UsageCost
} from '@skript-ide/agent'
import { l } from '@skript-ide/i18n'
import { SkriptLanguageService } from '@skript-ide/language-server'
import type { SkriptServer } from '@skript-ide/runtime-validator'
import { loadSyntaxDatabase } from '@skript-ide/syntax-db'
import {
  IpcChannel,
  type AgentCompactResult,
  type AgentSessionInfo,
  type AgentSettings,
  type AgentState,
  type AgentSubagentInfo,
  type AgentUiEvent,
  type AgentUndoResult,
  type AgentUsage,
  type ApiKeySource,
  type CodexAccount
} from '../shared/ipc'
import { loginWithChatGPT } from './codex-login'
import { getProjectState } from './project'

/** Katalog bundan eskiyse açılışta yeniden indirilir. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Ayrıştırılan katalog biçimi değişince artar; eski sürümle yazılmış önbellek yeniden indirilir. */
const CATALOG_CACHE_VERSION = 2

interface StoredAgentFile extends AgentSettings {
  /** Sağlayıcı kimliği → `safeStorage` ile şifrelenmiş anahtarın base64'ü. */
  keys: Record<string, string>
  /** Yeni konuşmaların başladığı agent modu; panelde son seçilen. */
  agentMode?: AgentMode
  /** ChatGPT aboneliği oturumu: `safeStorage` ile şifrelenmiş `CodexTokens` JSON'u (base64). */
  codex?: string
  /** Aboneliğin model listesi (`/models`); indirilemezse yedek liste kullanılır. */
  codexModels?: { fetchedAt: number; models: CatalogModel[] }
}

interface CatalogCache {
  version?: number
  fetchedAt: number
  providers: CatalogProvider[]
}

/** Diskteki konuşma: `userData/agent-sessions/<id>.json`. */
interface StoredSession extends AgentSessionInfo {
  messages: Message[]
  goal?: string | null
  /** Konuşmanın başladığı mod; eski kayıtlarda yok (o zaman varsayılan). */
  mode?: AgentMode
  /** Eski kayıtlarda yok. */
  usage?: SessionUsage
  /** Çağrı bazlı kullanım; eski kayıtlarda yok (o zaman yalnızca `usage` toplamı vardır). */
  calls?: CallUsage[]
  /** Alt agent konuşmasıysa onu başlatan konuşma; konuşma listesinde gösterilmez. */
  parent?: { id: string; title: string }
  /** Alt agent konuşmasının modeli. */
  selection?: ModelSelection
  /** Bu konuşmanın başlattığı alt agent'lar. */
  subagents?: AgentSubagentInfo[]
}

/** Alt agent'ın kullandığı model; ana konuşma ayarlardaki seçimi kullanır. */
interface ModelSelection {
  providerId: string
  modelId: string
  effort: string | null
}

/** Konuşma boyunca biriken kullanım; maliyet o anki model fiyatıyla hesaplandığından ayrıca saklanır. */
interface SessionUsage {
  tokens: TokenUsage
  /** USD; fiyatı bilinmeyen çağrılar eklenmez. */
  cost: number
  /** Fiyatı bilinmeyen model kullanıldıysa maliyet eksik demektir. */
  costKnown: boolean
}

/** `/undo` için: bir kullanıcı mesajından önceki geçmiş uzunluğu ve o turda agent'ın yazdığı dosyalar. */
interface Checkpoint {
  baseLength: number
  /**
   * Mutlak yol → dosyanın turdan önceki içeriği ve agent'ın bıraktığı son içerik.
   * `original: null`: agent oluşturdu; `current: null`: agent sildi (ya da başka yere taşıdı).
   */
  files: Map<string, { path: string; original: string | null; current: string | null }>
}

/** Bellekteki bir konuşma; her birinin kendi turu, geçmişi ve kullanımı vardır, aynı anda çalışabilirler. */
interface Conversation {
  /** Baştan verilir; dosya yalnızca ilk mesajla birlikte diske yazılmaya başlar. */
  id: string
  /** Diskteki kaydın başlığı ve projesi; ilk mesaja kadar yok. */
  saved: { title: string; projectRoot: string | null } | null
  messages: Message[]
  goal: string | null
  /** Çağrı bazlı kullanım; önbellek analizi ve `/usage` dökümü bundan türetilir. */
  calls: CallUsage[]
  /** Sıkıştırmadan sonra son çağrının kesin ölçümü eski geçmişi anlatır; yeni çağrıya kadar tahmin kullanılır. */
  measurementStale: boolean
  /** Çağrı kaydı olmayan eski konuşmaların toplamı; yeni konuşmalarda `undefined`. */
  legacyUsage: SessionUsage | undefined
  /** Yalnızca bellekte: uygulama kapanınca ya da konuşma bellekten çıkınca `/undo` dosyaları geri alamaz. */
  checkpoints: Checkpoint[]
  controller: AbortController | null
  /** Tur sürerken o ana kadarki geçmiş; `/btw` ve konuşmaya geri dönen panel buna göre çalışır. */
  liveHistory: (() => Message[]) | null
  /** Akmakta olan yanıtın şimdiye kadarki kısmı; panel konuşmaya dönünce canlı görünümü bununla kurar. */
  streaming: { text: string; reasoning: string } | null
  /** Bu konuşmada geçerli izin modu; yeni konuşmada varsayılana döner. */
  permissionMode: PermissionMode
  /** Sistem istemi ve tool'lar buna göre kurulur, ilk mesajdan sonra değişmez. */
  agentMode: AgentMode
  /** Alt agent konuşmasıysa onu başlatan konuşma; alt agent konuşmasına kullanıcı mesaj yazamaz. */
  parent: { id: string; title: string } | null
  /** Alt agent konuşmasının modeli; ana konuşmada `null`. */
  selection: ModelSelection | null
  /** `run_subagent` çağrı kimliği → başlatılan alt agent. */
  subagents: Map<string, AgentSubagentInfo>
}

function newConversation(permissionMode: PermissionMode, agentMode: AgentMode): Conversation {
  return {
    id: randomUUID(),
    saved: null,
    messages: [],
    goal: null,
    calls: [],
    measurementStale: false,
    legacyUsage: undefined,
    checkpoints: [],
    controller: null,
    liveHistory: null,
    streaming: null,
    permissionMode,
    agentMode,
    parent: null,
    selection: null,
    subagents: new Map()
  }
}

const sessionsDir = () => join(app.getPath('userData'), 'agent-sessions')
const sessionPath = (id: string) => join(sessionsDir(), `${id}.json`)
const SESSION_ID = /^[0-9a-f-]{36}$/
const MAX_TITLE = 60

/** Kullanıcı hafızası: tüm projelerde geçerli agent notları. */
const userMemoryPath = () => join(app.getPath('userData'), 'agent-memory.md')
const settingsPath = () => join(app.getPath('userData'), 'agent.json')
const catalogPath = () => join(app.getPath('userData'), 'agent-catalog.json')

/**
 * AI agent'ı ana süreçte çalıştırır: API anahtarları ve dosya erişimi arayüze hiç girmez.
 * Arayüz mesaj gönderir, olayları `agent:event` kanalından izler, yazma işlemlerini onaylar.
 */
export function setupAgent(getWindow: () => BrowserWindow | null, server: SkriptServer): void {
  const tools = [...coreTools, ...createSkriptTools(), ...geometryTools, todoTool, ...memoryTools, ...conversationTools, ...subagentTools]
  const registries: Record<AgentMode, ToolRegistry> = {
    quick: new ToolRegistry(tools.filter((tool) => toolAllowedInMode('quick', tool.name))),
    standard: new ToolRegistry(tools),
    thorough: new ToolRegistry(tools)
  }
  // Alt agent iç içe alt agent açamaz
  const subagentRegistry = (mode: AgentMode) =>
    new ToolRegistry(registries[mode].list().filter((tool) => !SUBAGENT_TOOL_NAMES.includes(tool.name)))
  const subagentRegistries: Record<AgentMode, ToolRegistry> = {
    quick: subagentRegistry('quick'),
    standard: subagentRegistry('standard'),
    thorough: subagentRegistry('thorough')
  }
  // Arayüzdeki dil sunucusu worker'ından ayrı bir örnek: agent dosyaları diskten okur, editörün
  // kaydedilmemiş belgeleriyle karışmaz. Sürüm ve addon'lar her mesajda projeye göre ayarlanır.
  const languageService = new SkriptLanguageService({ loadDatabase: loadSyntaxDatabase })
  let stored: StoredAgentFile = { providerId: null, modelId: null, effort: null, permissionMode: DEFAULT_PERMISSION_MODE, keys: {} }
  let catalog: CatalogCache | null = null
  let catalogLoading: Promise<CatalogProvider[]> | null = null
  let sessionWrites: Promise<void> = Promise.resolve()
  /** Panelde açık konuşma; diğerleri arka planda çalışmaya devam edebilir. */
  let active = newConversation(DEFAULT_PERMISSION_MODE, DEFAULT_AGENT_MODE)
  /** Bellekteki konuşmalar: açık olan ve arka planda turu süren diğerleri. Biten arka plan konuşması çıkarılır. */
  const conversations = new Map<string, Conversation>([[active.id, active]])
  /** Süren `/btw` soruları; panelde kapatılınca iptal edilir. */
  const btwControllers = new Map<number, AbortController>()
  /** Açık ChatGPT giriş denemesi; ikinci bir giriş aynı bağlantı noktasını beklemesin. */
  let codexLogin: AbortController | null = null
  let nextApprovalId = 1
  const pendingApprovals = new Map<number, { conversation: Conversation; request: ApprovalRequest; done: (approved: boolean) => void }>()

  /** Olay hangi konuşmanınsa onun kimliğiyle gider; panel yalnızca açık konuşmanınkini çizer. */
  const send = (conversation: Conversation, event: AgentUiEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const parentId = conversation.parent ? { parentId: conversation.parent.id } : {}
    win.webContents.send(IpcChannel.agentEvent, { ...event, sessionId: conversation.id, ...parentId })
  }

  /** Yeni konuşmayı kayıtlı varsayılan izin moduyla ve son seçilen agent moduyla açar. */
  function freshConversation(): Conversation {
    return newConversation(stored.permissionMode, stored.agentMode ?? DEFAULT_AGENT_MODE)
  }

  /** Açık konuşmayı değiştirir; turu sürmeyen eski konuşma bellekten çıkar (zaten diskte). */
  function activate(next: Conversation): void {
    if (active !== next && !active.controller) conversations.delete(active.id)
    active = next
    conversations.set(next.id, next)
  }

  const loaded = (async () => {
    try {
      const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<StoredAgentFile>
      stored = {
        providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
        modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
        effort: typeof raw.effort === 'string' ? raw.effort : null,
        permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : DEFAULT_PERMISSION_MODE,
        keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {},
        ...(isAgentMode(raw.agentMode) ? { agentMode: raw.agentMode } : {}),
        ...(typeof raw.codex === 'string' ? { codex: raw.codex } : {}),
        ...(raw.codexModels && Array.isArray(raw.codexModels.models)
          ? { codexModels: { fetchedAt: Number(raw.codexModels.fetchedAt) || 0, models: raw.codexModels.models } }
          : {})
      }
      // Uygulama açılırken bir konuşma yüklenmiş olabilir; onun modu korunur
      if (active.messages.length === 0) {
        active.permissionMode = stored.permissionMode
        active.agentMode = stored.agentMode ?? DEFAULT_AGENT_MODE
      }
    } catch {
      // İlk açılış ya da bozuk dosya: varsayılanlarla devam
    }
  })()

  const save = () => writeFile(settingsPath(), JSON.stringify(stored, null, 2) + '\n', 'utf8')

  // --- Konuşma geçmişi ---

  /** Konuşmayı diske yazar; yazmalar sırayla yapılır, hata konuşmayı bozmaz. */
  function persistSession(conversation: Conversation): Promise<void> {
    const { saved, messages } = conversation
    if (!saved || messages.length === 0) return sessionWrites
    const record: StoredSession = {
      id: conversation.id,
      ...saved,
      updatedAt: Date.now(),
      turns: countTurns(messages),
      messages,
      goal: conversation.goal,
      mode: conversation.agentMode,
      // Toplam ayrıca yazılır: konuşma listesi ve eski sürümler tek alandan okuyabilsin
      usage: sessionTotal(conversation),
      calls: conversation.calls,
      ...(conversation.parent ? { parent: conversation.parent } : {}),
      ...(conversation.selection ? { selection: conversation.selection } : {}),
      ...(conversation.subagents.size ? { subagents: [...conversation.subagents.values()] } : {})
    }
    sessionWrites = sessionWrites
      .then(async () => {
        await mkdir(sessionsDir(), { recursive: true })
        await writeFile(sessionPath(record.id), JSON.stringify(record), 'utf8')
      })
      .catch(() => {})
    return sessionWrites
  }

  async function readSession(id: string): Promise<StoredSession | null> {
    if (!SESSION_ID.test(id)) return null
    try {
      const raw = JSON.parse(await readFile(sessionPath(id), 'utf8')) as Partial<StoredSession>
      if (raw.id !== id || !Array.isArray(raw.messages)) return null
      return {
        id,
        title: typeof raw.title === 'string' ? raw.title : id,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot : null,
        turns: countTurns(raw.messages),
        messages: raw.messages,
        goal: typeof raw.goal === 'string' ? raw.goal : null,
        mode: isAgentMode(raw.mode) ? raw.mode : DEFAULT_AGENT_MODE,
        usage: readUsage(raw.usage),
        calls: readCalls(raw.calls),
        parent: readParent(raw.parent),
        selection: readSelection(raw.selection),
        subagents: Array.isArray(raw.subagents) ? raw.subagents.filter(isSubagentInfo) : undefined
      }
    } catch {
      return null
    }
  }

  async function listSessions(): Promise<AgentSessionInfo[]> {
    await sessionWrites
    let files: string[]
    try {
      files = await readdir(sessionsDir())
    } catch {
      return []
    }
    const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readSession(f.slice(0, -5))))
    return all
      // Alt agent konuşmaları listede değil, başlatan konuşmadaki kartlarından açılır
      .filter((s): s is StoredSession => s !== null && !s.parent)
      .map(({ id, title, updatedAt, projectRoot, turns }): AgentSessionInfo => {
        const info: AgentSessionInfo = { id, title, updatedAt, projectRoot, turns }
        const conversation = conversations.get(info.id)
        if (!conversation?.controller) return info
        const awaiting = [...pendingApprovals.values()].some((entry) => entry.conversation === conversation)
        return { ...info, status: awaiting ? 'approval' : 'running' }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Agent'ın geçmiş konuşmalara erişimi; konuşmanın kendisi listede yer almaz. */
  function archiveFor(conversation: Conversation): ConversationArchive {
    return {
      list: async () => (await listSessions()).filter((info) => info.id !== conversation.id),
      read: async (id) => {
        if (id === conversation.id) return null
        const found = await readSession(id)
        return found && { info: found, messages: found.messages }
      }
    }
  }

  // --- Katalog ---

  async function readCatalogCache(): Promise<CatalogCache | null> {
    try {
      const raw = JSON.parse(await readFile(catalogPath(), 'utf8')) as CatalogCache
      // Eski sürümün önbelleğinde önbellek fiyatları (`cacheRead`) eksik olabilir
      if (raw.version !== CATALOG_CACHE_VERSION) return null
      return Array.isArray(raw.providers) && typeof raw.fetchedAt === 'number' ? raw : null
    } catch {
      return null
    }
  }

  async function loadCatalog(refresh = false): Promise<CatalogProvider[]> {
    const providers = await baseCatalog(refresh)
    await loadCodexModels(refresh)
    // Abonelik sağlayıcısı her zaman listede: giriş yapılmamışken de ayarlardan giriş açılabilmeli
    const merged = [codexProvider(), ...providers.filter((p) => p.id !== CODEX_PROVIDER_ID)]
    if (catalog) catalog.providers = merged
    return merged
  }

  async function baseCatalog(refresh = false): Promise<CatalogProvider[]> {
    catalog ??= await readCatalogCache()
    if (!refresh && catalog && Date.now() - catalog.fetchedAt < CATALOG_MAX_AGE_MS) {
      return catalog.providers.filter((p) => p.id !== CODEX_PROVIDER_ID)
    }
    catalogLoading ??= (async () => {
      try {
        const providers = await fetchCatalog(AbortSignal.timeout(30_000))
        catalog = { version: CATALOG_CACHE_VERSION, fetchedAt: Date.now(), providers }
        await writeFile(catalogPath(), JSON.stringify(catalog), 'utf8')
        return providers
      } catch (error) {
        // Çevrimdışıyken eski katalog işe yarar
        if (catalog) return catalog.providers.filter((p) => p.id !== CODEX_PROVIDER_ID)
        throw new Error(
          l(
            `Model kataloğu models.dev'den indirilemedi: ${(error as Error).message}`,
            `Could not download the model catalog from models.dev: ${(error as Error).message}`
          )
        )
      } finally {
        catalogLoading = null
      }
    })()
    return catalogLoading
  }

  async function findSelection(
    providerId = stored.providerId,
    modelId = stored.modelId
  ): Promise<{ provider: CatalogProvider; model: CatalogModel }> {
    if (!providerId || !modelId) {
      throw new Error(l('Önce agent ayarlarından bir model seç.', 'Choose a model in the agent settings first.'))
    }
    const providers = await loadCatalog()
    const provider = providers.find((p) => p.id === providerId)
    const model = provider?.models.find((m) => m.id === modelId)
    if (!provider || !model) {
      throw new Error(
        l(
          `Seçili model (${providerId}/${modelId}) katalogda artık yok; başka bir model seç.`,
          `The selected model (${providerId}/${modelId}) is no longer in the catalog; choose another model.`
        )
      )
    }
    return { provider, model }
  }

  // --- API anahtarları ---

  function storedKey(providerId: string): string | null {
    const encrypted = stored.keys[providerId]
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return null
    }
  }

  async function envKey(providerId: string): Promise<string | null> {
    const provider = catalog?.providers.find((p) => p.id === providerId) ?? (await loadCatalog().catch(() => [])).find((p) => p.id === providerId)
    for (const name of provider?.env ?? []) {
      const value = process.env[name]
      if (value) return value
    }
    return null
  }

  // --- ChatGPT aboneliği (Codex) ---

  /** Şifreli kayıttan çözülen oturum; giriş yapılmamışsa `null`. */
  function storedCodex(): CodexTokens | null {
    if (!stored.codex || !safeStorage.isEncryptionAvailable()) return null
    try {
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(stored.codex, 'base64'))) as Partial<CodexTokens>
      return typeof parsed.accessToken === 'string' && parsed.accessToken ? (parsed as CodexTokens) : null
    } catch {
      return null
    }
  }

  async function saveCodex(tokens: CodexTokens | null): Promise<void> {
    if (tokens) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          l(
            'Bu sistemde güvenli anahtar deposu yok; ChatGPT oturumu saklanamaz.',
            'No secure key storage is available on this system, so the ChatGPT session cannot be saved.'
          )
        )
      }
      stored.codex = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
    } else {
      delete stored.codex
    }
    await save()
  }

  /** Aynı anda tek yenileme isteği; diğer çağrılar bunun sonucunu bekler. */
  let codexRefresh: Promise<CodexTokens> | null = null

  /**
   * Süresi dolmak üzereyse jetonu yeniler. Yenileme reddedilirse (refresh token geçersiz) kayıt
   * silinir; ağ hatasında eldeki jeton korunur.
   */
  async function freshCodexTokens(): Promise<CodexTokens> {
    const tokens = storedCodex()
    if (!tokens) {
      throw new Error(
        l(
          'ChatGPT aboneliğiyle giriş yapılmamış; agent ayarlarından giriş yap.',
          'Not signed in with a ChatGPT subscription; sign in from the agent settings.'
        )
      )
    }
    if (!needsRefresh(tokens)) return tokens
    if (!tokens.refreshToken) {
      throw new Error(l('ChatGPT oturumu yenilenemiyor; yeniden giriş yap.', 'The ChatGPT session cannot be renewed; sign in again.'))
    }
    codexRefresh ??= (async () => {
      try {
        const refreshed = await refreshTokens({ refreshToken: tokens.refreshToken! })
        const next: CodexTokens = {
          ...tokens,
          ...refreshed,
          // Yenileme yanıtında `id_token` gelmeyebilir; hesap bilgileri eskisinden korunur
          accountId: refreshed.accountId ?? tokens.accountId,
          email: refreshed.email ?? tokens.email,
          plan: refreshed.plan ?? tokens.plan
        }
        await saveCodex(next)
        return next
      } catch (error) {
        if (error instanceof ProviderError && (error.status === 400 || error.status === 401)) await saveCodex(null)
        throw error
      } finally {
        codexRefresh = null
      }
    })()
    return codexRefresh
  }

  async function codexAuth(): Promise<{ accessToken: string; accountId: string | null }> {
    const tokens = await freshCodexTokens()
    return { accessToken: tokens.accessToken, accountId: tokens.accountId ?? null }
  }

  function codexStatus(): CodexAccount {
    const tokens = storedCodex()
    return { signedIn: tokens !== null, email: tokens?.email ?? null, plan: tokens?.plan ?? null }
  }

  /** Abonelik sağlayıcısı: model listesi hesaptan indirilir, inmemişse yedek liste kullanılır. */
  function codexProvider(): CatalogProvider {
    return codexCatalogProvider(stored.codexModels?.models.length ? stored.codexModels.models : CODEX_FALLBACK_MODELS)
  }

  /** Hesabın model listesini indirir; hata olursa eldeki liste (ya da yedek) kalır. */
  async function loadCodexModels(refresh = false): Promise<void> {
    if (!storedCodex()) return
    const cached = stored.codexModels
    if (!refresh && cached && Date.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) return
    try {
      const auth = await freshCodexTokens()
      const response = await fetch(codexModelsUrl(), {
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          originator: 'codex_cli_rs',
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {})
        },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) return
      const models = parseCodexModels(await response.json())
      if (models.length === 0) return
      stored.codexModels = { fetchedAt: Date.now(), models }
      await save()
    } catch {
      // Çevrimdışıyken son indirilen liste ya da yedek liste kullanılır
    }
  }

  async function keySource(providerId: string | null): Promise<ApiKeySource> {
    if (!providerId) return 'none'
    if (providerId === CODEX_PROVIDER_ID && storedCodex()) return 'subscription'
    if (storedKey(providerId)) return 'stored'
    return (await envKey(providerId)) ? 'env' : 'none'
  }

  /** Kayıtlı anahtarı, ortam değişkeni ya da ChatGPT oturumu olan sağlayıcılar. */
  function configuredProviders(): string[] {
    const ids = new Set(Object.keys(stored.keys).filter((id) => storedKey(id)))
    if (storedCodex()) ids.add(CODEX_PROVIDER_ID)
    for (const provider of catalog?.providers ?? []) {
      if (provider.env.some((name) => process.env[name])) ids.add(provider.id)
    }
    return [...ids]
  }

  /** Açık konuşmanın durumu; tur sürüyorsa geçmiş o ana kadarki haliyle, akan yanıt ve bekleyen onaylarla gelir. */
  async function state(): Promise<AgentState> {
    await loaded
    const conversation = active
    const messages = conversation.liveHistory?.() ?? conversation.messages
    return {
      settings: {
        providerId: stored.providerId,
        modelId: stored.modelId,
        effort: stored.effort,
        permissionMode: stored.permissionMode
      },
      parent: conversation.parent,
      subagents: [...conversation.subagents.values()],
      subagentModel: conversation.selection,
      permissionMode: conversation.permissionMode,
      agentMode: conversation.agentMode,
      sessionId: conversation.id,
      running: conversation.controller !== null,
      messages,
      streaming: conversation.streaming && { ...conversation.streaming },
      approvals: [...pendingApprovals]
        .filter(([, entry]) => entry.conversation === conversation)
        .map(([id, entry]) => ({ id, request: entry.request })),
      keySource: await keySource(stored.providerId),
      configuredProviders: configuredProviders(),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      codex: codexStatus(),
      goal: conversation.goal,
      todos: latestTodos(messages),
      usage: usageSummary(conversation)
    }
  }

  /**
   * Çağrı kayıtlarından oturum toplamı. Eski konuşmaya yeni mesaj eklenirse eski toplam
   * korunur; yalnızca çağrı kaydı olmayan konuşmalarda toplam tek başına geçerlidir.
   */
  function sessionTotal({ calls, legacyUsage }: Conversation): SessionUsage {
    if (calls.length === 0) return legacyUsage ?? newUsage()
    const tokens = calls.reduce((sum, call) => addUsage(sum, call.tokens), emptyUsage())
    const cost = calls.reduce((sum, call) => sum + (call.cost?.total ?? 0), 0)
    const costKnown = calls.every((call) => call.cost !== null)
    if (!legacyUsage) return { tokens, cost, costKnown }
    return {
      tokens: addUsage(tokens, legacyUsage.tokens),
      cost: cost + legacyUsage.cost,
      costKnown: costKnown && legacyUsage.costKnown
    }
  }

  /** Önbellek analizi için çağrının fiyatı; katalogda yoksa `undefined` (maliyet 0 sayılır). */
  function priceOf(call: CallUsage): PriceRates | undefined {
    const provider = catalog?.providers.find((p) => p.id === call.providerId)
    return provider?.models.find((m) => m.id === call.modelId)?.cost
  }

  /** Konuşmanın modeli (alt agent'ın kendi seçimi, yoksa ayarlardaki); katalog henüz yüklenmediyse `undefined`. */
  function modelOf(conversation: Conversation): CatalogModel | undefined {
    const providerId = conversation.selection?.providerId ?? stored.providerId
    const modelId = conversation.selection?.modelId ?? stored.modelId
    return catalog?.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)
  }

  /**
   * Bağlam boyu: son çağrının sağlayıcıdan gelen kesin hacmi ve (çalışmıyorken) sonrasındaki
   * mesajların tahmini. Çalışırken `messages` bu turun istemini de içerdiği için tahmin eklenmez.
   */
  function contextTokens({ calls, measurementStale, messages, agentMode, controller }: Conversation): number {
    const last = measurementStale ? undefined : calls.at(-1)
    if (!last) {
      const project = getProjectState()
      const system = systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? [], agentMode)
      const toolTokens = estimateTextTokens(JSON.stringify(registries[agentMode].definitions()))
      return estimateContextTokens(messages) + estimateTextTokens(system) + toolTokens
    }
    return estimateContextTokens(controller ? [] : messages, last)
  }

  /**
   * Çağrı maliyetlerini güncel katalog fiyatıyla yeniden hesaplar; eksik fiyatla (ör. `cacheRead`
   * olmadan) kaydedilmiş eski çağrılar da düzelir. Fiyatı katalogda olmayan çağrı olduğu gibi kalır.
   */
  function repriceCalls(calls: CallUsage[]): void {
    for (const call of calls) {
      const price = priceOf(call)
      if (price) call.cost = calculateCost(call.tokens, price)
    }
  }

  function usageSummary(conversation: Conversation): AgentUsage {
    const { calls, legacyUsage } = conversation
    repriceCalls(calls)
    const total = sessionTotal(conversation)
    const last = calls.at(-1)
    const prompt = total.tokens.input + total.tokens.cacheRead + total.tokens.cacheWrite
    const waste = scanCacheMisses(calls, priceOf)
    const byModel = new Map<string, { tokens: number; cost: number }>()
    for (const call of calls) {
      const key = `${call.providerId}/${call.modelId}`
      const entry = byModel.get(key) ?? { tokens: 0, cost: 0 }
      entry.tokens += promptTokens(call.tokens) + call.tokens.output
      entry.cost += call.cost?.total ?? 0
      byModel.set(key, entry)
    }
    if (legacyUsage) {
      const legacyPrompt = promptTokens(legacyUsage.tokens)
      byModel.set(l('eski kayıt', 'legacy'), {
        tokens: legacyPrompt + legacyUsage.tokens.output,
        cost: legacyUsage.cost
      })
    }
    const lastPrompt = last ? promptTokens(last.tokens) : 0
    return {
      uncached: total.tokens.input,
      cached: total.tokens.cacheRead,
      written: total.tokens.cacheWrite,
      output: total.tokens.output,
      cost: total.costKnown ? total.cost : null,
      hitRate: last && lastPrompt > 0 ? (last.tokens.cacheRead / lastPrompt) * 100 : null,
      totalHitRate: prompt > 0 ? (total.tokens.cacheRead / prompt) * 100 : null,
      contextTokens: contextTokens(conversation),
      contextWindow: modelOf(conversation)?.contextWindow ?? 0,
      reBilledTokens: waste.missedTokens,
      reBilledCost: waste.missedCost,
      reBilledCount: waste.missCount,
      byModel: [...byModel].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => b.cost - a.cost)
    }
  }

  /** Önbellek isabetsizliği bu eşiklerden birini geçerse transkriptte gösterilir. */
  const CACHE_MISS_MIN_TOKENS = 20_000
  const CACHE_MISS_MIN_COST = 0.1
  /** Önbellek kaydının varsayılan ömrü (5 dakika); bundan uzun boşluk miss'in en olası nedenidir. */
  const CACHE_TTL_MS = 5 * 60 * 1000

  /** Çağrıyı kaydeder; anlamlı bir önbellek isabetsizliği varsa arayüze bildirir. */
  function noteCall(conversation: Conversation, call: CallUsage): void {
    conversation.calls.push(call)
    conversation.measurementStale = false
    const miss = scanCacheMisses(conversation.calls, priceOf).misses.get(call)
    if (!miss) return
    if (miss.missedTokens < CACHE_MISS_MIN_TOKENS && miss.missedCost < CACHE_MISS_MIN_COST) return
    send(conversation, {
      type: 'cache-miss',
      missedTokens: miss.missedTokens,
      missedCost: miss.missedCost,
      idleMs: miss.idleMs,
      // Beş dakikalık varsayılan ömürden uzun boşluk, miss'in en olası nedeni
      reason: miss.modelChanged ? 'model' : miss.idleMs >= CACHE_TTL_MS ? 'idle' : 'other'
    })
  }

  // --- Çalıştırma ---

  function requestApproval(conversation: Conversation, request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const id = nextApprovalId++
    return new Promise((resolvePromise) => {
      const done = (approved: boolean) => {
        pendingApprovals.delete(id)
        resolvePromise(approved)
      }
      pendingApprovals.set(id, { conversation, request, done })
      signal.addEventListener('abort', () => done(false), { once: true })
      send(conversation, { type: 'approval-request', id, request })
    })
  }

  /** Seçili model ve kimlik bilgisi; eksikse kullanıcıya gösterilecek hatayı fırlatır. */
  async function connect(
    providerId?: string,
    modelId?: string
  ): Promise<{ provider: CatalogProvider; model: CatalogModel; apiKey: string; subscription: boolean }> {
    const { provider, model } = await findSelection(providerId, modelId)
    // `codex` protokolü API anahtarı değil ChatGPT oturumu ister
    const subscription = model.protocol === 'codex'
    const apiKey = subscription ? '' : (storedKey(provider.id) ?? (await envKey(provider.id)) ?? '')
    if (subscription && !storedCodex()) {
      throw new Error(
        l(
          'ChatGPT aboneliğiyle giriş yapılmamış. Agent ayarlarından giriş yap.',
          'Not signed in with a ChatGPT subscription. Sign in from the agent settings.'
        )
      )
    }
    if (!subscription && !apiKey && !isLocalUrl(model.baseURL)) {
      throw new Error(
        l(
          `${provider.name} için API anahtarı yok. Agent ayarlarından ekle.`,
          `There is no API key for ${provider.name}. Add one in the agent settings.`
        )
      )
    }
    return { provider, model, apiKey, subscription }
  }

  async function run(
    text: string,
    problems: ProblemReport[] = [],
    editor: EditorContext | null = null,
    images: ImageBlock[] = []
  ): Promise<void> {
    await loaded
    // Bağlanmayı beklerken panel başka konuşmaya geçebilir; mesaj gönderildiği konuşmaya gider
    const conversation = active
    if (conversation.parent) throw new Error(READ_ONLY_SUBAGENT())
    if (conversation.controller) throw new Error(l('Agent zaten çalışıyor.', 'The agent is already running.'))
    const { provider, model, apiKey, subscription } = await connect()
    const effort = stored.effort
    if (images.length && model.images === false) {
      throw new Error(
        l(
          `${model.name} görsel kabul etmiyor. Görseli kaldır ya da görsel destekleyen bir model seç.`,
          `${model.name} does not accept images. Remove the image or pick a model that supports images.`
        )
      )
    }

    const project = getProjectState()
    // Skript tool'ları projenin o anki sürümü ve addon'larıyla çalışsın
    await languageService.setSkriptVersion(project.settings.skriptVersion)
    languageService.setAddons(project.settings.addons ?? [])
    // `@dosya` etiketlerinin içeriği mesaja eklenir; bulunamayanlar metinde olduğu gibi kalır
    const { blocks: attachments } = await readMentions(project.root, text)
    // `@Problems`: arayüzün gönderdiği sorun listesi, yollar proje köküne göre
    if (parseMentions(text).some(isProblemsMention)) {
      const reported = problems.map((problem) => ({ ...problem, path: projectPath(project.root, problem.path) }))
      attachments.push({ type: 'text', text: problemsAttachmentText(reported) })
    }
    // `@chat:…`: geçmiş konuşmanın dökümü; bulunamayan etiket metinde olduğu gibi kalır
    for (const ref of parseMentions(text).flatMap((mention) => conversationMentionRef(mention) ?? [])) {
      try {
        const found = await resolveConversation(archiveFor(conversation), ref)
        attachments.push({ type: 'text', text: attachedConversationText(found.info, found.messages) })
      } catch {
        // Model etiketi görür; isterse search_conversations ile arar
      }
    }
    // Hedef sistem istemine değil, değiştiği ilk mesaja eklenir; geçmiş yalnızca büyür, önbellek korunur
    const goalBlock = goalUpdate(conversation.messages, conversation.goal)
    if (goalBlock) attachments.push({ type: 'text', text: goalBlock })
    // Proje talimatları da aynı desenle yalnızca değiştiğinde mesaja eklenir
    const memoryBlock = projectMemoryUpdate(conversation.messages, await loadProjectMemory(project.root))
    if (memoryBlock) attachments.push({ type: 'text', text: memoryBlock })
    // Agent hafızası (kullanıcı + proje) da yalnızca değiştiğinde eklenir
    const agentMemoryBlock = memoryUpdate(conversation.messages, await loadMemory(userMemoryPath(), project.root))
    if (agentMemoryBlock) attachments.push({ type: 'text', text: agentMemoryBlock })
    if (editor) {
      const path = editor.untitled ? editor.path : projectPath(project.root, editor.path)
      attachments.push({ type: 'text', text: editorContextText({ ...editor, path }) })
    }
    const userMessage: Message = { role: 'user', content: [...textMessage('user', text).content, ...images, ...attachments] }
    if (conversation.controller) throw new Error(l('Agent zaten çalışıyor.', 'The agent is already running.'))
    const checkpoint: Checkpoint = { baseLength: conversation.messages.length, files: new Map() }
    conversation.checkpoints.push(checkpoint)
    const history = [...conversation.messages, userMessage]
    conversation.messages = history
    conversation.saved ??= { title: titleFrom(text || l('Görsel', 'Image')), projectRoot: project.root }
    void persistSession(conversation)
    send(conversation, { type: 'user-message', message: userMessage })

    // Önceki çağrının kesin kullanımına dayanır; tur başlayınca (controller varken) hesap değişir
    const initialTokens = conversation.calls.length ? contextTokens(conversation) : undefined
    const contextWindow = model.contextWindow ?? 0
    const controller = new AbortController()
    conversation.controller = controller
    const signal = controller.signal
    // Bu turun numarası: çağrılar buna göre gruplanır, `/undo` geri alırken bununla kırpar
    let turn = countTurns(history)
    // Hata ya da iptalde de konuşmanın tutarlı kalması için olaylardan izlenen geçmiş
    const tracked = [...history]
    let pendingResults: ToolResultBlock[] = []
    const flushResults = () => {
      if (pendingResults.length) tracked.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
    conversation.liveHistory = () => (pendingResults.length ? [...tracked, { role: 'user', content: [...pendingResults] }] : [...tracked])

    try {
      const result = await runAgent({
        provider: createProvider(provider, model, {
          apiKey,
          effort: effort ?? undefined,
          codexAuth: subscription ? codexAuth : undefined,
          sessionId: conversation.id
        }),
        registry: registries[conversation.agentMode],
        permissionMode: () => conversation.permissionMode,
        system: systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? [], conversation.agentMode),
        messages: history,
        contextLimits: { window: contextWindow, initialTokens },
        context: {
          projectRoot: project.root,
          signal,
          languageService,
          server,
          requestApproval: (request) => requestApproval(conversation, request, signal),
          onFilesChanged: (changes) => recordChanges(conversation, checkpoint, project.root, changes),
          onTodosChanged: (todos) => send(conversation, { type: 'todos', todos: [...todos] }),
          userMemoryFile: userMemoryPath(),
          conversations: archiveFor(conversation),
          subagents: {
            models: () => subagentModels(provider.id, model.id),
            run: (request, ctx) => runSubagent(conversation, { providerId: provider.id, modelId: model.id, effort }, request, ctx)
          }
        },
        onEvent: (event) => {
          if (event.type === 'assistant-message') {
            flushResults()
            tracked.push(event.message)
            conversation.streaming = null
            send(conversation, event)
          } else if (event.type === 'usage') {
            noteCall(conversation, {
              at: Date.now(),
              providerId: provider.id,
              modelId: model.id,
              turn,
              tokens: event.usage,
              cost: calculateCost(event.usage, model.cost)
            })
            send(conversation, { type: 'usage', usage: usageSummary(conversation) })
            void persistSession(conversation)
          } else if (event.type === 'context-trimmed') {
            // Kısaltılmış geçmiş bekleyen tool sonuçlarını da içerir
            pendingResults = []
            tracked.splice(0, tracked.length, ...event.messages)
            send(conversation, { type: 'context-trimmed', trimmed: event.trimmed })
          } else if (event.type === 'context-compacted') {
            // Özet, eski tur açıklamalarını da kapsar: bekleyen sonuçlar ve /undo noktaları yeni geçmişe taşınır
            const removedTurns = countTurns(tracked.slice(0, event.summarizedMessages))
            pendingResults = []
            tracked.splice(0, tracked.length, ...event.messages)
            conversation.checkpoints = conversation.checkpoints.filter((point) => {
              // Eski indeks yeni geçmişe taşınır: başa bir özet mesajı eklendiği için +1
              if (point.baseLength < event.summarizedMessages) return false
              point.baseLength = point.baseLength - event.summarizedMessages + 1
              return true
            })
            // Özete giren turlar geri alınamaz; kalan çağrılar yeni tur numaralarına kaydırılır
            for (const call of conversation.calls) call.turn -= removedTurns
            turn -= removedTurns
            conversation.measurementStale = true
            send(conversation, { type: 'context-compacted', summarizedMessages: event.summarizedMessages })
            void persistSession(conversation)
          } else if (event.type === 'retry') {
            // Yarım akan yanıt geçersiz; yeniden deneme baştan akar
            conversation.streaming = null
            send(conversation, event)
          } else if (event.type === 'delta') {
            const streaming = (conversation.streaming ??= { text: '', reasoning: '' })
            streaming[event.delta.kind] += event.delta.text
            send(conversation, event)
          } else if (event.type === 'tool-start') {
            send(conversation, event)
          } else if (event.type === 'tool-result') {
            pendingResults.push(event.result)
            send(conversation, event)
          }
        }
      })
      conversation.messages = result.messages
      send(conversation, { type: 'done', reason: result.reason })
    } catch (error) {
      flushResults()
      conversation.messages = closeDanglingToolCalls(tracked)
      if (signal.aborted) send(conversation, { type: 'done', reason: 'cancelled' })
      else send(conversation, { type: 'done', reason: 'error', error: (error as Error).message })
    } finally {
      conversation.controller = null
      conversation.liveHistory = null
      conversation.streaming = null
      for (const [id, entry] of pendingApprovals) if (entry.conversation === conversation) pendingApprovals.delete(id)
      // Arka planda biten konuşma diskte kalır, bellekten çıkar
      if (conversation !== active) conversations.delete(conversation.id)
      void persistSession(conversation)
    }
  }

  // --- Alt agent'lar ---

  /** Alt agent'ın seçebileceği modeller: kimlik bilgisi olan sağlayıcıların modelleri ve ana agent'ın modeli. */
  async function subagentModels(currentProvider: string, currentModel: string): Promise<SubagentModel[]> {
    const providers = await loadCatalog()
    const configured = new Set([...configuredProviders(), currentProvider])
    return providers
      .filter((provider) => configured.has(provider.id))
      .flatMap((provider) =>
        provider.models.map(
          (model): SubagentModel => ({
            id: `${provider.id}/${model.id}`,
            name: model.name,
            effortLevels: model.effortLevels ?? [],
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            ...(model.cost ? { cost: { input: model.cost.input, output: model.cost.output } } : {}),
            current: provider.id === currentProvider && model.id === currentModel
          })
        )
      )
  }

  /**
   * `run_subagent`: görevi kendi konuşmasında (oturumunda) çalışan yeni bir agent'a verir. Alt agent'ın
   * olayları kendi kimliğiyle akar, panel onu ana konuşma gibi açabilir; ana konuşmaya ise ilerlemesi
   * `subagent` olayıyla gider. Onaylar ve dosya değişiklikleri ana konuşmanın turuna bağlanır, böylece
   * ana konuşmada görünür ve `/undo` ile geri alınır. Ana tur durdurulursa alt agent da durur.
   */
  async function runSubagent(parent: Conversation, current: ModelSelection, request: SubagentRequest, ctx: ToolContext): Promise<string> {
    // Model verilmezse ana agent'ın modeli ve effort'u; verilirse yalnızca istenen effort
    let selection: ModelSelection = current
    if (request.modelId) {
      const slash = request.modelId.indexOf('/')
      selection = { providerId: request.modelId.slice(0, slash), modelId: request.modelId.slice(slash + 1), effort: request.effort ?? null }
    }
    let connection: Awaited<ReturnType<typeof connect>>
    try {
      connection = await connect(selection.providerId, selection.modelId)
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
    const { provider, model, apiKey, subscription } = connection
    const project = getProjectState()
    const child: Conversation = {
      ...newConversation(parent.permissionMode, parent.agentMode),
      saved: { title: request.description, projectRoot: project.root },
      parent: { id: parent.id, title: parent.saved?.title ?? request.description },
      selection
    }
    const controller = new AbortController()
    child.controller = controller
    conversations.set(child.id, child)
    // Ana tur durunca alt agent da durur; alt agent'ı kendi görünümünden durdurmak ana turu durdurmaz
    const stop = () => controller.abort()
    ctx.signal.addEventListener('abort', stop, { once: true })

    const info: AgentSubagentInfo = {
      callId: ctx.callId ?? child.id,
      sessionId: child.id,
      title: request.description,
      providerId: provider.id,
      modelId: model.id,
      modelName: model.name,
      effort: selection.effort,
      status: 'running',
      toolCalls: 0,
      usage: usageSummary(child)
    }
    parent.subagents.set(info.callId, info)
    const report = () => {
      info.usage = usageSummary(child)
      send(parent, { type: 'subagent', info: { ...info } })
    }

    const userMessage = textMessage('user', request.prompt)
    child.messages = [userMessage]
    const tracked: Message[] = [userMessage]
    let pendingResults: ToolResultBlock[] = []
    const flushResults = () => {
      if (pendingResults.length) tracked.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
    child.liveHistory = () => (pendingResults.length ? [...tracked, { role: 'user', content: [...pendingResults] }] : [...tracked])
    void persistSession(child)
    void persistSession(parent)
    send(child, { type: 'user-message', message: userMessage })
    report()

    try {
      const result = await runAgent({
        provider: createProvider(provider, model, {
          apiKey,
          effort: selection.effort ?? undefined,
          codexAuth: subscription ? codexAuth : undefined,
          sessionId: child.id
        }),
        registry: subagentRegistries[child.agentMode],
        permissionMode: () => parent.permissionMode,
        system: `${systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? [], child.agentMode)}\n\n${SUBAGENT_INSTRUCTIONS}`,
        messages: child.messages,
        contextLimits: { window: model.contextWindow ?? 0 },
        context: {
          projectRoot: project.root,
          signal: controller.signal,
          languageService,
          server,
          // Kullanıcı ana konuşmayı izliyor: onay orada, alt agent'ın adıyla istenir
          requestApproval: (approval) =>
            requestApproval(parent, { ...approval, summary: `[${request.description}] ${approval.summary}` }, controller.signal),
          // Ana çağrının satırında +/- sayısı görünsün ve değişiklikler ana turla geri alınsın
          onFilesChanged: (changes) => ctx.onFilesChanged?.(changes),
          onTodosChanged: (todos) => send(child, { type: 'todos', todos: [...todos] }),
          userMemoryFile: userMemoryPath(),
          conversations: archiveFor(child)
        },
        onEvent: (event) => {
          if (event.type === 'assistant-message') {
            flushResults()
            tracked.push(event.message)
            child.streaming = null
            send(child, event)
          } else if (event.type === 'usage') {
            noteCall(child, {
              at: Date.now(),
              providerId: provider.id,
              modelId: model.id,
              turn: 1,
              tokens: event.usage,
              cost: calculateCost(event.usage, model.cost)
            })
            send(child, { type: 'usage', usage: usageSummary(child) })
            report()
            void persistSession(child)
          } else if (event.type === 'context-trimmed' || event.type === 'context-compacted') {
            pendingResults = []
            tracked.splice(0, tracked.length, ...event.messages)
            if (event.type === 'context-compacted') {
              child.measurementStale = true
              send(child, { type: 'context-compacted', summarizedMessages: event.summarizedMessages })
            } else send(child, { type: 'context-trimmed', trimmed: event.trimmed })
          } else if (event.type === 'retry') {
            child.streaming = null
            send(child, event)
          } else if (event.type === 'delta') {
            const streaming = (child.streaming ??= { text: '', reasoning: '' })
            streaming[event.delta.kind] += event.delta.text
            send(child, event)
          } else if (event.type === 'tool-start') {
            info.toolCalls++
            send(child, event)
            report()
          } else if (event.type === 'tool-result') {
            pendingResults.push(event.result)
            send(child, event)
          }
        }
      })
      child.messages = result.messages
      info.status = 'done'
      send(child, { type: 'done', reason: result.reason })
      const text = finalText(result.messages)
      const note = result.reason === 'end' ? '' : `\n\n(The subagent stopped early: ${result.reason}. Its work may be incomplete.)`
      return `Subagent "${request.description}" (${provider.id}/${model.id}) finished after ${info.toolCalls} tool call(s).\n\n${text || '(It gave no final message.)'}${note}`
    } catch (error) {
      flushResults()
      child.messages = closeDanglingToolCalls(tracked)
      if (controller.signal.aborted) {
        info.status = 'cancelled'
        send(child, { type: 'done', reason: 'cancelled' })
        // Ana tur durduysa iptal döngüyü durdurmalı; yalnızca alt agent durdurulduysa ana agent devam eder
        if (ctx.signal.aborted) throw error
        throw new ToolError('The user stopped this subagent.')
      }
      info.status = 'error'
      send(child, { type: 'done', reason: 'error', error: (error as Error).message })
      throw new ToolError(`Subagent failed: ${(error as Error).message}`)
    } finally {
      ctx.signal.removeEventListener('abort', stop)
      child.controller = null
      child.liveHistory = null
      child.streaming = null
      if (child !== active) conversations.delete(child.id)
      report()
      void persistSession(child)
      void persistSession(parent)
    }
  }

  /**
   * `/btw`: konuşmanın o anki bağlamıyla tek bir yan soru sorar. Tool çalıştırılmaz, soru ve yanıt
   * geçmişe eklenmez; tur sürerken de sorulabilir. Sistem istemi ve tool tanımları aynı tutulur
   * ki konuşmanın önbelleği okunsun. Kullanım konuşmanın toplamına eklenir.
   */
  async function btw(id: number, question: string): Promise<string> {
    await loaded
    if (!question.trim()) throw new Error(l('Soru boş.', 'The question is empty.'))
    const conversation = active
    const { provider, model, apiKey, subscription } = await connect()
    const project = getProjectState()
    const history = closeDanglingToolCalls(conversation.liveHistory?.() ?? conversation.messages, 'Still running; the result is not available yet.')
    const ask = textMessage('user', `${BTW_PREFIX}\n\n${question.trim()}`)
    // Tur sürerken geçmiş kullanıcı mesajıyla (tool sonuçları) bitebilir; art arda iki kullanıcı mesajı gönderilmez
    const last = history.at(-1)
    const request =
      last?.role === 'user' ? [...history.slice(0, -1), { role: 'user' as const, content: [...last.content, ...ask.content] }] : [...history, ask]
    const btwController = new AbortController()
    btwControllers.set(id, btwController)
    try {
      const response = await createProvider(provider, model, {
        apiKey,
        effort: stored.effort ?? undefined,
        codexAuth: subscription ? codexAuth : undefined,
        sessionId: conversation.id
      }).complete({
        system: systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? [], conversation.agentMode),
        messages: request,
        tools: registries[conversation.agentMode].definitions(),
        signal: btwController.signal,
        onDelta: (delta) => {
          if (delta.kind === 'text') send(conversation, { type: 'btw-delta', id, text: delta.text })
        }
      })
      if (response.usage) {
        noteCall(conversation, {
          at: Date.now(),
          providerId: provider.id,
          modelId: model.id,
          turn: countTurns(conversation.messages),
          tokens: response.usage,
          cost: calculateCost(response.usage, model.cost)
        })
        send(conversation, { type: 'usage', usage: usageSummary(conversation) })
        void persistSession(conversation)
      }
      // Model yine de tool isterse çağrılar yok sayılır; yalnızca metin gösterilir
      return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    } finally {
      btwControllers.delete(id)
    }
  }

  /** `/compact`: geçmişin eski kısmını hemen özetler. Çalışan bir tur varsa önce durdurulur. */
  async function compact(): Promise<AgentCompactResult> {
    const conversation = active
    if (conversation.parent) throw new Error(READ_ONLY_SUBAGENT())
    await settle(conversation)
    if (conversation.messages.length === 0) return { state: await state(), summarizedMessages: 0 }
    const { provider, model, apiKey, subscription } = await connect()
    const turn = countTurns(conversation.messages)
    const result = await compactMessages(
      createProvider(provider, model, {
        apiKey,
        effort: stored.effort ?? undefined,
        codexAuth: subscription ? codexAuth : undefined,
        sessionId: conversation.id
      }),
      conversation.messages,
      {
        signal: new AbortController().signal,
        onUsage: (tokens) =>
          noteCall(conversation, {
            at: Date.now(),
            providerId: provider.id,
            modelId: model.id,
            turn,
            tokens,
            cost: calculateCost(tokens, model.cost)
          })
      }
    )
    if (!result) return { state: await state(), summarizedMessages: 0 }
    const removedTurns = countTurns(conversation.messages.slice(0, result.summarized))
    conversation.messages = result.messages
    conversation.measurementStale = true
    // Özete giren turların kullanımı da yeni tur numaralarına kaydırılır; geri alınamazlar
    for (const call of conversation.calls) call.turn -= removedTurns
    conversation.checkpoints = []
    if (result.usage) send(conversation, { type: 'usage', usage: usageSummary(conversation) })
    void persistSession(conversation)
    return { state: await state(), summarizedMessages: result.summarized }
  }

  /** Tool'un yazdığı dosyaları turun geri alma noktasına işler ve açık sekmelerin yenilenmesini ister. */
  function recordChanges(conversation: Conversation, checkpoint: Checkpoint, root: string | null, changes: readonly FileChange[]): void {
    if (!root) return
    for (const change of changes) {
      const file = resolve(root, change.path)
      const known = checkpoint.files.get(file)
      checkpoint.files.set(file, {
        path: change.path,
        original: known ? known.original : change.created ? null : change.before,
        current: change.deleted ? null : change.after
      })
      send(conversation, { type: 'file-changed', path: file })
    }
  }

  /** Konuşmanın turunu durdurup bitmesini bekler; böylece geçmiş değiştirilirken tur araya yazmaz. */
  async function settle(conversation: Conversation): Promise<void> {
    conversation.controller?.abort()
    while (conversation.controller) await new Promise((r) => setTimeout(r, 20))
  }

  /** Son kullanıcı mesajını ve sonrasını siler; o turda agent'ın yazdığı dosyaları, hâlâ agent'ın bıraktığı haldeyse, eski haline döndürür. */
  async function undo(): Promise<AgentUndoResult> {
    const conversation = active
    if (conversation.parent) throw new Error(READ_ONLY_SUBAGENT())
    await settle(conversation)
    const { messages } = conversation
    const checkpoint = conversation.checkpoints.pop()
    let baseLength = checkpoint ? Math.min(checkpoint.baseLength, messages.length) : -1
    if (baseLength < 0) baseLength = messages.findLastIndex(isUserTextMessage)
    const removed = baseLength >= 0 ? messages[baseLength] : undefined
    const restored: string[] = []
    const skipped: string[] = []
    if (!removed) return { state: await state(), text: null, images: [], restored, skipped }

    for (const [file, entry] of checkpoint?.files ?? []) {
      try {
        if ((await readIfExists(file)) !== entry.current) {
          skipped.push(entry.path)
          continue
        }
        if (entry.original === null) {
          await rm(file, { force: true })
        } else {
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, entry.original, 'utf8')
        }
        restored.push(entry.path)
        send(conversation, { type: 'file-changed', path: file })
      } catch {
        skipped.push(entry.path)
      }
    }
    // Eklenen dosya içerikleri girişe geri konmaz; `@etiket`ler metinde zaten duruyor
    const text = removed.content
      .flatMap((b) =>
        b.type === 'text' &&
        !parseAttachment(b.text) &&
        parseGoal(b.text) === undefined &&
        parseProjectInstructions(b.text) === undefined &&
        parseMemory(b.text) === undefined &&
        !isConversationSummary(b.text) &&
        !isEditorContext(b.text)
          ? [b.text]
          : []
      )
      .join('\n')
    conversation.messages = messages.slice(0, baseLength)
    // Geri alınan turun kullanımı toplamlardan da düşsün
    const remainingTurns = countTurns(conversation.messages)
    conversation.calls = conversation.calls.filter((call) => call.turn <= remainingTurns)
    if (conversation.messages.length === 0) {
      // Konuşma boşaldı: sonraki mesaj yeni bir kayıt açar, eski kayıt diskte olduğu gibi kalır
      conversations.delete(conversation.id)
      conversation.id = randomUUID()
      conversations.set(conversation.id, conversation)
      conversation.saved = null
      conversation.calls = []
      conversation.legacyUsage = undefined
    } else void persistSession(conversation)
    const images = removed.content.filter((b): b is ImageBlock => b.type === 'image')
    return { state: await state(), text, images, restored, skipped }
  }

  // --- IPC ---

  ipcMain.handle(IpcChannel.agentUndo, () => undo())
  ipcMain.handle(IpcChannel.agentSetGoal, async (_event, raw: unknown) => {
    active.goal = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    void persistSession(active)
    return state()
  })
  ipcMain.handle(IpcChannel.agentCompact, () => compact())
  ipcMain.handle(IpcChannel.agentState, () => state())
  ipcMain.handle(IpcChannel.agentProviders, (_event, refresh: unknown) => loadCatalog(refresh === true))
  ipcMain.handle(IpcChannel.agentSetSettings, async (_event, raw: Partial<AgentSettings>) => {
    await loaded
    stored.providerId = typeof raw?.providerId === 'string' ? raw.providerId : null
    stored.modelId = typeof raw?.modelId === 'string' ? raw.modelId : null
    stored.effort = typeof raw?.effort === 'string' ? raw.effort : null
    if (isPermissionMode(raw?.permissionMode) && raw.permissionMode !== stored.permissionMode) {
      stored.permissionMode = raw.permissionMode
      // Varsayılanı değiştiren kullanıcı bunun açık konuşmada hemen geçerli olmasını bekler
      active.permissionMode = raw.permissionMode
    }
    await save()
    return state()
  })
  ipcMain.handle(IpcChannel.agentSetPermissionMode, async (_event, mode: unknown) => {
    if (isPermissionMode(mode)) active.permissionMode = mode
    return state()
  })
  ipcMain.handle(IpcChannel.agentSetAgentMode, async (_event, mode: unknown) => {
    await loaded
    // Sistem istemi ve tool'lar moda bağlı: konuşmanın ortasında değişirse önbellek baştan yazılır
    if (active.messages.length > 0) {
      throw new Error(l('Mod yalnızca yeni bir konuşmada değiştirilebilir.', 'The mode can only be changed in a new conversation.'))
    }
    if (isAgentMode(mode) && mode !== active.agentMode) {
      active.agentMode = mode
      // Son seçilen mod sonraki yeni konuşmaların da başlangıcı olur
      stored.agentMode = mode
      await save()
    }
    return state()
  })
  ipcMain.handle(IpcChannel.agentSetApiKey, async (_event, providerId: unknown, key: unknown) => {
    await loaded
    const id = String(providerId)
    if (typeof key === 'string' && key.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          l(
            'Bu sistemde güvenli anahtar deposu yok; anahtarı ortam değişkeniyle ver.',
            'No secure key storage is available on this system; provide the key with an environment variable.'
          )
        )
      }
      stored.keys[id] = safeStorage.encryptString(key.trim()).toString('base64')
    } else {
      delete stored.keys[id]
    }
    await save()
    return state()
  })
  ipcMain.handle(IpcChannel.agentKeySource, (_event, providerId: unknown) => keySource(String(providerId)))
  ipcMain.handle(IpcChannel.agentCodexLogin, async () => {
    await loaded
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        l(
          'Bu sistemde güvenli anahtar deposu yok; ChatGPT oturumu saklanamaz.',
          'No secure key storage is available on this system, so the ChatGPT session cannot be saved.'
        )
      )
    }
    // Yeni deneme öncekini iptal eder: kullanıcı tarayıcıyı kapattıysa beklemeden tekrar deneyebilmeli
    codexLogin?.abort()
    const attempt = new AbortController()
    codexLogin = attempt
    try {
      const tokens = await loginWithChatGPT({
        onAuthUrl: (url) => void shell.openExternal(url).catch(() => {}),
        signal: attempt.signal
      })
      await saveCodex(tokens)
      // Yeni hesapla model listesi de değişir; indirilemezse yedek liste görünür
      await loadCodexModels(true)
      await loadCatalog().catch(() => {})
      return state()
    } finally {
      if (codexLogin === attempt) codexLogin = null
    }
  })
  ipcMain.handle(IpcChannel.agentCodexLogout, async () => {
    await loaded
    codexLogin?.abort()
    await saveCodex(null)
    delete stored.codexModels
    await save()
    await loadCatalog().catch(() => {})
    return state()
  })
  ipcMain.handle(IpcChannel.agentSend, (_event, text: unknown, problems: unknown, editor: unknown, images: unknown) =>
    run(
      String(text),
      Array.isArray(problems) ? (problems as ProblemReport[]) : [],
      parseEditorContextInput(editor),
      parseImageInput(images)
    )
  )
  ipcMain.handle(IpcChannel.agentBtw, (_event, id: unknown, question: unknown) => btw(Number(id), String(question)))
  ipcMain.handle(IpcChannel.agentBtwCancel, (_event, id: unknown) => btwControllers.get(Number(id))?.abort())
  ipcMain.handle(IpcChannel.agentListFiles, () => {
    const root = getProjectState().root
    return root ? listProjectFiles(root) : []
  })
  ipcMain.handle(IpcChannel.agentCancel, () => active.controller?.abort())
  // Yeni konuşma ya da başka konuşmaya geçiş süren turu durdurmaz: o konuşma arka planda devam eder
  ipcMain.handle(IpcChannel.agentReset, async () => {
    await loaded
    activate(freshConversation())
  })
  ipcMain.handle(IpcChannel.agentSessions, () => listSessions())
  ipcMain.handle(IpcChannel.agentLoadSession, async (_event, id: unknown) => {
    await loaded
    const target = String(id)
    // Arka planda süren (ya da zaten açık) konuşma bellekteki haliyle açılır; disktekinde son adımlar eksik olabilir
    const running = conversations.get(target)
    if (running) {
      activate(running)
      return state()
    }
    const found = await readSession(target)
    if (!found) throw new Error(l('Konuşma bulunamadı.', 'Conversation not found.'))
    const calls = found.calls ?? []
    activate({
      ...newConversation(stored.permissionMode, found.mode ?? DEFAULT_AGENT_MODE),
      id: found.id,
      saved: { title: found.title, projectRoot: found.projectRoot },
      messages: closeDanglingToolCalls(found.messages),
      goal: found.goal ?? null,
      calls,
      // Çağrı kaydı olan konuşmada toplam yeniden hesaplanır; eski kayıtta toplam tek başına durur
      legacyUsage: calls.length > 0 ? undefined : (found.usage ?? newUsage()),
      parent: found.parent ?? null,
      selection: found.selection ?? null,
      // Bellekte olmayan konuşmanın alt agent'ları çalışıyor olamaz (uygulama kapanmış olmalı)
      subagents: new Map(
        (found.subagents ?? []).map((info) => [info.callId, info.status === 'running' ? { ...info, status: 'cancelled' as const } : info])
      )
    })
    return state()
  })
  ipcMain.handle(IpcChannel.agentDeleteSession, async (_event, id: unknown) => {
    const target = String(id)
    if (!SESSION_ID.test(target)) throw new Error(l('Geçersiz konuşma kimliği.', 'Invalid conversation id.'))
    const conversation = conversations.get(target)
    if (conversation) {
      await settle(conversation)
      // Silinen konuşma bir daha diske yazılmasın
      conversation.saved = null
      conversations.delete(target)
      if (conversation === active) activate(freshConversation())
    }
    await sessionWrites
    // Alt agent konuşmaları başlatan konuşmayla birlikte silinir
    const children = conversation ? [...conversation.subagents.values()] : ((await readSession(target))?.subagents ?? [])
    for (const child of children) {
      const running = conversations.get(child.sessionId)
      if (running) {
        await settle(running)
        running.saved = null
        conversations.delete(child.sessionId)
      }
      if (SESSION_ID.test(child.sessionId)) await rm(sessionPath(child.sessionId), { force: true })
    }
    await rm(sessionPath(target), { force: true })
    return state()
  })
  ipcMain.on(IpcChannel.agentApproval, (_event, id: unknown, approved: unknown) => {
    pendingApprovals.get(Number(id))?.done(approved === true)
  })

  // Ayarlar penceresi açıldığında beklemesin diye kataloğu arka planda hazırla
  void loadCatalog().catch(() => {})
}

function newUsage(): SessionUsage {
  return { tokens: emptyUsage(), cost: 0, costKnown: true }
}

function readUsage(raw: unknown): SessionUsage | undefined {
  const r = raw as Partial<SessionUsage> | null
  const tokens = readTokens(r?.tokens)
  if (!tokens || typeof r?.cost !== 'number') return undefined
  return { tokens, cost: r.cost, costKnown: r.costKnown !== false }
}

/** Diskteki çağrı kayıtları; bozuk girdiler sessizce atlanır. */
function readCalls(raw: unknown): CallUsage[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const calls: CallUsage[] = []
  for (const item of raw) {
    const r = item as Partial<CallUsage> | null
    const tokens = readTokens(r?.tokens)
    const at = finite(r?.at)
    if (!tokens || at === undefined) continue
    calls.push({
      at,
      providerId: typeof r?.providerId === 'string' ? r.providerId : '',
      modelId: typeof r?.modelId === 'string' ? r.modelId : '',
      turn: finite(r?.turn) ?? 0,
      tokens,
      cost: readCost(r?.cost)
    })
  }
  return calls
}

function readTokens(raw: unknown): TokenUsage | undefined {
  const t = raw as Partial<TokenUsage> | null
  if (!t || typeof t !== 'object') return undefined
  const input = finite(t.input)
  const cacheRead = finite(t.cacheRead)
  const cacheWrite = finite(t.cacheWrite)
  const output = finite(t.output)
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) return undefined
  const cacheWrite1h = finite(t.cacheWrite1h)
  const reasoning = finite(t.reasoning)
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning })
  }
}

function readCost(raw: unknown): UsageCost | null {
  const c = raw as Partial<UsageCost> | null
  if (!c || typeof c !== 'object') return null
  const input = finite(c.input)
  const output = finite(c.output)
  const cacheRead = finite(c.cacheRead)
  const cacheWrite = finite(c.cacheWrite)
  const total = finite(c.total)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || total === undefined) {
    return null
  }
  return { input, output, cacheRead, cacheWrite, total }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Kullanıcı mesajı sayısı (tool sonuçları ve sıkıştırma özeti `user` rolündedir, onlar sayılmaz). */
function countTurns(history: Message[]): number {
  return history.filter(isUserTextMessage).length
}

/** Kullanıcının gerçekten yazdığı metni taşıyan mesaj mı; yalnızca özet/bağlam blokları taşıyanlar değil. */
function isUserTextMessage(message: Message): boolean {
  return message.role === 'user' && message.content.some((block) => block.type === 'text' && !isConversationSummary(block.text))
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** Başarılı bir yazma tool'unun değiştirdiği dosyanın mutlak yolu. */
async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** `/btw` sorusunun başına eklenir: modele bunun ana işten ayrı, tool'suz bir yan soru olduğunu söyler. */
const BTW_PREFIX = [
  '<side_question>',
  'This is a quick side question from the user, separate from the main task. It is answered once and is not kept in the conversation.',
  'Answer it directly and concisely from what you already know and the conversation so far. Do not call any tools and do not continue the main task.',
  '</side_question>'
].join('\n')

function readParent(raw: unknown): { id: string; title: string } | undefined {
  const r = raw as { id?: unknown; title?: unknown } | null
  return typeof r?.id === 'string' && typeof r.title === 'string' ? { id: r.id, title: r.title } : undefined
}

function readSelection(raw: unknown): ModelSelection | undefined {
  const r = raw as Partial<ModelSelection> | null
  if (typeof r?.providerId !== 'string' || typeof r.modelId !== 'string') return undefined
  return { providerId: r.providerId, modelId: r.modelId, effort: typeof r.effort === 'string' ? r.effort : null }
}

function isSubagentInfo(raw: unknown): raw is AgentSubagentInfo {
  const r = raw as Partial<AgentSubagentInfo> | null
  return typeof r?.callId === 'string' && typeof r.sessionId === 'string' && typeof r.title === 'string' && !!r.usage
}

/** Alt agent'ın son yanıtındaki metin; ana agent'a tool sonucu olarak döner. */
function finalText(messages: readonly Message[]): string {
  const last = messages.findLast((message) => message.role === 'assistant')
  return (last?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim()
}

const READ_ONLY_SUBAGENT = () =>
  l(
    'Bu bir alt agent konuşması; yalnızca izlenebilir. Ana konuşmaya dönüp oradan devam et.',
    'This is a subagent conversation and is read-only. Go back to the main conversation to continue.'
  )

/** Alt agent'ın sistem istemine eklenir: kullanıcıyla değil ana agent'la konuştuğunu söyler. */
const SUBAGENT_INSTRUCTIONS = [
  '# Subagent',
  'You are a subagent: the main agent gave you the task in the first message. The user does not read your replies; your final message is returned to the main agent as the result.',
  '- Work on the task until it is done, without asking questions. If something blocks you, stop and explain what is missing.',
  '- End with a concise, complete report: what you found or changed (with file paths and line numbers), and anything left undone. Write it in English unless the task says otherwise.'
].join('\n')

/** Sonucu gelmemiş tool çağrılarına "iptal edildi" sonucu ekler; aksi halde sonraki istek reddedilir. */
function closeDanglingToolCalls(history: Message[], content = 'Cancelled by the user.'): Message[] {
  const last = history.at(-1)
  if (!last || last.role !== 'assistant') return history
  const calls = toolCalls(last)
  if (calls.length === 0) return history
  return [
    ...history,
    {
      role: 'user',
      content: calls.map((call) => ({ type: 'tool_result', callId: call.id, content, isError: true }))
    }
  ]
}

function systemPrompt(
  root: string | null,
  skriptVersion: string,
  addons: readonly { name: string; version: string }[],
  mode: AgentMode
): string {
  const addonText = addons.length ? addons.map((addon) => `${addon.name} ${addon.version}`).join(', ') : 'none'
  return [
    'You are the AI assistant built into Skript IDE, an editor for Minecraft Skript (.sk) scripts.',
    '',
    '# Project',
    root ? `- Project folder: ${root}` : '- No project folder is open, so file tools are unavailable. Ask the user to open a folder if you need files.',
    `- Skript version: ${skriptVersion}`,
    `- Addons: ${addonText}`,
    '',
    '# Scope',
    SCOPE_INSTRUCTIONS,
    '',
    modeInstructions(mode),
    '',
    '# How to work',
    '- File paths in tool calls are relative to the project folder.',
    '- Find files by name with find_files and search their contents with search_files. For .sk files, get_outline shows where events, commands and functions are; find_definition and find_references follow functions, variables and options across scripts.',
    '- Create new files with write_file. Change existing files with edit_file: read the file first, and keep edits small and focused. For several changes in one file use multi_edit; to rename a function, variable or option everywhere use rename_symbol. Move, rename or delete files with move_file and delete_file. Depending on the permission mode the user chose, a change is shown as a diff and runs only if they approve it, or is applied directly.',
    '- Keep everything in one .sk file unless the user asks for more files: add to the file the user has open or is working on, and if a new script is needed, create just one file for it. Do not split code into helper, library, config or test files; put functions, options, generated display code and test commands in that same file.',
    '- Skript is indentation-based: keep the file\'s existing indentation (tabs or spaces) exactly.',
    `- Only use syntax that exists in Skript ${skriptVersion} and the listed addons. If you are not sure a pattern exists, look it up with search_syntax and get_syntax_docs; if it is not there, say so instead of guessing.`,
    '- When search_syntax prints a "Not available in this project (addon not installed)" section, that syntax needs an addon the project does not use: name the addon and suggest installing it instead of writing the syntax.',
    '- Before writing Skript syntax you are not sure about, call explain_line (pass code plus an optional context such as "on join:", or path and line) to see which syntax entry and pattern it matches; when nothing matches it lists the closest patterns and the missing or misspelled word.',
    '- Use inspect_position on an existing line to get its hover documentation, the enclosing event and its event values, local variables and options in scope, and a short completion list, instead of guessing whether an event value or expression exists there.',
    '- For real-world idioms use search_examples. Snippets come from real scripts and may target another Skript version or addons the project does not use, so verify anything you copy.',
    '- Edits to .sk files already report the new errors and warnings they introduce (with quick fixes when available). Fix those before moving on; use get_diagnostics only for a full check of a file or the whole project.',
    '- When the user wants proof that a script really loads, use validate_on_server. When they want proof that it works at runtime, use test_script: it loads one .sk file on the local test server, runs console commands, checks expect/forbid output, and unloads the script afterwards. run_server_command runs console commands on the test server, and get_server_log shows its recent console output.',
    '- The test server console is not a player: player-only events (on join, on break, ...) never fire and "!" effect commands are unavailable. Test such logic through a console-executable command in the script instead.',
    '- Before changing the project\'s Skript version, call get_migration_notes with the current and target versions to find removed or changed syntax.',
    '- Use get_project_info when the Skript version, addons or validation server state matter.',
    '- Never guess Minecraft value names: lookup_minecraft_data gives the exact particle, enchantment, potion, biome, damage cause and other names for this Skript version; for items, blocks and entity types call dump_type_values once.',
    '- Before adding or renaming global variables, and when a variable "is always empty", run inspect_variables: it maps where every variable is set and read and flags typos and unset variables. get_call_graph does the same for functions (undefined calls, wrong argument counts, unused functions), and list_commands for commands (duplicate names and aliases, clashes with vanilla or EssentialsX).',
    '- When indentation errors appear, fix them with format_script instead of re-indenting by hand.',
    '- Check message strings with preview_text (colors, tags, Skript quirks such as <red> being dark red) and inventory menus with preview_gui (slot grid and legend) instead of imagining how they look.',
    '- When the user mentions lag or code runs in frequent events (move, every tick, physics), run analyze_performance.',
    '- For skript-reflect or exact Java names, use search_java_api and get_java_class (Paper javadoc for the server\'s Minecraft version).',
    '- Before a large refactor or migration, save a create_checkpoint; restore_checkpoint undoes it if the result is worse.',
    '- You may call several read-only tools in one response; they run in parallel. File changes and commands run one at a time, in the order you list them.',
    '- When run_subagent is available, you can hand self-contained work to subagents: broad searches or reviews that would flood your context, or independent tasks that can run in parallel (call it several times in one response). Give each a complete prompt, since it cannot see this conversation; pick a cheaper model or lower effort from list_models for simple work. Do not use subagents for small tasks you can do directly.',
    '- For multi-step work (3 or more steps) keep the plan with update_todos: put the whole list in one call, mark a step in_progress before starting it and completed as soon as it is done. Do not use it for simple one-step requests.',
    '- Reply in the language the user writes in.',
    '- The chat panel renders Markdown headings (#, ##, ###), **bold**, `inline code` and ``` code blocks; other Markdown is shown as plain text.',
    '',
    '# Skript guide',
    SKRIPT_GUIDE,
    '',
    '# Math and block displays',
    GEOMETRY_INSTRUCTIONS,
    '',
    '# Editor',
    EDITOR_CONTEXT_INSTRUCTIONS,
    '',
    '# Project instructions',
    PROJECT_MEMORY_INSTRUCTIONS,
    '',
    '# Memory',
    MEMORY_INSTRUCTIONS,
    '',
    '# Goal',
    GOAL_INSTRUCTIONS
  ].join('\n')
}

/** Proje içindeki mutlak yolu köke göre `/` ile yazar; dışındakiler (adsız belgeler dahil) olduğu gibi kalır. */
function projectPath(root: string | null, path: string): string {
  if (!root || !isAbsolute(path)) return path
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path
}
