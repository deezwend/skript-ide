/**
 * Testlerde gerçek `@skript-ide/parser` yerine kullanılan küçük, bağımsız bir uygulama.
 * Sözleşmedeki (faz4-sozlesme.md §2) alanların tümünü doldurur; yalnızca testlerin ihtiyaç
 * duyduğu sözdizimini tanır.
 */

import type {
  BodyNode,
  CommandDefinition,
  EntryNode,
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
  LineInfo,
  OptionDefinition,
  OptionReference,
  ParseDiagnostic,
  Position,
  Range,
  SectionNode,
  SkriptDocument,
  StatementNode,
  StructureKind,
  StructureNode,
  VariableReference
} from '../../src/contracts'

interface RawLine {
  index: number
  raw: string
  indent: number
  content: string
  start: number
  commentStart?: number
  blank: boolean
}

const CALL_KEYWORDS = new Set([
  'if',
  'else',
  'while',
  'loop',
  'for',
  'parse',
  'function',
  'local',
  'command',
  'on',
  'every',
  'at',
  'return'
])

export function parseDocument(text: string): SkriptDocument {
  const rawLines = text.split(/\r\n|\n|\r/)
  const lines: RawLine[] = rawLines.map((raw, index) => {
    const leading = /^\s*/.exec(raw)?.[0] ?? ''
    const withoutComment = stripComment(raw)
    const content = withoutComment.content.trim().trimEnd()
    return {
      index,
      raw,
      indent: leading.length,
      content,
      start: leading.length,
      commentStart: withoutComment.commentStart,
      blank: content.trim().length === 0
    }
  })

  const diagnostics: ParseDiagnostic[] = []
  for (const line of lines) {
    if (line.blank) continue
    const body = line.raw.slice(0, line.commentStart ?? line.raw.length)
    const end = line.start + line.content.trim().length
    if (countOutsideStrings(body, '"') % 2 === 1) {
      diagnostics.push({
        range: { start: { line: line.index, character: Math.max(0, end - 1) }, end: { line: line.index, character: end } },
        severity: 'error',
        code: 'unclosed-string',
        message: 'Kapanmamış tırnak işareti.'
      })
    }
    if (countOutsideStrings(body, '%') % 2 === 1) {
      diagnostics.push({
        range: { start: { line: line.index, character: Math.max(0, end - 1) }, end: { line: line.index, character: end } },
        severity: 'error',
        code: 'unclosed-percent',
        message: 'Kapanmamış yüzde işareti.'
      })
    }
    if (count(body, '{') > count(body, '}')) {
      diagnostics.push({
        range: { start: { line: line.index, character: Math.max(0, end - 1) }, end: { line: line.index, character: end } },
        severity: 'error',
        code: 'unclosed-variable',
        message: 'Kapanmamış süslü parantez.'
      })
    }
  }

  const structures: StructureNode[] = []
  const headerLines = new Set<number>()
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.blank || line.indent > 0) {
      index += 1
      continue
    }
    const kind = classifyStructure(line.content.trim())
    if (!kind) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && (lines[end].blank || lines[end].indent > 0)) end += 1
    let lastBody = index
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (!lines[cursor].blank) lastBody = cursor
    }
    const header = stripColon(line.content.trim())
    const children = parseBody(lines, index + 1, end, 0, kind)
    const rangeEnd = bodyEnd(lines, lastBody, children, index)
    const structure = buildStructure(kind, header, line, lines, index, rangeEnd, children)
    structures.push(structure)
    headerLines.add(index)
    index = end
  }

  const functions: FunctionDefinition[] = []
  const commands: CommandDefinition[] = []
  for (const structure of structures) {
    if (structure.kind === 'function') {
      const definition = parseFunctionDefinition(structure, lines)
      if (definition) {
        functions.push(definition)
        structure.name = definition.name
        structure.nameRange = definition.nameRange
      }
    } else if (structure.kind === 'command') {
      const match = /^command\s+(\/[^\s[]+)/i.exec(structure.header)
      if (match) {
        const name = match[1]
        const offset = structure.header.indexOf(name)
        structure.name = name
        structure.nameRange = {
          start: { line: structure.headerRange.start.line, character: structure.headerRange.start.character + offset },
          end: { line: structure.headerRange.start.line, character: structure.headerRange.start.character + offset + name.length }
        }
        commands.push({ name, nameRange: structure.nameRange, structure })
      }
    }
  }

  const options: OptionDefinition[] = []
  for (const structure of structures) {
    if (structure.kind !== 'options') continue
    for (const child of structure.children) {
      if (child.type !== 'entry') continue
      options.push({ name: child.key, value: child.value, nameRange: child.keyRange, range: child.range })
    }
  }

  const optionReferences: OptionReference[] = []
  const variables: VariableReference[] = []
  for (const line of lines) {
    if (line.blank) continue
    const body = line.content
    for (const match of body.matchAll(/\{@([^{}]+)\}/g)) {
      optionReferences.push({
        name: match[1],
        range: rangeFrom(line, match.index ?? 0, match[0].length)
      })
    }
    for (const match of body.matchAll(/\{([^{}]+)\}/g)) {
      const inner = match[1]
      if (inner.startsWith('@')) continue
      variables.push({
        name: inner,
        range: rangeFrom(line, match.index ?? 0, match[0].length),
        local: inner.startsWith('_'),
        list: inner.endsWith('::*')
      })
    }
  }

  const functionCalls: FunctionCall[] = []
  for (const line of lines) {
    if (line.blank || headerLines.has(line.index)) continue
    const masked = maskStrings(line.content)
    for (const match of masked.matchAll(/([A-Za-z_][\w-]*)\s*\(/g)) {
      const name = match[1]
      if (CALL_KEYWORDS.has(name.toLowerCase())) continue
      const start = match.index ?? 0
      functionCalls.push({
        name,
        nameRange: rangeFrom(line, start, name.length),
        range: rangeFrom(line, start, match[0].length)
      })
    }
  }

  const lineInfos: LineInfo[] = lines.map((line) => ({
    line: line.index,
    indent: line.raw.slice(0, line.indent),
    text: line.content.trim(),
    start: line.start + (line.content.length - line.content.trimStart().length),
    commentStart: line.commentStart,
    blank: line.blank
  }))

  return {
    lines: lineInfos,
    structures,
    diagnostics,
    functions,
    functionCalls,
    options,
    optionReferences,
    variables,
    commands
  }
}

function buildStructure(
  kind: StructureKind,
  header: string,
  line: RawLine,
  lines: RawLine[],
  index: number,
  rangeEnd: Position,
  children: BodyNode[]
): StructureNode {
  const start = line.start + (line.content.length - line.content.trimStart().length)
  const headerRange: Range = {
    start: { line: index, character: start },
    end: { line: index, character: start + header.length }
  }
  const range: Range = {
    start: headerRange.start,
    end: rangeEnd
  }
  const structure: StructureNode = {
    type: 'structure',
    kind,
    header,
    headerRange,
    range,
    children
  }
  if (kind === 'event') {
    structure.name = header
    structure.nameRange = headerRange
  }
  void lines
  return structure
}

function parseBody(
  lines: RawLine[],
  from: number,
  to: number,
  parentIndent: number,
  rootKind: StructureKind
): BodyNode[] {
  const nodes: BodyNode[] = []
  let index = from
  const entries = rootKind === 'command' || rootKind === 'options' || rootKind === 'variables' || rootKind === 'aliases'

  while (index < to) {
    const line = lines[index]
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent <= parentIndent) break
    const content = line.content.trim()
    const start = line.start + (line.content.length - line.content.trimStart().length)
    const entry = entries ? /^(\S[^:]*):(?:\s*(.*))?$/.exec(content) : null

    if (entry) {
      let childEnd = index + 1
      while (childEnd < to && (lines[childEnd].blank || lines[childEnd].indent > line.indent)) childEnd += 1
      const key = entry[1].trim()
      const value = (entry[2] ?? '').trim()
      const keyOffset = content.indexOf(key)
      const children =
        key.toLowerCase() === 'trigger' ? parseBody(lines, index + 1, childEnd, line.indent, 'event') : undefined
      const end = children ? bodyEnd(lines, childEnd - 1, children, index) : lineEnd(lines, index)
      const valueOffset = value ? content.indexOf(value) : content.length
      const node: EntryNode = {
        type: 'entry',
        key,
        keyRange: {
          start: { line: index, character: start + keyOffset },
          end: { line: index, character: start + keyOffset + key.length }
        },
        value,
        valueRange: {
          start: { line: index, character: start + valueOffset },
          end: { line: index, character: start + valueOffset + value.length }
        },
        range: { start: { line: index, character: start }, end },
        children
      }
      nodes.push(node)
      index = childEnd
      continue
    }

    if (content.endsWith(':')) {
      let childEnd = index + 1
      while (childEnd < to && (lines[childEnd].blank || lines[childEnd].indent > line.indent)) childEnd += 1
      const header = content.slice(0, -1).trimEnd()
      const children = parseBody(lines, index + 1, childEnd, line.indent, rootKind)
      const end = bodyEnd(lines, childEnd - 1, children, index)
      const section: SectionNode = {
        type: 'section',
        header,
        headerRange: {
          start: { line: index, character: start },
          end: { line: index, character: start + header.length }
        },
        children,
        range: { start: { line: index, character: start }, end }
      }
      nodes.push(section)
      index = childEnd
      continue
    }

    const statement: StatementNode = {
      type: 'statement',
      text: content,
      textRange: {
        start: { line: index, character: start },
        end: { line: index, character: start + content.length }
      },
      range: {
        start: { line: index, character: start },
        end: { line: index, character: start + content.length }
      }
    }
    nodes.push(statement)
    index += 1
  }
  return nodes
}

