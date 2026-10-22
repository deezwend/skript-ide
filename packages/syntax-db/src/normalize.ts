/**
 * Skript'in kendi JSON dokümantasyon çıktısını (`sk gen-docs` → `docs.json`) bu paketin şemasına çevirir.
 * Skript'in `ch.njol.skript.doc.JSONGenerator` sınıfının 1.x (≤ 2.12) ve 2.x (≥ 2.13) biçimlerini tanır.
 * Saf fonksiyonlardan oluşur; dosya sistemine dokunmaz. İleride addon'ların aynı biçimdeki çıktısı için de kullanılabilir.
 */

import { SCHEMA_VERSION, SYNTAX_KINDS, type SyntaxDatabase, type SyntaxDatabaseSource, type SyntaxEntry, type SyntaxKind, type SyntaxRef } from './schema'

type RawText = string | string[] | null | undefined
type RawRef = { id?: string; name?: string } | string

interface RawElement {
  id: string
  name: string
  since?: RawText
  deprecated?: boolean
  description?: RawText
  patterns?: string[] | null
  examples?: string[] | null
  requirements?: string[] | null
  keywords?: string[] | null
  events?: RawRef[] | null
  eventValues?: RawRef[] | null
  cancellable?: boolean
  /** 2.x: ifadeler ve fonksiyonlar. */
  returns?: RawRef | null
  /** 1.x: fonksiyonlar. */
  returnType?: RawRef | null
}

export interface RawSkriptDocs {
  version?: { major: number; minor: number }
  source?: { name?: string; version?: string | null }
  conditions?: RawElement[]
  effects?: RawElement[]
  expressions?: RawElement[]
  events?: RawElement[]
  structures?: RawElement[]
  sections?: RawElement[]
  /** 2.x adı. */
  types?: RawElement[]
  /** 1.x adı. */
  classes?: RawElement[]
  functions?: RawElement[]
}

const RAW_GROUPS: Record<SyntaxKind, (keyof RawSkriptDocs)[]> = {
  event: ['events'],
  condition: ['conditions'],
  effect: ['effects'],
  expression: ['expressions'],
  section: ['sections'],
  structure: ['structures'],
  type: ['types', 'classes'],
  function: ['functions']
}

// Skript açıklamalarında kullanılan HTML etiketleri. `<number>`, `<.+>` gibi Skript sözdizimine dokunulmasın diye
// yalnızca bu adlar ayıklanır.
const HTML_TAG = /<\/?(a|b|br|code|div|em|h[1-6]|i|li|ol|p|pre|span|strong|sub|sup|u|ul)(\s[^<>]*)?\/?>/gi

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Dokümantasyondaki basit HTML'i düz metne çevirir; Skript'in `<...>` sözdizimini korur. */
export function htmlToText(html: string): string {
  const text = html.replace(HTML_TAG, (tag, name: string) => {
    const closing = tag.startsWith('</')
    switch (name.toLowerCase()) {
      case 'br':
        return '\n'
      case 'p':
      case 'div':
        return '\n\n'
      case 'li':
        return closing ? '' : '\n• '
      case 'ul':
      case 'ol':
        return '\n'
      default:
        return ''
    }
  })
  return tidy(decodeEntities(text))
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n\s*\n• /g, '\n• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Örnekler Skript kodudur; `<red>`, `<b>` gibi MiniMessage etiketlerine dokunulmaz.
 * Yalnızca dokümantasyonun yorumlara eklediği bağlantılar (`<a href=…>…</a>`) ayıklanır.
 */
function exampleToText(example: string): string {
  return decodeEntities(example.replace(/<a\s[^<>]*>|<\/a>/gi, '')).replace(/\s+$/, '')
}

function toList(value: RawText): string[] {
  if (value == null) return []
  return (Array.isArray(value) ? value : value.split('\n')).map((item) => item.trim()).filter(Boolean)
}

function toRef(raw: RawRef | null | undefined): SyntaxRef | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') return { id: raw, name: raw }
  const id = raw.id ?? raw.name
  if (!id) return undefined
  // Bazı fonksiyonlarda ad boş geliyor (`{"id": "long", "name": ""}`)
  return { id, name: raw.name || id }
}

