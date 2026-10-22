import type {
  FunctionCall,
  OptionReference,
  ParseDiagnostic,
  Range,
  VariableReference
} from './types.js'
import type { ParsedLine } from './lines.js'
import {
  codePointLengthAt,
  findInterpolationEnd,
  findMatchingBrace,
  findMatchingParen,
  findUnclosedBrace,
  isIdentPartAt,
  isIdentPartCodePoint,
  isIdentStartAt,
  previousCodePoint
} from './text-utils.js'

import { l } from '@skript-ide/i18n'
const MAX_SCAN_DEPTH = 16
/** Bozuk tek bir satırın tanı listesini sınırlar; sözdizimi zaten ilk hatada taranmayı bırakır. */
const MAX_DIAGNOSTICS_PER_LINE = 20

export interface SymbolSink {
  functionCalls: FunctionCall[]
  variables: VariableReference[]
  optionReferences: OptionReference[]
  diagnostics: ParseDiagnostic[]
  /** Satır başına üretilen sözcüksel tanı sayısı (isteğe bağlı, tembel kurulur). */
  diagnosticCounts?: Map<number, number>
}

function positionRange(line: ParsedLine, baseOffset: number, start: number, end: number): Range {
  const characterStart = line.start + baseOffset + start
  return {
    start: { line: line.line, character: characterStart },
    end: { line: line.line, character: characterStart + (end - start) }
  }
}

function addDiagnostic(
  line: ParsedLine,
  sink: SymbolSink,
  baseOffset: number,
  start: number,
  end: number,
  code: string,
  message: string,
  severity: ParseDiagnostic['severity'] = 'error'
): void {
  const counts = (sink.diagnosticCounts ??= new Map<number, number>())
  const used = counts.get(line.line) ?? 0
  if (used >= MAX_DIAGNOSTICS_PER_LINE) return
  counts.set(line.line, used + 1)
  sink.diagnostics.push({
    range: positionRange(line, baseOffset, start, end),
    severity,
    code,
    message
  })
}

function addVariable(
  line: ParsedLine,
  sink: SymbolSink,
  baseOffset: number,
  start: number,
  end: number,
  name: string
): void {
  sink.variables.push({
    name,
    range: positionRange(line, baseOffset, start, end),
    local: name.startsWith('_'),
    list: name.endsWith('::*')
  })
}

/**
 * Bir kod parçasını (statement, section başlığı, ifade) tarar.
 * `baseOffset`, `text`in satırın `text`i içindeki başlangıcıdır.
 */
export function scanCodeText(
  text: string,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink,
  depth = 0
): void {
  if (depth > MAX_SCAN_DEPTH) return

  // Eşleşmeyen bir açılıştan sonra satırın kalanında aynı türü yeniden denemek
  // O(n²) taramaya ve binlerce aynı tanıya yol açar; ilk hatadan sonra o tür atlanır.
  let bracesUnmatched = false
  let parensUnmatched = false

  let i = 0
  while (i < text.length) {
    const character = text.charAt(i)

    if (character === '"') {
      i = scanStringLiteral(text, i, baseOffset, line, sink, depth)
      continue
    }

    if (character === '{') {
      if (bracesUnmatched) {
        i++
        continue
      }
      const close = findMatchingBrace(text, i)
      if (close < 0) {
        addDiagnostic(
          line,
          sink,
          baseOffset,
          i,
          i + 1,
          'unclosed-variable',
          l("Kapanmamış süslü parantez '}'.", "Unclosed curly brace '}'.")
        )
        bracesUnmatched = true
        i++
        continue
      }
      const inner = text.slice(i + 1, close)
      if (!inner.startsWith('@')) {
        addVariable(line, sink, baseOffset, i, close + 1, inner)
        // {a::%{_b}%} gibi dinamik adlarda iç ifadeleri de tara.
        scanStringContent(inner, baseOffset + i + 1, line, sink, depth + 1)
      }
      i = close + 1
      continue
    }

    if (isIdentStartAt(text, i)) {
      const previous = previousCodePoint(text, i)
      if (previous >= 0 && isIdentPartCodePoint(previous)) {
        i += codePointLengthAt(text, i)
        continue
      }
      let end = i + codePointLengthAt(text, i)
      while (end < text.length && isIdentPartAt(text, end)) {
        end += codePointLengthAt(text, end)
      }
      if (text.charAt(end) === '(') {
        if (!parensUnmatched) {
          const close = findMatchingParen(text, end)
          if (close < 0) {
            parensUnmatched = true
          } else {
            const name = text.slice(i, end)
            sink.functionCalls.push({
              name,
              nameRange: positionRange(line, baseOffset, i, end),
              range: positionRange(line, baseOffset, i, close + 1)
            })
          }
        }
      }
      i = end
      continue
    }

    i += codePointLengthAt(text, i)
  }
}

