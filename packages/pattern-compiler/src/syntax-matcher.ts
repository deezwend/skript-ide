/**
 * Syntax veritabanındaki pattern'leri bir kez derleyip satır/olay/ifade eşleştirmesi yapan
 * üst düzey eşleştirici.
 *
 * Tasarım ilkesi: yanlış pozitif, uyarı vermemekten kötüdür. Yer tutucunun içi kesin olarak
 * tanınamıyorsa sonuç `structural` olur; satır hiç eşleşmiyorsa boş liste döner.
 */

import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import {
  countLiteralChars,
  countPlaceholders,
  type PatternNode,
  type PlaceholderInfo
} from './ast'
import { compilePattern, PatternSyntaxError, type CompiledPattern } from './compiler'
import {
  classifyLiteral,
  isChangeableText,
  isLiteralOnlyText,
  isPlausiblePlaceholderText
} from './lexical'
import {
  createMatchBudget,
  matchWithBudget,
  type MatchBudget,
  type PatternMatch
} from './matcher'
import { findParenEnd, splitTopLevelList } from './scan'

import { l } from '@skript-ide/i18n'
export type MatchConfidence = 'exact' | 'structural'

export interface SyntaxMatch {
  readonly entry: SyntaxEntry
  readonly patternIndex: number
  readonly match: PatternMatch
  readonly confidence: MatchConfidence
}

/**
 * Eşleşmeler ve aramanın tamamlanıp tamamlanmadığı. `complete: false` ise adım bütçesi tükenmiştir:
 * boş liste "hiçbir syntax'a uymuyor" anlamına gelmez.
 */
export interface SyntaxMatchResult {
  readonly matches: readonly SyntaxMatch[]
  readonly complete: boolean
}

export interface SyntaxMatcherOptions {
  /** İç içe ifade doğrulamasında en fazla derinlik (varsayılan 3). */
  maxDepth?: number
  /** Tek bir `match` çağrısı için adım bütçesi. Aşılırsa elde olanla döner. */
  maxSteps?: number
}

export interface PatternCompileError {
  readonly entry: SyntaxEntry
  readonly pattern: string
  readonly message: string
}

interface CompiledEntry {
  readonly entry: SyntaxEntry
  readonly patternIndex: number
  readonly compiled: CompiledPattern
  readonly literalChars: number
  readonly placeholderCount: number
  /**
   * `[the] [event-]<.+>` gibi, zorunlu literal içermeyen ve her metni yakalayan ifade
   * pattern'leri. Bunlar eşleşme üretir ama "kesin" sayılmaz; aksi halde her metin
   * geçerli ifade olurdu.
   */
  readonly genericExpression: boolean
}

interface ScoredMatch {
  readonly syntaxMatch: SyntaxMatch
  readonly literalChars: number
  readonly placeholderCount: number
}

const CACHE_LIMIT = 3000
const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_STEPS = 20000

export class SyntaxMatcher {
  readonly patternErrors: readonly PatternCompileError[]

  private readonly byKind = new Map<SyntaxKind, CompiledEntry[]>()
  private readonly expressionEntries: CompiledEntry[] = []
  private readonly maxDepth: number
  private readonly maxSteps: number
  private readonly matchCache = new Map<string, readonly SyntaxMatch[]>()
  private readonly eventCache = new Map<string, readonly SyntaxMatch[]>()
  private readonly expressionCache = new Map<string, readonly SyntaxMatch[]>()
  private readonly expressionMatchesByKey = new Map<string, readonly ScoredMatch[]>()

