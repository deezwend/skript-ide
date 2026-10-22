import type { SyntaxEntry } from '@skript-ide/syntax-db'
import type { MatcherAdapter, Range, SkriptDocument, SyntaxMatchLike } from './contracts'
import type { DocumentAnalysis, LineContext } from './document'
import { matchLine, type LineGroup } from './diagnostics'

import { l } from '@skript-ide/i18n'
/**
 * Geçiş asistanı: projedeki her satırı kaynak (`from`) ve hedef (`to`) Skript sürümünün matcher'ıyla
 * eşleştirir. Değerlendirme satır düzeyindedir; bir kaydın kimliği değişse bile satır hedefte başka
 * bir kayıtla tanınıyorsa sorun sayılmaz.
 *
 * - `removed`: satır kaynakta tanınıyor, hedefte hiçbir kayıtla tanınmıyor ve eşleşen kayıt hedefte yok.
 * - `changed`: aynı durum, ama kayıt hedefte var; kalıbı değişmiş (hedef kalıplar raporda gösterilir).
 * - `new`: satır yalnızca hedef sürümde tanınıyor (kaynakta hata veren satır geçişle düzelir).
 *
 * Hızlı düzeltmeler küçük bir kural tablosundan gelir ve yalnızca yeniden yazılmış satır hedef
 * sürümde gerçekten eşleşiyorsa önerilir.
 */

export type MigrationStatus = 'removed' | 'changed' | 'new'

export interface MigrationEntryRef {
  id: string
  name: string
  kind: string
  patterns: readonly string[]
}

export interface MigrationFix {
  title: string
  /** `range` yerine yazılacak metin; boş metin satırı kaldırır. */
  newText: string
  range: Range
}

export interface MigrationItem {
  uri: string
  line: number
  range: Range
  text: string
  status: MigrationStatus
  message: string
  /** Kaynak sürümde eşleşen kayıt (`new` için hedefteki). */
  entry?: MigrationEntryRef
  /** `changed`: aynı kaydın hedef sürümdeki kalıpları. */
  target?: MigrationEntryRef
  fix?: MigrationFix
}

export interface MigrationReport {
  from: string
  to: string
  files: number
  checkedLines: number
  counts: Record<MigrationStatus, number>
  items: MigrationItem[]
}

export interface MigrationFile {
  uri: string
  doc: SkriptDocument
  analysis: DocumentAnalysis
}

interface MigrationRule {
  title: string
  /** Kuralın uygulanacağı kayıt kimlikleri; yoksa her `removed`/`changed` satırda denenir. */
  ids?: readonly string[]
  rewrite(text: string): string | null
  /** Satırı tümden kaldırır (yalnızca davranışı etkilemeyen uyarı bastırma satırları için). */
  remove?: boolean
}

const RULES: readonly MigrationRule[] = [
  {
    // 2.14+: `[execute] command` yerine `execute` zorunlu.
    get title() {
      return l('Başına "execute" ekle', 'Prepend "execute"')
    },
    ids: ['EffCommand'],
    rewrite: (text) => (/^(?:the\s+)?(?:bungee(?:cord)?\s+)?commands?\s/i.test(text) ? `execute ${text}` : null)
  },
  {
    // `command executor` ifadesi kaldırıldı; `command sender` aynı değeri verir.
    get title() {
      return l('"executor" yerine "sender" yaz', 'Write "sender" instead of "executor"')
    },
    rewrite: (text) => (/\bexecutor\b/i.test(text) ? text.replace(/\bexecutor\b/gi, 'sender') : null)
  },
  {
    get title() {
      return l('Uyarı bastırma satırını kaldır', 'Remove the warning suppression line')
    },
    ids: ['EffSuppressWarnings', 'EffSuppressTypeHints'],
    rewrite: () => '',
    remove: true
  }
]

function entryRef(entry: SyntaxEntry): MigrationEntryRef {
  return { id: entry.id, name: entry.name, kind: entry.kind, patterns: entry.patterns ?? [] }
}

