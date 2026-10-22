/**
 * Gerçek `@skript-ide/parser` ve `@skript-ide/pattern-compiler` paketlerinin varsayılan bağlanması.
 * Testler ve farklı taşımalar bu iki paketi `LanguageServiceOptions` üzerinden değiştirebilir.
 */

import { parseDocument, type SkriptDocument } from '@skript-ide/parser'
import {
  compilePattern,
  patternToLabel,
  patternToSnippet,
  SyntaxMatcher,
  type CompiledPattern
} from '@skript-ide/pattern-compiler'
import type { SyntaxEntry } from '@skript-ide/syntax-db'
import type { MatcherAdapter, ParserAdapter, PatternCompilerAdapter } from './contracts'

class DefaultPatternCompiler implements PatternCompilerAdapter {
  private readonly compiled = new Map<string, CompiledPattern | null>()

  createMatcher(entries: readonly SyntaxEntry[]): MatcherAdapter {
    return new SyntaxMatcher(entries)
  }

  private compile(pattern: string): CompiledPattern | null {
    if (this.compiled.has(pattern)) return this.compiled.get(pattern) ?? null
    try {
      const compiled = compilePattern(pattern)
      this.compiled.set(pattern, compiled)
      return compiled
    } catch {
      this.compiled.set(pattern, null)
      return null
    }
  }

  toSnippet(pattern: string): string {
    const compiled = this.compile(pattern)
    if (compiled) {
      try {
        return patternToSnippet(compiled)
      } catch {
        // Aşağıdaki basit dönüşüme düşeriz.
      }
    }
    return fallbackSnippet(pattern)
  }

  toLabel(pattern: string): string {
    const compiled = this.compile(pattern)
    if (compiled) {
      try {
        return patternToLabel(compiled)
      } catch {
        // Aşağıdaki basit dönüşüme düşeriz.
      }
    }
    return fallbackLabel(pattern)
  }
}

let adapters: { parser: ParserAdapter; patternCompiler: PatternCompilerAdapter } | undefined

export function loadDefaultAdapters(): {
  parser: ParserAdapter
  patternCompiler: PatternCompilerAdapter
} {
  adapters ??= {
    parser: { parseDocument: (text: string): SkriptDocument => parseDocument(text) },
    patternCompiler: new DefaultPatternCompiler()
  }
  return adapters
}

/** Pattern-compiler yoksa tamamlama için kaba ama kullanışlı bir snippet üretir. */
export function fallbackSnippet(pattern: string): string {
  let result = ''
  let index = 0
  let placeholder = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '[') {
      const end = matchingBracket(pattern, index, '[', ']')
      if (end !== -1) {
        // Opsiyonel kısımlar snippet'e girmez.
        index = end + 1
        continue
      }
    }
    if (char === '(') {
      const end = matchingBracket(pattern, index, '(', ')')
      if (end !== -1) {
        const inner = pattern.slice(index + 1, end)
        const first = inner.split('|')[0] ?? ''
        result += `${first.trim()} `
        index = end + 1
        continue
      }
    }
    if (char === '<') {
      const end = pattern.indexOf('>', index + 1)
      if (end !== -1) {
        placeholder += 1
        result += `\${${placeholder}:${pattern.slice(index + 1, end)}}`
        index = end + 1
        continue
      }
    }
    if (char === '%') {
      const end = pattern.indexOf('%', index + 1)
      if (end !== -1) {
        placeholder += 1
        const raw = pattern.slice(index + 1, end).replace(/^[-~*]/, '')
        result += `\${${placeholder}:${raw.split('/')[0]}}`
        index = end + 1
        continue
      }
    }
    result += char
    index += 1
  }
  return result.replace(/\s+/g, ' ').trim()
}

/** Pattern-compiler yoksa tamamlama listesinde kullanılacak kısa etiket. */
export function fallbackLabel(pattern: string): string {
  return pattern
    .replace(/<[^>]*>/g, '…')
    .replace(/%[-~*]?([^%]+)%/g, () => `…`)
    .replace(/\[([^\]]*)\]/g, (_, inner: string) => inner)
    .replace(/\(([^)]*)\)/g, (_, inner: string) => inner.split('|')[0] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchingBracket(text: string, start: number, open: string, close: string): number {
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
