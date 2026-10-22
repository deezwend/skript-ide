import test from 'node:test'
import assert from 'node:assert/strict'
import { nodePathAt, parseDocument } from '../src/index'

const sample = [
  'on join:',
  '\tif player is op:',
  '\t\tsend "op" to player',
  'command /x:',
  '\tpermission: p',
  '\ttrigger:',
  '\t\twait 1 tick',
  'options:',
  '\ta:',
  '\t\tb: 1'
].join('\n')

function describePath(path: ReturnType<typeof nodePathAt>): string[] {
  return path.map((node) => {
    if (node.type === 'structure') return `structure:${node.header}`
    if (node.type === 'section') return `section:${node.header}`
    if (node.type === 'entry') return `entry:${node.key}`
    return `statement:${node.text}`
  })
}

test('iç içe statement için dıştan içe yol döner', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(describePath(nodePathAt(doc, { line: 2, character: 5 })), [
    'structure:on join',
    'section:if player is op',
    'statement:send "op" to player'
  ])
})

test('section başlığındaki iki nokta üst üste bölümün içinde sayılır', () => {
  const doc = parseDocument(sample)
  const path = describePath(nodePathAt(doc, { line: 1, character: 15 }))
  assert.deepEqual(path, ['structure:on join', 'section:if player is op'])
})

test('command trigger alt bloğunda EntryNode yolda bulunur', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(describePath(nodePathAt(doc, { line: 6, character: 5 })), [
    'structure:command /x',
    'entry:trigger',
    'statement:wait 1 tick'
  ])
})

test('command girdisinin değerinde entry yolu döner', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(describePath(nodePathAt(doc, { line: 4, character: 13 })), [
    'structure:command /x',
    'entry:permission'
  ])
})

test('iç içe option girdisinde iki entry yolda bulunur', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(describePath(nodePathAt(doc, { line: 9, character: 3 })), [
    'structure:options',
    'entry:a',
    'entry:b'
  ])
})

test('yapı başlığında yalnızca yapı döner', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(describePath(nodePathAt(doc, { line: 0, character: 3 })), [
    'structure:on join'
  ])
})

test('belge dışındaki konum için boş yol döner', () => {
  const doc = parseDocument(sample)
  assert.deepEqual(nodePathAt(doc, { line: 99, character: 0 }), [])
  assert.deepEqual(nodePathAt(doc, { line: 10, character: 0 }), [])
  assert.deepEqual(nodePathAt(parseDocument(''), { line: 0, character: 0 }), [])
})

test('bloğun son içeriğinden sonraki konum yapı içinde sayılmaz', () => {
  const text = 'on join:\n\tsend "a" to player # yorum'
  const doc = parseDocument(text)
  const path = describePath(nodePathAt(doc, { line: 1, character: 24 }))
  assert.deepEqual(path, [])
})