function toRefs(raw: RawRef[] | null | undefined): SyntaxRef[] | undefined {
  const refs = (raw ?? []).map(toRef).filter((ref): ref is SyntaxRef => ref !== undefined)
  if (refs.length === 0) return undefined
  // Skript olay değerlerini HashSet'ten yazıyor; sıra her üretimde değişmesin
  const unique = new Map(refs.map((ref) => [`${ref.id}\u0000${ref.name}`, ref]))
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'))
}

function optionalList(raw: string[] | null | undefined, convert: (text: string) => string): string[] | undefined {
  const list = (raw ?? []).map(convert).filter(Boolean)
  return list.length ? list : undefined
}

function normalizeElement(kind: SyntaxKind, raw: RawElement): SyntaxEntry {
  // Syntax pattern'leri ham Skript sözdizimidir, yalnızca HTML karakter kodları çözülür.
  // Türlerde ise "pattern" serbest metinli bir kullanım açıklaması ve HTML içerebiliyor.
  const convertPattern = kind === 'type' ? htmlToText : (text: string) => decodeEntities(text).trim()

  const entry: SyntaxEntry = {
    kind,
    id: raw.id,
    name: decodeEntities(raw.name).trim() || raw.id,
    patterns: (raw.patterns ?? []).map(convertPattern).filter(Boolean),
    // Açıklama dizisinin her öğesi bir satır; boş öğeler paragraf arası (Skript'in HTML üreticisi de `<br>` ile birleştirir)
    description: tidy(
      (Array.isArray(raw.description) ? raw.description : raw.description ? [raw.description] : [])
        .map(htmlToText)
        .join('\n')
    ),
    examples: (raw.examples ?? []).map(exampleToText).filter(Boolean),
    since: toList(raw.since),
    deprecated: raw.deprecated === true
  }

  const requirements = optionalList(raw.requirements, htmlToText)
  if (requirements) entry.requirements = requirements
  const keywords = optionalList(raw.keywords, (text) => text.trim())
  if (keywords) entry.keywords = keywords
  const returnType = toRef(raw.returns ?? raw.returnType)
  if (returnType) entry.returnType = returnType
  if (kind === 'event') {
    const eventValues = toRefs(raw.eventValues)
    if (eventValues) entry.eventValues = eventValues
    entry.cancellable = raw.cancellable === true
  }
  const events = toRefs(raw.events)
  if (events) entry.events = events
  return entry
}

export interface NormalizeOptions {
  skriptVersion: string
  source: Omit<SyntaxDatabaseSource, 'jsonFormat'>
}

/** Ham `docs.json` içeriğini veritabanına çevirir. Kayıtlar tür sırasına ve ada göre sıralanır. */
export function normalizeSkriptDocs(raw: RawSkriptDocs, options: NormalizeOptions): SyntaxDatabase {
  if (raw.source?.version && raw.source.version !== options.skriptVersion) {
    throw new Error(`docs.json Skript ${raw.source.version} sürümüne ait, ${options.skriptVersion} bekleniyordu.`)
  }

  const counts = Object.fromEntries(SYNTAX_KINDS.map((kind) => [kind, 0])) as Record<SyntaxKind, number>
  const entries: SyntaxEntry[] = []
  for (const kind of SYNTAX_KINDS) {
    const seen = new Set<string>()
    for (const group of RAW_GROUPS[kind]) {
      const list = raw[group]
      if (!Array.isArray(list)) continue
      for (const element of list as RawElement[]) {
        if (!element?.id || seen.has(element.id)) continue
        seen.add(element.id)
        entries.push(normalizeElement(kind, element))
        counts[kind]++
      }
    }
  }

  const kindOrder = new Map(SYNTAX_KINDS.map((kind, index) => [kind, index]))
  entries.sort(
    (a, b) =>
      kindOrder.get(a.kind)! - kindOrder.get(b.kind)! ||
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id, 'en')
  )

  if (entries.length === 0) throw new Error('docs.json içinde hiç syntax kaydı bulunamadı.')

  return {
    schemaVersion: SCHEMA_VERSION,
    skriptVersion: options.skriptVersion,
    source: { ...options.source, jsonFormat: raw.version ? `${raw.version.major}.${raw.version.minor}` : 'unknown' },
    counts,
    entries
  }
}
