import {
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  InsertTextFormat,
  MarkupKind,
  TextEdit,
  type Position,
  type Range
} from 'vscode-languageserver'
import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import type {
  BodyNode,
  EntryNode,
  FunctionDefinition,
  OptionDefinition,
  PatternCompilerAdapter,
  SkriptDocument,
  StructureNode
} from './contracts'
import { fallbackLabel, fallbackSnippet } from './defaults'
import { findNodePath, type DocumentAnalysis } from './document'
import { functionSignature, kindLabel, locationLabel, syntaxMarkdown } from './markdown'
import { wordStart } from './util'

import { l } from '@skript-ide/i18n'
export interface VisibleFunction {
  definition: FunctionDefinition
  uri: string
}

export interface VisibleVariable {
  name: string
  local: boolean
  list: boolean
}

export interface CompletionInput {
  /** Tamamlamanın istendiği belge; tanım konumlarını "bu dosya" diye göstermek için. */
  uri?: string
  doc: SkriptDocument
  analysis: DocumentAnalysis
  text: string
  position: Position
  entries: readonly SyntaxEntry[]
  compiler: PatternCompilerAdapter
  functions: readonly VisibleFunction[]
  variables: readonly VisibleVariable[]
}

const commandEntries = (): readonly { key: string; value: string; description: string }[] => [
  { key: 'permission', value: 'skript.admin', description: l('Komutu kullanma izni', 'Permission to use the command') },
  {
    key: 'permission message',
    value: l('Bu komutu kullanma iznin yok.', "You don't have permission to use this command."),
    description: l('İzin yoksa gösterilecek mesaj', 'Message shown when the permission is missing')
  },
  { key: 'description', value: l('Komut açıklaması', 'Command description'), description: l('Komutun açıklaması', 'Description of the command') },
  { key: 'usage', value: l('/komut', '/command'), description: l('Kullanım metni', 'Usage text') },
  { key: 'aliases', value: '/alias', description: l('Alternatif komut adları', 'Alternative command names') },
  { key: 'executable by', value: 'players', description: l('Komutu kimler çalıştırabilir', 'Who can run the command') },
  { key: 'cooldown', value: '5 seconds', description: l('Komut bekleme süresi', 'Command cooldown') },
  {
    key: 'cooldown message',
    value: l('Lütfen bekle.', 'Please wait.'),
    description: l('Bekleme sırasında gösterilecek mesaj', 'Message shown during the cooldown')
  },
  { key: 'cooldown bypass', value: 'skript.admin', description: l('Beklemeyi atlayabilecek izin', 'Permission to bypass the cooldown') },
  {
    key: 'cooldown storage',
    value: l('{cooldowns::%player%::komut}', '{cooldowns::%player%::command}'),
    description: l('Bekleme süresinin saklanacağı değişken', 'Variable that stores the cooldown')
  },
  { key: 'trigger', value: '', description: l('Komutun gövdesi', 'Body of the command') }
]

const RANK: Record<SyntaxKind, string> = {
  section: '0',
  effect: '1',
  condition: '2',
  structure: '0',
  event: '0',
  expression: '3',
  function: '4',
  type: '9'
}

const COMPLETION_KIND: Record<SyntaxKind, CompletionItemKind> = {
  event: CompletionItemKind.Event,
  condition: CompletionItemKind.Keyword,
  effect: CompletionItemKind.Keyword,
  expression: CompletionItemKind.Value,
  section: CompletionItemKind.Module,
  structure: CompletionItemKind.Module,
  type: CompletionItemKind.TypeParameter,
  function: CompletionItemKind.Function
}

interface Presentation {
  label: string
  snippet: string
}

const presentationCache = new WeakMap<PatternCompilerAdapter, Map<string, Presentation>>()

function present(compiler: PatternCompilerAdapter, pattern: string): Presentation {
  let cache = presentationCache.get(compiler)
  if (!cache) {
    cache = new Map()
    presentationCache.set(compiler, cache)
  }
  const cached = cache.get(pattern)
  if (cached) return cached
  let snippet: string
  let label: string
  try {
    snippet = compiler.toSnippet(pattern)
  } catch {
    snippet = fallbackSnippet(pattern)
  }
  try {
    label = compiler.toLabel(pattern)
  } catch {
    label = fallbackLabel(pattern)
  }
  const presentation = { label: label.trim() || pattern, snippet: snippet || pattern }
  if (cache.size > 4000) cache.clear()
  cache.set(pattern, presentation)
  return presentation
}

