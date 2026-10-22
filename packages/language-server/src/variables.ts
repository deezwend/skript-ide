import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver'
import type { LineInfo, Position, Range, SkriptDocument, StructureNode, VariableReference } from './contracts'
import { findNodePath } from './document'
import { containsPosition } from './util'

import { l } from '@skript-ide/i18n'
/**
 * Değişken analizi: her `{…}` kullanımının okuma mı yazma mı olduğu, kapsamı ve normalize adı.
 *
 * - Ad karşılaştırması büyük/küçük harf duyarsızdır (Skript de öyle).
 * - Dinamik parçalar (`%player%`, `{@seçenek}`) joker sayılır: `{coins::%player%}` ile `{coins::%arg-1%}`
 *   aynı değişken ailesidir, `{coins::*}` listesi de `coins::` ile başlayan her şeyi kapsar.
 * - Sınıflandırma satır metnine bakar (set/add/delete/loop…); emin olunamayan kullanım okuma sayılır.
 *   Böylece "yazılmamış" uyarısı yalnızca hiç yazma görülmeyen adlarda çıkar.
 */

export type VariableAccess = 'read' | 'write' | 'readwrite'

export interface VariableOccurrence {
  ref: VariableReference
  /** Normalize ad: küçük harf, dinamik parçalar `%`, ör. `_coins`, `coins::%`, `list::*`. */
  key: string
  /** Yeniden adlandırılan kök: ilk `::` öncesi (ör. `_list`); dinamikse `null`. */
  stem: string | null
  access: VariableAccess
  /** `global` ya da yerel değişkenler için yapının (tetikleyicinin) sırası: `local:3`. */
  scope: string
  /** Yerel değişken bir tetikleyici (olay/komut/fonksiyon gövdesi) dışında mı? */
  outsideTrigger: boolean
  /** Fonksiyon parametresi (`function f(p: player)` → `{_p}`); aralığı yalnızca `p` adını kapsar. */
  parameter?: boolean
  /**
   * Metinde `{…}` olarak geçmeyen türetilmiş kullanım: liste parametresinin `{_ad::*}` yazması ya da
   * `{@seçenek}` başvurusunda seçenek değerindeki değişkenin okunması. Yalnızca okuma/yazma
   * istatistiğine katılır; uyarı, gezinme ve yeniden adlandırmada yok sayılır.
   */
  synthetic?: boolean
}

export const VariableCodes = {
  unwritten: 'variable-unwritten',
  unread: 'variable-unread',
  typo: 'variable-typo',
  localScope: 'variable-local-scope'
} as const

/** `%…%` (iç içe süslü parantez dahil) ve `{@…}` parçalarını `%` jokerine indirger. */
export function variableKey(name: string): string {
  let result = ''
  let index = 0
  const lower = name.toLowerCase().replace(/\s+/g, ' ').trim()
  while (index < lower.length) {
    const char = lower[index]!
    if (char === '%') {
      let depth = 0
      let end = index + 1
      for (; end < lower.length; end++) {
        const current = lower[end]
        if (current === '{') depth++
        else if (current === '}') depth--
        else if (current === '%' && depth <= 0) break
      }
      result += '%'
      index = end + 1
      continue
    }
    if (char === '{' && lower[index + 1] === '@') {
      const end = lower.indexOf('}', index)
      result += '%'
      index = end < 0 ? lower.length : end + 1
      continue
    }
    result += char
    index++
  }
  return result.replace(/%+/g, '%')
}

export function variableStem(name: string): string | null {
  const separator = name.indexOf('::')
  const stem = (separator < 0 ? name : name.slice(0, separator)).trim()
  if (!stem || /[%{}*]/.test(stem)) return null
  return stem
}

export function isDynamicKey(key: string): boolean {
  return key.includes('%') || key.endsWith('::*')
}

