import { strict as assert } from 'node:assert'
import test from 'node:test'
import type {
  BodyNode,
  LineInfo,
  Range,
  SectionNode,
  SkriptDocument,
  StatementNode,
  StructureNode
} from '../src/contracts'
import { analyzeDocument } from '../src/document'
import { computeDocumentSymbols } from '../src/symbols'
import { createService, database } from './helpers'

const DEPTH = 6000
const LAST_LINE = DEPTH + 1

function range(line: number, length: number): Range {
  return {
    start: { line, character: 0 },
    end: { line, character: length }
  }
}

function deepDocument(): SkriptDocument {
  const statement: StatementNode = {
    type: 'statement',
    text: 'send "x" to player',
    textRange: range(LAST_LINE, 19),
    range: range(LAST_LINE, 19)
  }
  let nodes: BodyNode[] = [statement]
  for (let line = DEPTH; line >= 1; line--) {
    const section: SectionNode = {
      type: 'section',
      header: 'if player is op',
      headerRange: range(line, 15),
      children: nodes,
      range: {
        start: { line, character: 0 },
        end: { line: LAST_LINE, character: 19 }
      }
    }
    nodes = [section]
  }

  const structure: StructureNode = {
    type: 'structure',
    kind: 'event',
    header: 'on join',
    headerRange: range(0, 7),
    children: nodes,
    range: { start: { line: 0, character: 0 }, end: { line: LAST_LINE, character: 19 } }
  }

  const lines: LineInfo[] = []
  for (let line = 0; line <= LAST_LINE; line++) {
    lines.push({ line, indent: '', text: line === 0 ? 'on join:' : 'if player is op', start: 0, blank: false })
  }

  return {
    lines,
    structures: [structure],
    diagnostics: [],
    functions: [],
    functionCalls: [],
    options: [],
    optionReferences: [],
    variables: [],
    commands: []
  }
}

test('6.000 iç içe bölüm analiz ve outline sırasında taşmaz', () => {
  const doc = deepDocument()
  assert.doesNotThrow(() => analyzeDocument(doc))
  const symbols = computeDocumentSymbols(doc)
  assert.equal(symbols.length, 1)
})

test('6.000 iç içe bölümde getDiagnostics çalışır', async () => {
  const doc = deepDocument()
  const service = createService({
    parser: { parseDocument: () => doc },
    loadDatabase: async () => database('2.0', [])
  })
  const uri = 'file:///test/derin.sk'
  service.openDocument(uri, 'x', 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(Array.isArray(diagnostics))
})