/** `floor(n: number)` gibi bir fonksiyon imzasından `floor(${1:n})` snippet'i üretir. */
function functionSnippet(signature: string, fallbackName: string): string {
  const name = /^[A-Za-z_][\w-]*/.exec(signature)?.[0] ?? fallbackName
  const open = signature.indexOf('(')
  const close = signature.lastIndexOf(')')
  if (open === -1 || close <= open) return `${name}()`
  const parameters = signature
    .slice(open + 1, close)
    .split(',')
    .map((parameter) => parameter.trim())
    .filter(Boolean)
  if (parameters.length === 0) return `${name}()`
  const placeholders = parameters.map((parameter, index) => {
    const withoutDefault = parameter.split('=')[0] ?? parameter
    const parameterName = withoutDefault.split(':')[0]?.trim() || `arg${index + 1}`
    return `\${${index + 1}:${parameterName}}`
  })
  return `${name}(${placeholders.join(', ')})`
}

export function computeCompletions(input: CompletionInput): CompletionItem[] {
  const lines = input.text.split(/\r\n|\n|\r/)
  const line = lines[input.position.line] ?? ''
  const character = Math.min(input.position.character, line.length)
  const prefix = line.slice(0, character)
  const path = findNodePath(input.doc, input.position)
  // Boş (henüz yazılmamış) girintili satır hiçbir düğüme ait değil; girintiliyse son yapının gövdesindeyiz
  const indented = /^[ \t]+/.test(line)
  const enclosing = indented
    ? input.doc.structures.filter((s) => s.headerRange.start.line < input.position.line).at(-1)
    : undefined
  const structure = path[0]?.type === 'structure' ? path[0] : enclosing
  const cursor: Position = { line: input.position.line, character }

  const brace = openBraceIndex(prefix)
  if (brace !== -1) {
    const content = prefix.slice(brace + 1)
    if (content.startsWith('@')) return optionItems(input.doc.options, brace, cursor)
    if (/^[\p{L}\p{N}_:*-]*$/u.test(content)) return variableItems(input.variables, brace, cursor)
  }

  const lineContext = input.analysis.lines.get(input.position.line)
  const onStructureHeader =
    structure !== undefined && path.length === 1 && structure.headerRange.start.line === input.position.line

  // options/variables/aliases gövdelerinde effect/koşul/bölüm önerisi anlamsızdır.
  if (
    structure !== undefined &&
    !onStructureHeader &&
    (structure.kind === 'options' || structure.kind === 'variables' || structure.kind === 'aliases')
  ) {
    return []
  }

  if (structure?.kind === 'command' && lineContext === undefined) {
    // Komut girdisinin değerinde (`permission: ` vb.) ya da `trigger:` başlığında gövde önerilmez.
    const entry = findEntryOnLine(structure.children, input.position.line)
    const colon = line.indexOf(':')
    if (entry && colon >= 0 && character > colon) return []
  }

  const triggerIndex = path.findIndex(
    (node) => node.type === 'entry' && node.key.trim().toLowerCase() === 'trigger'
  )
  // Yol trigger'da bitse bile girinti trigger başlığından derinse gövdedeyizdir
  // (boş satırın trigger aralığına dahil edildiği parser uygulamalarında).
  const inCommandBody =
    triggerIndex !== -1 &&
    (path.length > triggerIndex + 1 ||
      belowTrigger(structure, input.position.line, line))
  const inCommandEntries = path.length > 0 ? !inCommandBody : !belowTrigger(structure, input.position.line, line)
  if (structure?.kind === 'command' && inCommandEntries && /^[\s\w-]*$/.test(prefix) && !prefix.includes(':')) {
    return commandEntryItems(structure.children, cursor, line, character)
  }

  const last = path[path.length - 1]
  const onSectionHeader = lineContext?.kind === 'condition' || lineContext?.kind === 'section'
  const firstWord = /^\s*\S+/.exec(prefix)
  const afterFirstWord = firstWord !== null && character > firstWord[0].length
  const expressionContext =
    (onSectionHeader && afterFirstWord) ||
    (lineContext?.kind === 'statement' && afterFirstWord) ||
    (last?.type === 'statement' && afterFirstWord)

  if (expressionContext) {
    return syntaxItems(input, COMPLETION_KINDS_EXPRESSION, cursor, line, true)
  }
  if (!structure || onStructureHeader) {
    return syntaxItems(input, COMPLETION_KINDS_TOP, cursor, line, false)
  }
  // Skript'te fonksiyon çağrısı tek başına bir satır (effect) olabilir
  return syntaxItems(input, COMPLETION_KINDS_BODY, cursor, line, true)
}