function parseFunctionDefinition(structure: StructureNode, lines: RawLine[]): FunctionDefinition | null {
  const header = structure.header
  const match = /^(local\s+)?function\s+([A-Za-z_][\w-]*)\s*(?:\((.*?)\))?\s*(?:::\s*(.+?))?\s*$/i.exec(header)
  if (!match) return null
  const local = Boolean(match[1])
  const name = match[2]
  const nameOffset = header.indexOf(name, match[1]?.length ?? 0)
  const line = structure.headerRange.start.line
  const base = structure.headerRange.start.character
  const parameters: FunctionParameter[] = []
  const parameterText = match[3] ?? ''
  if (parameterText.trim()) {
    let offset = header.indexOf(parameterText)
    for (const part of splitParameters(parameterText)) {
      const parameterMatch = /^\s*([A-Za-z_][\w-]*)\s*:\s*([^=]+?)(?:\s*=\s*(.+?))?\s*$/.exec(part)
      const absolute = header.indexOf(part, offset)
      if (parameterMatch) {
        const nameIndex = part.indexOf(parameterMatch[1])
        parameters.push({
          name: parameterMatch[1],
          type: parameterMatch[2].trim(),
          defaultValue: parameterMatch[3]?.trim(),
          range: {
            start: { line, character: base + absolute + nameIndex },
            end: { line, character: base + absolute + nameIndex + parameterMatch[1].length }
          }
        })
      }
      offset = absolute + part.length
    }
  }
  void lines
  return {
    name,
    nameRange: {
      start: { line, character: base + nameOffset },
      end: { line, character: base + nameOffset + name.length }
    },
    parameters,
    returnType: match[4]?.trim(),
    local,
    structure
  }
}

