/**
 * Skript pattern sözdizimini derler.
 *
 * Kaynak: SkriptLang/Skript 2.17.1, `ch.njol.skript.patterns.PatternCompiler`,
 * `ch.njol.skript.lang.SkriptParser#nextBracket` ve
 * `ch.njol.skript.doc.Documentation#cleanPatterns`.
 *
 * İki biçim de desteklenir:
 * - Ham Java pattern'leri (`[ ]`, `( | )`, `%tip%`, `1¦`, `tag:`, `\` kaçışı, `<regex>`)
 * - Doküman üreticisinden geçmiş biçim (parse mark/tag'leri ve `@zaman` ekleri temizlenmiş)
 */

import {
  collectRequiredWords,
  countPlaceholders,
  isPluralTypeName,
  type PatternNode,
  type PlaceholderInfo,
  type SequenceNode
} from './ast'

import { l } from '@skript-ide/i18n'
export class PatternSyntaxError extends Error {
  readonly pattern: string
  readonly offset: number

  constructor(pattern: string, offset: number, message: string) {
    super(`${message} (konum ${offset})`)
    this.name = 'PatternSyntaxError'
    this.pattern = pattern
    this.offset = offset
  }
}

export interface CompiledPattern {
  readonly source: string
  readonly ast: PatternNode
  /** Eşleşme için mutlaka geçmesi gereken literal kelimeler (küçük harf). Ön süzme için. */
  readonly requiredWords: readonly string[]
  /** Kolaylık: toplam yer tutucu sayısı. */
  readonly placeholderCount: number
}

export interface CompileOptions {
  /**
   * Doküman çıktısındaki bilinen bozukluklara tolerans gösterir:
   * - kapanmamış `<` (ör. CondCompare'de kaçışı kaybolmuş `<`/`<=`)
   * - boş yer tutucu `%%` (ör. `string` türünün kullanım metni)
   *
   * Normal derlemede bunlar sözdizimi hatasıdır.
   */
  readonly tolerant?: boolean
}

export function compilePattern(source: string, options: CompileOptions = {}): CompiledPattern {
  const parser = new PatternParser(source, options.tolerant === true)
  const ast = parser.parse()
  return {
    source,
    ast,
    requiredWords: collectRequiredWords(ast),
    placeholderCount: countPlaceholders(ast)
  }
}

class PatternParser {
  private readonly source: string
  private readonly tolerant: boolean

  constructor(source: string, tolerant: boolean) {
    this.source = source
    this.tolerant = tolerant
  }

  parse(): PatternNode {
    return this.parseRange(0, this.source.length)
  }

  /** Bir aralığı seçeneklere ayırır: `a|b c` → seçenekler `a` ve `b c`. */
  private parseRange(start: number, end: number): PatternNode {
    const pipes = this.findTopLevelPipes(start, end)
    if (pipes.length === 0) {
      return { type: 'sequence', nodes: this.parseSequence(start, end) }
    }

    const bounds = [start, ...pipes, end]
    const alternatives: SequenceNode[] = []
    for (let index = 0; index < bounds.length - 1; index++) {
      alternatives.push({
        type: 'sequence',
        nodes: this.parseSequence(bounds[index] + (index === 0 ? 0 : 1), bounds[index + 1])
      })
    }
    return { type: 'choice', alternatives }
  }

  private parseSequence(start: number, end: number): PatternNode[] {
    const nodes: PatternNode[] = []
    let literal = ''
    let index = start

    const flush = (): void => {
      if (literal !== '') {
        nodes.push({ type: 'literal', text: literal })
        literal = ''
      }
    }

    while (index < end) {
      const char = this.source[index]!

      if (char === '[') {
        flush()
        const close = this.findClosing(index, ']', '[')
        if (close === -1) {
          throw new PatternSyntaxError(this.source, index, "Kapanmayan '['")
        }
        nodes.push({ type: 'optional', node: this.parseRange(index + 1, close) })
        index = close + 1
        continue
      }

      if (char === '(') {
        flush()
        const close = this.findClosing(index, ')', '(')
        if (close === -1) {
          throw new PatternSyntaxError(this.source, index, "Kapanmayan '('")
        }
        nodes.push({ type: 'group', node: this.parseRange(index + 1, close) })
        index = close + 1
        continue
      }

      if (char === '%') {
        flush()
        const close = this.findUnescaped(index + 1, end, '%')
        if (close === -1) {
          throw new PatternSyntaxError(this.source, index, "Kapanmayan '%'")
        }
        const content = this.source.slice(index + 1, close)
        if (content === '' && this.tolerant) {
          // Doküman çıktısında `%%` yüzde işaretinin kaçışı olarak kullanılıyor (ör. `string` türü).
          literal += '%'
          index = close + 1
          continue
        }
        nodes.push({
          type: 'placeholder',
          info: parsePlaceholderInfo(this.source, content, index),
          raw: content
        })
        index = close + 1
        continue
      }

      if (char === '<') {
        const close = this.source.indexOf('>', index + 1)
        if (close === -1 || close >= end) {
          if (this.tolerant) {
            // CondCompare pattern'lerinde kaçış kaybolduğu için `<`/`<=` literal olarak kalır.
            literal += '<'
            index++
            continue
          }
          throw new PatternSyntaxError(this.source, index, "Kapanmayan regex '<'")
        }
        const regexSource = this.source.slice(index + 1, close)
        assertValidRegex(this.source, index, regexSource)
        flush()
        nodes.push({ type: 'regex', source: regexSource })
        index = close + 1
        continue
      }

      if (char === '\\') {
        if (index + 1 >= end) {
          throw new PatternSyntaxError(this.source, index, l("Sonda kaçış karakteri", "Trailing escape character"))
        }
        literal += this.source[index + 1]!
        index += 2
        continue
      }

      if (char === '¦') {
        const markText = literal
        literal = ''
        if (!/^[+-]?\d+$/.test(markText)) {
          throw new PatternSyntaxError(this.source, index, l(`Geçersiz parse mark: '${markText}'`, `Invalid parse mark: '${markText}'`))
        }
        nodes.push({ type: 'parse-tag', tag: null, mark: Number.parseInt(markText, 10) })
        index++
        continue
      }

      if (char === ':') {
        const tag = literal
        literal = ''
        const parsed = Number.parseInt(tag, 10)
        nodes.push({
          type: 'parse-tag',
          tag,
          mark: Number.isNaN(parsed) ? 0 : parsed
        })
        index++
        continue
      }

      literal += char
      index++
    }

    flush()
    return applyEmptyTagInference(nodes)
  }

