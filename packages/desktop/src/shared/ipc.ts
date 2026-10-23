/** Ana süreç ile arayüz arasındaki sözleşme. Preload bunu `window.skriptIde` olarak açar. */

import type {
  AgentMode,
  AgentStopReason,
  ApprovalRequest,
  CatalogProvider,
  EditorContext,
  ImageBlock,
  Message,
  PermissionMode,
  ProblemReport,
  StreamDelta,
  ToolCallBlock,
  ToolResultBlock,
  Todo
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
  AgentMode,
  ApprovalRequest,
  CatalogModel,
  CatalogProvider,
  ContentBlock,
  EditorContext,
  ImageBlock,
  Message,
  PermissionMode,
  ProblemReport,
  ToolCallBlock,
  ToolResultBlock,
  Todo
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

export type ContextMenuItem =
  | { type: 'separator' }
  | { id: string; label: string; enabled?: boolean; accelerator?: string }

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
  | 'whats-new'

// --- Güncellemeler ---

/**
 * Güncelleyicinin durumu. `unsupported`: geliştirme modu ya da kurulumsuz çalıştırma; güncelleme denetlenmez.
 * `manual`: durum kullanıcının elle başlattığı bir denetimden geliyor (arayüz sonucu pencerede gösterir).
 */
export type UpdateStatus = { manual?: boolean } & (
  | { state: 'idle' | 'checking' | 'not-available' | 'unsupported' }
  | { state: 'available'; version: string; notes: string | null }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string; notes: string | null }
  | { state: 'error'; error: string }
)

/** Bir sürümün yayın notları; `html` GitHub'ın işlediği HTML'dir, arayüz göstermeden önce temizler. */
export interface ReleaseNotes {
  version: string
  html: string | null
  /** Sürümün GitHub sayfası. */
  url: string
}

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
  /** Turu sürüyorsa: çalışıyor ya da onay bekliyor. Boştaki konuşmada yok. */
  status?: 'running' | 'approval'
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

/** Ana agent'ın `run_subagent` ile başlattığı alt agent; kendi konuşması (oturumu) ve kullanımı vardır. */
export interface AgentSubagentInfo {
  /** Alt agent'ı başlatan `run_subagent` çağrısı; panel kartı bu satırın altına çizer. */
  callId: string
  /** Alt agent'ın konuşma kimliği; `agentLoadSession` ile açılır. */
  sessionId: string
  title: string
  providerId: string
  modelId: string
  /** Katalogdaki görünen ad. */
  modelName: string
  effort: string | null
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** Alt agent'ın yaptığı tool çağrısı sayısı. */
  toolCalls: number
  usage: AgentUsage
}

export interface AgentState {
  settings: AgentSettings
  /** Açık konuşma bir alt agent'sa onu başlatan konuşma; alt agent konuşmasına mesaj yazılamaz. */
  parent: { id: string; title: string } | null
  /** Açık konuşmanın başlattığı alt agent'lar. */
  subagents: AgentSubagentInfo[]
  /** Alt agent konuşmasında kullanılan model ve effort; ana konuşmada `null` (ayarlardaki seçim geçerli). */
  subagentModel: { providerId: string; modelId: string; effort: string | null } | null
  /** Açık konuşmanın kimliği; olaylar bununla eşleşir. Kayıt dosyası ilk mesajla oluşur. */
  sessionId: string | null
  running: boolean
  /** Şu anki konuşma; tur sürüyorsa o ana kadarki haliyle. Panel geçmişi buradan kurar. */
  messages: Message[]
  /** Tur sürerken akmakta olan yanıtın şimdiye kadarki kısmı; yoksa `null`. */
  streaming?: { text: string; reasoning: string } | null
  /** Açık konuşmada yanıt bekleyen onaylar; panel konuşmaya dönünce kartları yeniden çizer. */
  approvals?: { id: number; request: ApprovalRequest }[]
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
  /** Agent'ın `update_todos` ile bıraktığı plan listesi; geçmişteki son çağrıdan kurulur. */
  todos: Todo[]
  usage: AgentUsage
  /** Şu an geçerli izin modu; yeni konuşmada `settings.permissionMode`'a döner. */
  permissionMode: PermissionMode
  /** Açık konuşmanın modu; ilk mesajdan sonra değişmez, yeni konuşma son seçilen modla başlar. */
  agentMode: AgentMode
}