/** Joker içeren bir anahtarın düzenli ifadesi: `%` herhangi bir metin, sondaki `::*` her alt eleman. */
function keyPattern(key: string): RegExp {
  let source = ''
  const body = key.endsWith('::*') ? key.slice(0, -1) : key
  for (const char of body) source += char === '%' ? '.*' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${source}${key.endsWith('::*') ? '.*' : ''}$`)
}

/** Aynı kapsamdaki iki anahtar aynı değişkene (ya da ailesine) değebilir mi? */
export function keysOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (isDynamicKey(a) && keyPattern(a).test(b)) return true
  if (isDynamicKey(b) && keyPattern(b).test(a)) return true
  // İki joker birbirini tam içermese de ortak bir ad üretebilir: sabit önekleri uyuşuyorsa öyle say.
  if (isDynamicKey(a) && isDynamicKey(b)) {
    const prefix = (key: string) => key.split(/%|::\*$/)[0] ?? ''
    const [pa, pb] = [prefix(a), prefix(b)]
    return pa.startsWith(pb) || pb.startsWith(pa)
  }
  return false
}

// --- Okuma / yazma sınıflandırması ---

interface Region {
  start: number
  end: number
}

/**
 * Hedefin değişkeni nasıl kapsadığı:
 * - `whole`: hedef değişkenin kendisi (`set {_a} to`); `set {_a}'s owner to` gibi bir özelliği değil.
 * - `list`: virgül/`and` ile ayrılmış değişkenler (`delete {_a} and {_b}`).
 * - `start`: hedef değişkenle başlar, ardından başka metin gelebilir (`into {_x} with …`).
 * - `any`: bölgedeki her değişken (`for each {_x} in`).
 */
type TargetMode = 'whole' | 'list' | 'start' | 'any'

/** `set X to …`, `add … to X`, `delete X` gibi kalıplarda hedefin satır içindeki yeri ve erişim türü. */
function targetRegions(text: string): { region: Region; access: VariableAccess; mode: TargetMode }[] {
  const result: { region: Region; access: VariableAccess; mode: TargetMode }[] = []
  const trimmed = text.replace(/:\s*$/, '')
  const push = (pattern: RegExp, group: number, access: VariableAccess, mode: TargetMode) => {
    const match = new RegExp(pattern.source, `${pattern.flags}d`).exec(trimmed)
    if (!match) return
    const found = groupRegion(match, group)
    if (found) result.push({ region: found, access, mode })
  }
  push(/^set\s+(.+?)\s+to\s/i, 1, 'write', 'whole')
  push(/^(?:delete|clear|reset|wipe)\s+(.+)$/i, 1, 'write', 'list')
  push(/^(?:add|give)\s+.+?\s+to\s+(.+)$/i, 1, 'readwrite', 'whole')
  push(/^remove\s+.+?\s+from\s+(.+)$/i, 1, 'readwrite', 'whole')
  push(/^(?:increase|decrease|raise|lower)\s+(.+?)\s+by\s/i, 1, 'readwrite', 'whole')
  push(/^(?:sort|reverse|shuffle|transform|filter|map)\s+(.+?)(?:\s+(?:by|based|with|using|to|in)\b.*)?$/i, 1, 'readwrite', 'whole')
  push(/^for\s+(?:each\s+)?(.+?)\s+in\s/i, 1, 'write', 'any')
  push(/\binto\s+(\{.+)$/i, 1, 'write', 'start')
  push(/\bstored\s+in\s+(\{.+?\})/i, 1, 'write', 'whole')
  return result
}

/** Değişken dışında yalnızca `the`/`all` (liste kipinde `and` ve virgül) içeren metin mi? */
function onlyFiller(text: string, list: boolean): boolean {
  const rest = (list ? text.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, ' ') : text).toLowerCase()
  const filler = list ? /^(?:\s|,|\band\b|\bthe\b|\ball\b)*$/ : /^\s*(?:the|all)?\s*$/
  return filler.test(rest)
}

function groupRegion(match: RegExpExecArray, group: number): Region | null {
  const span = match.indices?.[group]
  return span ? { start: span[0], end: span[1] } : null
}

function classify(
  occurrence: { start: number; end: number; nested: boolean },
  lineText: string,
  inVariablesStructure: boolean
): VariableAccess {
  if (inVariablesStructure) return 'write'
  if (occurrence.nested) return 'read'
  for (const target of targetRegions(lineText)) {
    const { start, end } = target.region
    if (occurrence.start < start || occurrence.end > end) continue
    if (target.mode !== 'any') {
      const list = target.mode === 'list'
      if (!onlyFiller(lineText.slice(start, occurrence.start), list)) continue
      if ((target.mode === 'whole' || list) && !onlyFiller(lineText.slice(occurrence.end, end), list)) continue
    }
    return target.access
  }
  return 'read'
}

// --- Belge analizi ---

function structureIndexAt(doc: SkriptDocument, position: Position): number {
  return doc.structures.findIndex((structure) => containsPosition(structure.range, position))
}

/** Bir yerel değişken tetikleyici gövdesi içinde mi? (olay/fonksiyon gövdesi ya da komutun `trigger:` bölümü) */
function insideTrigger(doc: SkriptDocument, structure: StructureNode | undefined, position: Position): boolean {
  if (!structure) return false
  if (structure.kind === 'event' || structure.kind === 'function') return true
  if (structure.kind === 'command') {
    const path = findNodePath(doc, position)
    const entry = path[1]
    return entry?.type === 'entry' && entry.key.trim().toLowerCase() === 'trigger'
  }
  return false
}

function lineOf(doc: SkriptDocument, line: number): LineInfo | undefined {
  return doc.lines[line]
}

/** Belgedeki tüm değişken kullanımlarını sınıflandırır. */
export function analyzeVariables(doc: SkriptDocument): VariableOccurrence[] {
  const result: VariableOccurrence[] = []
  const refs = doc.variables
  // Büyük dosyalarda (binlerce değişken) iç içelik denetimi tüm belge yerine yalnızca aynı satırda yapılır.
  const refsByLine = new Map<number, VariableReference[]>()
  for (const ref of refs) {
    const list = refsByLine.get(ref.range.start.line)
    if (list) list.push(ref)
    else refsByLine.set(ref.range.start.line, [ref])
  }
  // Yapı aralıkları satır sınırında başlar/biter; aynı satırdaki değişkenler aynı yapıdadır.
  const structureByLine = new Map<number, number>()
  for (const ref of refs) {
    if (!ref.name.trim()) continue
    const position = ref.range.start
    let index = structureByLine.get(position.line)
    if (index === undefined) {
      index = structureIndexAt(doc, position)
      structureByLine.set(position.line, index)
    }
    const structure = index >= 0 ? doc.structures[index] : undefined
    const line = lineOf(doc, position.line)
    const lineText = line?.text ?? ''
    const lineStart = line?.start ?? 0
    const start = position.character - lineStart
    const end = ref.range.end.line === position.line ? ref.range.end.character - lineStart : lineText.length
    const nested = refsByLine.get(position.line)!.some(
      (other) =>
        other !== ref &&
        other.range.start.character < position.character &&
        other.range.end.character >= ref.range.end.character
    )
    const access = classify({ start, end, nested }, lineText, structure?.kind === 'variables')
    result.push({
      ref,
      key: variableKey(ref.name),
      stem: variableStem(ref.name),
      access,
      scope: ref.local ? `local:${index}` : 'global',
      outsideTrigger: ref.local && !insideTrigger(doc, structure, position)
    })
  }
  // Fonksiyon parametreleri gövdede `{_ad}` olarak okunur: her parametre bir yazma sayılır.
  for (const definition of doc.functions) {
    const index = doc.structures.indexOf(definition.structure)
    for (const parameter of definition.parameters) {
      const start = parameter.range.start
      const range = { start, end: { line: start.line, character: start.character + parameter.name.length } }
      result.push({
        ref: { name: `_${parameter.name}`, range, local: true, list: false },
        key: variableKey(`_${parameter.name}`),
        stem: variableStem(`_${parameter.name}`),
        access: 'write',
        scope: `local:${index}`,
        outsideTrigger: false,
        parameter: true
      })
      // Liste parametresi (`lines: strings`) gövdede `{_lines::*}` olarak okunur.
      result.push({
        ref: { name: `_${parameter.name}::*`, range, local: true, list: true },
        key: variableKey(`_${parameter.name}::*`),
        stem: null,
        access: 'write',
        scope: `local:${index}`,
        outsideTrigger: false,
        synthetic: true
      })
    }
  }
  // Adlandırılmış komut argümanı (`command /x [<pkg: text>]`) gövdede `{_pkg}` olarak gelir.
  for (const command of doc.commands) {
    const index = doc.structures.indexOf(command.structure)
    const header = lineOf(doc, command.structure.range.start.line)?.text ?? ''
    for (const match of header.matchAll(/<\s*([A-Za-z_][\w-]*)\s*:/g)) {
      const name = `_${match[1]!}`
      result.push({
        ref: { name, range: command.nameRange, local: true, list: false },
        key: variableKey(name),
        stem: null,
        access: 'write',
        scope: `local:${index}`,
        outsideTrigger: false,
        synthetic: true
      })
    }
  }
  // `{@seçenek}` başvurusu, seçenek değerindeki değişkenleri o noktada okur (`msg: %{_x}% kazandı`).
  const optionValues = new Map(doc.options.map((option) => [option.name.trim().toLowerCase(), option.value]))
  for (const reference of doc.optionReferences) {
    const value = optionValues.get(reference.name.trim().toLowerCase())
    if (!value) continue
    const index = structureIndexAt(doc, reference.range.start)
    for (const match of value.matchAll(/\{(?!@)([^{}]+)\}/g)) {
      const name = match[1]!
      const local = name.trimStart().startsWith('_')
      result.push({
        ref: { name, range: reference.range, local, list: name.endsWith('::*') },
        key: variableKey(name),
        stem: null,
        access: 'read',
        scope: local ? `local:${index}` : 'global',
        outsideTrigger: false,
        synthetic: true
      })
    }
  }
  return result
}

// --- Diagnostics ---

/** Levenshtein uzaklığı; `limit` aşılınca erken çıkar. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > limit) return limit + 1
    previous = current
  }
  return previous[b.length]!
}

interface KeyStats {
  key: string
  reads: number
  writes: number
  count: number
  /** İlk görülen yazılış (öneri metni için). */
  display: string
}

