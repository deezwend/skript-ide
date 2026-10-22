/**
 * Addon syntax verisinin dönüştürücüsü. Girdi, `scripts/addon-dump.sk` betiğinin gerçek sunucuda yazdığı
 * kayıt defteri dökümü ve (varsa) addon'un kendi doküman üreticisinin çıktısıdır (ör. SkBee'nin `skbee docs`
 * komutu). Pattern'ler ve türler her zaman kayıt defterinden gelir — sunucuda gerçekten kayıtlı olan budur;
 * addon dokümanı yalnızca ad, açıklama, örnek ve sürüm bilgisini doldurur.
 * Saf fonksiyonlardan oluşur; dosya sistemine dokunmaz.
 */

import { normalizeSkriptDocs, type RawSkriptDocs } from './normalize'
import { SCHEMA_VERSION, type SyntaxDatabase, type SyntaxDatabaseSource, type SyntaxEntry, type SyntaxKind } from './schema'

/** `addon-dump.sk` çıktısı. */
export interface RegistryDump {
  skript: string
  syntaxes: DumpSyntax[]
  types: DumpType[]
  functions?: DumpFunction[]
}

export interface DumpSyntax {
  kind: 'event' | 'structure' | 'section' | 'effect' | 'condition' | 'expression'
  /** Kaydı yapan addon'un adı (Skript'te `Skript`). */
  origin: string
  class: string
  patterns: string[]
  returns?: string
  name?: string
  description?: string[]
  examples?: string[]
  since?: string[]
}

export interface DumpType {
  codeName: string
  docName?: string | null
  class: string
  patterns: string[]
}

export interface DumpFunction {
  name: string
  class: string
  signature: string
  returns?: string
  description?: string[]
  examples?: string[]
  since?: string
}

/** Addon'un kendi doküman çıktısındaki bir kayıt (SkBee `json-docs.json` biçimi). */
export interface AddonDocEntry {
  id?: string
  name?: string
  description?: string[]
  examples?: string[]
  since?: string[]
  patterns?: string[]
  cancellable?: boolean
  requirements?: string[]
}

export type AddonDocs = Partial<
  Record<'events' | 'conditions' | 'effects' | 'expressions' | 'sections' | 'structures' | 'types' | 'functions', AddonDocEntry[]>
>

export interface ConvertAddonOptions {
  /** Addon'un kanonik adı (`skript-project.json` anahtarı), ör. `SkBee`. */
  addon: string
  addonVersion: string
  dump: RegistryDump
  docs?: AddonDocs
  /** Aynı Skript sürümünün kendi veritabanı: türler ve fonksiyonlar Skript'inkilerden ayıklanır. */
  base: SyntaxDatabase
  /**
   * Türlerin ve fonksiyonların kökeni kayıt defterinde yok. Verilirse, bu dökümde olup `reference` dökümünde
   * (aynı sunucu, bu addon olmadan) bulunmayan türler/fonksiyonlar bu addon'a verilir. Yalnızca sunucuda
   * (araç olarak kurulan skript-reflect dışında) tek addon varken doğrudur; üretici bunu kendisi belirler.
   */
  reference?: RegistryDump
  /** Sınıf adı bu öneklerden biriyle başlayan türler/fonksiyonlar bu addon'undur. */
  packages: readonly string[]
  source: Omit<SyntaxDatabaseSource, 'jsonFormat'>
  jsonFormat: string
}

const DOC_GROUP: Record<DumpSyntax['kind'], keyof AddonDocs> = {
  event: 'events',
  structure: 'structures',
  section: 'sections',
  effect: 'effects',
  condition: 'conditions',
  expression: 'expressions'
}

/**
 * Hiçbir zaman kullanıcı satırıyla eşleşmemesi gereken pattern'ler: skript-reflect'in "en az bir pattern gerekli"
 * yer tutucuları ve yalnızca bir düzenli ifadeden ibaret her şeyi yakalayan pattern'ler (`[1:await] <.+>`).
 * Bunlar eşleştiriciye girerse her satır "tanındı" sayılır.
 */
export function isUsablePattern(pattern: string): boolean {
  if (/^this is here because/i.test(pattern)) return false
  let rest = pattern
  // İç içe isteğe bağlı grupları dıştan içe sil
  for (let previous = ''; previous !== rest; ) {
    previous = rest
    rest = rest.replace(/\[[^[\]]*\]/g, '')
  }
  return rest.replace(/<[^<>]*>/g, '').trim() !== ''
}

/** `EffNegateCondition` → `Negate Condition`. */
export function humanizeClassName(className: string): string {
  const simple = simpleName(className)
  const stripped = simple.replace(/^(EffSec|Eff|Cond|Expr|Sec|Struct|Evt|Event)(?=[A-Z])/, '') || simple
  return stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}

