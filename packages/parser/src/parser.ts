import type {
  BodyNode,
  CommandDefinition,
  EntryNode,
  FunctionDefinition,
  LineInfo,
  OptionDefinition,
  ParseDiagnostic,
  Position,
  Range,
  SectionNode,
  SkriptDocument,
  StatementNode,
  StructureKind,
  StructureNode,
  VariableReference
} from './types.js'
import { splitDocument, type ParsedLine } from './lines.js'
import { classifyHeader, isSimpleStructureHeader } from './headers.js'
import {
  scanCodeText,
  scanOptionReferences,
  scanStringContent,
  scanVariableName,
  type SymbolSink
} from './symbols.js'

import { l } from '@skript-ide/i18n'
type Context = 'statements' | 'options' | 'variables' | 'aliases' | 'command'

interface Frame {
  node: StructureNode | SectionNode | EntryNode
  /** Bu düğümün doğrudan çocuklarının beklenen girinti seviyesi. */
  childDepth: number
  context: Context
  /** options bağlamında iç içe option adlarının öneki (ör. 'mesaj.'). */
  optionsPrefix: string
  /** Gövdede yorum ya da girinti hatası nedeniyle atlanan satır görüldü; boş bölüm uyarısı verilmez. */
  quiet?: boolean
  /** Girinti hatası nedeniyle bir çocuk satır atlandı; aynı satır için ikinci bir uyarı üretmeyiz. */
  skippedLine?: boolean
  /** Komut bağlamında görülen girdi anahtarları (küçük harf). */
  seenKeys?: Set<string>
  /** Bilinmeyen/eklenti yapılarında ham gövde olabileceği için sözcüksel tarama kapalıdır. */
  scan: boolean
}

interface ParsedEntry {
  key: string
  keyStart: number
  keyEnd: number
  value: string
  valueStart: number
  valueEnd: number
  header: boolean
}

function lineRange(line: ParsedLine, start: number, end: number): Range {
  return {
    start: { line: line.line, character: line.start + start },
    end: { line: line.line, character: line.start + end }
  }
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line
  return a.character - b.character
}

function laterPosition(a: Position, b: Position): Position {
  return comparePositions(a, b) >= 0 ? a : b
}

function cloneRange(range: Range): Range {
  return { start: { ...range.start }, end: { ...range.end } }
}

function rangeContains(range: Range, position: Position): boolean {
  return (
    comparePositions(position, range.start) >= 0 &&
    comparePositions(position, range.end) < 0
  )
}

function addDiagnostic(
  doc: SkriptDocument,
  range: Range,
  code: string,
  message: string,
  severity: ParseDiagnostic['severity'] = 'error'
): void {
  doc.diagnostics.push({ range, severity, code, message })
}

function makeStatement(line: ParsedLine): StatementNode {
  const textRange = lineRange(line, 0, line.text.length)
  return {
    type: 'statement',
    text: line.text,
    textRange,
    range: cloneRange(textRange)
  }
}

function makeSection(line: ParsedLine, header: string): SectionNode {
  const headerRange = lineRange(line, 0, header.length)
  return {
    type: 'section',
    header,
    headerRange,
    children: [],
    range: {
      start: { ...headerRange.start },
      end: lineRange(line, 0, line.text.length).end
    }
  }
}

function makeEntry(line: ParsedLine, parsed: ParsedEntry): EntryNode {
  const keyRange = lineRange(line, parsed.keyStart, parsed.keyEnd)
  const valueRange = lineRange(line, parsed.valueStart, parsed.valueEnd)
  const entry: EntryNode = {
    type: 'entry',
    key: parsed.key,
    keyRange,
    value: parsed.value,
    valueRange,
    range: {
      start: { ...keyRange.start },
      end:
        parsed.value.length > 0
          ? { ...valueRange.end }
          : lineRange(line, 0, line.text.length).end
    }
  }
  if (parsed.header) entry.children = []
  return entry
}

function appendChild(parent: StructureNode | SectionNode | EntryNode, child: BodyNode): void {
  if (parent.type === 'entry') {
    if (parent.children === undefined) parent.children = []
    parent.children.push(child)
  } else {
    parent.children.push(child)
  }
  parent.range.end = laterPosition(parent.range.end, child.range.end)
}