function collectStats(occurrences: readonly VariableOccurrence[]): Map<string, KeyStats> {
  const stats = new Map<string, KeyStats>()
  for (const occurrence of occurrences) {
    let entry = stats.get(occurrence.key)
    if (!entry) {
      entry = { key: occurrence.key, reads: 0, writes: 0, count: 0, display: occurrence.ref.name }
      stats.set(occurrence.key, entry)
    }
    entry.count++
    if (occurrence.access !== 'write') entry.reads++
    if (occurrence.access !== 'read') entry.writes++
  }
  return stats
}

/** Anahtarın kapsamda (jokerler dahil) yazılıp yazılmadığı / okunup okunmadığı. */
function overlapState(key: string, stats: Map<string, KeyStats>, dynamic: readonly KeyStats[]): { written: boolean; read: boolean } {
  let written = false
  let read = false
  const own = stats.get(key)
  if (own) {
    written = own.writes > 0
    read = own.reads > 0
  }
  const candidates = isDynamicKey(key) ? stats.values() : dynamic.values()
  for (const other of candidates) {
    if (written && read) break
    if (other.key === key || !keysOverlap(key, other.key)) continue
    if (other.writes > 0) written = true
    if (other.reads > 0) read = true
  }
  return { written, read }
}

function suggestionFor(key: string, stats: Map<string, KeyStats>): KeyStats | null {
  if (isDynamicKey(key)) return null
  const limit = key.length >= 8 ? 2 : 1
  let best: { stats: KeyStats; distance: number } | null = null
  for (const candidate of stats.values()) {
    if (candidate.key === key || candidate.count < 2 || isDynamicKey(candidate.key)) continue
    if (candidate.writes === 0 || candidate.reads === 0) continue
    // Yerel/genel ayrımı farklıysa öneri anlamsız (`{_x}` ↔ `{x}`).
    if (candidate.key.startsWith('_') !== key.startsWith('_')) continue
    const distance = editDistance(key, candidate.key, limit)
    if (distance > limit) continue
    if (!best || distance < best.distance || (distance === best.distance && candidate.count > best.stats.count)) {
      best = { stats: candidate, distance }
    }
  }
  return best?.stats ?? null
}

