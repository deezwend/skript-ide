/**
 * Skript syntax veritabanının şeması. Her Skript sürümü için `data/skript-<sürüm>.json`
 * dosyası bu biçimdedir. Editörden bağımsızdır: hem arayüz hem de ileride language server kullanır.
 */

/** Şema değişirse artır; yükleyici farklı sürümdeki dosyaları reddeder. */
export const SCHEMA_VERSION = 1

export type SyntaxKind =
  | 'event'
  | 'condition'
  | 'effect'
  | 'expression'
  | 'section'
  | 'structure'
  | 'type'
  | 'function'

export const SYNTAX_KINDS: readonly SyntaxKind[] = [
  'event',
  'condition',
  'effect',
  'expression',
  'section',
  'structure',
  'type',
  'function'
]

/** Başka bir kayda (çoğunlukla bir türe) kimlik + görünen adla verilen referans. */
export interface SyntaxRef {
  id: string
  name: string
}

export interface SyntaxEntry {
  kind: SyntaxKind
  /**
   * Skript dokümantasyonundaki kimlik, ör. `ExprNumberOfCharacters`, `unknown_command_execution`.
   * Yalnızca aynı `kind` içinde benzersizdir (`player` hem tür hem fonksiyon olabilir).
   */
  id: string
  /** Görünen ad, ör. `Number of Characters`. */
  name: string
  /**
   * Skript'in ham pattern sözdizimiyle (`[ ]`, `( | )`, `%type%`, `<regex>`) kalıplar.
   * Türlerde kullanım metni, fonksiyonlarda imza (`floor(n: number)`) bulunur.
   */
  patterns: string[]
  /** Düz metin açıklama; HTML etiketleri ayıklanmıştır, paragraflar `\n\n` ile ayrılır. */
  description: string
  /** Skript kodu örnekleri (girinti için tab içerir). */
  examples: string[]
  /** Eklendiği / değiştiği Skript sürümleri, ör. `["2.5", "2.10 (multiple)"]`. */
  since: string[]
  deprecated: boolean
  /** Ek gereksinimler, ör. `Minecraft 1.21.5+` ya da `Paper`. */
  requirements?: string[]
  /** Aramada kullanılan ek anahtar kelimeler. */
  keywords?: string[]
  /** İfadelerin ve fonksiyonların döndürdüğü tür (bilinmiyorsa yok). */
  returnType?: SyntaxRef
  /** Olaylarda kullanılabilen `event-x` değerleri. */
  eventValues?: SyntaxRef[]
  /** Olay iptal edilebilir mi (`cancel event`). */
  cancellable?: boolean
  /** Bu syntax'ın yalnızca çalıştığı olaylar. */
  events?: SyntaxRef[]
  /** Kaydı ekleyen addon (ör. `SkBee`); Skript'in kendi kayıtlarında yok. */
  addon?: string
}

export interface SyntaxDatabaseSource {
  /**
   * `skript-docs-archive`: SkriptLang/skript-docs deposundaki, Skript'in CI'da `gen-docs` ile ürettiği arşiv.
   * `local-server`: Bu makinede gerçek Paper sunucusunda `sk gen-docs` ile üretilen çıktı.
   * `addon-server`: Addon kurulu gerçek sunucuda Skript'in syntax kayıt defterinden (kökene göre) alınan döküm,
   *   varsa addon'un kendi doküman üreticisinin çıktısıyla zenginleştirilmiş (`scripts/generate-addons.ts`).
   */
  kind: 'skript-docs-archive' | 'local-server' | 'addon-server'
  /** Ham dosyanın alındığı adres ya da yerelde üretildiyse açıklama. */
  url: string
  /** Arşiv kaynağında, sabitlenmiş skript-docs commit'i. */
  commit?: string
  /** Ham `docs.json` dosyasının SHA-256 özeti. */
  sha256: string
  /** Skript JSON üreticisinin biçim sürümü, ör. `2.0`. */
  jsonFormat: string
}

export interface SyntaxDatabase {
  schemaVersion: typeof SCHEMA_VERSION
  /** Skript'in kendi verisinde sürüm; addon verisinde üretildiği sunucudaki Skript sürümü. */
  skriptVersion: string
  /** Yalnızca addon veritabanlarında: addon adı ve sürümü. */
  addon?: { name: string; version: string }
  source: SyntaxDatabaseSource
  counts: Record<SyntaxKind, number>
  entries: SyntaxEntry[]
}

/** Katalogdaki bir addon veritabanı: addon sürümü + üretildiği Skript sürümü. */
export interface AddonSyntaxInfo {
  addon: string
  addonVersion: string
  skriptVersion: string
  counts: Record<SyntaxKind, number>
}

/** Katalogda (yüklemeden önce) bilinen sürüm bilgisi. */
export interface SyntaxVersionInfo {
  skriptVersion: string
  counts: Record<SyntaxKind, number>
  source: SyntaxDatabaseSource['kind']
}