/** `/undo` sonucu: son kullanıcı mesajı ve cevapları geçmişten silindi, agent'ın yazdığı dosyalar geri alındı. */
export interface AgentUndoResult {
  state: AgentState
  /** Silinen kullanıcı mesajının metni (panel girişe geri koyabilir); geri alınacak mesaj yoksa `null`. */
  text: string | null
  /** Silinen mesajın görselleri; panel girişe geri koyar. */
  images: ImageBlock[]
  /** Eski haline döndürülen dosyalar (proje köküne göre). */
  restored: string[]
  /** Sen ya da başka bir şey değiştirdiği için dokunulmayan dosyalar. */
  skipped: string[]
}

/** `/compact` sonucu: eski geçmiş özetlendi, geçmişin uzunluğu küçüldü. */
export interface AgentCompactResult {
  state: AgentState
  /** Özete dönüşen mesaj sayısı; sıkıştırılacak geçmiş yoksa 0. */
  summarizedMessages: number
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
  /** Bağlam dolmaya yaklaştığı için bu kadar eski tool sonucu kısaltıldı. */
  | { type: 'context-trimmed'; trimmed: number }
  /** Bağlam sığmadığı için konuşmanın eski kısmı özetlendi; önceki turlar artık geri alınamaz. */
  | { type: 'context-compacted'; summarizedMessages: number }
  /** Agent plan listesini (`update_todos`) değiştirdi. */
  | { type: 'todos'; todos: Todo[] }
  /** Konuşmanın toplam kullanımı; her model çağrısından sonra gelir. */
  | { type: 'usage'; usage: AgentUsage }
  /**
   * Bir turda önbellekte olması gereken token'lar yeniden faturalandı.
   * `reason`: model değişti, önbellek ömrünü aşan boşluk ya da başka bir neden.
   */
  | { type: 'cache-miss'; missedTokens: number; missedCost: number; idleMs: number; reason: 'model' | 'idle' | 'other' }
  | { type: 'done'; reason: AgentStopReason | 'cancelled' | 'error'; error?: string }
  /** `/btw` yanıtının akan metni; `id` panelin verdiği soru kimliğidir. */
  | { type: 'btw-delta'; id: number; text: string }
  /** Bu konuşmanın bir alt agent'ı başladı, ilerledi ya da bitti. */
  | { type: 'subagent'; info: AgentSubagentInfo }

/**
 * Ana süreçten gelen olay: hangi konuşmaya ait olduğuyla; konuşmalar aynı anda çalışabilir.
 * `parentId`: olay bir alt agent konuşmasınınsa onu başlatan konuşma.
 */
export type AgentEvent = AgentUiEvent & { sessionId: string; parentId?: string }

export interface SkriptIdeApi {
  openFolderDialog(): Promise<string | null>
  openFileDialog(): Promise<string[]>
  saveFileDialog(suggestedName: string): Promise<string | null>
  readDir(dir: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** Gezgin işlemleri; hepsi açık klasörün içinde kalır ve yeni yolu döner. */
  createFile(dir: string, name: string): Promise<string>
  createDirectory(dir: string, name: string): Promise<string>
  renamePath(path: string, newName: string): Promise<string>
  /** Geri dönüşüm kutusuna taşır. */
  trashPath(path: string): Promise<void>
  /** `targetDir` içine kopyalar (`move` ise taşır); ad çakışırsa "- kopya" eklenir. */
  transferPath(source: string, targetDir: string, move: boolean): Promise<string>
  revealPath(path: string): Promise<void>
  /** Yerel bağlam menüsü; seçilen öğenin `id`'si ya da vazgeçildiyse `null`. */
  showContextMenu(items: ContextMenuItem[]): Promise<string | null>
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
  /** `editor`: kullanıcının o an editörde baktığı yer; mesaja bağlam olarak eklenir. `images`: eklenen görseller. */
  agentSend(text: string, problems?: ProblemReport[], editor?: EditorContext | null, images?: ImageBlock[]): Promise<void>
  /** `@` etiket listesi için projedeki dosyalar (köke göre); proje yoksa boş. */
  agentListFiles(): Promise<string[]>
  /**
   * `/btw`: konuşmanın bağlamıyla tool'suz bir yan soru sorar; soru ve yanıt geçmişe girmez,
   * tur sürerken de çalışır. Akan metin `btw-delta` olaylarıyla gelir, tam yanıtla çözülür.
   */
  agentBtw(id: number, question: string): Promise<string>
  agentBtwCancel(id: number): Promise<void>
  agentCancel(): Promise<void>
  /** Yeni konuşma başlatır; açık konuşmanın süren turu arka planda devam eder. */
  agentReset(): Promise<void>
  /** Kayıtlı konuşmalar, en son güncellenen başta. */
  agentListSessions(): Promise<AgentSessionInfo[]>
  /** Kayıtlı bir konuşmayı açar; açık konuşmanın süren turu arka planda devam eder. */
  agentLoadSession(id: string): Promise<AgentState>
  agentDeleteSession(id: string): Promise<AgentState>
  /** Son kullanıcı mesajını ve sonrasını geri alır; o turda agent'ın yazdığı dosyaları eski haline döndürür. */
  agentUndo(): Promise<AgentUndoResult>
  /** Kalıcı hedefi ayarlar; `null` temizler. */
  agentSetGoal(goal: string | null): Promise<AgentState>
  /** Geçmişin eski kısmını özetleyerek bağlamı hemen küçültür. */
  agentCompact(): Promise<AgentCompactResult>
  /** Geçerli izin modunu değiştirir (çalışan tur dahil); varsayılan `agentSetSettings` ile değişir. */
  agentSetPermissionMode(mode: PermissionMode): Promise<AgentState>
  /** Agent modunu değiştirir; yalnızca konuşmada henüz mesaj yokken çalışır. */
  agentSetAgentMode(mode: AgentMode): Promise<AgentState>
  agentRespondApproval(id: number, approved: boolean): void
  onAgentEvent(listener: (event: AgentEvent) => void): () => void

  // --- Güncellemeler ---
  /** Uygulamanın sürümü (`package.json`). */
  appVersion: string
  getUpdateStatus(): Promise<UpdateStatus>
  /** Güncellemeleri hemen denetler; sonuç `onUpdateStatus` ile `manual: true` olarak gelir. */
  checkForUpdates(): Promise<void>
  /** Otomatik indirme kapalıyken bulunan güncellemeyi indirir. */
  downloadUpdate(): Promise<void>
  /** İndirilen güncellemeyi kurmak için uygulamayı kapatıp yeniden açar. */
  installUpdate(): Promise<void>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  /** Sürümün yayın notları; `version` verilmezse çalışan sürümünkiler. */
  getReleaseNotes(version?: string): Promise<ReleaseNotes>
  /**
   * Uygulama yeni bir sürüme güncellendikten sonraki ilk açılışta o sürümü döndürür (bir kez);
   * aksi halde `null`. İlk kurulumda pencere gösterilmez.
   */
  takeWhatsNew(): Promise<string | null>
}

export const IpcChannel = {
  openFolderDialog: 'dialog:open-folder',
  openFileDialog: 'dialog:open-file',
  saveFileDialog: 'dialog:save-file',
  readDir: 'fs:read-dir',
  readFile: 'fs:read-file',
  writeFile: 'fs:write-file',
  createFile: 'fs:create-file',
  createDirectory: 'fs:create-directory',
  renamePath: 'fs:rename',
  trashPath: 'fs:trash',
  transferPath: 'fs:transfer',
  revealPath: 'fs:reveal',
  contextMenu: 'menu:context',
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
  agentBtw: 'agent:btw',
  agentBtwCancel: 'agent:btw-cancel',
  agentCancel: 'agent:cancel',
  agentReset: 'agent:reset',
  agentSessions: 'agent:sessions',
  agentLoadSession: 'agent:load-session',
  agentDeleteSession: 'agent:delete-session',
  agentUndo: 'agent:undo',
  agentSetGoal: 'agent:set-goal',
  agentCompact: 'agent:compact',
  agentSetPermissionMode: 'agent:set-permission-mode',
  agentSetAgentMode: 'agent:set-agent-mode',
  agentApproval: 'agent:approval',
  agentEvent: 'agent:event',
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatusChanged: 'update:status-changed',
  releaseNotes: 'update:release-notes',
  whatsNew: 'update:whats-new',
  appVersion: 'app:version'
} as const
