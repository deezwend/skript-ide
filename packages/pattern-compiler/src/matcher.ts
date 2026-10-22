/**
 * Derlenmiş pattern'leri Skript'in eşleştirme kurallarıyla çalıştırır.
 *
 * `LiteralPatternElement` boşluk davranışı, `TypePatternElement`'in ifade sınırları
 * (`SkriptParser#next`), `ChoicePatternElement` sırası ve parse mark'ların XOR ile
 * birleşmesi kaynaktan alınmıştır.
 */

import type { PatternNode, PlaceholderInfo } from './ast'
import type { CompiledPattern } from './compiler'
import { findBraceEnd, findParenEnd, findStringEnd, nextIndex } from './scan'

export interface PlaceholderMatch extends PlaceholderInfo {
  readonly text: string
  /** Girdi metni içindeki [start, end) */
  readonly start: number
  readonly end: number
}

export interface PatternMatch {
  /** Seçilen parse mark'ların XOR bileşimi. */
  readonly mark: number
  readonly tags: readonly string[]
  readonly placeholders: readonly PlaceholderMatch[]
  readonly regexes: readonly { text: string; start: number; end: number }[]
}

export interface MatchOptions {
  /** Yer tutucu metni kabul edilebilir mi? Verilmezse boş olmayan, dengeli her metin kabul edilir. */
  placeholder?: (text: string, info: PlaceholderInfo) => boolean
  /** Geri izleme adım sınırı. Aşılırsa null döner. */
  maxSteps?: number
}

export interface MatchBudget {
  steps: number
  maxSteps: number
  exhausted: boolean
}

export function createMatchBudget(maxSteps = 6000): MatchBudget {
  return { steps: 0, maxSteps, exhausted: false }
}

interface PlaceholderRecord {
  info: PlaceholderInfo
  text: string
  start: number
  end: number
}

interface RegexRecord {
  text: string
  start: number
  end: number
}

interface MatchState {
  pos: number
  mark: number
  tags: readonly string[]
  placeholders: readonly PlaceholderRecord[]
  regexes: readonly RegexRecord[]
}

const DEFAULT_MAX_STEPS = 6000
const regexCache = new Map<string, RegExp>()

function tick(budget: MatchBudget): boolean {
  if (budget.steps >= budget.maxSteps) {
    budget.exhausted = true
    return false
  }
  budget.steps++
  return true
}

export function matchPattern(
  pattern: CompiledPattern,
  input: string,
  options: MatchOptions = {}
): PatternMatch | null {
  const accept = options.placeholder ?? defaultPlaceholder
  const budget = createMatchBudget(options.maxSteps ?? DEFAULT_MAX_STEPS)
  return matchWithBudget(pattern, input, accept, budget)
}

/**
 * `SyntaxMatcher` gibi kendi bütçesini ve önbelleğini yöneten çağıranlar için.
 * `budget` birden fazla pattern arasında paylaşılabilir.
 */
export function matchWithBudget(
  pattern: CompiledPattern,
  input: string,
  acceptPlaceholder: (text: string, info: PlaceholderInfo) => boolean,
  budget: MatchBudget
): PatternMatch | null {
  const leading = input.length - input.trimStart().length
  const text = input.trim()
  const baseOffset = leading

  const initial: MatchState = {
    pos: 0,
    mark: 0,
    tags: [],
    placeholders: [],
    regexes: []
  }

  const result = matchNode(pattern.ast, initial, (state) => {
    return state.pos === text.length ? state : null
  }, text, acceptPlaceholder, budget)

  if (result === null) return null

  return {
    mark: result.mark,
    tags: result.tags,
    placeholders: result.placeholders.map(record => ({
      ...record.info,
      text: record.text,
      start: record.start + baseOffset,
      end: record.end + baseOffset
    })),
    regexes: result.regexes.map(record => ({
      text: record.text,
      start: record.start + baseOffset,
      end: record.end + baseOffset
    }))
  }
}

function defaultPlaceholder(text: string, info: PlaceholderInfo): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return info.nullable
  return isPlausibleText(trimmed)
}

function isPlausibleText(text: string): boolean {
  if (text.includes('\n') || text.includes('\r')) return false

  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      const close = findStringEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '{') {
      const close = findBraceEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '(') {
      const close = findParenEnd(text, index)
      if (close === -1) return false
      index = close + 1
      continue
    }
    if (char === '%') return false
    index++
  }

  return true
}

