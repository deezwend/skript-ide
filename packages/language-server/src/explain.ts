import { compilePattern, type PatternNode } from '@skript-ide/pattern-compiler'
import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import type { MatcherAdapter, SyntaxMatchLike } from './contracts'
import { matchLine, type LineGroup } from './diagnostics'
import { editDistance } from './variables'

/**
 * "Bu satır nasıl parse edildi?" sorusunu var olan eşleştiriciyle yanıtlar: hangi syntax kaydına
 * uyduğu, yer tutucuların neye çözüldüğü ve uymadıysa en yakın pattern'lerde neyin eksik olduğu.
 * İkinci bir parser değildir; yalnızca `matchLine` sonucunu ve derlenmiş pattern'leri okur.
 */

export interface ExplainedPlaceholder {
  /** Yer tutucunun eşleştiği alt metin (boş olabilir). */
  text: string
  types: readonly string[]
  nullable: boolean
  literalOnly: boolean
  changeable: boolean
  plural: boolean
  time?: number
  /** Alt metnin ifade olarak çözümü (iç içe, sınırlı derinlikte). */
  expression?: readonly ExplainedMatch[]
}

export interface ExplainedMatch {
  kind: SyntaxKind
  id: string
  name: string
  addon?: string
  pattern: string
  patternIndex: number
  confidence: 'exact' | 'structural'
  placeholders: readonly ExplainedPlaceholder[]
}

/** Eşleşmeyen satırda en yakın pattern ve tutmama nedeni. */
export interface ExplainedCandidate {
  kind: SyntaxKind
  id: string
  name: string
  addon?: string
  pattern: string
  missing: readonly string[]
  reason: string
}

export interface LineExplanation {
  /** 1 tabanlı satır numarası. */
  line: number
  text: string
  /** Satırın bağlamı (`event`, `condition`, `section`, `statement`); eşleştirilmeyecekse null. */
  context: string | null
  matches: readonly ExplainedMatch[]
  candidates: readonly ExplainedCandidate[]
  /** Satır beklenen türde değil de başka bir türde eşleştiyse. */
  otherKinds: readonly { kind: SyntaxKind; id: string; name: string; addon?: string }[]
}

export interface ExplainInput {
  /** 1 tabanlı satır numarası (yalnızca gösterim için). */
  line: number
  text: string
  context: LineGroup | null
  matcher: MatcherAdapter
  entries: readonly SyntaxEntry[]
  maxCandidates?: number
  /** Yer tutucu içindeki ifadelerin çözüleceği derinlik. */
  maxDepth?: number
}

const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_MAX_DEPTH = 2
const MAX_NESTED = 2
const MAX_OTHER_KINDS = 3

/** Bağlama göre eşleştirilecek kayıt türleri (`unknown-syntax` denetimiyle aynı). */
function kindsFor(group: LineGroup): readonly SyntaxKind[] {
  switch (group) {
    case 'event':
      return ['event']
    case 'condition':
      return ['condition']
    case 'section':
      return ['section', 'condition', 'effect']
    case 'statement':
      return ['effect', 'condition', 'section']
  }
}

/** Hiç uymayan satır başka bir tür olarak okunabilir mi? */
function otherKindsFor(group: LineGroup): readonly SyntaxKind[] {
  switch (group) {
    case 'event':
      return ['effect', 'condition', 'section']
    case 'condition':
      return ['effect', 'section']
    case 'section':
      return ['effect']
    case 'statement':
      return []
  }
}

export function explainLine(input: ExplainInput): LineExplanation {
  const empty: LineExplanation = {
    line: input.line,
    text: input.text,
    context: input.context,
    matches: [],
    candidates: [],
    otherKinds: []
  }
  if (input.context === null) return empty

  const depth = input.maxDepth ?? DEFAULT_MAX_DEPTH
  const matches = matchLine(input.matcher, input.context, input.text, true)
  if (matches.length > 0) {
    return { ...empty, matches: matches.map((match) => explainMatch(match, input.matcher, depth)) }
  }

  const candidates = nearMisses(
    input.entries,
    input.text,
    kindsFor(input.context),
    input.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  )
  const others: { kind: SyntaxKind; id: string; name: string; addon?: string }[] = []
  const otherKinds = otherKindsFor(input.context)
  if (otherKinds.length > 0) {
    for (const match of input.matcher.match(input.text, otherKinds)) {
      if (others.length >= MAX_OTHER_KINDS) break
      others.push(ref(match.entry))
    }
  }
  return { ...empty, candidates, otherKinds: others }
}

