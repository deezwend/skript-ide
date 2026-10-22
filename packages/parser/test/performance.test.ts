import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from '../src/index'

function makeLargeDocument(blocks: number): string {
  const block = [
    'on join:',
    '\tset {_x} to 1',
    '\tif {_x} is 1:',
    '\t\tsend "value: %{_x}% and %f({_x})%" to player',
    '\telse:',
    '\t\tsend "no" to player',
    'command /cmd:',
    '\ttrigger:',
    '\t\twait 1 tick',
    ''
  ]
  const lines: string[] = []
  for (let index = 0; index < blocks; index++) lines.push(...block)
  return lines.join('\n')
}

test('40.000 eşleşmemiş { tek satırda doğrusal taranır', (t) => {
  const text = `on join:\n\t${'{'.repeat(40000)}`
  const start = performance.now()
  const doc = parseDocument(text)
  const elapsed = performance.now() - start
  t.diagnostic(`40.000 '{': ${elapsed.toFixed(1)} ms`)
  const diagnostics = doc.diagnostics.filter((diagnostic) => diagnostic.code === 'unclosed-variable')
  assert.ok(diagnostics.length > 0, 'en az bir kapanmamış değişken tanısı bekleniyor')
  assert.ok(diagnostics.length <= 20, `satır başına tanı sınırı aşıldı: ${diagnostics.length}`)
  assert.ok(elapsed < 300, `40.000 '{' çok yavaş: ${elapsed.toFixed(1)} ms`)
})

test('20.000 eşleşmemiş ( tek satırda doğrusal taranır', (t) => {
  const text = `on join:\n\t${'a('.repeat(20000)}`
  const start = performance.now()
  parseDocument(text)
  const elapsed = performance.now() - start
  t.diagnostic(`20.000 'a(': ${elapsed.toFixed(1)} ms`)
  assert.ok(elapsed < 300, `20.000 'a(' çok yavaş: ${elapsed.toFixed(1)} ms`)
})

test('10.000 satırlık belge birkaç on milisaniyede ayrıştırılır', (t) => {
  const text = makeLargeDocument(1000)
  assert.equal(text.split('\n').length, 10000)

  parseDocument(text)

  const durations: number[] = []
  let doc = parseDocument(text)
  for (let run = 0; run < 3; run++) {
    const start = performance.now()
    doc = parseDocument(text)
    durations.push(performance.now() - start)
  }
  const best = Math.min(...durations)
  t.diagnostic(`10.000 satır: ${best.toFixed(1)} ms`)
  assert.equal(doc.structures.length, 2000)
  assert.ok(doc.functionCalls.length > 0)
  assert.ok(best < 2000, `10.000 satır çok yavaş: ${best.toFixed(1)} ms`)
})
