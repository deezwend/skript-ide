/** Ana süreç ile arayüz arasındaki sözleşme. Preload bunu `window.skriptIde` olarak açar. */

import type { Locale } from '@skript-ide/i18n'
import type {
  AddonIssue,
  AddonSelection,
  ServerStatus,
  SkriptRuntimeProfile,
  ValidationResult
} from '@skript-ide/runtime-validator'

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

export interface ValidateRequest {
  /** Sonucu belgeyle eşlemek için kimlik: dosya yolu ya da kaydedilmemiş belgede `untitled:<id>`. */
  source: string
  fileName: string
  content: string
}

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
  /** Sürümü değiştirir: proje açıksa `skript-project.json`'a yazar ve sunucuyu yeni sürüme geçirir. */
  setSkriptVersion(version: string): Promise<ProjectState>
  /** Addon seçimini değiştirir: proje açıksa `skript-project.json`'a yazar, sunucu addon'larla yeniden hazırlanır. */
  setAddons(addons: AddonSelection[]): Promise<ProjectState>
  /**
   * Geçiş asistanı: dosyaları geçici olarak başka bir Skript sürümünün gerçek sunucusunda doğrular,
   * sonra sunucuyu projenin sürümüne geri döndürür. EULA kabul edilmemişse hata verir.
   */
  validateOnVersion(version: string, requests: ValidateRequest[]): Promise<ValidationResult[]>
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
  setSkriptVersion: 'project:set-skript-version',
  setAddons: 'project:set-addons',
  validateOnVersion: 'server:validate-on-version'
} as const