function ref(entry: SyntaxEntry): { kind: SyntaxKind; id: string; name: string; addon?: string } {
  return { kind: entry.kind, id: entry.id, name: entry.name, ...(entry.addon ? { addon: entry.addon } : {}) }
}

interface PlaceholderLike {
  text?: string
  types?: readonly string[]
  nullable?: boolean
  literalOnly?: boolean
  changeable?: boolean
  plural?: boolean
  time?: number
}

function explainMatch(match: SyntaxMatchLike, matcher: MatcherAdapter, depth: number): ExplainedMatch {
  const entry = match.entry
  const placeholders = (match.match.placeholders as readonly PlaceholderLike[]).map((raw): ExplainedPlaceholder => {
    const placeholder: ExplainedPlaceholder = {
      text: raw.text ?? '',
      types: raw.types ?? [],
      nullable: raw.nullable ?? false,
      literalOnly: raw.literalOnly ?? false,
      changeable: raw.changeable ?? false,
      plural: raw.plural ?? false
    }
    if (raw.time !== undefined) placeholder.time = raw.time
    if (depth <= 0 || placeholder.literalOnly || placeholder.text.trim() === '') return placeholder
    // Alt metnin ifade olarak çözümü. Matcher'ın sıralaması literal tanımayı (`literal:string` gibi)
    // geriye atabildiğinden literal kayıtlar öne alınır; yoksa `"hi"` bir "Entities" ifadesi gibi görünür.
    const nestedMatches = matcher.matchExpression(placeholder.text)
    const ordered = [
      ...nestedMatches.filter((item) => item.entry.id.startsWith('literal:')),
      ...nestedMatches.filter((item) => !item.entry.id.startsWith('literal:'))
    ]
    const nested = ordered.slice(0, MAX_NESTED).map((item) => explainMatch(item, matcher, depth - 1))
    if (nested.length > 0) placeholder.expression = nested
    return placeholder
  })

  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    ...(entry.addon ? { addon: entry.addon } : {}),
    pattern: entry.patterns[match.patternIndex] ?? '',
    patternIndex: match.patternIndex,
    confidence: match.confidence,
    placeholders
  }
}

// --- En yakın pattern'ler ---

interface PatternWords {
  /** Zorunlu (opsiyonel olmayan) literal kelimeler. */
  required: readonly string[]
  /** Opsiyoneller ve seçenekler dahil tüm literal kelimeler; benzerlik ölçüsü için. */
  all: readonly string[]
}

/** Pahalı derlemeyi pattern başına bir kez yapar; derleme başarısızsa boş. */
const wordsCache = new Map<string, PatternWords>()

function patternWords(pattern: string): PatternWords {
  const cached = wordsCache.get(pattern)
  if (cached !== undefined) return cached
  let words: PatternWords = { required: [], all: [] }
  try {
    const ast = compilePattern(pattern, { tolerant: true }).ast
    words = { required: [...collectWords(ast, true)], all: [...collectWords(ast, false)] }
  } catch {
    words = { required: [], all: [] }
  }
  if (wordsCache.size > 20_000) wordsCache.clear()
  wordsCache.set(pattern, words)
  return words
}