function parseEntry(
  text: string,
  separator: ':' | '=',
  allowHeader = true
): ParsedEntry | null {
  let separatorIndex: number
  let header = false

  if (separator === ':' && allowHeader && text.endsWith(':')) {
    separatorIndex = text.length - 1
    header = true
  } else {
    separatorIndex = text.indexOf(separator)
    if (separatorIndex < 0) return null
  }

  const rawKey = text.slice(0, separatorIndex)
  const keyLeading = rawKey.length - rawKey.trimStart().length
  const key = rawKey.trim()
  const keyStart = keyLeading
  const keyEnd = keyLeading + key.length

  let valueStart = separatorIndex + separator.length
  while (valueStart < text.length && /\s/.test(text.charAt(valueStart))) valueStart++
  const value = text.slice(valueStart).trimEnd()
  const valueEnd = valueStart + value.length

  return {
    key,
    keyStart,
    keyEnd,
    value,
    valueStart,
    valueEnd,
    header
  }
}

function contextForKind(kind: StructureKind): Context {
  switch (kind) {
    case 'options':
      return 'options'
    case 'variables':
      return 'variables'
    case 'aliases':
      return 'aliases'
    case 'command':
      return 'command'
    default:
      return 'statements'
  }
}

function isMixedIndent(indent: string): boolean {
  return indent.includes(' ') && indent.includes('\t')
}

/** `#-#` ile devre dışı bırakılmış satırlar Skript'te bölüm başlığı sayılmaz. */
function isHeaderLine(line: ParsedLine): boolean {
  return line.text.endsWith(':') && !line.disabledSection
}

interface IndentAnalysis {
  depth: number
  exact: boolean
}

function analyzeIndent(extra: string, unit: string): IndentAnalysis {
  if (extra.length === 0) return { depth: 0, exact: true }
  if (!extra.startsWith(unit)) return { depth: 1, exact: false }
  let depth = 0
  let offset = 0
  while (offset < extra.length && extra.startsWith(unit, offset)) {
    depth++
    offset += unit.length
  }
  return { depth: Math.max(1, depth), exact: offset === extra.length }
}

const emptySectionMessage = () =>
  l(
    "Boş bölüm: girintili satır ekleyin ya da sonundaki ':' işaretini kaldırın.",
    "Empty section: add an indented line or remove the trailing ':'."
  )

function sortByStart<T extends { range: Range }>(items: T[]): void {
  items.sort((a, b) => comparePositions(a.range.start, b.range.start))
}

/** İç ayrıştırma alanlarını (raw, charBase) dış API'den ayıklar. */
function publicLines(lines: ParsedLine[]): LineInfo[] {
  return lines.map((line) => {
    const info: LineInfo = {
      line: line.line,
      indent: line.indent,
      text: line.text,
      start: line.start,
      blank: line.blank
    }
    if (line.commentStart !== undefined) info.commentStart = line.commentStart
    return info
  })
}

