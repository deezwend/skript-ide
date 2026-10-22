import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument, type Range, type SkriptDocument } from '../src/index'
import { assertDocumentRanges } from './helpers'

const sample = [
  'options:',
  '\tprefix: [P]',
  '\tmesaj:',
  '\t\tkisa: K',
  'variables:',
  '\t{coins::*} = 0',
  '\t{home::%player%} = "x"',
  'on join:',
  "\tset {coins::%player's uuid%} to 1",
  '\tif f({_x}) is true:',
  '\t\tsend "{@prefix} %g({_y})% and %{a::%{_b}%}%" to player',
  '\tsend "plain f() and {x} and 50%%" to player',
  '\t# yorum: h({_z}), {@yorum}',
  'command /heal:',
  '\tcooldown storage: {cd::%player%}',
  '\tusage: Use %f(1)% now',
  '\tpermission message: Yetkin yok %{_p}%',
  '\ttrigger:',
  '\t\tsend "%paraGetir({_hedef})%" to player',
  'function paraGetir(p: offlineplayer, varsayilan: number = 0) :: number:',
  "\treturn {coins::%{_p}'s uuid%} ? {_varsayilan}"
].join('\n')

function textOfRange(doc: SkriptDocument, range: Range): string {
  assert.equal(range.start.line, range.end.line)
  const line = doc.lines[range.start.line]
  assert.ok(line !== undefined)
  return line.text.slice(
    range.start.character - line.start,
    range.end.character - line.start
  )
}

test('fonksiyon tanımları, parametreler ve dönüş türü', () => {
  const doc = parseDocument(sample)
  assert.equal(doc.functions.length, 1)
  const definition = doc.functions[0]
  assert.ok(definition !== undefined)
  assert.equal(definition.name, 'paraGetir')
  assert.equal(definition.local, false)
  assert.equal(definition.returnType, 'number')
  assert.equal(definition.structure.kind, 'function')
  assert.equal(textOfRange(doc, definition.nameRange), 'paraGetir')
  assert.deepEqual(
    definition.parameters.map((parameter) => [
      parameter.name,
      parameter.type,
      parameter.defaultValue,
      textOfRange(doc, parameter.range)
    ]),
    [
      ['p', 'offlineplayer', undefined, 'p: offlineplayer'],
      ['varsayilan', 'number', '0', 'varsayilan: number = 0']
    ]
  )
})

test('fonksiyon çağrıları string içi %…% ifadelerinde de bulunur', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(
    doc.functionCalls.map((call) => call.name),
    ['f', 'g', 'f', 'paraGetir']
  )
  assert.deepEqual(
    doc.functionCalls.map((call) => textOfRange(doc, call.range)),
    ['f({_x})', 'g({_y})', 'f(1)', 'paraGetir({_hedef})']
  )
  for (const call of doc.functionCalls) {
    assert.equal(textOfRange(doc, call.nameRange), call.name)
  }
})

test('düz string ve yorum içindeki çağrılar sembol değildir', () => {
  const doc = parseDocument(sample)
  assert.ok(!doc.functionCalls.some((call) => call.name === 'h'))
  assert.ok(doc.functionCalls.filter((call) => call.name === 'f').length === 2)
})

test('option tanımları ve {@x} referansları toplanır', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(
    doc.options.map((option) => [option.name, option.value]),
    [
      ['prefix', '[P]'],
      ['mesaj.kisa', 'K']
    ]
  )
  assert.deepEqual(
    doc.optionReferences.map((reference) => [
      reference.name,
      textOfRange(doc, reference.range)
    ]),
    [['prefix', '{@prefix}']]
  )
})

test('değişken referansları iç içe {a::%{_b}%} ile birlikte bulunur', () => {
  const doc = parseDocument(sample)
  const names = doc.variables.map((variable) => variable.name)
  assert.deepEqual(names, [
    'coins::*',
    'home::%player%',
    "coins::%player's uuid%",
    '_x',
    '_y',
    'a::%{_b}%',
    '_b',
    'cd::%player%',
    '_p',
    '_hedef',
    "coins::%{_p}'s uuid%",
    '_p',
    '_varsayilan'
  ])

  const list = doc.variables.find((variable) => variable.name === 'coins::*')
  assert.equal(list?.list, true)
  assert.equal(list?.local, false)

  const local = doc.variables.find((variable) => variable.name === '_hedef')
  assert.equal(local?.local, true)
  assert.equal(local?.list, false)

  const outer = doc.variables.find((variable) => variable.name === 'a::%{_b}%')
  assert.ok(outer !== undefined)
  assert.equal(outer.local, false)
  assert.equal(outer.list, false)
  assert.equal(textOfRange(doc, outer.range), '{a::%{_b}%}')

  assert.ok(!doc.variables.some((variable) => variable.name === 'x'))
  assert.ok(!doc.variables.some((variable) => variable.name === '@prefix'))
  assert.ok(!doc.variables.some((variable) => variable.name === '_z'))
})

test('command tanımı ve nameRange', () => {
  const doc = parseDocument(sample)
  assert.equal(doc.commands.length, 1)
  assert.equal(doc.commands[0]?.name, '/heal')
  assert.equal(textOfRange(doc, doc.commands[0]!.nameRange), '/heal')
})

test('fonksiyon varsayılan değerlerindeki semboller taranır', () => {
  const text = 'function f(x: text = "%g()%"):\n\treturn "x"'
  const doc = parseDocument(text)
  assert.deepEqual(doc.functionCalls.map((call) => call.name), ['g'])
})

test('tüm sembol aralıkları belge sınırları içinde', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(doc.diagnostics, [])
  assertDocumentRanges(doc, sample)
})

test('astral karakterlerden sonraki sembol aralıkları UTF-16 konumlarıyla hizalıdır', () => {
  const text = 'on join:\n\tsend "🎉%f({_x})%" to player'
  const doc = parseDocument(text)
  assert.equal(doc.functionCalls.length, 1)
  assert.equal(textOfRange(doc, doc.functionCalls[0]!.range), 'f({_x})')
  const variable = doc.variables.find((item) => item.name === '_x')
  assert.ok(variable !== undefined)
  assert.equal(textOfRange(doc, variable.range), '{_x}')
  assertDocumentRanges(doc, text)
})