/** Literal kelimeler; `strict` ise opsiyonel parçalar ve seçenekler yok sayılır. */
function collectWords(node: PatternNode, strict: boolean): Set<string> {
  switch (node.type) {
    case 'sequence': {
      const words = new Set<string>()
      for (const child of node.nodes) for (const word of collectWords(child, strict)) words.add(word)
      return words
    }
    case 'choice': {
      if (!strict) {
        const words = new Set<string>()
        for (const alternative of node.alternatives) for (const word of collectWords(alternative, false)) words.add(word)
        return words
      }
      let common: Set<string> | null = null
      for (const alternative of node.alternatives) {
        const words = collectWords(alternative, true)
        if (common === null) common = new Set(words)
        else for (const word of [...common]) if (!words.has(word)) common.delete(word)
      }
      return common ?? new Set()
    }
    case 'group':
      return collectWords(node.node, strict)
    case 'optional':
      return strict ? new Set<string>() : collectWords(node.node, false)
    case 'literal':
      return new Set(node.text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    default:
      return new Set()
  }
}

/**
 * Aday sıralamasında bağlaçlar belirleyici olmasın: `to`, `the` gibi kelimeler neredeyse her
 * pattern'de geçtiği için yalnızca anlamlı kelimeler benzerlik hesabına katılır.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'with', 'and', 'or', 'is', 'are', 'was', 'were',
  'be', 'it', 'its', 'this', 'that', 'these', 'those', 'all', 'any', 'as', 'for', 'by', 'from',
  'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'if', 'else', 'when', 'then', 'so',
  'can', 'will', 'would', 'should', 'may', 'might', 'must', 'than', 'up', 'down', 'out', 'over',
  'into', 'per', 'via', 's', 'es', 'ed'
])

function isSignificant(word: string): boolean {
  return word.length > 2 && !STOP_WORDS.has(word)
}

function nearMisses(
  entries: readonly SyntaxEntry[],
  text: string,
  kinds: readonly SyntaxKind[],
  limit: number
): ExplainedCandidate[] {
  const kindSet = new Set(kinds)
  const inputWords = new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
  const scored: {
    candidate: ExplainedCandidate
    shared: number
    missing: number
    literals: number
  }[] = []

  for (const entry of entries) {
    if (!kindSet.has(entry.kind)) continue
    for (const pattern of entry.patterns) {
      const { required, all } = patternWords(pattern)
      const literals = all.filter(isSignificant)
      if (literals.length === 0) continue
      const shared = literals.filter((word) => inputWords.has(word) || closestWord(word, inputWords) !== null).length
      // Ne ortak anlamlı kelime ne de yazım yakınlığı varsa bu pattern satırla ilgili değildir
      if (shared === 0) continue
      const missing: string[] = []
      const hints: string[] = []
      for (const word of required) {
        if (!isSignificant(word) || inputWords.has(word)) continue
        missing.push(word)
        const best = closestWord(word, inputWords)
        if (best !== null) hints.push(`"${word}" (close to "${best}")`)
      }
      const reason =
        missing.length === 0
          ? 'the structure does not fit (word order, types or separators)'
          : `missing ${mergeHints(missing, hints)}`
      scored.push({
        candidate: { ...ref(entry), pattern, missing, reason },
        shared,
        missing: missing.length,
        literals: literals.length
      })
    }
  }

  scored.sort(
    (left, right) =>
      right.shared - left.shared ||
      left.missing - right.missing ||
      left.literals - right.literals ||
      left.candidate.pattern.length - right.candidate.pattern.length
  )
  return scored.slice(0, limit).map((item) => item.candidate)
}

/** Eksik kelimeleri ipuçlarıyla birlikte yazar; ipucu olmayanlar tırnak içinde listelenir. */
function mergeHints(missing: readonly string[], hints: readonly string[]): string {
  const hinted = new Set(hints.map((hint) => hint.slice(1, hint.indexOf('"', 1))))
  const plain = missing.filter((word) => !hinted.has(word)).map((word) => `"${word}"`)
  const parts = [...hints, ...plain]
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? ', …' : '')
}

/** Kısa kelimelerde (bağlaçlar) yazım yakınlığı anlamsız; yalnızca tek harf farkı olan yakın adayları döndürür. */
function closestWord(word: string, candidates: ReadonlySet<string>): string | null {
  if (word.length < 4) return null
  const allowed = Math.max(1, Math.floor(word.length / 4))
  let best: string | null = null
  let bestDistance = allowed + 1
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - word.length) > allowed) continue
    const distance = editDistance(word, candidate, allowed)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}