  constructor(entries: readonly SyntaxEntry[], options: SyntaxMatcherOptions = {}) {
    this.maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH)
    this.maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS)

    const errors: PatternCompileError[] = []

    for (const entry of entries) {
      const compiledForEntry: CompiledEntry[] = []

      for (let patternIndex = 0; patternIndex < entry.patterns.length; patternIndex++) {
        const pattern = entry.patterns[patternIndex]!
        try {
          const compiled = compilePattern(pattern, { tolerant: true })
          const item: CompiledEntry = {
            entry,
            patternIndex,
            compiled,
            literalChars: countLiteralChars(compiled.ast),
            placeholderCount: countPlaceholders(compiled.ast),
            genericExpression: !hasMandatoryLiteral(compiled.ast) && hasMandatoryCatchAllRegex(compiled.ast)
          }
          compiledForEntry.push(item)
          if (entry.kind === 'expression') this.expressionEntries.push(item)
        } catch (error) {
          const message = error instanceof PatternSyntaxError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error)
          errors.push({ entry, pattern, message })
        }
      }

      if (compiledForEntry.length > 0) {
        const list = this.byKind.get(entry.kind)
        if (list === undefined) this.byKind.set(entry.kind, compiledForEntry)
        else list.push(...compiledForEntry)
      }
    }

    this.patternErrors = errors
  }

  /** Bir satır içeriğini verilen türlerdeki kayıtlarla eşleştirir. */
  match(text: string, kinds: readonly SyntaxKind[]): readonly SyntaxMatch[] {
    return this.matchWithStatus(text, kinds).matches
  }

  /** `match` gibi; ayrıca aramanın bütçe tükenmeden bitip bitmediğini bildirir. */
  matchWithStatus(text: string, kinds: readonly SyntaxKind[]): SyntaxMatchResult {
    const uniqueKinds = [...new Set(kinds)]
    const input = text.trim()
    const key = `m\u0000${uniqueKinds.slice().sort().join(',')}\u0000${input}`
    const cached = this.matchCache.get(key)
    // Önbelleğe yalnızca tamamlanmış aramalar yazılır.
    if (cached !== undefined) return { matches: cached, complete: true }

    const budget = createMatchBudget(this.maxSteps)
    const scored = this.matchInternal(input, uniqueKinds, budget)
    const result = sortMatches(scored)
    if (!budget.exhausted) this.remember(this.matchCache, key, result)
    return { matches: result, complete: !budget.exhausted }
  }

  /**
   * Olay başlığını `StructEvent` sarmalayıcısından soyar: `[on]`, `cancelled/uncancelled/any/all`
   * ve `with priority ...`.
   */
  matchEvent(header: string): readonly SyntaxMatch[] {
    return this.matchEventWithStatus(header).matches
  }

  /** `matchEvent` gibi; ayrıca aramanın bütçe tükenmeden bitip bitmediğini bildirir. */
  matchEventWithStatus(header: string): SyntaxMatchResult {
    const input = header.trim().replace(/:$/, '').trim()
    const key = `e\u0000${input}`
    const cached = this.eventCache.get(key)
    if (cached !== undefined) return { matches: cached, complete: true }

    const budget = createMatchBudget(this.maxSteps)
    const merged: ScoredMatch[] = []
    const seen = new Set<string>()

    for (const candidate of eventCandidates(input)) {
      if (budget.exhausted) break
      const scored = this.matchInternal(candidate, ['event'], budget)
      for (const item of scored) {
        const id = `${item.syntaxMatch.entry.kind}\u0000${item.syntaxMatch.entry.id}\u0000${item.syntaxMatch.patternIndex}`
        if (seen.has(id)) continue
        seen.add(id)
        merged.push(item)
      }
    }

    const result = sortMatches(merged)
    if (!budget.exhausted) this.remember(this.eventCache, key, result)
    return { matches: result, complete: !budget.exhausted }
  }

  /** Bir metnin ifade/literal olarak tanınıp tanınmadığı. */
  matchExpression(text: string): readonly SyntaxMatch[] {
    const input = text.trim()
    const key = `x\u0000${input}`
    const cached = this.expressionCache.get(key)
    if (cached !== undefined) return cached

    const budget = createMatchBudget(this.maxSteps)
    const scored = this.expressionMatches(input, budget, 0, true, true)
    const result = sortMatches(scored)
    if (!budget.exhausted) this.remember(this.expressionCache, key, result)
    return result
  }

  private matchInternal(
    text: string,
    kinds: readonly SyntaxKind[],
    budget: MatchBudget
  ): ScoredMatch[] {
    const lower = text.toLowerCase()
    const results: ScoredMatch[] = []

    for (const kind of kinds) {
      const entries = this.byKind.get(kind)
      if (entries === undefined) continue

      for (const item of entries) {
        if (budget.exhausted) return results
        if (!requiredWordsPresent(item.compiled.requiredWords, lower)) continue

        // Önce yapısal eşleşme bulunur (ucuz), sonra yer tutucuların içi doğrulanır.
        // Böylece pattern'in denediği her olası bölünme için pahalı ifade araması yapılmaz.
        const match = matchWithBudget(
          item.compiled,
          text,
          (placeholder, info) => this.acceptLoosePlaceholder(placeholder, info),
          budget
        )
        if (match === null) continue

        const confidence: MatchConfidence = this.allPlaceholdersExact(match, budget, 1)
          ? 'exact'
          : 'structural'
        results.push({
          syntaxMatch: {
            entry: item.entry,
            patternIndex: item.patternIndex,
            match,
            confidence
          },
          literalChars: item.literalChars,
          placeholderCount: item.placeholderCount
        })
      }
    }

    return results
  }

  private expressionMatches(
    text: string,
    budget: MatchBudget,
    depth: number,
    allowSynthetic: boolean,
    useCache: boolean
  ): ScoredMatch[] {
    const input = text.trim()
    const key = `${depth}\u0000${allowSynthetic ? '1' : '0'}\u0000${input}`
    if (useCache) {
      const cached = this.expressionMatchesByKey.get(key)
      if (cached !== undefined) return [...cached]
    }

    const lower = input.toLowerCase()
    const results: ScoredMatch[] = []
    const canValidateRecursively = depth < this.maxDepth

    for (const item of this.expressionEntries) {
      if (budget.exhausted) break
      if (!requiredWordsPresent(item.compiled.requiredWords, lower)) continue

      const match = matchWithBudget(
        item.compiled,
        input,
        (placeholder, info) => this.acceptLoosePlaceholder(placeholder, info),
        budget
      )
      if (match === null) continue

      const confidence: MatchConfidence =
        canValidateRecursively &&
        !item.genericExpression &&
        this.allPlaceholdersExact(match, budget, depth + 1)
          ? 'exact'
          : 'structural'

      results.push({
        syntaxMatch: {
          entry: item.entry,
          patternIndex: item.patternIndex,
          match,
          confidence
        },
        literalChars: item.literalChars,
        placeholderCount: item.placeholderCount
      })
    }

    if (allowSynthetic) {
      const category = classifyLiteral(input)
      if (category !== null) {
        results.push({
          syntaxMatch: {
            entry: syntheticEntry(category),
            patternIndex: 0,
            match: EMPTY_MATCH,
            confidence: 'exact'
          },
          literalChars: input.length,
          placeholderCount: 0
        })
      }
    }

    if (useCache && !budget.exhausted) {
      this.rememberScored(this.expressionMatchesByKey, key, results)
    }

    return results
  }

  private isExpressionText(text: string, budget: MatchBudget, depth: number): boolean {
    const input = text.trim()
    if (input === '') return false
    if (budget.exhausted) return false

    if (input.startsWith('(') && findParenEnd(input, 0) === input.length - 1) {
      if (depth >= this.maxDepth) return false
      return this.isExpressionText(input.slice(1, -1), budget, depth + 1)
    }

    if (classifyLiteral(input) !== null) return true
    if (depth >= this.maxDepth) return false

    const parts = splitTopLevelList(input)
    if (parts.length > 1) {
      return parts.every(part => this.isExpressionText(part, budget, depth + 1))
    }

    const matches = this.expressionMatches(input, budget, depth, false, true)
    return matches.some(item => item.syntaxMatch.confidence === 'exact')
  }

  private allPlaceholdersExact(match: PatternMatch, budget: MatchBudget, depth: number): boolean {
    for (const placeholder of match.placeholders) {
      if (!this.validatePlaceholder(placeholder.text, placeholder, budget, depth)) return false
    }
    return true
  }

  private validatePlaceholder(
    text: string,
    info: PlaceholderInfo,
    budget: MatchBudget,
    depth: number
  ): boolean {
    const input = text.trim()
    if (input === '') return info.nullable
    if (budget.exhausted) return false

    if (info.literalOnly) return isLiteralOnlyText(input)
    if (info.changeable) return isChangeableText(input)
    return this.isExpressionText(input, budget, depth)
  }

  private acceptLoosePlaceholder(text: string, info: PlaceholderInfo): boolean {
    const input = text.trim()
    if (input === '') return info.nullable

    if (info.literalOnly) return isLiteralOnlyText(input)

    if (info.changeable) {
      if (isChangeableText(input)) return true
      const category = classifyLiteral(input)
      // Olay ve döngü değerleri (`event-block`, `loop-value`) çoğu olayda değiştirilebilir.
      if (
        category !== null &&
        category !== 'bare-token' &&
        category !== 'variable' &&
        category !== 'event-value' &&
        category !== 'loop-value'
      ) {
        return false
      }
    }

    return isPlausiblePlaceholderText(input)
  }

  private remember(map: Map<string, readonly SyntaxMatch[]>, key: string, value: readonly SyntaxMatch[]): void {
    if (map.size >= CACHE_LIMIT) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }

  private rememberScored(map: Map<string, readonly ScoredMatch[]>, key: string, value: readonly ScoredMatch[]): void {
    if (map.size >= CACHE_LIMIT) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }
}