export interface VariableDiagnosticsOptions {
  /** Çalışma alanının tüm dosyalarından genel (global) değişken kullanımları; yoksa genel denetim yapılmaz. */
  globalOccurrences?: readonly VariableOccurrence[]
  source: string
}

/** Bir belgenin değişken uyarıları. Genel değişkenler için tüm çalışma alanı kullanımları verilmelidir. */
export function collectVariableDiagnostics(
  occurrences: readonly VariableOccurrence[],
  options: VariableDiagnosticsOptions
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byScope = new Map<string, VariableOccurrence[]>()
  for (const occurrence of occurrences) {
    if (occurrence.scope === 'global') continue
    const list = byScope.get(occurrence.scope)
    if (list) list.push(occurrence)
    else byScope.set(occurrence.scope, [occurrence])
  }
  if (options.globalOccurrences) byScope.set('global', [...options.globalOccurrences])

  for (const [scope, scoped] of byScope) {
    const stats = collectStats(scoped)
    const dynamic = [...stats.values()].filter((entry) => isDynamicKey(entry.key))
    // Kapsamda tamamen dinamik bir ad varsa (ör. `{%x%}`) her şeye yazıyor olabilir.
    const wildcardWrite = dynamic.some((entry) => entry.writes > 0 && /^%/.test(entry.key))
    const states = new Map<string, { written: boolean; read: boolean }>()
    const reported = new Set<string>()
    for (const occurrence of occurrences) {
      if (occurrence.scope !== scope || occurrence.synthetic) continue
      if (occurrence.stem === null && occurrence.key.startsWith('%')) continue
      if (occurrence.ref.local && occurrence.outsideTrigger) {
        diagnostics.push({
          range: occurrence.ref.range,
          severity: DiagnosticSeverity.Warning,
          code: VariableCodes.localScope,
          source: options.source,
          message: l(`{${occurrence.ref.name}} yerel bir değişken; yalnızca olay, komut ya da fonksiyon gövdesinde anlamlıdır.`, `{${occurrence.ref.name}} is a local variable; it only makes sense inside an event, command or function body.`)
        })
        continue
      }
      let state = states.get(occurrence.key)
      if (!state) {
        state = overlapState(occurrence.key, stats, dynamic)
        states.set(occurrence.key, state)
      }
      const unwritten = !state.written && !wildcardWrite && occurrence.access === 'read'
      // Kullanılmayan parametre bir imza tercihidir; okunmayan değişken uyarısı vermez.
      const unread = scope !== 'global' && !state.read && occurrence.access !== 'read' && !occurrence.parameter
      if (!unwritten && !unread) continue
      // Aynı ad için yalnızca ilk kullanımda bildir; aynı satırdaki tekrarlar gürültü olur.
      const reportKey = `${occurrence.key}|${unwritten ? 'w' : 'r'}`
      if (reported.has(reportKey)) continue
      reported.add(reportKey)
      const suggestion = suggestionFor(occurrence.key, stats)
      const name = `{${occurrence.ref.name}}`
      if (suggestion) {
        const replacement = `{${suggestion.display}}`
        diagnostics.push({
          range: occurrence.ref.range,
          severity: DiagnosticSeverity.Warning,
          code: VariableCodes.typo,
          source: options.source,
          message: unwritten
            ? l(`${name} hiç yazılmadan okunuyor; şunu mu demek istedin: ${replacement}?`, `${name} is read but never written; did you mean ${replacement}?`)
            : l(`${name} yazılıyor ama hiç okunmuyor; şunu mu demek istedin: ${replacement}?`, `${name} is written but never read; did you mean ${replacement}?`),
          data: { replacement }
        })
      } else if (unwritten) {
        diagnostics.push({
          range: occurrence.ref.range,
          // Genel değişken eklentiden, başka bir betikten ya da kalıcı veriden gelebilir: bilgi düzeyi.
          severity: occurrence.ref.local ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
          code: VariableCodes.unwritten,
          source: options.source,
          message: occurrence.ref.local
            ? l(`${name} okunuyor ama hiçbir yerde değer atanmıyor (bu tetikleyicide).`, `${name} is read but never assigned a value (in this trigger).`)
            : l(`${name} okunuyor ama hiçbir yerde değer atanmıyor.`, `${name} is read but never assigned a value anywhere.`)
        })
      } else {
        diagnostics.push({
          range: occurrence.ref.range,
          severity: DiagnosticSeverity.Information,
          code: VariableCodes.unread,
          source: options.source,
          message: l(`${name} değer alıyor ama bu tetikleyicide hiç okunmuyor.`, `${name} is assigned but never read in this trigger.`)
        })
      }
    }
  }
  return diagnostics
}