function reportInterpolationError(
  text: string,
  interpolationStart: number,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink
): void {
  const brace = findUnclosedBrace(text, interpolationStart + 1)
  if (brace >= 0) {
    addDiagnostic(
      line,
      sink,
      baseOffset,
      brace,
      brace + 1,
      'unclosed-variable',
      l("Kapanmamış süslü parantez '}'.", "Unclosed curly brace '}'.")
    )
    return
  }
  addDiagnostic(
    line,
    sink,
    baseOffset,
    interpolationStart,
    interpolationStart + 1,
    'unclosed-percent',
    l("Kapanmamış '%': ifade yüzde işaretleri arasına yazılmalı; literal '%' için '%%' kullanın.", "Unclosed '%': expressions must be written between percent signs; use '%%' for a literal '%'.")
  )
}

function scanStringLiteral(
  text: string,
  start: number,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink,
  depth: number
): number {
  let i = start + 1
  while (i < text.length) {
    const character = text.charAt(i)
    if (character === '"') {
      if (i + 1 < text.length && text.charAt(i + 1) === '"') {
        i += 2
        continue
      }
      return i + 1
    }
    if (character === '%') {
      if (i + 1 < text.length && text.charAt(i + 1) === '%') {
        i += 2
        continue
      }
      const end = findInterpolationEnd(text, i)
      if (end < 0) {
        reportInterpolationError(text, i, baseOffset, line, sink)
        return text.length
      }
      if (end > i + 1) {
        scanCodeText(text.slice(i + 1, end), baseOffset + i + 1, line, sink, depth + 1)
      }
      i = end + 1
      continue
    }
    i++
  }

  addDiagnostic(
    line,
    sink,
    baseOffset,
    start,
    start + 1,
    'unclosed-string',
    l('Kapanmamış çift tırnak.', 'Unclosed double quote.')
  )
  return text.length
}

/**
 * VariableString olarak ayrıştırılan ham metin (ör. `usage:` değeri).
 * Tırnaklar metin içinde literaldir; yalnızca `%...%` ifadeleri taranır.
 */
export function scanStringContent(
  text: string,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink,
  depth = 0
): void {
  if (depth > MAX_SCAN_DEPTH) return

  let i = 0
  while (i < text.length) {
    const character = text.charAt(i)
    if (character === '"' && text.charAt(i + 1) === '"') {
      i += 2
      continue
    }
    if (character === '%') {
      if (text.charAt(i + 1) === '%') {
        i += 2
        continue
      }
      const end = findInterpolationEnd(text, i)
      if (end < 0) {
        reportInterpolationError(text, i, baseOffset, line, sink)
        return
      }
      if (end > i + 1) {
        scanCodeText(text.slice(i + 1, end), baseOffset + i + 1, line, sink, depth + 1)
      }
      i = end + 1
      continue
    }
    i++
  }
}

/**
 * StringMode.VARIABLE_NAME bağlamı: `{...}` değişken adı. `%...%` tür adıdır,
 * içindeki metin ifade olarak taranmaz.
 */
export function scanVariableName(
  text: string,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink
): boolean {
  const open = text.indexOf('{')
  if (open < 0) return false
  const close = findMatchingBrace(text, open)
  if (close < 0) {
    addDiagnostic(
      line,
      sink,
      baseOffset,
      open,
      open + 1,
      'unclosed-variable',
      l("Kapanmamış süslü parantez '}'.", "Unclosed curly brace '}'.")
    )
    return false
  }
  const inner = text.slice(open + 1, close)
  if (inner.startsWith('@')) return false
  addVariable(line, sink, baseOffset, open, close + 1, inner)
  return true
}

const OPTION_REFERENCE = /\{@([^}]+)\}/g

/** Yorumlar çıkarıldıktan sonra satırdaki tüm `{@option}` referanslarını toplar. */
export function scanOptionReferences(
  text: string,
  baseOffset: number,
  line: ParsedLine,
  sink: SymbolSink
): void {
  OPTION_REFERENCE.lastIndex = 0
  let match = OPTION_REFERENCE.exec(text)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    sink.optionReferences.push({
      name: match[1] ?? '',
      range: positionRange(line, baseOffset, start, end)
    })
    match = OPTION_REFERENCE.exec(text)
  }
}