const EMPTY_MATCH: PatternMatch = { mark: 0, tags: [], placeholders: [], regexes: [] }

const syntheticEntries = new Map<string, SyntaxEntry>()

const syntheticNames = (): Record<string, string> => ({
  option: l('Seçenek', 'Option'),
  string: l('Metin', 'Text'),
  variable: l('Değişken', 'Variable'),
  number: l('Sayı', 'Number'),
  timespan: l('Zaman aralığı', 'Timespan'),
  clock: l('Saat', 'Time'),
  boolean: l('Mantıksal değer', 'Boolean'),
  argument: l('Argüman', 'Argument'),
  'event-value': l('Olay değeri', 'Event value'),
  'loop-value': l('Döngü değeri', 'Loop value'),
  'function-call': l('Fonksiyon çağrısı', 'Function call'),
  parenthesized: l('Parantezli ifade', 'Parenthesized expression'),
  list: l('Liste', 'List'),
  'bare-token': 'Literal'
})

function syntheticEntry(category: string): SyntaxEntry {
  const cached = syntheticEntries.get(category)
  if (cached !== undefined) return cached

  const entry: SyntaxEntry = {
    kind: 'expression',
    id: `literal:${category}`,
    name: syntheticNames()[category] ?? 'Literal',
    patterns: [],
    description: l('Yerleşik literal/ifade tanıması.', 'Built-in literal/expression recognition.'),
    examples: [],
    since: [],
    deprecated: false
  }
  syntheticEntries.set(category, entry)
  return entry
}

