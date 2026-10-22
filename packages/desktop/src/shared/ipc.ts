/** Ana süreç ile arayüz arasındaki sözleşme. Preload bunu `window.skriptIde` olarak açar. */

import type {
  AgentStopReason,
  ApprovalRequest,
  CatalogProvider,
  Message,
  PermissionMode,
  ProblemReport,
  StreamDelta,
  ToolCallBlock,
  ToolResultBlock
} from '@skript-ide/agent'
import type { Locale } from '@skript-ide/i18n'
import type {
  AddonIssue,
  AddonSelection,
  ServerStatus,
  SkriptRuntimeProfile,
  ValidationResult
} from '@skript-ide/runtime-validator'

export type {
  ApprovalRequest,
  CatalogModel,
  CatalogProvider,
  ContentBlock,
  Message,
  PermissionMode,
  ProblemReport,
  ToolCallBlock
} from '@skript-ide/agent'
export type {
  AddonIssue,
  AddonLoadStatus,
  AddonSelection,
  ServerState,
  ServerStatus,
  SkriptDiagnostic,
  SkriptRuntimeProfile,
  ValidationResult
} from '@skript-ide/runtime-validator'

/** Açılan klasörün kökündeki proje ayar dosyası. */
export const PROJECT_FILE_NAME = 'skript-project.json'

/** `skript-project.json` içeriği. Bilinmeyen alanlar yazarken korunur. */
export interface ProjectSettings {
  skriptVersion: string
  /** İleride: doğrulama sunucusu için Paper/Minecraft sürümünü elle seçmek. */
  serverVersion?: string
  /** Projede kullanılan addon'lar; dosyada `{ "SkBee": "3.26.0" }` biçiminde durur. */
  addons?: AddonSelection[]
}

export interface ProjectState {
  /** Açık klasör; yalnızca tek tek dosyalar açıldıysa `null`. */
  root: string | null
  settings: ProjectSettings
  /** Ayarlar `skript-project.json` dosyasından mı okundu (yoksa varsayılan mı). */
  fromFile: boolean
  /** Dosya okunamadıysa ya da desteklenmeyen bir sürüm içeriyorsa kullanıcıya gösterilecek uyarı. */
  warning?: string
  /** Seçili addon'ların seçili Skript sürümüyle uyumluluk sorunları (bilinmeyen, uyumsuz, denenmemiş…). */
  addonIssues?: AddonIssue[]
}

/** Sürüm seçicide gösterilen seçenek: uyumluluk tablosu + bu makinedeki Java durumu. */
export interface SkriptVersionOption extends SkriptRuntimeProfile {
  isDefault: boolean
  /** Gereken Java bu makinede bulundu mu (`null`: henüz bakılmadı). */
  javaAvailable: boolean | null
}

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export type MenuAction =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'close-tab'
  | 'validate'
  | 'go-to-symbol'
  | 'addons'
  | 'migration'
  | 'toggle-agent'

export interface ValidateRequest {
  /** Sonucu belgeyle eşlemek için kimlik: dosya yolu ya da kaydedilmemiş belgede `untitled:<id>`. */
  source: string
  fileName: string
  content: string
}

// --- AI agent ---

/** Kullanıcının seçtiği sağlayıcı/model; `userData/agent.json`'da saklanır (API anahtarları ayrı, şifreli). */
export interface AgentSettings {
  providerId: string | null
  modelId: string | null
  /** Modelin desteklediği `effort` seviyelerinden biri; `null`: sağlayıcının varsayılanı. */
  effort: string | null
  /** Yeni konuşmaların başladığı izin modu (varsayılan). */
  permissionMode: PermissionMode
}

/** API anahtarının nereden geldiği: uygulamada şifreli kayıt, ortam değişkeni, ChatGPT oturumu ya da hiç. */
export type ApiKeySource = 'stored' | 'env' | 'subscription' | 'none'

/** ChatGPT aboneliğiyle giriş yapılmış hesap; arayüzde yalnızca gösterilecek bilgiler. */
export interface CodexAccount {
  signedIn: boolean
  email: string | null
  /** `plus`, `pro`, `team`… */
  plan: string | null
}