function splitParameters(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quote = false
  for (const char of text) {
    if (char === '"') quote = !quote
    if (!quote && char === '(') depth += 1
    if (!quote && char === ')') depth -= 1
    if (char === ',' && !quote && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

function classifyStructure(header: string): StructureKind | null {
  const value = stripColon(header)
  if (/^on\s+/i.test(value) || /^every\s+/i.test(value) || /^at\s+/i.test(value)) return 'event'
  if (/^command\s+/i.test(value)) return 'command'
  if (/^(local\s+)?function\s+/i.test(value)) return 'function'
  if (/^options$/i.test(value)) return 'options'
  if (/^variables$/i.test(value)) return 'variables'
  if (/^aliases$/i.test(value)) return 'aliases'
  return null
}

function stripColon(header: string): string {
  return header.endsWith(':') ? header.slice(0, -1).trimEnd() : header
}

function stripComment(raw: string): { content: string; commentStart?: number } {
  let quote = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '"' && raw[index - 1] !== '\\') quote = !quote
    else if (char === '#' && !quote) {
      return { content: raw.slice(0, index), commentStart: index }
    }
  }
  return { content: raw }
}

function bodyEnd(lines: RawLine[], lastBody: number, children: BodyNode[], headerLine: number): Position {
  if (children.length > 0) return children[children.length - 1].range.end
  if (lastBody > headerLine) return lineEnd(lines, lastBody)
  return lineEnd(lines, headerLine)
}

function lineEnd(lines: RawLine[], index: number): Position {
  const line = lines[index]
  return { line: index, character: line.start + line.content.trim().length }
}

function rangeFrom(line: RawLine, offset: number, length: number): Range {
  const start = line.start + (line.content.length - line.content.trimStart().length) + offset
  return { start: { line: line.index, character: start }, end: { line: line.index, character: start + length } }
}

function count(text: string, char: string): number {
  let total = 0
  for (const current of text) if (current === char) total += 1
  return total
}

function countOutsideStrings(text: string, char: string): number {
  const masked = maskStrings(text, char)
  return count(masked, char)
}

function maskStrings(text: string, keep = '"'): string {
  let quote = false
  let result = ''
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]
    if (current === '"' && text[index - 1] !== '\\') {
      quote = !quote
      result += keep === '"' ? current : ' '
      continue
    }
    if (quote) {
      result += current === keep ? current : ' '
    } else {
      result += current
    }
  }
  return result
}