function parseDocumentUnsafe(text: string): SkriptDocument {
  const split = splitDocument(text)
  const doc: SkriptDocument = {
    lines: publicLines(split.lines),
    structures: [],
    diagnostics: [],
    functions: [],
    functionCalls: [],
    options: [],
    optionReferences: [],
    variables: [],
    commands: []
  }

  const sink: SymbolSink = {
    functionCalls: doc.functionCalls,
    variables: doc.variables,
    optionReferences: doc.optionReferences,
    diagnostics: doc.diagnostics
  }

  const stack: Frame[] = []
  let baseIndent = ''
  let unit: string | null = null

  /** Bir düğümü ekler ve açık tüm ataların aralık sonunu büyütür. */
  const append = (
    parent: StructureNode | SectionNode | EntryNode,
    child: BodyNode
  ): void => {
    appendChild(parent, child)
    for (const frame of stack) {
      frame.node.range.end = laterPosition(frame.node.range.end, child.range.end)
    }
  }

  const warnEmpty = (frame: Frame): void => {
    const node = frame.node
    if (node.type === 'entry') {
      // Skript yalnızca yorum içeren `trigger:` için uyarmaz (olaylar için uyarır)
      if (frame.quiet === true || frame.skippedLine === true) return
      if (node.children !== undefined && node.children.length === 0) {
        addDiagnostic(doc, node.keyRange, 'empty-section', emptySectionMessage(), 'warning')
      }
      return
    }
    if (node.type === 'structure' || node.type === 'section') {
      if (node.children.length === 0 && frame.skippedLine !== true) {
        addDiagnostic(doc, node.headerRange, 'empty-section', emptySectionMessage(), 'warning')
      }
    }
  }

  const popFrame = (): void => {
    const frame = stack.pop()
    if (frame !== undefined) warnEmpty(frame)
  }

  const closeAll = (): void => {
    while (stack.length > 0) popFrame()
  }

  const addFunctionDefinition = (
    structure: StructureNode,
    line: ParsedLine,
    signature: NonNullable<ReturnType<typeof classifyHeader>['signature']>
  ): void => {
    for (const diagnostic of signature.diagnostics) {
      addDiagnostic(
        doc,
        lineRange(line, diagnostic.start, diagnostic.end),
        diagnostic.code,
        diagnostic.message
      )
    }
    if (signature.name.length === 0) return

    const parameters = signature.parameters.map((parameter) => {
      const result: FunctionDefinition['parameters'][number] = {
        name: parameter.name,
        type: parameter.type,
        range: lineRange(line, parameter.start, parameter.end)
      }
      if (parameter.defaultValue !== undefined) result.defaultValue = parameter.defaultValue
      return result
    })

    const definition: FunctionDefinition = {
      name: signature.name,
      nameRange: lineRange(line, signature.nameStart, signature.nameEnd),
      parameters,
      local: signature.local,
      structure
    }
    if (signature.returnType !== undefined) definition.returnType = signature.returnType
    doc.functions.push(definition)

    for (const parameter of signature.parameters) {
      if (
        parameter.defaultValue !== undefined &&
        parameter.defaultStart !== undefined &&
        parameter.defaultEnd !== undefined
      ) {
        scanCodeText(
          parameter.defaultValue,
          parameter.defaultStart,
          line,
          sink
        )
      }
    }
  }

  const handleTopLevel = (line: ParsedLine): void => {
    baseIndent = line.indent
    unit = null

    if (line.indent.length > 0) {
      if (isMixedIndent(line.indent)) {
        addDiagnostic(
          doc,
          lineRange(line, 0, line.indent.length),
          'indent-mixed',
          l('Girintide tab ve boşluk karıştırılamaz.', 'Tabs and spaces cannot be mixed in indentation.')
        )
      }
      addDiagnostic(
        doc,
        lineRange(line, 0, line.indent.length),
        'indent-unexpected',
        l('Beklenmeyen girinti: üst düzey satır girintisiz olmalı.', 'Unexpected indentation: top-level lines must not be indented.')
      )
    }

    const content = line.text
    if (isHeaderLine(line)) {
      const header = content.slice(0, -1).trimEnd()
      const headerRange = lineRange(line, 0, header.length)
      const classified = classifyHeader(header)
      const structure: StructureNode = {
        type: 'structure',
        kind: classified.kind,
        header,
        headerRange,
        children: [],
        range: {
          start: { ...headerRange.start },
          end: lineRange(line, 0, content.length).end
        }
      }

      if (classified.name !== undefined) {
        structure.name = classified.name
        if (classified.nameStart !== undefined && classified.nameEnd !== undefined) {
          structure.nameRange = lineRange(
            line,
            classified.nameStart,
            classified.nameEnd
          )
        } else {
          structure.nameRange = cloneRange(headerRange)
        }
      }

      if (classified.kind === 'function') {
        if (classified.signature !== undefined) {
          addFunctionDefinition(structure, line, classified.signature)
        } else {
          addDiagnostic(
            doc,
            headerRange,
            'function-invalid-signature',
            l('Geçersiz fonksiyon imzası.', 'Invalid function signature.')
          )
        }
      } else if (classified.kind === 'command' && classified.name !== undefined) {
        const nameRange =
          classified.nameStart !== undefined && classified.nameEnd !== undefined
            ? lineRange(line, classified.nameStart, classified.nameEnd)
            : cloneRange(headerRange)
        const command: CommandDefinition = {
          name: classified.name,
          nameRange,
          structure
        }
        doc.commands.push(command)
      } else if (classified.kind === 'event') {
        structure.name = header
        structure.nameRange = cloneRange(headerRange)
      }

      doc.structures.push(structure)
      stack.push({
        node: structure,
        childDepth: 1,
        context: contextForKind(classified.kind),
        optionsPrefix: '',
        scan: classified.kind !== 'unknown'
      })
      return
    }

    if (isSimpleStructureHeader(content)) {
      const headerRange = lineRange(line, 0, content.length)
      const structure: StructureNode = {
        type: 'structure',
        kind: 'unknown',
        header: content,
        headerRange,
        children: [],
        range: cloneRange(headerRange)
      }
      doc.structures.push(structure)
      return
    }

    addDiagnostic(
      doc,
      lineRange(line, 0, content.length),
      'top-level-statement',
      l("Üst düzeyde ':' ile bitmeyen satır bir yapı olamaz.", "A top-level line that does not end with ':' cannot be a structure.")
    )
    scanCodeText(content, 0, line, sink)
  }

  const addVariableReference = (
    name: string,
    range: Range
  ): void => {
    const reference: VariableReference = {
      name,
      range: cloneRange(range),
      local: name.startsWith('_'),
      list: name.endsWith('::*')
    }
    doc.variables.push(reference)
  }

  const handleStatementContext = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    if (isHeaderLine(line)) {
      const header = line.text.slice(0, -1).trimEnd()
      const section = makeSection(line, header)
      append(parent.node, section)
      if (parent.scan) scanCodeText(header, 0, line, sink)
      stack.push({
        node: section,
        childDepth: depth + 1,
        context: 'statements',
        optionsPrefix: '',
        scan: parent.scan
      })
      return
    }

    const statement = makeStatement(line)
    append(parent.node, statement)
    if (parent.scan) scanCodeText(statement.text, 0, line, sink)
  }

  const handleOptionsContext = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    const parsed = parseEntry(line.text, ':', !line.disabledSection)
    if (parsed === null) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.text.length),
        'invalid-option-line',
        l("Option satırı 'anahtar: değer' biçiminde olmalı.", "Option line must be in the form 'key: value'.")
      )
      const fallback: ParsedEntry = {
        key: line.text,
        keyStart: 0,
        keyEnd: line.text.length,
        value: '',
        valueStart: line.text.length,
        valueEnd: line.text.length,
        header: false
      }
      append(parent.node, makeEntry(line, fallback))
      return
    }

    const entry = makeEntry(line, parsed)
    append(parent.node, entry)

    if (parsed.header) {
      stack.push({
        node: entry,
        childDepth: depth + 1,
        context: 'options',
        optionsPrefix: `${parent.optionsPrefix}${parsed.key}.`,
        scan: true
      })
      return
    }

    const definition: OptionDefinition = {
      name: `${parent.optionsPrefix}${parsed.key}`,
      value: parsed.value,
      nameRange: entry.keyRange,
      range: entry.range
    }
    doc.options.push(definition)
  }

  const handleVariablesContext = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    if (isHeaderLine(line)) {
      const header = line.text.slice(0, -1).trimEnd()
      const section = makeSection(line, header)
      append(parent.node, section)
      addDiagnostic(
        doc,
        section.headerRange,
        'invalid-variable-line',
        l("Değişken satırı '{ad} = değer' biçiminde olmalı.", "Variable line must be in the form '{name} = value'.")
      )
      stack.push({
        node: section,
        childDepth: depth + 1,
        context: 'variables',
        optionsPrefix: '',
        scan: true
      })
      return
    }

    const parsed = parseEntry(line.text, '=')
    if (parsed === null) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.text.length),
        'invalid-variable-line',
        l("Değişken satırı '{ad} = değer' biçiminde olmalı.", "Variable line must be in the form '{name} = value'.")
      )
      const fallback: ParsedEntry = {
        key: line.text,
        keyStart: 0,
        keyEnd: line.text.length,
        value: '',
        valueStart: line.text.length,
        valueEnd: line.text.length,
        header: false
      }
      append(parent.node, makeEntry(line, fallback))
      return
    }

    const entry = makeEntry(line, parsed)
    append(parent.node, entry)

    if (parsed.key.length === 0) {
      addDiagnostic(
        doc,
        entry.keyRange,
        'invalid-variable-line',
        l('Değişken adı boş olamaz.', 'Variable name cannot be empty.')
      )
      return
    }

    if (parsed.key.startsWith('{') && parsed.key.endsWith('}') && parsed.key.length >= 2) {
      addVariableReference(parsed.key.slice(1, -1), entry.keyRange)
      return
    }

    if (parsed.key.startsWith('{')) {
      addDiagnostic(
        doc,
        entry.keyRange,
        'unclosed-variable',
        l("Kapanmamış süslü parantez '}'.", "Unclosed curly brace '}'.")
      )
      return
    }

    addDiagnostic(
      doc,
      entry.keyRange,
      'variable-missing-brackets',
      l(`Değişken adı süslü parantez içine alınmalı: {${parsed.key}}.`, `Variable name must be wrapped in curly braces: {${parsed.key}}.`),
      'warning'
    )
  }

  const handleAliasesContext = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    if (isHeaderLine(line)) {
      const header = line.text.slice(0, -1).trimEnd()
      const section = makeSection(line, header)
      append(parent.node, section)
      stack.push({
        node: section,
        childDepth: depth + 1,
        context: 'aliases',
        optionsPrefix: '',
        scan: true
      })
      return
    }

    const parsed = parseEntry(line.text, '=')
    if (parsed === null) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.text.length),
        'invalid-alias-line',
        l("Alias satırı 'ad = değer' biçiminde olmalı.", "Alias line must be in the form 'name = value'.")
      )
      const fallback: ParsedEntry = {
        key: line.text,
        keyStart: 0,
        keyEnd: line.text.length,
        value: '',
        valueStart: line.text.length,
        valueEnd: line.text.length,
        header: false
      }
      append(parent.node, makeEntry(line, fallback))
      return
    }

    append(parent.node, makeEntry(line, parsed))
  }

  const scanCommandValue = (line: ParsedLine, parsed: ParsedEntry): void => {
    if (parsed.value.length === 0) return
    const key = parsed.key.toLowerCase()
    if (key === 'cooldown storage') {
      scanVariableName(parsed.value, parsed.valueStart, line, sink)
      return
    }
    if (key === 'usage' || key === 'cooldown message' || key === 'permission message') {
      scanStringContent(parsed.value, parsed.valueStart, line, sink)
    }
  }

  const handleCommandContext = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    const parsed = parseEntry(line.text, ':', !line.disabledSection)
    if (parsed === null) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.text.length),
        'invalid-command-line',
        l("Komut gövdesinde 'anahtar: değer' bekleniyordu.", "Expected 'key: value' in command body.")
      )
      const fallback: ParsedEntry = {
        key: line.text,
        keyStart: 0,
        keyEnd: line.text.length,
        value: '',
        valueStart: line.text.length,
        valueEnd: line.text.length,
        header: false
      }
      append(parent.node, makeEntry(line, fallback))
      return
    }

    const entry = makeEntry(line, parsed)
    append(parent.node, entry)

    // Skript her komut girdisini bir kez kabul eder; tekrarı "Unexpected entry" ile komutu tümden reddeder
    const normalizedKey = parsed.key.toLowerCase()
    parent.seenKeys ??= new Set()
    if (normalizedKey.length > 0 && parent.seenKeys.has(normalizedKey)) {
      addDiagnostic(
        doc,
        entry.keyRange,
        'duplicate-command-entry',
        l(`'${parsed.key}' girdisi bu komutta zaten tanımlı; Skript tekrarlanan girdiyi kabul etmez.`, `The '${parsed.key}' entry is already defined in this command; Skript does not accept duplicate entries.`)
      )
    }
    parent.seenKeys.add(normalizedKey)

    if (parsed.header) {
      const key = parsed.key.toLowerCase()
      let context: Context = 'statements'
      if (/^subcommands?(?:\s|$)/.test(key)) {
        context = 'command'
      }
      stack.push({
        node: entry,
        childDepth: depth + 1,
        context,
        optionsPrefix: '',
        scan: true
      })
      return
    }

    if (parsed.key.length === 0) {
      addDiagnostic(
        doc,
        entry.keyRange,
        'invalid-command-line',
        l('Komut girdisinin anahtarı boş olamaz.', 'Command entry key cannot be empty.')
      )
      return
    }

    scanCommandValue(line, parsed)
  }

  const handleBody = (
    parent: Frame,
    line: ParsedLine,
    depth: number
  ): void => {
    switch (parent.context) {
      case 'statements':
        handleStatementContext(parent, line, depth)
        return
      case 'options':
        handleOptionsContext(parent, line, depth)
        return
      case 'variables':
        handleVariablesContext(parent, line, depth)
        return
      case 'aliases':
        handleAliasesContext(parent, line, depth)
        return
      case 'command':
        handleCommandContext(parent, line, depth)
        return
    }
  }

  for (const line of split.lines) {
    if (line.blank) {
      const top = stack[stack.length - 1]
      if (top !== undefined && line.commentStart !== undefined) top.quiet = true
      continue
    }

    scanOptionReferences(line.text, 0, line, sink)

    if (stack.length === 0) {
      handleTopLevel(line)
      continue
    }

    if (line.indent.length <= baseIndent.length) {
      closeAll()
      handleTopLevel(line)
      continue
    }

    if (!line.indent.startsWith(baseIndent)) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.indent.length),
        'indent-inconsistent',
        l('Tutarsız girinti: satır üst düzey girintisiyle uyuşmuyor.', 'Inconsistent indentation: line does not match the top-level indentation.')
      )
      closeAll()
      handleTopLevel(line)
      continue
    }

    const extra = line.indent.slice(baseIndent.length)
    const mixed = isMixedIndent(extra)
    // Skript karışık girintiyi birim olarak kabul etmez; birim sonraki satırdan alınır.
    if (unit === null && !mixed) unit = extra
    const analysis =
      unit === null ? { depth: 1, exact: true } : analyzeIndent(extra, unit)

    // Skript girinti hatalı satırı raporlayıp atlar; açık bloklar değişmez. Biz de aynısını yaparız,
    // aksi halde sonraki geçerli satırlar da zincirleme hata alır.
    if (mixed) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.indent.length),
        'indent-mixed',
        l('Girintide tab ve boşluk karıştırılamaz.', 'Tabs and spaces cannot be mixed in indentation.')
      )
      stack[stack.length - 1]!.skippedLine = true
      continue
    }
    if (!analysis.exact) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.indent.length),
        'indent-inconsistent',
        l('Tutarsız girinti: beklenen girinti seviyesiyle uyuşmuyor.', 'Inconsistent indentation: does not match the expected indentation level.')
      )
      stack[stack.length - 1]!.skippedLine = true
      continue
    }

    while (stack.length > 0 && stack[stack.length - 1]!.childDepth > analysis.depth) {
      popFrame()
    }

    if (stack.length === 0) {
      handleTopLevel(line)
      continue
    }

    const parent = stack[stack.length - 1]!
    if (parent.childDepth < analysis.depth) {
      addDiagnostic(
        doc,
        lineRange(line, 0, line.indent.length),
        'indent-inconsistent',
        l('Tutarsız girinti: beklenenden fazla girintilenmiş.', 'Inconsistent indentation: indented more than expected.')
      )
      parent.skippedLine = true
      continue
    }

    handleBody(parent, line, analysis.depth)
  }

  closeAll()

  if (split.unclosedBlockCommentLine !== undefined) {
    const line = split.lines[split.unclosedBlockCommentLine]
    if (line !== undefined) {
      addDiagnostic(
        doc,
        {
          start: { line: line.line, character: line.start },
          end: { line: line.line, character: line.start + 3 }
        },
        'unclosed-block-comment',
        l('Açılan blok yorumu (###) kapatılmamış.', 'Block comment (###) is never closed.')
      )
    }
  }

  sortByStart(doc.diagnostics)
  doc.functions.sort((a, b) => comparePositions(a.nameRange.start, b.nameRange.start))
  sortByStart(doc.functionCalls)
  sortByStart(doc.options)
  sortByStart(doc.optionReferences)
  sortByStart(doc.variables)
  doc.commands.sort((a, b) => comparePositions(a.nameRange.start, b.nameRange.start))

  // Düğüm dizileri zaten belge sırasında; tanılamalar konuma göre sıralandı.
  return doc
}