/** Kayıtlı bir konuşmanın liste görünümü (mesajlar olmadan). */
export interface AgentSessionInfo {
  id: string
  title: string
  /** Epoch ms. */
  updatedAt: number
  /** Konuşmanın yapıldığı proje klasörü; projesiz konuşmada `null`. */
  projectRoot: string | null
  /** Kullanıcının gönderdiği mesaj sayısı. */
  turns: number
}

/** Konuşmanın şimdiye dek harcadığı token'lar, önbellek performansı ve maliyeti. */
export interface AgentUsage {
  /** Önbelleğe isabet etmeyen girdi (önbelleğe yazılanlar hariç). */
  uncached: number
  /** Önbellekten okunan girdi. */
  cached: number
  /** Önbelleğe yazılan girdi (yalnızca yazmayı bildiren sağlayıcılarda). */
  written: number
  output: number
  /** USD; model fiyatı kataloğda yoksa `null`. */
  cost: number | null
  /** Son turun önbellek isabet oranı (%); çağrı yoksa `null`. */
  hitRate: number | null
  /** Konuşma geneli isabet oranı (%); girdi yoksa `null`. */
  totalHitRate: number | null
  /** Bağlam boyu tahmini; bilinmiyorsa 0. */
  contextTokens: number
  /** Seçili modelin bağlam penceresi; bilinmiyorsa 0. */
  contextWindow: number
  /** Önbellek isabetsizliği yüzünden yeniden faturalanan token'lar. */
  reBilledTokens: number
  /** Bu token'ların önbellek fiyatına göre fazladan tutarı (USD). */
  reBilledCost: number
  /** Sayılan miss sayısı. */
  reBilledCount: number
  /** Model bazlı döküm; maliyete göre azalan. */
  byModel: { key: string; tokens: number; cost: number }[]
}

export interface AgentState {
  settings: AgentSettings
  /** Açık konuşmanın kimliği; ilk mesaj gönderilene kadar `null`. */
  sessionId: string | null
  running: boolean
  /** Şu anki konuşma; panel yeniden yüklendiğinde geçmişi buradan kurar. */
  messages: Message[]
  /** Seçili sağlayıcının anahtar kaynağı. */
  keySource: ApiKeySource
  /** ChatGPT aboneliği (Codex) oturumu; giriş yapılmadıysa `signedIn: false`. */
  codex: CodexAccount
  /** Anahtarı (kayıtlı ya da ortam değişkeninde) olan sağlayıcılar; hızlı model seçici bunların modellerini listeler. */
  configuredProviders: string[]
  /** İşletim sisteminin şifreleme deposu kullanılabilir mi (değilse anahtar kaydedilemez). */
  encryptionAvailable: boolean
  /** `/goal` ile verilen kalıcı hedef; değiştiği ilk kullanıcı mesajına blok olarak eklenir (sistem istemi önbellek için sabit kalır). */
  goal: string | null
  usage: AgentUsage
  /** Şu an geçerli izin modu; yeni konuşmada `settings.permissionMode`'a döner. */
  permissionMode: PermissionMode
}

/** `/undo` sonucu: son kullanıcı mesajı ve cevapları geçmişten silindi, agent'ın yazdığı dosyalar geri alındı. */
export interface AgentUndoResult {
  state: AgentState
  /** Silinen kullanıcı mesajının metni (panel girişe geri koyabilir); geri alınacak mesaj yoksa `null`. */
  text: string | null
  /** Eski haline döndürülen dosyalar (proje köküne göre). */
  restored: string[]
  /** Sen ya da başka bir şey değiştirdiği için dokunulmayan dosyalar. */
  skipped: string[]
}

