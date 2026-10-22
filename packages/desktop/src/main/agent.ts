import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  coreTools,
  createSkriptTools,
  addUsage,
  calculateCost,
  codexCatalogProvider,
  codexModelsUrl,
  CODEX_FALLBACK_MODELS,
  CODEX_PROVIDER_ID,
  createProvider,
  emptyUsage,
  DEFAULT_PERMISSION_MODE,
  estimateContextTokens,
  estimateTextTokens,
  fetchCatalog,
  GOAL_INSTRUCTIONS,
  goalUpdate,
  isPermissionMode,
  isProblemsMention,
  listProjectFiles,
  needsRefresh,
  parseAttachment,
  parseCodexModels,
  parseGoal,
  parseMentions,
  problemsAttachmentText,
  promptTokens,
  ProviderError,
  readMentions,
  refreshTokens,
  runAgent,
  scanCacheMisses,
  textMessage,
  ToolRegistry,
  toolCalls,
  type ApprovalRequest,
  type CallUsage,
  type CatalogModel,
  type CatalogProvider,
  type CodexTokens,
  type Message,
  type PriceRates,
  type ProblemReport,
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
  type AgentSessionInfo,
  type AgentSettings,
  type AgentState,
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

interface StoredAgentFile extends AgentSettings {
  /** Sağlayıcı kimliği → `safeStorage` ile şifrelenmiş anahtarın base64'ü. */
  keys: Record<string, string>
  /** ChatGPT aboneliği oturumu: `safeStorage` ile şifrelenmiş `CodexTokens` JSON'u (base64). */
  codex?: string
  /** Aboneliğin model listesi (`/models`); indirilemezse yedek liste kullanılır. */
  codexModels?: { fetchedAt: number; models: CatalogModel[] }
}

interface CatalogCache {
  fetchedAt: number
  providers: CatalogProvider[]
}

/** Diskteki konuşma: `userData/agent-sessions/<id>.json`. */
interface StoredSession extends AgentSessionInfo {
  messages: Message[]
  goal?: string | null
  /** Eski kayıtlarda yok. */
  usage?: SessionUsage
  /** Çağrı bazlı kullanım; eski kayıtlarda yok (o zaman yalnızca `usage` toplamı vardır). */
  calls?: CallUsage[]
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
  /** Mutlak yol → dosyanın turdan önceki içeriği ve agent'ın bıraktığı son içerik. */
  files: Map<string, { path: string; original: string; current: string }>
}

const sessionsDir = () => join(app.getPath('userData'), 'agent-sessions')
const sessionPath = (id: string) => join(sessionsDir(), `${id}.json`)
const SESSION_ID = /^[0-9a-f-]{36}$/
const MAX_TITLE = 60

const settingsPath = () => join(app.getPath('userData'), 'agent.json')
const catalogPath = () => join(app.getPath('userData'), 'agent-catalog.json')

/**
 * AI agent'ı ana süreçte çalıştırır: API anahtarları ve dosya erişimi arayüze hiç girmez.
 * Arayüz mesaj gönderir, olayları `agent:event` kanalından izler, yazma işlemlerini onaylar.
 */