type Continuation = (state: MatchState) => MatchState | null

function matchNode(
  node: PatternNode,
  state: MatchState,
  cont: Continuation,
  text: string,
  acceptPlaceholder: (text: string, info: PlaceholderInfo) => boolean,
  budget: MatchBudget
): MatchState | null {
  if (!tick(budget)) return null

  switch (node.type) {
    case 'sequence':
      return matchSequence(node.nodes, 0, state, cont, text, acceptPlaceholder, budget)

    case 'literal': {
      const pos = matchLiteral(node.text, text, state.pos)
      if (pos === null) return null
      return cont({ ...state, pos })
    }

    case 'optional': {
      const attempted = matchNode(node.node, state, cont, text, acceptPlaceholder, budget)
      if (attempted !== null) return attempted
      return cont(state)
    }

    case 'group':
      return matchNode(node.node, state, cont, text, acceptPlaceholder, budget)

    case 'choice': {
      for (const alternative of node.alternatives) {
        if (!tick(budget)) return null
        const result = matchNode(alternative, state, cont, text, acceptPlaceholder, budget)
        if (result !== null) return result
      }
      return null
    }

    case 'placeholder': {
      const candidates: number[] = []
      if (node.info.nullable) candidates.push(state.pos)
      let cursor = state.pos
      while (cursor < text.length) {
        const next = nextIndex(text, cursor)
        if (next <= cursor) break
        candidates.push(next)
        cursor = next
      }

      for (const end of candidates) {
        if (!tick(budget)) return null
        const raw = text.slice(state.pos, end)
        const trimmed = raw.trim()
        if (trimmed === '' && !node.info.nullable) continue

        const startOffset = state.pos + (raw.length - raw.trimStart().length)
        const endOffset = end - (raw.length - raw.trimEnd().length)
        const candidate: PlaceholderRecord = {
          info: node.info,
          text: trimmed,
          start: startOffset,
          end: endOffset
        }

        if (!acceptPlaceholder(trimmed, node.info)) continue

        const nextState: MatchState = {
          ...state,
          pos: end,
          placeholders: [...state.placeholders, candidate]
        }
        const result = cont(nextState)
        if (result !== null) return result
      }
      return null
    }

    case 'regex': {
      const matcher = getRegex(node.source)
      let cursor = state.pos
      while (cursor < text.length) {
        const end = nextIndex(text, cursor)
        if (end <= cursor) break
        cursor = end
        if (!tick(budget)) return null

        const raw = text.slice(state.pos, end)
        if (!matcher.test(raw)) continue

        const result = cont({
          ...state,
          pos: end,
          regexes: [
            ...state.regexes,
            { text: raw, start: state.pos, end }
          ]
        })
        if (result !== null) return result
      }
      return null
    }

    case 'parse-tag':
      return cont({
        ...state,
        mark: state.mark ^ node.mark,
        tags: node.tag !== null && node.tag !== '' ? [...state.tags, node.tag] : state.tags
      })
  }
}

function matchSequence(
  nodes: readonly PatternNode[],
  index: number,
  state: MatchState,
  cont: Continuation,
  text: string,
  acceptPlaceholder: (text: string, info: PlaceholderInfo) => boolean,
  budget: MatchBudget
): MatchState | null {
  if (index >= nodes.length) return cont(state)
  return matchNode(
    nodes[index]!,
    state,
    (nextState) => matchSequence(nodes, index + 1, nextState, cont, text, acceptPlaceholder, budget),
    text,
    acceptPlaceholder,
    budget
  )
}

/** `LiteralPatternElement#match` ile aynı boşluk ve büyük/küçük harf davranışı. */
function matchLiteral(literal: string, text: string, start: number): number | null {
  let pos = start

  for (const char of literal) {
    if (char === ' ') {
      if (pos === 0 || pos === text.length) continue
      if (text[pos] === ' ') {
        pos++
        continue
      }
      if (text[pos - 1] === ' ') continue
      return null
    }

    if (pos >= text.length || char.toLowerCase() !== text[pos]!.toLowerCase()) {
      return null
    }
    pos++
  }

  return pos
}

function getRegex(source: string): RegExp {
  const cached = regexCache.get(source)
  if (cached !== undefined) return cached
  const regex = new RegExp(`^(?:${source})$`)
  regexCache.set(source, regex)
  return regex
}
