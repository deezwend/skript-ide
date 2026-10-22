import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createService, positionOf } from './helpers'

const LIB = 'file:///test/lib.sk'
const LIB_TEXT = [
  'function genel(a: number) :: text:',
  '    return "x"',
  '',
  'local function yerel() :: text:',
  '    return "y"',
  '',
  'on join:',
  '    genel(1)',
  '    yerel()'
].join('\n')

const CONSUMER = 'file:///test/kullan.sk'
const CONSUMER_TEXT = ['on join:', '    genel(1)', '    yerel()'].join('\n')

test('fonksiyon tanımına git (dosyalar arası)', async () => {
  const service = createService()
  service.openDocument(LIB, LIB_TEXT, 1)
  service.openDocument(CONSUMER, CONSUMER_TEXT, 1)
  service.setWorkspaceFiles([], true)

  const locations = await service.getDefinition(CONSUMER, positionOf(CONSUMER_TEXT, 'genel'))
  assert.equal(locations.length, 1)
  assert.equal(locations[0].uri, LIB)
  assert.deepEqual(locations[0].range, {
    start: { line: 0, character: 9 },
    end: { line: 0, character: 14 }
  })
})

test('local function başka dosyadan çözülemez', async () => {
  const service = createService()
  service.openDocument(LIB, LIB_TEXT, 1)
  service.openDocument(CONSUMER, CONSUMER_TEXT, 1)
  service.setWorkspaceFiles([], true)

  assert.deepEqual(await service.getDefinition(CONSUMER, positionOf(CONSUMER_TEXT, 'yerel')), [])
})

test('fonksiyon referansları tüm çalışma alanını kapsar', async () => {
  const service = createService()
  service.openDocument(LIB, LIB_TEXT, 1)
  service.openDocument(CONSUMER, CONSUMER_TEXT, 1)
  service.setWorkspaceFiles([], true)

  const withDeclaration = await service.getReferences(LIB, positionOf(LIB_TEXT, 'genel'), true)
  assert.equal(withDeclaration.length, 3)
  assert.equal(withDeclaration.filter((location) => location.uri === CONSUMER).length, 1)

  const withoutDeclaration = await service.getReferences(LIB, positionOf(LIB_TEXT, 'genel'), false)
  assert.equal(withoutDeclaration.length, 2)
})

test('local function referansları yalnızca kendi dosyasında', async () => {
  const service = createService()
  service.openDocument(LIB, LIB_TEXT, 1)
  service.openDocument(CONSUMER, CONSUMER_TEXT, 1)
  service.setWorkspaceFiles([], true)

  const locations = await service.getReferences(LIB, positionOf(LIB_TEXT, 'yerel'), true)
  assert.equal(locations.length, 2)
  assert.ok(locations.every((location) => location.uri === LIB))
})

test('option tanımına git ve referanslar', async () => {
  const service = createService()
  const uri = 'file:///test/option-nav.sk'
  const text = ['options:', '    isim: Merhaba', '', 'on join:', '    send "{@isim}" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const definition = await service.getDefinition(uri, positionOf(text, '{@isim}'))
  assert.equal(definition.length, 1)
  assert.deepEqual(definition[0].range, {
    start: { line: 1, character: 4 },
    end: { line: 1, character: 8 }
  })

  const references = await service.getReferences(uri, positionOf(text, '{@isim}'), true)
  assert.equal(references.length, 2)

  const referencesWithoutDeclaration = await service.getReferences(
    uri,
    positionOf(text, '{@isim}'),
    false
  )
  assert.equal(referencesWithoutDeclaration.length, 1)
})
