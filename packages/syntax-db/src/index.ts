import { ADDON_SYNTAX_DB_LOADERS, ADDON_SYNTAX_DBS, SYNTAX_DB_LOADERS, SYNTAX_DB_VERSIONS } from './catalog'
import { SCHEMA_VERSION, type AddonSyntaxInfo, type SyntaxDatabase, type SyntaxVersionInfo } from './schema'

import { l } from '@skript-ide/i18n'
export * from './schema'
export { decodeEntities, htmlToText, normalizeSkriptDocs, type NormalizeOptions, type RawSkriptDocs } from './normalize'
export { SyntaxIndex, type SearchOptions } from './search'
export {
  convertAddonDump,
  docCoverage,
  humanizeClassName,
  isUsablePattern,
  type AddonDocEntry,
  type AddonDocs,
  type ConvertAddonOptions,
  type RegistryDump
} from './addon-dump'
export { ADDON_SYNTAX_DBS, SYNTAX_DB_VERSIONS }

/** Veritabanı olan Skript sürümleri, en yeniden eskiye. */
export function listSyntaxVersions(): readonly SyntaxVersionInfo[] {
  return SYNTAX_DB_VERSIONS
}

export function hasSyntaxDatabase(skriptVersion: string): boolean {
  return Object.hasOwn(SYNTAX_DB_LOADERS, skriptVersion)
}

/** Ayrıştırılmış JSON'un bu şemaya uyduğunu kabaca doğrular. */
export function assertSyntaxDatabase(value: unknown, skriptVersion?: string): SyntaxDatabase {
  const db = value as Partial<SyntaxDatabase> | null
  if (!db || typeof db !== 'object' || !Array.isArray(db.entries)) throw new Error(l('Geçersiz syntax veritabanı.', 'Invalid syntax database.'))
  if (db.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(l(`Syntax veritabanı şema sürümü ${db.schemaVersion}, beklenen ${SCHEMA_VERSION}.`, `Syntax database schema version is ${db.schemaVersion}, expected ${SCHEMA_VERSION}.`))
  }
  if (skriptVersion && db.skriptVersion !== skriptVersion) {
    throw new Error(l(`Syntax veritabanı Skript ${db.skriptVersion} için, ${skriptVersion} istendi.`, `Syntax database is for Skript ${db.skriptVersion}, but ${skriptVersion} was requested.`))
  }
  return db as SyntaxDatabase
}

const cache = new Map<string, Promise<SyntaxDatabase>>()

/**
 * Bir Skript sürümünün syntax veritabanını yükler. Veri dosyaları ayrı parçalar halinde
 * paketlendiğinden yalnızca istenen sürüm belleğe alınır; sonuç önbelleğe alınır.
 */
export function loadSyntaxDatabase(skriptVersion: string): Promise<SyntaxDatabase> {
  let pending = cache.get(skriptVersion)
  if (!pending) {
    const loader = SYNTAX_DB_LOADERS[skriptVersion]
    if (!loader) return Promise.reject(new Error(l(`Skript ${skriptVersion} için syntax veritabanı yok.`, `No syntax database for Skript ${skriptVersion}.`)))
    pending = loader().then((module) => assertSyntaxDatabase((module as { default: unknown }).default, skriptVersion))
    pending.catch(() => cache.delete(skriptVersion))
    cache.set(skriptVersion, pending)
  }
  return pending
}

/** Katalogdaki addon veritabanları (addon adı büyük/küçük harf duyarsız süzülebilir). */
export function listAddonDatabases(addon?: string): readonly AddonSyntaxInfo[] {
  if (!addon) return ADDON_SYNTAX_DBS
  const key = addon.toLowerCase()
  return ADDON_SYNTAX_DBS.filter((info) => info.addon.toLowerCase() === key)
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number(part) || 0)
}

/** İki sürüm arasındaki "uzaklık": önce ana/ara sürüm, sonra yama farkı. */
function versionDistance(a: string, b: string): number {
  const [pa, pb] = [versionParts(a), versionParts(b)]
  let distance = 0
  for (let i = 0; i < 3; i++) distance = distance * 1000 + Math.abs((pa[i] ?? 0) - (pb[i] ?? 0))
  return distance
}

/**
 * Bir addon sürümü + Skript sürümü için kullanılacak veritabanı. Tam eşleşme yoksa aynı addon sürümünün
 * en yakın Skript sürümünde üretilmiş verisi seçilir (`exact: false`). Addon sürümü hiç yoksa `undefined`.
 */
export function resolveAddonDatabase(addon: string, addonVersion: string, skriptVersion: string): (AddonSyntaxInfo & { exact: boolean }) | undefined {
  const candidates = listAddonDatabases(addon).filter((info) => info.addonVersion === addonVersion.trim())
  if (candidates.length === 0) return undefined
  const best = [...candidates].sort((a, b) => versionDistance(a.skriptVersion, skriptVersion) - versionDistance(b.skriptVersion, skriptVersion))[0]
  return { ...best, exact: best.skriptVersion === skriptVersion }
}

export function addonDatabaseKey(info: Pick<AddonSyntaxInfo, 'addon' | 'addonVersion' | 'skriptVersion'>): string {
  return `${info.addon.toLowerCase()}@${info.addonVersion}@${info.skriptVersion}`
}

const addonCache = new Map<string, Promise<SyntaxDatabase>>()

/** `resolveAddonDatabase` sonucunun (ya da tam anahtarın) verisini yükler; sonuç önbelleğe alınır. */
export function loadAddonDatabase(info: Pick<AddonSyntaxInfo, 'addon' | 'addonVersion' | 'skriptVersion'>): Promise<SyntaxDatabase> {
  const key = addonDatabaseKey(info)
  let pending = addonCache.get(key)
  if (!pending) {
    const loader = ADDON_SYNTAX_DB_LOADERS[key]
    if (!loader) return Promise.reject(new Error(l(`${info.addon} ${info.addonVersion} (Skript ${info.skriptVersion}) için syntax veritabanı yok.`, `No syntax database for ${info.addon} ${info.addonVersion} (Skript ${info.skriptVersion}).`)))
    pending = loader().then((module) => assertSyntaxDatabase((module as { default: unknown }).default, info.skriptVersion))
    pending.catch(() => addonCache.delete(key))
    addonCache.set(key, pending)
  }
  return pending
}