// --- Gezinme / yeniden adlandırma ---

/** Konumdaki en içteki değişken kullanımı. */
export function occurrenceAt(occurrences: readonly VariableOccurrence[], position: Position): VariableOccurrence | null {
  let best: VariableOccurrence | null = null
  for (const occurrence of occurrences) {
    if (occurrence.synthetic || (occurrence.stem === null && occurrence.key.startsWith('%'))) continue
    if (!occurrence.ref.name || !containsPosition(occurrence.ref.range, position)) continue
    if (occurrence.ref.range.start.line !== occurrence.ref.range.end.line) continue
    if (!best || occurrence.ref.range.start.character >= best.ref.range.start.character) best = occurrence
  }
  return best
}

/** Kök adın `{` sonrasındaki aralığı (yeniden adlandırmada değişen kısım). */
export function stemRange(occurrence: VariableOccurrence): Range | null {
  if (occurrence.stem === null) return null
  const start = occurrence.ref.range.start
  // Parametre kaydının aralığı yalnızca `_` öneksiz adı kapsar.
  if (occurrence.parameter) return occurrence.ref.range
  const leading = occurrence.ref.name.length - occurrence.ref.name.trimStart().length
  const character = start.character + 1 + leading
  return { start: { line: start.line, character }, end: { line: start.line, character: character + occurrence.stem.length } }
}

export function sameVariable(a: VariableOccurrence, b: VariableOccurrence): boolean {
  return !a.synthetic && !b.synthetic && a.stem !== null && b.stem !== null && a.stem.toLowerCase() === b.stem.toLowerCase() && a.ref.local === b.ref.local
}