function simpleName(className: string): string {
  return className.split('.').pop()!.split('$').pop()!
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Doküman ve kayıt defteri pattern'lerini karşılaştırmak için ortak biçim. SkBee dokümanı ayrıştırma
 * etiketlerini (`1:`, `neg:`, `:sprinting`, `1¦`) siliyor; kayıt defterinde duruyorlar.
 */
function patternKey(kind: DumpSyntax['kind'], pattern: string): string {
  let key = pattern
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(^|[([|\s])[\w-]*:(?=\S)/g, '$1')
    .replace(/\d+¦/g, '')
  if (kind === 'event') key = key.replace(/^\[on\] /, '')
  return key
}

function belongsTo(className: string, packages: readonly string[]): boolean {
  return packages.some((prefix) => className.startsWith(prefix))
}

/** Skript'in kendi (belgelenmemiş olabilen) sınıfları hiçbir addon'a verilmez. */
function isSkriptClass(className: string): boolean {
  return className.startsWith('ch.njol.') || className.startsWith('org.skriptlang.skript.')
}

/** Paket öneki: sınıf adının ilk üç parçası (ör. `com.shanebeestudios.skbee`). */
const packagePrefix = (className: string) => className.split('.').slice(0, 3).join('.')

/**
 * Kaydın kökeni. Skript 2.12'nin kayıt defteri olayların kökenini boş döndürüyor; bu durumda köken,
 * aynı paket önekine sahip ve kökeni bilinen kayıtlardan çıkarılır (tek bir addon'a çıkıyorsa).
 */
export function syntaxOrigins(dump: RegistryDump): (syntax: DumpSyntax) => string {
  const byPrefix = new Map<string, Set<string>>()
  for (const syntax of dump.syntaxes) {
    if (!syntax.origin) continue
    const prefix = packagePrefix(syntax.class)
    let origins = byPrefix.get(prefix)
    if (!origins) byPrefix.set(prefix, (origins = new Set()))
    origins.add(syntax.origin)
  }
  return (syntax) => {
    if (syntax.origin) return syntax.origin
    if (isSkriptClass(syntax.class)) return 'Skript'
    const origins = byPrefix.get(packagePrefix(syntax.class))
    return origins?.size === 1 ? [...origins][0]! : ''
  }
}

const looseName = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Kayıt defteri dökümünü ve addon dokümanını tek addon'un veritabanına çevirir. */
export function convertAddonDump(options: ConvertAddonOptions): SyntaxDatabase {
  const { dump, docs = {}, base } = options
  const origin = options.addon.toLowerCase()
  const originOf = syntaxOrigins(dump)
  const raw: Required<Pick<RawSkriptDocs, 'events' | 'conditions' | 'effects' | 'expressions' | 'structures' | 'sections' | 'types' | 'functions'>> = {
    events: [],
    conditions: [],
    effects: [],
    expressions: [],
    structures: [],
    sections: [],
    types: [],
    functions: []
  }

  // Türlerin görünen adları (dönüş türü referansları için): önce dökümdeki, sonra Skript'in kendi verisi
  const typeNames = new Map<string, string>()
  for (const entry of base.entries) if (entry.kind === 'type') typeNames.set(entry.id, entry.name)
  for (const type of dump.types) if (type.docName && type.docName !== 'none') typeNames.set(type.codeName, type.docName)
  const typeRef = (codeName: string | undefined) => (codeName ? { id: codeName, name: typeNames.get(codeName) ?? codeName } : undefined)

  // Addon dokümanı: ilk pattern'den kayda
  const docIndex = new Map<string, AddonDocEntry>()
  for (const kind of Object.keys(DOC_GROUP) as DumpSyntax['kind'][]) {
    for (const doc of docs[DOC_GROUP[kind]] ?? []) {
      for (const pattern of doc.patterns ?? []) docIndex.set(`${kind}\u0000${patternKey(kind, pattern)}`, doc)
    }
  }

  const usedIds = new Set<string>()
  const uniqueId = (kind: string, id: string) => {
    let candidate = id
    for (let n = 2; usedIds.has(`${kind}\u0000${candidate}`); n++) candidate = `${id}-${n}`
    usedIds.add(`${kind}\u0000${candidate}`)
    return candidate
  }

  for (const syntax of dump.syntaxes) {
    if (originOf(syntax).toLowerCase() !== origin) continue
    const patterns = syntax.patterns.filter(isUsablePattern)
    if (patterns.length === 0) continue
    const doc = syntax.patterns.map((pattern) => docIndex.get(`${syntax.kind}\u0000${patternKey(syntax.kind, pattern)}`)).find(Boolean)
    const name = doc?.name ?? syntax.name ?? humanizeClassName(syntax.class)
    const baseId = syntax.kind === 'event' ? `${simpleName(syntax.class)}:${slug(name)}` : simpleName(syntax.class)
    raw[DOC_GROUP[syntax.kind] as keyof typeof raw].push({
      id: uniqueId(syntax.kind, baseId),
      name,
      patterns,
      description: doc?.description ?? syntax.description ?? [],
      examples: doc?.examples ?? syntax.examples ?? [],
      since: doc?.since ?? syntax.since ?? [],
      requirements: doc?.requirements,
      returns: typeRef(syntax.returns),
      cancellable: doc?.cancellable
    })
  }

  // Türler: Skript'in kendi verisinde olmayan ve bu addon'a ait olanlar
  const baseTypes = new Set(base.entries.filter((entry) => entry.kind === 'type').map((entry) => entry.id))
  // Doküman türleri ad ya da kimlik sonekiyle eşleşir (`skbee:type:time_period` ↔ `timeperiod`)
  const typeDocs = new Map<string, AddonDocEntry>()
  for (const doc of docs.types ?? []) {
    typeDocs.set(looseName(doc.name), doc)
    if (doc.id) typeDocs.set(looseName(doc.id.split(':').pop()), doc)
  }
  const referenceTypes = new Set(options.reference?.types.map((type) => type.codeName))
  for (const type of dump.types) {
    if (baseTypes.has(type.codeName) || referenceTypes.has(type.codeName)) continue
    const doc = typeDocs.get(looseName(type.docName)) ?? typeDocs.get(looseName(type.codeName))
    const owned = belongsTo(type.class, options.packages) || (options.reference !== undefined && !isSkriptClass(type.class))
    if (!doc && !owned) continue
    raw.types.push({
      id: type.codeName,
      name: doc?.name ?? (type.docName && type.docName !== 'none' ? type.docName : type.codeName),
      patterns: doc?.patterns?.length ? doc.patterns : type.patterns,
      description: doc?.description ?? [],
      examples: doc?.examples ?? [],
      since: doc?.since ?? []
    })
  }

  // Fonksiyonlar: aynı mantık, dokümanla ad üzerinden eşleşir
  const baseFunctions = new Set(base.entries.filter((entry) => entry.kind === 'function').map((entry) => entry.id.toLowerCase()))
  const functionDocs = new Map<string, AddonDocEntry>()
  for (const doc of docs.functions ?? []) {
    const name = doc.patterns?.[0]?.match(/^([\w$]+)\s*\(/)?.[1]
    if (name) functionDocs.set(name.toLowerCase(), doc)
  }
  const referenceFunctions = new Set(options.reference?.functions?.map((fn) => fn.name.toLowerCase()))
  for (const fn of dump.functions ?? []) {
    if (baseFunctions.has(fn.name.toLowerCase()) || referenceFunctions.has(fn.name.toLowerCase())) continue
    const doc = functionDocs.get(fn.name.toLowerCase())
    const owned = belongsTo(fn.class, options.packages) || (options.reference !== undefined && !isSkriptClass(fn.class))
    if (!doc && !owned) continue
    raw.functions.push({
      id: fn.name,
      name: fn.name,
      patterns: [fn.signature],
      description: doc?.description ?? fn.description ?? [],
      examples: doc?.examples ?? fn.examples ?? [],
      since: doc?.since ?? (fn.since ? [fn.since] : []),
      returns: typeRef(fn.returns)
    })
  }

  const db = normalizeSkriptDocs(raw, { skriptVersion: dump.skript, source: options.source })
  const entries: SyntaxEntry[] = db.entries.map((entry) => ({ ...entry, addon: options.addon }))
  return {
    schemaVersion: SCHEMA_VERSION,
    skriptVersion: dump.skript,
    addon: { name: options.addon, version: options.addonVersion },
    source: { ...db.source, jsonFormat: options.jsonFormat },
    counts: db.counts,
    entries
  }
}

/** Karşılaştırma için: dökümdeki bir addon'un kaç kaydı doküman eşleşmesi buldu. */
export function docCoverage(dump: RegistryDump, docs: AddonDocs, addon: string): { matched: number; total: number; kinds: Partial<Record<SyntaxKind, number>> } {
  const keys = new Set<string>()
  for (const kind of Object.keys(DOC_GROUP) as DumpSyntax['kind'][]) {
    for (const doc of docs[DOC_GROUP[kind]] ?? []) for (const pattern of doc.patterns ?? []) keys.add(`${kind}\u0000${patternKey(kind, pattern)}`)
  }
  let matched = 0
  let total = 0
  const kinds: Partial<Record<SyntaxKind, number>> = {}
  const originOf = syntaxOrigins(dump)
  for (const syntax of dump.syntaxes) {
    if (originOf(syntax).toLowerCase() !== addon.toLowerCase()) continue
    total++
    if (syntax.patterns.some((pattern) => keys.has(`${syntax.kind}\u0000${patternKey(syntax.kind, pattern)}`))) matched++
    else kinds[syntax.kind] = (kinds[syntax.kind] ?? 0) + 1
  }
  return { matched, total, kinds }
}
