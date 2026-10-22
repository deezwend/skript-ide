import type { Range, SemanticTokens, SemanticTokensLegend } from 'vscode-languageserver'
import type { SkriptDocument } from './contracts'

/** İstemciye `initialize` sonucunda ve dinamik kayıtta bildirilen legend. */
export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: ['function', 'parameter', 'variable', 'macro'],
  tokenModifiers: ['declaration']
}

const TOKEN_TYPE = {
  function: 0,
  parameter: 1,
  variable: 2,
  macro: 3
} as const

const DECLARATION = 1

interface PendingToken {
  line: number
  character: number
  length: number
  type: number
  modifiers: number
}

export function computeSemanticTokens(doc: SkriptDocument): SemanticTokens {
  const pending: PendingToken[] = []

  const push = (range: Range, type: number, modifiers = 0): void => {
    const line = range.start.line
    const info = doc.lines[line]
    if (!info) return
    const rawLength = info.start + info.text.length
    const start = Math.min(range.start.character, rawLength)
    let end = range.end.line === line ? Math.min(range.end.character, rawLength) : rawLength
    if (end <= start) {
      // Boş aralık: en azından bir karakterlik token üretmeyelim.
      return
    }
    if (end > rawLength) end = rawLength
    pending.push({ line, character: start, length: end - start, type, modifiers })
  }

  for (const definition of doc.functions) {
    push(definition.nameRange, TOKEN_TYPE.function, DECLARATION)
    for (const parameter of definition.parameters) push(parameter.range, TOKEN_TYPE.parameter, DECLARATION)
  }
  for (const call of doc.functionCalls) push(call.nameRange, TOKEN_TYPE.function)
  for (const option of doc.options) push(option.nameRange, TOKEN_TYPE.macro, DECLARATION)
  for (const reference of doc.optionReferences) push(reference.range, TOKEN_TYPE.macro)
  for (const variable of doc.variables) push(variable.range, TOKEN_TYPE.variable)

  pending.sort(
    (left, right) =>
      left.line - right.line ||
      left.character - right.character ||
      right.length - left.length ||
      left.type - right.type
  )

  const data: number[] = []
  let lastLine = 0
  let lastCharacter = 0
  let previousEndLine = -1
  let previousEndCharacter = -1

  for (const token of pending) {
    if (token.line === previousEndLine && token.character < previousEndCharacter) continue
    if (token.line < previousEndLine) continue

    const deltaLine = token.line - lastLine
    const deltaCharacter = deltaLine === 0 ? token.character - lastCharacter : token.character
    data.push(deltaLine, deltaCharacter, token.length, token.type, token.modifiers)
    lastLine = token.line
    lastCharacter = token.character
    previousEndLine = token.line
    previousEndCharacter = token.character + token.length
  }

  return { data }
}