/** Yolu olmayan boş satır, girintisi `trigger:` girdisinden derinse komut gövdesindedir. */
function belowTrigger(structure: StructureNode | undefined, lineNumber: number, line: string): boolean {
  if (structure?.kind !== 'command') return false
  const trigger = structure.children.find(
    (child): child is EntryNode => child.type === 'entry' && child.key.trim().toLowerCase() === 'trigger'
  )
  if (!trigger || trigger.keyRange.start.line >= lineNumber) return false
  const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0
  return indent > trigger.keyRange.start.character
}

/** Verilen satırda başlayan girdiyi (iç içe bölümler dahil) bulur. */
function findEntryOnLine(nodes: readonly BodyNode[], lineNumber: number): EntryNode | undefined {
  const stack: BodyNode[] = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'entry' && node.keyRange.start.line === lineNumber) return node
    const children = node.type === 'statement' ? undefined : node.children
    if (children) {
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!)
    }
  }
  return undefined
}

const COMPLETION_KINDS_TOP: readonly SyntaxKind[] = ['event', 'structure']
const COMPLETION_KINDS_BODY: readonly SyntaxKind[] = ['effect', 'condition', 'section']
const COMPLETION_KINDS_EXPRESSION: readonly SyntaxKind[] = ['expression', 'function']

function syntaxItems(
  input: CompletionInput,
  kinds: readonly SyntaxKind[],
  cursor: Position,
  line: string,
  includeFunctions: boolean
): CompletionItem[] {
  const kindSet = new Set(kinds)
  const start = wordStart(line, cursor.character)
  const replaceRange: Range = {
    start: { line: cursor.line, character: start },
    end: cursor
  }
  const word = line.slice(start, cursor.character).toLowerCase()
  const items: CompletionItem[] = []

  for (const entry of input.entries) {
    if (!kindSet.has(entry.kind)) continue
    if (entry.kind === 'function') {
      const signature = entry.patterns[0]?.trim() || entry.name
      if (word && !matchesWord(entry, signature, word)) continue
      items.push({
        label: signature,
        kind: CompletionItemKind.Function,
        detail: `fonksiyon • ${entry.name}${entry.addon ? ` • ${entry.addon}` : ''}`,
        documentation: { kind: MarkupKind.Markdown, value: syntaxMarkdown(entry) },
        filterText: `${entry.name} ${signature}`,
        sortText: `4${entry.name.toLowerCase()}`,
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: TextEdit.replace(replaceRange, functionSnippet(signature, entry.name)),
        tags: entry.deprecated ? [CompletionItemTag.Deprecated] : undefined
      })
      continue
    }
    for (const [patternIndex, pattern] of entry.patterns.entries()) {
      if (!pattern.trim()) continue
      if (word && !matchesWord(entry, pattern, word)) continue
      const presentation = present(input.compiler, pattern)
      // StructEvent'in `[on] <.+>` sarmalayıcısı gibi yalnızca yer tutucudan oluşan etiketler öneri değil
      if (!/[\p{L}\p{N}]/u.test(presentation.label)) continue
      items.push({
        label: presentation.label,
        kind: COMPLETION_KIND[entry.kind],
        detail: `${kindLabel(entry.kind)} • ${entry.name}${entry.addon ? ` • ${entry.addon}` : ''}`,
        documentation: { kind: MarkupKind.Markdown, value: syntaxMarkdown(entry) },
        filterText: `${presentation.label} ${entry.name}`,
        sortText: `${RANK[entry.kind]}${entry.name.toLowerCase()}${String(patternIndex).padStart(2, '0')}`,
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: TextEdit.replace(replaceRange, presentation.snippet),
        tags: entry.deprecated ? [CompletionItemTag.Deprecated] : undefined
      })
    }
  }

  if (includeFunctions) {
    const builtinNames = new Set(
      input.entries.filter((entry) => entry.kind === 'function').map((entry) => entry.name.toLowerCase())
    )
    const seen = new Set<string>()
    for (const visible of input.functions) {
      const name = visible.definition.name
      const key = name.toLowerCase()
      if (builtinNames.has(key) || seen.has(key)) continue
      seen.add(key)
      const parameters = visible.definition.parameters
      const snippet =
        parameters.length > 0
          ? `${name}(${parameters.map((parameter, index) => `\${${index + 1}:${parameter.name}}`).join(', ')})`
          : `${name}()`
      items.push({
        label: functionSignature(visible.definition),
        kind: CompletionItemKind.Function,
        detail: visible.definition.local ? l('yerel fonksiyon', 'local function') : l('fonksiyon', 'function'),
        documentation: {
          kind: MarkupKind.Markdown,
          value: l(`Tanım: ${locationLabel(visible.uri, visible.definition.nameRange, input.uri)}`, `Defined in: ${locationLabel(visible.uri, visible.definition.nameRange, input.uri)}`)
        },
        filterText: `${name} ${functionSignature(visible.definition)}`,
        sortText: `00${name.toLowerCase()}`,
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: TextEdit.replace(replaceRange, snippet)
      })
    }
  }

  return items
}

