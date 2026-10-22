import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument, type EntryNode, type SectionNode } from '../src/index'
import { assertDocumentRanges, diagnosticCodes } from './helpers'

const sample = [
  'options:',
  '\tprefix: &8[&6Sunucu&8]&r',
  '\tmesaj:',
  '\t\tkisa: Kısa',
  '\t\tuzun: Uzun',
  'variables:',
  '\t{coins::*} = 0',
  'aliases:',
  '\titem = stone',
  'on join:',
  '\tif player is op:',
  '\t\tsend "op" to player',
  '\telse:',
  '\t\tsend "normal" to player',
  'command /heal [<player>]:',
  '\tpermission: heal.use',
  '\ttrigger:',
  '\t\theal player',
  'function f(p: player, n: number = 1) :: text:',
  '\treturn "x"',
  'every 5 seconds:',
  '\twait 1 tick',
  'at 6:00:',
  '\twait 1 tick',
  'cancelled block break:',
  '\tsend "x" to player',
  'foo bar:',
  '\tsend "y" to player',
  'using 1.21'
].join('\n')

test('tüm yapı türleri ve başlıkları çıkarılır', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(
    doc.structures.map((structure) => structure.kind),
    [
      'options',
      'variables',
      'aliases',
      'event',
      'command',
      'function',
      'event',
      'event',
      'event',
      'unknown',
      'unknown'
    ]
  )
  assert.deepEqual(
    doc.structures.map((structure) => structure.header),
    [
      'options',
      'variables',
      'aliases',
      'on join',
      'command /heal [<player>]',
      'function f(p: player, n: number = 1) :: text',
      'every 5 seconds',
      'at 6:00',
      'cancelled block break',
      'foo bar',
      'using 1.21'
    ]
  )

  const event = doc.structures.find((structure) => structure.header === 'on join')
  assert.equal(event?.name, 'on join')
  assert.deepEqual(event?.nameRange, event?.headerRange)

  const every = doc.structures.find((structure) => structure.header === 'every 5 seconds')
  assert.equal(every?.kind, 'event')

  const at = doc.structures.find((structure) => structure.header === 'at 6:00')
  assert.equal(at?.kind, 'event')

  const cancelled = doc.structures.find(
    (structure) => structure.header === 'cancelled block break'
  )
  assert.equal(cancelled?.kind, 'event')

  const unknown = doc.structures.find((structure) => structure.header === 'foo bar')
  assert.equal(unknown?.kind, 'unknown')
  assert.equal(unknown?.children.length, 1)

  const simple = doc.structures.find((structure) => structure.header === 'using 1.21')
  assert.equal(simple?.kind, 'unknown')
  assert.deepEqual(simple?.children, [])
  assert.equal(simple?.name, undefined)

  assert.deepEqual(doc.diagnostics, [])
  assertDocumentRanges(doc, sample)
})

test('headerRange sondaki iki nokta üst üsteyi içermez', () => {
  const doc = parseDocument(sample)
  for (const structure of doc.structures) {
    if (structure.header === 'using 1.21') continue
    const line = doc.lines[structure.headerRange.start.line]
    assert.ok(line !== undefined)
    assert.equal(
      structure.headerRange.end.character - structure.headerRange.start.character,
      structure.header.length
    )
    assert.equal(
      line.text.charAt(structure.header.length),
      ':',
      `${structure.header} başlığından sonra ':' bekleniyordu`
    )
  }
})

test('options tanımları iç içe adlarla toplanır', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(
    doc.options.map((option) => [option.name, option.value]),
    [
      ['prefix', '&8[&6Sunucu&8]&r'],
      ['mesaj.kisa', 'Kısa'],
      ['mesaj.uzun', 'Uzun']
    ]
  )
  const optionsStructure = doc.structures[0]
  assert.equal(optionsStructure?.kind, 'options')
  const mesaj = optionsStructure?.children.find(
    (child): child is EntryNode => child.type === 'entry' && child.key === 'mesaj'
  )
  assert.ok(mesaj !== undefined)
  assert.equal(mesaj.value, '')
  assert.equal(mesaj.children?.length, 2)
  assert.deepEqual(mesaj.valueRange, {
    start: { line: 2, character: 7 },
    end: { line: 2, character: 7 }
  })
})

test('variables yapısı değişken referansı üretir', () => {
  const doc = parseDocument(sample)
  const variablesStructure = doc.structures[1]
  assert.equal(variablesStructure?.kind, 'variables')
  const entry = variablesStructure?.children[0]
  assert.equal(entry?.type, 'entry')
  assert.equal(entry?.key, '{coins::*}')
  assert.equal(entry?.value, '0')

  const definition = doc.variables[0]
  assert.equal(definition?.name, 'coins::*')
  assert.equal(definition?.local, false)
  assert.equal(definition?.list, true)
  assert.deepEqual(definition?.range, entry?.type === 'entry' ? entry.keyRange : undefined)
})