function exact(matches: readonly SyntaxMatchLike[]): SyntaxMatchLike | undefined {
  return matches.find((match) => match.confidence === 'exact')
}

export interface MigrationOptions {
  from: string
  to: string
  fromMatcher: MatcherAdapter
  toMatcher: MatcherAdapter
  /** Hedef sürüm kayıtları kimliğe göre (`changed` ayrımı ve hedef kalıplar için). */
  toEntries: ReadonlyMap<string, MigrationEntryRef>
  /** Uzun taramalarda olay döngüsüne dönmek için. */
  yieldEvery?: () => Promise<void>
}

export async function buildMigrationReport(files: readonly MigrationFile[], options: MigrationOptions): Promise<MigrationReport> {
  const items: MigrationItem[] = []
  let checkedLines = 0
  for (const file of files) {
    const parserErrorLines = new Set(
      file.doc.diagnostics.filter((d) => d.severity === 'error').map((d) => d.range.start.line)
    )
    const lines = [...file.analysis.lines.entries()].sort(([a], [b]) => a - b)
    for (const [line, context] of lines) {
      if (context.kind === 'skip' || parserErrorLines.has(line) || !context.text.trim()) continue
      checkedLines++
      const item = compareLine(file.uri, line, context as LineContext & { kind: LineGroup }, options)
      if (item) items.push(item)
    }
    await options.yieldEvery?.()
  }
  const counts: Record<MigrationStatus, number> = { removed: 0, changed: 0, new: 0 }
  for (const item of items) counts[item.status]++
  return { from: options.from, to: options.to, files: files.length, checkedLines, counts, items }
}

function compareLine(
  uri: string,
  line: number,
  context: LineContext & { kind: LineGroup },
  options: MigrationOptions
): MigrationItem | null {
  const fromMatches = matchLine(options.fromMatcher, context.kind, context.text, true)
  const toMatches = matchLine(options.toMatcher, context.kind, context.text, true)
  const base = { uri, line, range: context.range, text: context.text }
  if (toMatches.length > 0) {
    const found = exact(toMatches)
    if (fromMatches.length > 0 || !found) return null
    return {
      ...base,
      status: 'new',
      entry: entryRef(found.entry),
      message: l(`Skript ${options.from} bu satırı tanımıyor; ${options.to} sürümünde "${found.entry.name}" olarak tanınıyor.`, `Skript ${options.from} does not recognize this line; in ${options.to} it is recognized as "${found.entry.name}".`)
    }
  }
  const source = exact(fromMatches)
  if (!source) return null
  const target = options.toEntries.get(source.entry.id)
  const status: MigrationStatus = target ? 'changed' : 'removed'
  const message = target
    ? l(`"${source.entry.name}" Skript ${options.to} sürümünde değişti; bu yazılış artık tanınmıyor.`, `"${source.entry.name}" changed in Skript ${options.to}; this form is no longer recognized.`)
    : l(`"${source.entry.name}" Skript ${options.to} sürümünde kaldırıldı.`, `"${source.entry.name}" was removed in Skript ${options.to}.`)
  return {
    ...base,
    status,
    message,
    entry: entryRef(source.entry),
    target,
    fix: findFix(context, source.entry.id, options)
  }
}

function findFix(context: LineContext & { kind: LineGroup }, id: string, options: MigrationOptions): MigrationFix | undefined {
  for (const rule of RULES) {
    if (rule.ids && !rule.ids.includes(id)) continue
    const rewritten = rule.rewrite(context.text)
    if (rewritten === null) continue
    if (rule.remove) {
      // Satırın tamamı (girinti ve satır sonu dahil) kaldırılır.
      const range = { start: { line: context.range.start.line, character: 0 }, end: { line: context.range.start.line + 1, character: 0 } }
      return { title: rule.title, newText: '', range }
    }
    if (rewritten === context.text) continue
    if (!exact(matchLine(options.toMatcher, context.kind, rewritten, true))) continue
    return { title: rule.title, newText: rewritten, range: context.range }
  }
  return undefined
}