/** Ana süreçten arayüze tek kanaldan (`agent:event`) akan olaylar. */
export type AgentUiEvent =
  | { type: 'user-message'; message: Message }
  | { type: 'assistant-message'; message: Message }
  /** Yanıt akarken gelen metin/düşünme parçası; yanıt bitince `assistant-message` ile tamamı gelir. */
  | { type: 'delta'; delta: StreamDelta }
  | { type: 'tool-start'; call: ToolCallBlock }
  | { type: 'tool-result'; call: ToolCallBlock; result: ToolResultBlock }
  | { type: 'approval-request'; id: number; request: ApprovalRequest }
  /** Agent diskteki bir dosyayı değiştirdi; açık sekme varsa yeniden yüklenmeli. */
  | { type: 'file-changed'; path: string }
  /** Konuşmanın toplam kullanımı; her model çağrısından sonra gelir. */
  | { type: 'usage'; usage: AgentUsage }
  /**
   * Bir turda önbellekte olması gereken token'lar yeniden faturalandı.
   * `reason`: model değişti, önbellek ömrünü aşan boşluk ya da başka bir neden.
   */
  | { type: 'cache-miss'; missedTokens: number; missedCost: number; idleMs: number; reason: 'model' | 'idle' | 'other' }
  | { type: 'done'; reason: AgentStopReason | 'cancelled' | 'error'; error?: string }