function matchesWord(entry: SyntaxEntry, pattern: string, word: string): boolean {
  return (
    pattern.toLowerCase().includes(word) ||
    entry.name.toLowerCase().includes(word) ||
    entry.id.toLowerCase().includes(word)
  )
}

function optionItems(
  options: readonly OptionDefinition[],
  brace: number,
  cursor: Position
): CompletionItem[] {
  const replaceRange: Range = {
    start: { line: cursor.line, character: brace },
    end: cursor
  }
  return options.map((option) => ({
    label: `{@${option.name}}`,
    kind: CompletionItemKind.Constant,
    detail: option.value.trim() || l('seçenek', 'option'),
    filterText: `{@${option.name}`,
    sortText: `00${option.name.toLowerCase()}`,
    textEdit: TextEdit.replace(replaceRange, `{@${option.name}}`)
  }))
}

function variableItems(
  variables: readonly VisibleVariable[],
  brace: number,
  cursor: Position
): CompletionItem[] {
  const replaceRange: Range = {
    start: { line: cursor.line, character: brace + 1 },
    end: cursor
  }
  const seen = new Set<string>()
  const items: CompletionItem[] = []
  for (const variable of variables) {
    if (seen.has(variable.name)) continue
    seen.add(variable.name)
    items.push({
      label: `{${variable.name}}`,
      kind: CompletionItemKind.Variable,
      detail: variable.list
        ? l('liste değişkeni', 'list variable')
        : variable.local
          ? l('yerel değişken', 'local variable')
          : l('değişken', 'variable'),
      filterText: variable.name,
      sortText: `${variable.local ? '1' : '0'}${variable.name.toLowerCase()}`,
      textEdit: TextEdit.replace(replaceRange, variable.name)
    })
  }
  return items
}

function commandEntryItems(
  children: readonly import('./contracts').BodyNode[],
  cursor: Position,
  line: string,
  character: number
): CompletionItem[] {
  const existing = new Set<string>()
  for (const node of children) {
    if (node.type === 'entry') existing.add(node.key.trim().toLowerCase())
  }
  const start = Math.min(character, line.length)
  const wordStartIndex = (() => {
    let index = start
    while (index > 0 && /[\w-]/.test(line[index - 1])) index -= 1
    return index
  })()
  const replaceRange: Range = {
    start: { line: cursor.line, character: wordStartIndex },
    end: cursor
  }
  return commandEntries().filter((entry) => !existing.has(entry.key)).map((entry) => {
    const snippet =
      entry.key === 'trigger'
        ? '${1:trigger}:'
        : `\${1:${entry.key}}: \${2:${entry.value.replace(/\$/g, '\\$')}}`
    return {
      label: `${entry.key}:`,
      kind: CompletionItemKind.Property,
      detail: entry.description,
      filterText: entry.key,
      sortText: `00${entry.key}`,
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit: TextEdit.replace(replaceRange, snippet)
    }
  })
}

/** İmleçten geriye doğru eşleşmemiş son `{` karakterinin konumu; yoksa -1. */
function openBraceIndex(prefix: string): number {
  let depth = 0
  let lastOpen = -1
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] === '{') {
      if (depth === 0) lastOpen = index
      depth += 1
    } else if (prefix[index] === '}' && depth > 0) {
      depth -= 1
    }
  }
  return depth > 0 ? lastOpen : -1
}
