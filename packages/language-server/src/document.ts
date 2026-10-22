import type {
  BodyNode,
  LineInfo,
  Position,
  Range,
  SectionNode,
  SkriptDocument,
  StructureNode
} from './contracts'
import { containsPosition } from './util'

/**
 * Bir satırın hangi syntax türüyle eşleştirileceği. Versiyon uyarıları ve hover bu sınıflandırmayı
 * kullanır; eşleşmeyen satır için uyarı üretilmez.
 */
export type LineContextKind = 'event' | 'condition' | 'section' | 'statement' | 'skip'

export interface LineContext {
  kind: LineContextKind
  /** Eşleştirilecek metin (olay başlığında `on` dahil, `:` hariç). */
  text: string
  range: Range
}

export interface DocumentAnalysis {
  /** Satır numarası → bağlam. Yalnızca sözdizimsel olarak anlamlı satırlar bulunur. */
  lines: Map<number, LineContext>
  functions: Map<string, import('./contracts').FunctionDefinition[]>
  options: Map<string, import('./contracts').OptionDefinition>
}

const IF_CONDITION = /^(?:else\s+)?(?:parse\s+)?if\s+(.+)$/i
const WHILE_CONDITION = /^(?:do\s+)?while\s+(.+)$/i

/** `if …`, `else if …`, `while …` başlıklarındaki koşul metnini çıkarır; diğerlerinde null. */
export function conditionText(header: string): string | null {
  const trimmed = header.trim()
  const ifMatch = IF_CONDITION.exec(trimmed)
  if (ifMatch) return ifMatch[1].trim()
  const whileMatch = WHILE_CONDITION.exec(trimmed)
  if (whileMatch) return whileMatch[1].trim()
  return null
}

function addContext(
  analysis: DocumentAnalysis,
  line: number,
  kind: LineContextKind,
  text: string,
  range: Range
): void {
  if (!analysis.lines.has(line)) analysis.lines.set(line, { kind, text, range })
}

function visitBody(
  analysis: DocumentAnalysis,
  nodes: readonly BodyNode[],
  lineInfo: readonly LineInfo[],
  rootKind: StructureNode['kind']
): void {
  if (rootKind === 'unknown') return
  // Derin iç içe bölümlerde özyineleme taşmasın diye açık yığınla gezinilir.
  const stack: BodyNode[] = [...nodes].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'section') {
      addSection(analysis, node, lineInfo)
      for (let index = node.children.length - 1; index >= 0; index--) {
        stack.push(node.children[index]!)
      }
      continue
    }
    if (node.type === 'entry') {
      // Komut girişleri (`permission:` vb.) syntax satırı değildir; yalnızca alt blokları gezeriz.
      const children = node.children
      if (children) {
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push(children[index]!)
        }
      }
      continue
    }
    const info = lineInfo[node.textRange.start.line]
    if (!info || info.blank) continue
    addContext(analysis, node.textRange.start.line, 'statement', node.text, node.textRange)
  }
}

function addSection(analysis: DocumentAnalysis, section: SectionNode, lineInfo: readonly LineInfo[]): void {
  const line = section.headerRange.start.line
  const info = lineInfo[line]
  if (!info) return
  const condition = conditionText(section.header)
  if (condition !== null) {
    addContext(analysis, line, 'condition', condition, section.headerRange)
    return
  }
  addContext(analysis, line, 'section', section.header, section.headerRange)
}

/** Bir belgenin satır bağlamlarını ve hızlı arama tablolarını üretir. */
export function analyzeDocument(doc: SkriptDocument): DocumentAnalysis {
  const analysis: DocumentAnalysis = { lines: new Map(), functions: new Map(), options: new Map() }

  for (const definition of doc.functions) {
    const key = definition.name.toLowerCase()
    const list = analysis.functions.get(key)
    if (list) list.push(definition)
    else analysis.functions.set(key, [definition])
  }
  for (const option of doc.options) analysis.options.set(option.name.toLowerCase(), option)

  for (const structure of doc.structures) {
    const line = structure.headerRange.start.line
    switch (structure.kind) {
      case 'event':
        addContext(analysis, line, 'event', structure.header, structure.headerRange)
        visitBody(analysis, structure.children, doc.lines, structure.kind)
        break
      case 'function':
        visitBody(analysis, structure.children, doc.lines, structure.kind)
        break
      case 'command':
        visitBody(analysis, structure.children, doc.lines, structure.kind)
        break
      case 'options':
      case 'variables':
      case 'aliases':
      case 'unknown':
        break
    }
  }

  return analysis
}

/** Konumun içinde bulunduğu düğümler, dıştan içe. */
export function findNodePath(
  doc: SkriptDocument,
  position: Position
): (StructureNode | BodyNode)[] {
  for (const structure of doc.structures) {
    if (!containsPosition(structure.range, position)) continue
    const path: (StructureNode | BodyNode)[] = [structure]
    let children: BodyNode[] = structure.children
    for (;;) {
      const child = children.find((candidate) => containsPosition(candidate.range, position))
      if (!child) break
      path.push(child)
      if (child.type === 'section') children = child.children
      else if (child.type === 'entry') children = child.children ?? []
      else children = []
    }
    return path
  }
  return []
}