  private findTopLevelPipes(start: number, end: number): number[] {
    const pipes: number[] = []
    let square = 0
    let round = 0
    let index = start

    while (index < end) {
      const char = this.source[index]!

      if (char === '\\') {
        index += 2
        continue
      }

      if (char === '%') {
        const close = this.findUnescaped(index + 1, end, '%')
        index = close === -1 ? index + 1 : close + 1
        continue
      }

      if (char === '<') {
        const close = this.source.indexOf('>', index + 1)
        index = close === -1 || close >= end ? index + 1 : close + 1
        continue
      }

      if (char === '[') square++
      else if (char === ']' && square > 0) square--
      else if (char === '(') round++
      else if (char === ')' && round > 0) round--
      else if (char === '|' && square === 0 && round === 0) pipes.push(index)

      index++
    }

    return pipes
  }

  private findClosing(openIndex: number, closing: string, opening: string): number {
    let depth = 0
    let index = openIndex + 1

    while (index < this.source.length) {
      const char = this.source[index]!

      if (char === '\\') {
        index += 2
        continue
      }

      if (char === '%') {
        const close = this.findUnescaped(index + 1, this.source.length, '%')
        if (close !== -1) {
          index = close + 1
          continue
        }
      }

      if (char === '<') {
        const close = this.source.indexOf('>', index + 1)
        if (close !== -1) {
          index = close + 1
          continue
        }
      }

      if (char === opening) {
        depth++
      } else if (char === closing) {
        if (depth === 0) return index
        depth--
      }

      index++
    }

    return -1
  }

  private findUnescaped(from: number, end: number, needle: string): number {
    for (let index = from; index < end; index++) {
      if (this.source[index] === '\\') {
        index++
      } else if (this.source[index] === needle) {
        return index
      }
    }
    return -1
  }
}

function parsePlaceholderInfo(source: string, content: string, offset: number): PlaceholderInfo {
  let index = 0
  let nullable = false
  let literalOnly = false
  let changeable = false

  while (index < content.length) {
    const char = content[index]
    if (char === '-') nullable = true
    else if (char === '*') literalOnly = true
    else if (char === '~') changeable = true
    else break
    index++
  }

  let rest = content.slice(index)
  const at = rest.indexOf('@')
  let time: number | undefined
  if (at !== -1) {
    const timeText = rest.slice(at + 1)
    if (!/^[+-]?\d+$/.test(timeText)) {
      throw new PatternSyntaxError(source, offset, l(`Geçersiz zaman eki: '@${timeText}'`, `Invalid time suffix: '@${timeText}'`))
    }
    time = Number.parseInt(timeText, 10)
    rest = rest.slice(0, at)
  }

  if (rest === '') {
    throw new PatternSyntaxError(source, offset, l('Boş yer tutucu', 'Empty placeholder'))
  }

  const types = rest.split('/').map(type => type.trim())
  if (types.some(type => type === '')) {
    throw new PatternSyntaxError(source, offset, l('Boş tür adı', 'Empty type name'))
  }

  return {
    types,
    nullable,
    literalOnly,
    changeable,
    plural: types.some(isPluralTypeName),
    ...(time === undefined ? {} : { time })
  }
}

function assertValidRegex(source: string, offset: number, regexSource: string): void {
  try {
    // Java `Pattern.matches` gibi tam eşleşme için sarmalıyoruz.
    new RegExp(`^(?:${regexSource})$`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PatternSyntaxError(source, offset, l(`Geçersiz regex <${regexSource}>: ${message}`, `Invalid regex <${regexSource}>: ${message}`))
  }
}

/**
 * Skript'te `:` tek başına yazıldığında tag, kendisinden sonraki literalden alınır
 * (`ParseTagPatternElement#setNext`).
 */
function applyEmptyTagInference(nodes: PatternNode[]): PatternNode[] {
  return nodes.map((node, index) => {
    if (node.type !== 'parse-tag' || node.tag !== '') return node
    const next = nodes[index + 1]
    if (next?.type === 'literal') {
      return { ...node, tag: next.text.trim() }
    }
    return node
  })
}
