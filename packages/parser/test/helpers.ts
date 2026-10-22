import assert from 'node:assert/strict'
import type { BodyNode, Range, SkriptDocument, StructureNode } from '../src/index'

export function diagnosticCodes(doc: SkriptDocument): string[] {
  return doc.diagnostics.map((diagnostic) => diagnostic.code)
}

export function documentLineLengths(text: string): number[] {
  return text.split(/\r\n|\n|\r/).map((line) => line.length)
}

function assertRange(
  range: Range,
  lineLengths: readonly number[],
  label: string
): void {
  assert.ok(range.start.line >= 0, `${label}: negatif satır`)
  assert.ok(range.end.line >= 0, `${label}: negatif satır`)
  assert.ok(range.start.line < lineLengths.length, `${label}: satır aralık dışında`)
  assert.ok(range.end.line < lineLengths.length, `${label}: satır aralık dışında`)
  assert.ok(range.start.character >= 0, `${label}: negatif karakter`)
  assert.ok(range.end.character >= 0, `${label}: negatif karakter`)
  if (range.start.line === range.end.line) {
    assert.ok(
      range.end.character >= range.start.character,
      `${label}: bitiş başlangıçtan önce`
    )
  }
  assert.ok(
    range.start.character <= (lineLengths[range.start.line] ?? 0),
    `${label}: başlangıç satır sonunu aşıyor`
  )
  assert.ok(
    range.end.character <= (lineLengths[range.end.line] ?? 0),
    `${label}: bitiş satır sonunu aşıyor`
  )
}

function assertBodyNode(
  node: BodyNode,
  lineLengths: readonly number[],
  label: string
): void {
  assertRange(node.range, lineLengths, label)
  if (node.type === 'statement') {
    assertRange(node.textRange, lineLengths, `${label}.textRange`)
    return
  }
  if (node.type === 'section') {
    assertRange(node.headerRange, lineLengths, `${label}.headerRange`)
    node.children.forEach((child, index) => {
      assertBodyNode(child, lineLengths, `${label}.children[${index}]`)
    })
    return
  }
  assertRange(node.keyRange, lineLengths, `${label}.keyRange`)
  assertRange(node.valueRange, lineLengths, `${label}.valueRange`)
  node.children?.forEach((child, index) => {
    assertBodyNode(child, lineLengths, `${label}.children[${index}]`)
  })
}

function assertStructure(
  structure: StructureNode,
  lineLengths: readonly number[],
  label: string
): void {
  assertRange(structure.range, lineLengths, label)
  assertRange(structure.headerRange, lineLengths, `${label}.headerRange`)
  if (structure.nameRange !== undefined) {
    assertRange(structure.nameRange, lineLengths, `${label}.nameRange`)
  }
  structure.children.forEach((child, index) => {
    assertBodyNode(child, lineLengths, `${label}.children[${index}]`)
  })
}

/** Tüm tanılama ve sembol aralıklarının belge sınırları içinde olduğunu doğrular. */
export function assertDocumentRanges(doc: SkriptDocument, text: string): void {
  const lineLengths = documentLineLengths(text)
  doc.diagnostics.forEach((diagnostic, index) => {
    assertRange(diagnostic.range, lineLengths, `diagnostics[${index}]`)
  })
  doc.structures.forEach((structure, index) => {
    assertStructure(structure, lineLengths, `structures[${index}]`)
  })
  doc.functions.forEach((definition, index) => {
    assertRange(definition.nameRange, lineLengths, `functions[${index}].nameRange`)
    definition.parameters.forEach((parameter, parameterIndex) => {
      assertRange(
        parameter.range,
        lineLengths,
        `functions[${index}].parameters[${parameterIndex}]`
      )
    })
  })
  doc.functionCalls.forEach((call, index) => {
    assertRange(call.nameRange, lineLengths, `functionCalls[${index}].nameRange`)
    assertRange(call.range, lineLengths, `functionCalls[${index}].range`)
  })
  doc.options.forEach((option, index) => {
    assertRange(option.nameRange, lineLengths, `options[${index}].nameRange`)
    assertRange(option.range, lineLengths, `options[${index}].range`)
  })
  doc.optionReferences.forEach((reference, index) => {
    assertRange(reference.range, lineLengths, `optionReferences[${index}]`)
  })
  doc.variables.forEach((variable, index) => {
    assertRange(variable.range, lineLengths, `variables[${index}]`)
  })
  doc.commands.forEach((command, index) => {
    assertRange(command.nameRange, lineLengths, `commands[${index}].nameRange`)
  })
}
