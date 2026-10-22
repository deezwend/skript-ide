/** Testlerde gerçek `@skript-ide/pattern-compiler` yerine kullanılan küçük uygulama. */

import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import type {
  MatcherAdapter,
  PatternCompilerAdapter,
  SyntaxMatchLike
} from '../../src/contracts'

export function createFakeCompiler(): PatternCompilerAdapter {
  return {
    createMatcher: (entries) => new FakeMatcher(entries),
    toSnippet: (pattern) => transform(pattern, 'snippet'),
    toLabel: (pattern) => transform(pattern, 'label')
  }
}

class FakeMatcher implements MatcherAdapter {
  private readonly compiled = new Map<string, RegExp | null>()

  constructor(private readonly entries: readonly SyntaxEntry[]) {}

  match(text: string, kinds: readonly SyntaxKind[]): readonly SyntaxMatchLike[] {
    return this.run(text, new Set(kinds), (entry) => entry.patterns)
  }

  matchEvent(header: string): readonly SyntaxMatchLike[] {
    const trimmed = header.trim().replace(/\s+with\s+priority\s+.*$/i, '')
    const withoutOn = trimmed.replace(/^on\s+/i, '')
    const direct = this.run(trimmed, new Set(['event']), (entry) => entry.patterns)
    if (direct.length > 0) return direct
    return this.run(withoutOn, new Set(['event']), (entry) => entry.patterns)
  }

  matchExpression(text: string): readonly SyntaxMatchLike[] {
    return this.run(text, new Set(['expression']), (entry) => entry.patterns)
  }

  private run(
    text: string,
    kinds: ReadonlySet<SyntaxKind>,
    patterns: (entry: SyntaxEntry) => readonly string[]
  ): readonly SyntaxMatchLike[] {
    const input = text.trim()
    if (!input) return []
    const matches: SyntaxMatchLike[] = []
    for (const entry of this.entries) {
      if (!kinds.has(entry.kind)) continue
      patterns(entry).forEach((pattern, patternIndex) => {
        const regex = this.regexFor(pattern)
        if (!regex || !regex.test(input)) return
        matches.push({
          entry,
          patternIndex,
          confidence: 'exact',
          match: { mark: 0, tags: [], placeholders: [], regexes: [] }
        })
      })
    }
    return matches.sort((left, right) => {
      const leftPattern = left.entry.patterns[left.patternIndex] ?? ''
      const rightPattern = right.entry.patterns[right.patternIndex] ?? ''
      return rightPattern.length - leftPattern.length || left.entry.name.localeCompare(right.entry.name)
    })
  }

  private regexFor(pattern: string): RegExp | null {
    if (this.compiled.has(pattern)) return this.compiled.get(pattern) ?? null
    try {
      const source = toRegexSource(pattern)
      const regex = new RegExp(`^${source}$`, 'i')
      this.compiled.set(pattern, regex)
      return regex
    } catch {
      this.compiled.set(pattern, null)
      return null
    }
  }
}

function toRegexSource(pattern: string): string {
  let result = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '[') {
      if (pattern[index + 1] === '[') {
        const end = pattern.indexOf(']]', index + 2)
        if (end !== -1) {
          index = end + 2
          continue
        }
      }
      const end = matching(pattern, index, '[', ']')
      if (end !== -1) {
        result += `(?:${toRegexSource(pattern.slice(index + 1, end))})?`
        index = end + 1
        if (pattern[index] === ' ') {
          result += '(?:\\s+)?'
          index += 1
        }
        continue
      }
    }
    if (char === '(') {
      const end = matching(pattern, index, '(', ')')
      if (end !== -1) {
        const inner = pattern.slice(index + 1, end)
        const alternatives = splitTopLevel(inner, '|').map((part) => toRegexSource(part))
        result += `(?:${alternatives.join('|')})`
        index = end + 1
        continue
      }
    }
    if (char === '%') {
      const end = pattern.indexOf('%', index + 1)
      if (end !== -1) {
        result += '(.+?)'
        index = end + 1
        continue
      }
    }
    if (char === '<') {
      const end = pattern.indexOf('>', index + 1)
      if (end !== -1) {
        result += `(?:${pattern.slice(index + 1, end)})`
        index = end + 1
        continue
      }
    }
    if (char === ' ') {
      result += '\\s+'
      index += 1
      while (pattern[index] === ' ') index += 1
      continue
    }
    result += escapeRegex(char)
    index += 1
  }
  return result
}

function transform(pattern: string, mode: 'snippet' | 'label'): string {
  let result = ''
  let index = 0
  let placeholder = 0

  const addLiteral = (text: string): void => {
    const normalized = text.replace(/\s+/g, ' ')
    if (!normalized) return
    if (result.endsWith(' ') && normalized.startsWith(' ')) {
      result += normalized.slice(1)
      return
    }
    result += normalized
  }

  const nextPlaceholder = (label: string): string => {
    placeholder += 1
    return mode === 'snippet' ? `\${${placeholder}:${label}}` : '…'
  }

  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '[') {
      if (pattern[index + 1] === '[') {
        const end = pattern.indexOf(']]', index + 2)
        if (end !== -1) {
          index = end + 2
          continue
        }
      }
      const end = matching(pattern, index, '[', ']')
      if (end !== -1) {
        index = end + 1
        if (pattern[index] === ' ') index += 1
        continue
      }
    }
    if (char === '(') {
      const end = matching(pattern, index, '(', ')')
      if (end !== -1) {
        const inner = pattern.slice(index + 1, end)
        addLiteral(transform(splitTopLevel(inner, '|')[0] ?? '', mode))
        index = end + 1
        continue
      }
    }
    if (char === '%') {
      const end = pattern.indexOf('%', index + 1)
      if (end !== -1) {
        const raw = pattern.slice(index + 1, end).replace(/^[-~*]/, '')
        addLiteral(nextPlaceholder(raw.split('/')[0] || 'değer'))
        index = end + 1
        continue
      }
    }
    if (char === '<') {
      const end = pattern.indexOf('>', index + 1)
      if (end !== -1) {
        addLiteral(nextPlaceholder('değer'))
        index = end + 1
        continue
      }
    }
    addLiteral(char)
    index += 1
  }
  return result.replace(/\s+/g, ' ').trim()
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function matching(text: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1
    else if (text[index] === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

export function syntaxEntry(
  kind: SyntaxKind,
  id: string,
  name: string,
  patterns: string[],
  extra: Partial<SyntaxEntry> = {}
): SyntaxEntry {
  return {
    kind,
    id,
    name,
    patterns,
    description: `${name} açıklaması.`,
    examples: [`${name} örneği`],
    since: ['2.0'],
    deprecated: false,
    ...extra
  }
}