/**
 * Skript betiğini hata toleranslı biçimde ayrıştırır. Bozuk girdide bile
 * her zaman bir belge döndürür.
 */
export function parseDocument(text: string): SkriptDocument {
  try {
    return parseDocumentUnsafe(text)
  } catch {
    let lines: ParsedLine[] = []
    try {
      lines = splitDocument(text).lines
    } catch {
      lines = []
    }
    return {
      lines: publicLines(lines),
      structures: [],
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          },
          severity: 'error',
          code: 'internal-error',
          message: l('Belge çözümlenirken beklenmeyen bir hata oluştu.', 'An unexpected error occurred while parsing the document.')
        }
      ],
      functions: [],
      functionCalls: [],
      options: [],
      optionReferences: [],
      variables: [],
      commands: []
    }
  }
}

/** Konum hangi düğümün içinde (dıştan içe yol). */
export function nodePathAt(
  doc: SkriptDocument,
  position: Position
): (StructureNode | BodyNode)[] {
  const structure = doc.structures.find((item) =>
    rangeContains(item.range, position)
  )
  if (structure === undefined) return []

  const path: (StructureNode | BodyNode)[] = [structure]
  let current: StructureNode | BodyNode = structure

  while (current.type !== 'statement') {
    const children: BodyNode[] = current.children ?? []
    const child: BodyNode | undefined = children.find((item: BodyNode) =>
      rangeContains(item.range, position)
    )
    if (child === undefined) break
    path.push(child)
    current = child
  }

  return path
}