export function setupAgent(getWindow: () => BrowserWindow | null, server: SkriptServer): void {
  const registry = new ToolRegistry([...coreTools, ...createSkriptTools()])
  // Arayüzdeki dil sunucusu worker'ından ayrı bir örnek: agent dosyaları diskten okur, editörün
  // kaydedilmemiş belgeleriyle karışmaz. Sürüm ve addon'lar her mesajda projeye göre ayarlanır.
  const languageService = new SkriptLanguageService({ loadDatabase: loadSyntaxDatabase })
  let stored: StoredAgentFile = { providerId: null, modelId: null, effort: null, permissionMode: DEFAULT_PERMISSION_MODE, keys: {} }
  /** Açık konuşmada geçerli mod; yeni konuşma/uygulama açılışında varsayılana döner. */
  let permissionMode = stored.permissionMode
  let catalog: CatalogCache | null = null
  let catalogLoading: Promise<CatalogProvider[]> | null = null
  let messages: Message[] = []
  /** Açık konuşma; ilk mesaja kadar yok, ilk mesajla birlikte diske yazılmaya başlar. */
  let session: { id: string; title: string; projectRoot: string | null } | null = null
  let sessionWrites: Promise<void> = Promise.resolve()
  let goal: string | null = null
  /** Çağrı bazlı kullanım; önbellek analizi ve `/usage` dökümü bundan türetilir. */
  let calls: CallUsage[] = []
  /** Çağrı kaydı olmayan eski konuşmaların toplamı; yeni konuşmalarda `undefined`. */
  let legacyUsage: SessionUsage | undefined
  /** Yalnızca bellekte: uygulama kapanınca ya da konuşma değişince `/undo` dosyaları geri alamaz. */
  let checkpoints: Checkpoint[] = []
  let controller: AbortController | null = null
  /** Açık ChatGPT giriş denemesi; ikinci bir giriş aynı bağlantı noktasını beklemesin. */
  let codexLogin: AbortController | null = null
  let nextApprovalId = 1
  const pendingApprovals = new Map<number, (approved: boolean) => void>()

  const send = (event: AgentUiEvent) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.agentEvent, event)
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
        ...(typeof raw.codex === 'string' ? { codex: raw.codex } : {}),
        ...(raw.codexModels && Array.isArray(raw.codexModels.models)
          ? { codexModels: { fetchedAt: Number(raw.codexModels.fetchedAt) || 0, models: raw.codexModels.models } }
          : {})
      }
      permissionMode = stored.permissionMode
    } catch {
      // İlk açılış ya da bozuk dosya: varsayılanlarla devam
    }
  })()

  const save = () => writeFile(settingsPath(), JSON.stringify(stored, null, 2) + '\n', 'utf8')

  // --- Konuşma geçmişi ---

  /** Açık konuşmayı diske yazar; yazmalar sırayla yapılır, hata konuşmayı bozmaz. */
  function persistSession(): Promise<void> {
    if (!session || messages.length === 0) return sessionWrites
    const record: StoredSession = {
      ...session,
      updatedAt: Date.now(),
      turns: countTurns(messages),
      messages,
      goal,
      // Toplam ayrıca yazılır: konuşma listesi ve eski sürümler tek alandan okuyabilsin
      usage: sessionTotal(),
      calls
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
        usage: readUsage(raw.usage),
        calls: readCalls(raw.calls)
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
      .filter((s): s is StoredSession => s !== null)
      .map(({ messages: _messages, goal: _goal, usage: _usage, calls: _calls, ...info }) => info)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function stopRun(): void {
    controller?.abort()
  }

  // --- Katalog ---

  async function readCatalogCache(): Promise<CatalogCache | null> {
    try {
      const raw = JSON.parse(await readFile(catalogPath(), 'utf8')) as CatalogCache
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
        catalog = { fetchedAt: Date.now(), providers }
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

  async function findSelection(): Promise<{ provider: CatalogProvider; model: CatalogModel }> {
    if (!stored.providerId || !stored.modelId) {
      throw new Error(l('Önce agent ayarlarından bir model seç.', 'Choose a model in the agent settings first.'))
    }
    const providers = await loadCatalog()
    const provider = providers.find((p) => p.id === stored.providerId)
    const model = provider?.models.find((m) => m.id === stored.modelId)
    if (!provider || !model) {
      throw new Error(
        l(
          `Seçili model (${stored.providerId}/${stored.modelId}) katalogda artık yok; başka bir model seç.`,
          `The selected model (${stored.providerId}/${stored.modelId}) is no longer in the catalog; choose another model.`
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

  async function state(): Promise<AgentState> {
    await loaded
    return {
      settings: {
        providerId: stored.providerId,
        modelId: stored.modelId,
        effort: stored.effort,
        permissionMode: stored.permissionMode
      },
      permissionMode,
      sessionId: session?.id ?? null,
      running: controller !== null,
      messages,
      keySource: await keySource(stored.providerId),
      configuredProviders: configuredProviders(),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      codex: codexStatus(),
      goal,
      usage: usageSummary()
    }
  }

  /**
   * Çağrı kayıtlarından oturum toplamı. Eski konuşmaya yeni mesaj eklenirse eski toplam
   * korunur; yalnızca çağrı kaydı olmayan konuşmalarda toplam tek başına geçerlidir.
   */
  function sessionTotal(): SessionUsage {
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

  /** Seçili model; katalog henüz yüklenmediyse `undefined`. */
  function selectedModel(): CatalogModel | undefined {
    const provider = catalog?.providers.find((p) => p.id === stored.providerId)
    return provider?.models.find((m) => m.id === stored.modelId)
  }

  /**
   * Bağlam boyu: son çağrının sağlayıcıdan gelen kesin hacmi ve (çalışmıyorken) sonrasındaki
   * mesajların tahmini. Çalışırken `messages` bu turun istemini de içerdiği için tahmin eklenmez.
   */
  function contextTokens(): number {
    const last = calls.at(-1)
    if (!last) {
      const project = getProjectState()
      const system = systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? [])
      const tools = estimateTextTokens(JSON.stringify(registry.definitions()))
      return estimateContextTokens(messages) + estimateTextTokens(system) + tools
    }
    return estimateContextTokens(controller ? [] : messages, last)
  }

  function usageSummary(): AgentUsage {
    const total = sessionTotal()
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
      contextTokens: contextTokens(),
      contextWindow: selectedModel()?.contextWindow ?? 0,
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
  function noteCall(call: CallUsage): void {
    calls.push(call)
    const miss = scanCacheMisses(calls, priceOf).misses.get(call)
    if (!miss) return
    if (miss.missedTokens < CACHE_MISS_MIN_TOKENS && miss.missedCost < CACHE_MISS_MIN_COST) return
    send({
      type: 'cache-miss',
      missedTokens: miss.missedTokens,
      missedCost: miss.missedCost,
      idleMs: miss.idleMs,
      // Beş dakikalık varsayılan ömürden uzun boşluk, miss'in en olası nedeni
      reason: miss.modelChanged ? 'model' : miss.idleMs >= CACHE_TTL_MS ? 'idle' : 'other'
    })
  }

  // --- Çalıştırma ---

  function requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const id = nextApprovalId++
    return new Promise((resolvePromise) => {
      const done = (approved: boolean) => {
        pendingApprovals.delete(id)
        resolvePromise(approved)
      }
      pendingApprovals.set(id, done)
      signal.addEventListener('abort', () => done(false), { once: true })
      send({ type: 'approval-request', id, request })
    })
  }

  async function run(text: string, problems: ProblemReport[] = []): Promise<void> {
    await loaded
    if (controller) throw new Error(l('Agent zaten çalışıyor.', 'The agent is already running.'))
    const { provider, model } = await findSelection()
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
    // Hedef sistem istemine değil, değiştiği ilk mesaja eklenir; geçmiş yalnızca büyür, önbellek korunur
    const goalBlock = goalUpdate(messages, goal)
    if (goalBlock) attachments.push({ type: 'text', text: goalBlock })
    const userMessage: Message = { role: 'user', content: [...textMessage('user', text).content, ...attachments] }
    const checkpoint: Checkpoint = { baseLength: messages.length, files: new Map() }
    checkpoints.push(checkpoint)
    const history = [...messages, userMessage]
    messages = history
    session ??= { id: randomUUID(), title: titleFrom(text), projectRoot: project.root }
    void persistSession()
    send({ type: 'user-message', message: userMessage })

    controller = new AbortController()
    const signal = controller.signal
    // Bu turun numarası: çağrılar buna göre gruplanır, `/undo` geri alırken bununla kırpar
    const turn = countTurns(history)
    // Hata ya da iptalde de konuşmanın tutarlı kalması için olaylardan izlenen geçmiş
    const tracked = [...history]
    let pendingChange: ApprovalRequest['change'] | undefined
    let pendingResults: ToolResultBlock[] = []
    const flushResults = () => {
      if (pendingResults.length) tracked.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }

    try {
      const result = await runAgent({
        provider: createProvider(provider, model, {
          apiKey,
          effort: stored.effort ?? undefined,
          codexAuth: subscription ? codexAuth : undefined,
          sessionId: session?.id
        }),
        registry,
        permissionMode: () => permissionMode,
        system: systemPrompt(project.root, project.settings.skriptVersion, project.settings.addons ?? []),
        messages: history,
        context: {
          projectRoot: project.root,
          signal,
          languageService,
          server,
          requestApproval: (request) => {
            pendingChange = request.change
            return requestApproval(request, signal)
          }
        },
        onEvent: (event) => {
          if (event.type === 'assistant-message') {
            flushResults()
            tracked.push(event.message)
            send(event)
          } else if (event.type === 'usage') {
            noteCall({
              at: Date.now(),
              providerId: provider.id,
              modelId: model.id,
              turn,
              tokens: event.usage,
              cost: calculateCost(event.usage, model.cost)
            })
            send({ type: 'usage', usage: usageSummary() })
            void persistSession()
          } else if (event.type === 'delta' || event.type === 'tool-start') {
            send(event)
          } else if (event.type === 'tool-result') {
            pendingResults.push(event.result)
            send(event)
            const path = changedPath(event.call.name, event.call.input, event.result, project.root)
            if (path) {
              if (pendingChange) {
                const known = checkpoint.files.get(path)
                checkpoint.files.set(path, {
                  path: pendingChange.path,
                  original: known?.original ?? pendingChange.before,
                  current: pendingChange.after
                })
              }
              send({ type: 'file-changed', path })
            }
          }
        }
      })
      messages = result.messages
      send({ type: 'done', reason: result.reason })
    } catch (error) {
      flushResults()
      messages = closeDanglingToolCalls(tracked)
      if (signal.aborted) send({ type: 'done', reason: 'cancelled' })
      else send({ type: 'done', reason: 'error', error: (error as Error).message })
    } finally {
      controller = null
      pendingApprovals.clear()
      void persistSession()
    }
  }

  /** Çalışan turu durdurup bitmesini bekler; böylece geçmiş değiştirilirken tur araya yazmaz. */
  async function settle(): Promise<void> {
    stopRun()
    while (controller) await new Promise((r) => setTimeout(r, 20))
  }

  /** Son kullanıcı mesajını ve sonrasını siler; o turda agent'ın yazdığı dosyaları, hâlâ agent'ın bıraktığı haldeyse, eski haline döndürür. */
  async function undo(): Promise<AgentUndoResult> {
    await settle()
    const checkpoint = checkpoints.pop()
    let baseLength = checkpoint ? Math.min(checkpoint.baseLength, messages.length) : -1
    if (baseLength < 0) baseLength = messages.findLastIndex((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'))
    const removed = baseLength >= 0 ? messages[baseLength] : undefined
    const restored: string[] = []
    const skipped: string[] = []
    if (!removed) return { state: await state(), text: null, restored, skipped }

    for (const [file, entry] of checkpoint?.files ?? []) {
      try {
        if ((await readFile(file, 'utf8')) !== entry.current) {
          skipped.push(entry.path)
          continue
        }
        await writeFile(file, entry.original, 'utf8')
        restored.push(entry.path)
        send({ type: 'file-changed', path: file })
      } catch {
        skipped.push(entry.path)
      }
    }
    // Eklenen dosya içerikleri girişe geri konmaz; `@etiket`ler metinde zaten duruyor
    const text = removed.content.flatMap((b) => (b.type === 'text' && !parseAttachment(b.text) && parseGoal(b.text) === undefined ? [b.text] : [])).join('\n')
    messages = messages.slice(0, baseLength)
    // Geri alınan turun kullanımı toplamlardan da düşsün
    const remainingTurns = countTurns(messages)
    calls = calls.filter((call) => call.turn <= remainingTurns)
    if (messages.length === 0) {
      session = null
      calls = []
      legacyUsage = undefined
    } else void persistSession()
    return { state: await state(), text, restored, skipped }
  }

  // --- IPC ---

  ipcMain.handle(IpcChannel.agentUndo, () => undo())
  ipcMain.handle(IpcChannel.agentSetGoal, async (_event, raw: unknown) => {
    goal = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    void persistSession()
    return state()
  })
  ipcMain.handle(IpcChannel.agentState, () => state())
  ipcMain.handle(IpcChannel.agentProviders, (_event, refresh: unknown) => loadCatalog(refresh === true))
  ipcMain.handle(IpcChannel.agentSetSettings, async (_event, raw: Partial<AgentSettings>) => {
    await loaded
    stored.providerId = typeof raw?.providerId === 'string' ? raw.providerId : null
    stored.modelId = typeof raw?.modelId === 'string' ? raw.modelId : null
    stored.effort = typeof raw?.effort === 'string' ? raw.effort : null
    if (isPermissionMode(raw?.permissionMode) && raw.permissionMode !== stored.permissionMode) {
      stored.permissionMode = raw.permissionMode
      // Varsayılanı değiştiren kullanıcı bunun hemen geçerli olmasını bekler
      permissionMode = raw.permissionMode
    }
    await save()
    return state()
  })
  ipcMain.handle(IpcChannel.agentSetPermissionMode, async (_event, mode: unknown) => {
    if (isPermissionMode(mode)) permissionMode = mode
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
  ipcMain.handle(IpcChannel.agentSend, (_event, text: unknown, problems: unknown) =>
    run(String(text), Array.isArray(problems) ? (problems as ProblemReport[]) : [])
  )
  ipcMain.handle(IpcChannel.agentListFiles, () => {
    const root = getProjectState().root
    return root ? listProjectFiles(root) : []
  })
  ipcMain.handle(IpcChannel.agentCancel, () => controller?.abort())
  ipcMain.handle(IpcChannel.agentReset, async () => {
    await settle()
    messages = []
    session = null
    goal = null
    calls = []
    legacyUsage = undefined
    checkpoints = []
    permissionMode = stored.permissionMode
  })
  ipcMain.handle(IpcChannel.agentSessions, () => listSessions())
  ipcMain.handle(IpcChannel.agentLoadSession, async (_event, id: unknown) => {
    await settle()
    const found = await readSession(String(id))
    if (!found) throw new Error(l('Konuşma bulunamadı.', 'Conversation not found.'))
    messages = closeDanglingToolCalls(found.messages)
    session = { id: found.id, title: found.title, projectRoot: found.projectRoot }
    goal = found.goal ?? null
    calls = found.calls ?? []
    // Çağrı kaydı olan konuşmada toplam yeniden hesaplanır; eski kayıtta toplam tek başına durur
    legacyUsage = calls.length > 0 ? undefined : (found.usage ?? newUsage())
    checkpoints = []
    return state()
  })
  ipcMain.handle(IpcChannel.agentDeleteSession, async (_event, id: unknown) => {
    const target = String(id)
    if (!SESSION_ID.test(target)) throw new Error(l('Geçersiz konuşma kimliği.', 'Invalid conversation id.'))
    if (session?.id === target) {
      await settle()
      messages = []
      session = null
      goal = null
      calls = []
      legacyUsage = undefined
      checkpoints = []
    }
    await sessionWrites
    await rm(sessionPath(target), { force: true })
    return state()
  })
  ipcMain.on(IpcChannel.agentApproval, (_event, id: unknown, approved: unknown) => {
    pendingApprovals.get(Number(id))?.(approved === true)
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

/** Kullanıcı mesajı sayısı (tool sonuçları da `user` rolünde gelir, onlar sayılmaz). */
function countTurns(history: Message[]): number {
  return history.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text')).length
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
function changedPath(tool: string, input: unknown, result: ToolResultBlock, root: string | null): string | null {
  if (result.isError || !root || tool !== 'edit_file') return null
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' ? resolve(root, path) : null
}

/** Sonucu gelmemiş tool çağrılarına "iptal edildi" sonucu ekler; aksi halde sonraki istek reddedilir. */
function closeDanglingToolCalls(history: Message[]): Message[] {
  const last = history.at(-1)
  if (!last || last.role !== 'assistant') return history
  const calls = toolCalls(last)
  if (calls.length === 0) return history
  return [
    ...history,
    {
      role: 'user',
      content: calls.map((call) => ({ type: 'tool_result', callId: call.id, content: 'Cancelled by the user.', isError: true }))
    }
  ]
}

function systemPrompt(
  root: string | null,
  skriptVersion: string,
  addons: readonly { name: string; version: string }[]
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
    '# How to work',
    '- File paths in tool calls are relative to the project folder.',
    '- Read a file before editing it, and keep edits small and focused. Depending on the permission mode the user chose, an edit is shown as a diff and runs only if they approve it, or is applied directly.',
    '- Skript is indentation-based: keep the file\'s existing indentation (tabs or spaces) exactly.',
    `- Only use syntax that exists in Skript ${skriptVersion} and the listed addons. If you are not sure a pattern exists, look it up with search_syntax and get_syntax_docs; if it is not there, say so instead of guessing.`,
    '- After editing a .sk file, check it with get_diagnostics and fix the errors you introduced. When the user wants proof that a script really loads, use validate_on_server.',
    '- Use get_project_info when the Skript version, addons or validation server state matter.',
    '- Reply in the language the user writes in.',
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
