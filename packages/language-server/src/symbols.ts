import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver'
import type {
  BodyNode,
  EntryNode,
  FunctionDefinition,
  SectionNode,
  SkriptDocument,
  StructureNode
} from './contracts'
import { functionSignature } from './markdown'

import { l } from '@skript-ide/i18n'
export function computeDocumentSymbols(doc: SkriptDocument): DocumentSymbol[] {
  const definitions = new Map<string, FunctionDefinition>()
  for (const definition of doc.functions) {
    definitions.set(structureKey(definition.structure), definition)
    definitions.set(structureKey(definition.structure.range), definition)
  }
  return doc.structures.map((structure) =>
    structureSymbol(structure, definitions.get(structureKey(structure)) ?? definitions.get(structureKey(structure.range)))
  )
}

function structureKey(value: StructureNode | import('./contracts').Range): string {
  if ('range' in value) return `${value.range.start.line}:${value.range.start.character}`
  return `${value.start.line}:${value.start.character}`
}

function structureSymbol(structure: StructureNode, definition?: FunctionDefinition): DocumentSymbol {
  const name = structure.name ?? structure.header
  const kind = structureKind(structure)
  const detail = structureDetail(structure, definition)
  const children = structureChildren(structure)
  return {
    name,
    detail,
    kind,
    range: structure.range,
    selectionRange: structure.nameRange ?? structure.headerRange,
    children: children.length > 0 ? children : undefined
  }
}

function structureKind(structure: StructureNode): SymbolKind {
  switch (structure.kind) {
    case 'event':
      return SymbolKind.Event
    case 'command':
      return SymbolKind.Function
    case 'function':
      return SymbolKind.Function
    case 'options':
    case 'variables':
    case 'aliases':
      return SymbolKind.Namespace
    case 'unknown':
      return SymbolKind.Object
  }
}

function structureDetail(structure: StructureNode, definition?: FunctionDefinition): string {
  switch (structure.kind) {
    case 'event':
      return l('olay', 'event')
    case 'command':
      return l('komut', 'command')
    case 'function':
      return definition ? `${l('fonksiyon', 'function')} • ${functionSignature(definition)}` : l('fonksiyon', 'function')
    case 'options':
      return l('seçenekler', 'options')
    case 'variables':
      return l('değişkenler', 'variables')
    case 'aliases':
      return l('takma adlar', 'aliases')
    case 'unknown':
      return l('yapı', 'structure')
  }
}

interface BuildFrame {
  nodes: readonly BodyNode[]
  index: number
  rootKind: StructureNode['kind']
  output: DocumentSymbol[]
}

/**
 * Gövde düğümlerini açık yığınla gezer; binlerce iç içe bölümde özyineleme taşmaz.
 * Bölüm çocuklarındaki girdiler komut girdisi sayılır (önceki davranışla aynı).
 */
function buildChildren(
  nodes: readonly BodyNode[],
  rootKind: StructureNode['kind'],
  output: DocumentSymbol[]
): void {
  const frames: BuildFrame[] = [{ nodes, index: 0, rootKind, output }]
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!
    if (frame.index >= frame.nodes.length) {
      frames.pop()
      continue
    }
    const node = frame.nodes[frame.index]!
    frame.index += 1
    if (node.type === 'statement') continue

    if (node.type === 'section') {
      const symbol = sectionSymbol(node)
      frame.output.push(symbol)
      if (node.children.length > 0) {
        const nested: DocumentSymbol[] = []
        symbol.children = nested
        frames.push({ nodes: node.children, index: 0, rootKind: 'command', output: nested })
      }
      continue
    }

    if (!node.children || node.children.length === 0) {
      if (frame.rootKind !== 'options' && frame.rootKind !== 'variables') continue
    }
    const symbol = entrySymbol(node, frame.rootKind)
    frame.output.push(symbol)
    if (node.children && node.children.length > 0) {
      const nested: DocumentSymbol[] = []
      symbol.children = nested
      frames.push({ nodes: node.children, index: 0, rootKind: frame.rootKind, output: nested })
    }
  }
}

function structureChildren(structure: StructureNode): DocumentSymbol[] {
  const children: DocumentSymbol[] = []
  buildChildren(structure.children, structure.kind, children)
  return children
}

function entrySymbol(node: EntryNode, rootKind: StructureNode['kind']): DocumentSymbol {
  return {
    name: node.key,
    detail:
      rootKind === 'options'
        ? l('seçenek', 'option')
        : rootKind === 'variables'
          ? l('değişken', 'variable')
          : node.children && node.children.length > 0
            ? l('bölüm', 'section')
            : l('girdi', 'entry'),
    kind: rootKind === 'variables' ? SymbolKind.Variable : SymbolKind.Constant,
    range: node.range,
    selectionRange: node.keyRange
  }
}

function sectionSymbol(section: SectionNode): DocumentSymbol {
  return {
    name: section.header,
    detail: l('bölüm', 'section'),
    kind: SymbolKind.Object,
    range: section.range,
    selectionRange: section.headerRange
  }
}