test('aliases yapısı ad = değer girdilerini ayrıştırır', () => {
  const doc = parseDocument(sample)
  const aliases = doc.structures[2]
  assert.equal(aliases?.kind, 'aliases')
  const entry = aliases?.children[0]
  assert.equal(entry?.type, 'entry')
  assert.equal(entry?.key, 'item')
  assert.equal(entry?.type === 'entry' ? entry.value : undefined, 'stone')
})

test('event gövdesindeki iç içe bölümler SectionNode olur', () => {
  const doc = parseDocument(sample)
  const event = doc.structures.find((structure) => structure.header === 'on join')
  assert.ok(event !== undefined)
  assert.equal(event.children.length, 2)
  const ifNode = event.children[0]
  const elseNode = event.children[1]
  assert.equal(ifNode?.type, 'section')
  assert.equal(elseNode?.type, 'section')
  assert.equal((ifNode as SectionNode).header, 'if player is op')
  assert.equal((elseNode as SectionNode).header, 'else')
  assert.equal((ifNode as SectionNode).children[0]?.type, 'statement')
  assert.equal((elseNode as SectionNode).children[0]?.type, 'statement')

  const lastChild = event.children[event.children.length - 1]
  assert.deepEqual(event.range.end, lastChild?.range.end)
})

test('command girdileri ve trigger alt bloğu EntryNode olur', () => {
  const doc = parseDocument(sample)
  const command = doc.structures.find((structure) => structure.kind === 'command')
  assert.ok(command !== undefined)
  assert.equal(command.name, '/heal')
  assert.equal(command.nameRange?.start.character, 8)
  assert.equal(doc.commands[0]?.name, '/heal')
  assert.equal(doc.commands[0]?.structure, command)

  const permission = command.children.find(
    (child): child is EntryNode => child.type === 'entry' && child.key === 'permission'
  )
  assert.equal(permission?.value, 'heal.use')
  assert.equal(permission?.children, undefined)

  const trigger = command.children.find(
    (child): child is EntryNode => child.type === 'entry' && child.key === 'trigger'
  )
  assert.ok(trigger !== undefined)
  assert.equal(trigger.value, '')
  assert.equal(trigger.children?.length, 1)
  assert.equal(trigger.children?.[0]?.type, 'statement')
  assert.deepEqual(command.range.end, trigger.children?.[0]?.range.end)
})

test('fonksiyon imzası parametreleri ve dönüş türü çıkarılır', () => {
  const doc = parseDocument(sample)
  assert.equal(doc.functions.length, 1)
  const definition = doc.functions[0]
  assert.ok(definition !== undefined)
  assert.equal(definition.name, 'f')
  assert.equal(definition.local, false)
  assert.equal(definition.returnType, 'text')
  assert.deepEqual(
    definition.parameters.map((parameter) => [
      parameter.name,
      parameter.type,
      parameter.defaultValue
    ]),
    [
      ['p', 'player', undefined],
      ['n', 'number', '1']
    ]
  )
})

test('local function ve returns biçimi', () => {
  const doc = parseDocument(
    [
      'local function hesapla(a: number, b: number = 2) returns number:',
      '\treturn {_a} + {_b}'
    ].join('\n')
  )
  assert.equal(doc.functions.length, 1)
  assert.equal(doc.functions[0]?.name, 'hesapla')
  assert.equal(doc.functions[0]?.local, true)
  assert.equal(doc.functions[0]?.returnType, 'number')
  assert.deepEqual(doc.diagnostics, [])
})

test('varsayılan değerdeki virgül ve parantez parametreleri bölmez', () => {
  const doc = parseDocument(
    [
      'function f(a: text = "x, y", b: number = (1 + 2)) :: text:',
      '\treturn "x"'
    ].join('\n')
  )
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.functions[0]?.parameters.length, 2)
  assert.equal(doc.functions[0]?.parameters[0]?.defaultValue, '"x, y"')
  assert.equal(doc.functions[0]?.parameters[1]?.defaultValue, '(1 + 2)')
})

test('option değerindeki iki nokta üst üste korunur', () => {
  const doc = parseDocument('options:\n\tadres: https://ornek.test:8080/yol')
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.options[0]?.value, 'https://ornek.test:8080/yol')
})

test('#-# ile devre dışı bırakılan option başlığı bölüm açmaz', () => {
  const doc = parseDocument(
    ['options:', '\ta: #-# devre dışı', '\tb: 2'].join('\n')
  )
  assert.deepEqual(
    doc.options.map((option) => [option.name, option.value]),
    [
      ['a', ''],
      ['b', '2']
    ]
  )
  assert.deepEqual(diagnosticCodes(doc), [])
})

test('bilinmeyen üst düzey başlıklar gövdesiyle birlikte unknown olur', () => {
  const text = 'benim yapim:\n\tsend "a" to player\n\tsub yapim:\n\t\tsend "b" to player'
  const doc = parseDocument(text)
  assert.equal(doc.structures.length, 1)
  const structure = doc.structures[0]
  assert.equal(structure?.kind, 'unknown')
  assert.equal(structure?.header, 'benim yapim')
  assert.equal(structure?.children.length, 2)
  assert.equal(structure?.children[1]?.type, 'section')
  assert.deepEqual(doc.diagnostics, [])
})