/** Opsiyonel olmayan, boşluk dışı bir literal var mı? */
function hasMandatoryLiteral(node: PatternNode): boolean {
  switch (node.type) {
    case 'sequence':
      return node.nodes.some(hasMandatoryLiteral)
    case 'choice':
      return node.alternatives.some(hasMandatoryLiteral)
    case 'group':
      return hasMandatoryLiteral(node.node)
    case 'optional':
      return false
    case 'literal':
      return node.text.trim() !== ''
    default:
      return false
  }
}

/** Zorunlu (opsiyonel olmayan) bir `<.+>` / `<.*>` regex'i var mı? */
function hasMandatoryCatchAllRegex(node: PatternNode): boolean {
  switch (node.type) {
    case 'sequence':
      return node.nodes.some(hasMandatoryCatchAllRegex)
    case 'choice':
      return node.alternatives.some(hasMandatoryCatchAllRegex)
    case 'group':
      return hasMandatoryCatchAllRegex(node.node)
    case 'optional':
      return false
    case 'regex':
      return node.source === '.+' || node.source === '.*'
    default:
      return false
  }
}

function requiredWordsPresent(words: readonly string[], lowerInput: string): boolean {
  for (const word of words) {
    if (!lowerInput.includes(word)) return false
  }
  return true
}

function sortMatches(matches: readonly ScoredMatch[]): readonly SyntaxMatch[] {
  const sorted = matches.slice().sort((left, right) => {
    if (left.syntaxMatch.confidence !== right.syntaxMatch.confidence) {
      return left.syntaxMatch.confidence === 'exact' ? -1 : 1
    }
    if (left.literalChars !== right.literalChars) return right.literalChars - left.literalChars
    if (left.placeholderCount !== right.placeholderCount) {
      return left.placeholderCount - right.placeholderCount
    }
    const leftId = `${left.syntaxMatch.entry.kind}:${left.syntaxMatch.entry.id}`
    const rightId = `${right.syntaxMatch.entry.kind}:${right.syntaxMatch.entry.id}`
    if (leftId !== rightId) return leftId < rightId ? -1 : 1
    return left.syntaxMatch.patternIndex - right.syntaxMatch.patternIndex
  })
  return sorted.map(item => item.syntaxMatch)
}

/** `StructEvent` sarmalayıcısını soyar; en çok soyulmuş aday başta. */
function eventCandidates(header: string): string[] {
  const candidates: string[] = []
  const add = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed !== '' && !candidates.includes(trimmed)) candidates.push(trimmed)
  }

  const withoutPriority = header.replace(
    /\s+with\s+priority\s+(?:lowest|low|normal|high|highest|monitor)\s*$/i,
    ''
  )

  for (const base of [withoutPriority, header]) {
    const withoutOn = base.replace(/^on\s+/i, '')
    add(withoutOn)
    add(withoutOn.replace(/^(?:uncancelled|cancelled|any|all)\s+/i, ''))
  }

  return candidates
}