export interface SkriptIdeApi {
  openFolderDialog(): Promise<string | null>
  openFileDialog(): Promise<string[]>
  saveFileDialog(suggestedName: string): Promise<string | null>
  readDir(dir: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  setDirty(dirty: boolean): void
  onMenuAction(listener: (action: MenuAction) => void): () => void

  /** Arayüz dili; ana süreçteki kayıtlı ayardan gelir, değişmesi yeniden başlatma gerektirir. */
  locale: Locale

  // --- Başlık çubuğu ---
  /** `process.platform`; macOS'ta menü sistem menü çubuğunda kalır, başlık çubuğunda gösterilmez. */
  platform: string
  /** Uygulama menüsünün üst düzey başlıkları (Dosya, Düzen…), başlık çubuğunda sırayla gösterilir. */
  getMenuLabels(): Promise<string[]>
  /** `index`'teki menüyü pencere içinde (x, y) noktasında açar; menü kapanınca çözülür. */
  popupMenu(index: number, x: number, y: number): Promise<void>

  // --- Doğrulama sunucusu ---
  getServerStatus(): Promise<ServerStatus>
  /** Şimdiye kadarki konsol çıktısı (arayüz sonradan açıldığında konsolu doldurmak için). */
  getServerLog(): Promise<string>
  startServer(): Promise<void>
  /** Kullanıcı EULA'yı arayüzde açıkça kabul ettiğinde çağrılır. */
  acceptEula(): Promise<void>
  validate(request: ValidateRequest): Promise<ValidationResult>
  sendServerCommand(command: string): Promise<void>
  onServerStatus(listener: (status: ServerStatus) => void): () => void
  onServerLog(listener: (text: string) => void): () => void

  // --- Proje ve Skript sürümü ---
  /** Seçilebilen Skript sürümleri, en yeniden eskiye. */
  listSkriptVersions(): Promise<SkriptVersionOption[]>
  /**
   * Proje kökünü belirler (yalnızca tek dosyalarla çalışılıyorsa `null`), `skript-project.json`'u okur
   * ve doğrulama sunucusunu projenin sürümüne geçirir.
   */
  openProject(root: string | null): Promise<ProjectState>
  /** Son açılan klasör hâlâ varsa yolunu döndürür; yoksa `null`. */
  lastProject(): Promise<string | null>
  /** Sürümü değiştirir: proje açıksa `skript-project.json`'a yazar ve sunucuyu yeni sürüme geçirir. */
  setSkriptVersion(version: string): Promise<ProjectState>
  /** Addon seçimini değiştirir: proje açıksa `skript-project.json`'a yazar, sunucu addon'larla yeniden hazırlanır. */
  setAddons(addons: AddonSelection[]): Promise<ProjectState>
  /**
   * Geçiş asistanı: dosyaları geçici olarak başka bir Skript sürümünün gerçek sunucusunda doğrular,
   * sonra sunucuyu projenin sürümüne geri döndürür. EULA kabul edilmemişse hata verir.
   */
  validateOnVersion(version: string, requests: ValidateRequest[]): Promise<ValidationResult[]>

  // --- AI agent ---
  agentGetState(): Promise<AgentState>
  /** models.dev kataloğu; bir günden eskiyse ya da `refresh` verilirse yeniden indirilir. */
  agentListProviders(refresh?: boolean): Promise<CatalogProvider[]>
  agentSetSettings(settings: AgentSettings): Promise<AgentState>
  /** Anahtarı işletim sisteminin şifreleme deposuyla şifreleyip saklar; `null` siler. */
  agentSetApiKey(providerId: string, key: string | null): Promise<AgentState>
  agentKeySource(providerId: string): Promise<ApiKeySource>
  /** ChatGPT aboneliğiyle tarayıcıda giriş yapar; pencere kapanana kadar çözülmez. */
  agentCodexLogin(): Promise<AgentState>
  /** Kayıtlı ChatGPT oturumunu siler. */
  agentCodexLogout(): Promise<AgentState>
  /**
   * Mesajı gönderir; agent turu bitince çözülür. Olaylar `onAgentEvent` ile akar.
   * `problems`: mesajda `@Problems` etiketi varsa PROBLEMLER sekmesinin o anki içeriği.
   */
  agentSend(text: string, problems?: ProblemReport[]): Promise<void>
  /** `@` etiket listesi için projedeki dosyalar (köke göre); proje yoksa boş. */
  agentListFiles(): Promise<string[]>
  agentCancel(): Promise<void>
  /** Yeni konuşma başlatır (çalışıyorsa önce durdurur). */
  agentReset(): Promise<void>
  /** Kayıtlı konuşmalar, en son güncellenen başta. */
  agentListSessions(): Promise<AgentSessionInfo[]>
  /** Kayıtlı bir konuşmayı açar (çalışıyorsa önce durdurur). */
  agentLoadSession(id: string): Promise<AgentState>
  agentDeleteSession(id: string): Promise<AgentState>
  /** Son kullanıcı mesajını ve sonrasını geri alır; o turda agent'ın yazdığı dosyaları eski haline döndürür. */
  agentUndo(): Promise<AgentUndoResult>
  /** Kalıcı hedefi ayarlar; `null` temizler. */
  agentSetGoal(goal: string | null): Promise<AgentState>
  /** Geçerli izin modunu değiştirir (çalışan tur dahil); varsayılan `agentSetSettings` ile değişir. */
  agentSetPermissionMode(mode: PermissionMode): Promise<AgentState>
  agentRespondApproval(id: number, approved: boolean): void
  onAgentEvent(listener: (event: AgentUiEvent) => void): () => void
}

export const IpcChannel = {
  openFolderDialog: 'dialog:open-folder',
  openFileDialog: 'dialog:open-file',
  saveFileDialog: 'dialog:save-file',
  readDir: 'fs:read-dir',
  readFile: 'fs:read-file',
  writeFile: 'fs:write-file',
  setDirty: 'app:set-dirty',
  locale: 'app:locale',
  menuAction: 'menu:action',
  menuLabels: 'menu:labels',
  menuPopup: 'menu:popup',
  serverStatus: 'server:status',
  serverLog: 'server:log',
  serverStart: 'server:start',
  serverAcceptEula: 'server:accept-eula',
  serverCommand: 'server:command',
  serverValidate: 'server:validate',
  serverStatusChanged: 'server:status-changed',
  serverLogOutput: 'server:log-output',
  skriptVersions: 'project:skript-versions',
  openProject: 'project:open',
  lastProject: 'project:last',
  setSkriptVersion: 'project:set-skript-version',
  setAddons: 'project:set-addons',
  validateOnVersion: 'server:validate-on-version',
  agentState: 'agent:state',
  agentProviders: 'agent:providers',
  agentSetSettings: 'agent:set-settings',
  agentSetApiKey: 'agent:set-api-key',
  agentKeySource: 'agent:key-source',
  agentCodexLogin: 'agent:codex-login',
  agentCodexLogout: 'agent:codex-logout',
  agentSend: 'agent:send',
  agentListFiles: 'agent:list-files',
  agentCancel: 'agent:cancel',
  agentReset: 'agent:reset',
  agentSessions: 'agent:sessions',
  agentLoadSession: 'agent:load-session',
  agentDeleteSession: 'agent:delete-session',
  agentUndo: 'agent:undo',
  agentSetGoal: 'agent:set-goal',
  agentSetPermissionMode: 'agent:set-permission-mode',
  agentApproval: 'agent:approval',
  agentEvent: 'agent:event'
} as const
