import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { SkriptLanguageService } from '../src/index'

/** Gerçek parser, pattern-compiler ve sürüm veritabanıyla açıklama/bağlam sorguları. */
function realService(): SkriptLanguageService {
  return new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1' })
}

test('explainLine satırın eşleştiği kaydı ve yer tutucu çözümlerini verir', async () => {
  const service = realService()
  const uri = 'file:///real/explain-line.sk'
  const text = ['on join:', '\tsend "hi" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const explanation = await service.explainLine(uri, 1)
  assert.equal(explanation?.context, 'statement')
  assert.equal(explanation?.text, 'send "hi" to player')

  const best = explanation!.matches[0]!
  assert.equal(best.kind, 'effect')
  assert.equal(best.id, 'EffMessage')
  assert.equal(best.confidence, 'exact')
  assert.match(best.pattern, /%objects%/)
  assert.equal(best.placeholders.length, 2)
  assert.equal(best.placeholders[0]!.text, '"hi"')
  assert.deepEqual(best.placeholders[0]!.types, ['objects'])
  assert.equal(best.placeholders[1]!.text, 'player')
  assert.deepEqual(best.placeholders[1]!.types, ['audiences'])
  // Metin sabiti alt ifade olarak literal tanınır
  assert.equal(best.placeholders[0]!.expression?.[0]?.id, 'literal:string')
})

test('explainLine eşleşmeyen satırda en yakın pattern\'i ve yazım ipucunu verir', async () => {
  const service = realService()
  const uri = 'file:///real/explain-miss.sk'
  service.openDocument(uri, ['on join:', '\tbrodcast "hi"'].join('\n'), 1)

  const explanation = await service.explainLine(uri, 1)
  assert.equal(explanation?.context, 'statement')
  assert.equal(explanation?.matches.length, 0)
  const best = explanation!.candidates[0]!
  assert.equal(best.id, 'EffBroadcast')
  assert.match(best.reason, /missing "broadcast" \(close to "brodcast"\)/)
})

test('explainCode başlık bağlamını ve olay satırını çözer', async () => {
  const service = realService()

  const inEvent = await service.explainCode('send "hi" to player', 'on join:')
  assert.equal(inEvent.context, 'statement')
  assert.equal(inEvent.matches[0]?.id, 'EffMessage')

  const header = await service.explainCode('on join:')
  assert.equal(header.context, 'event')
  assert.ok(header.matches.some((match) => match.kind === 'event'))

  const standalone = await service.explainCode('brodcast "hi"')
  assert.equal(standalone.context, 'statement')
  assert.equal(standalone.matches.length, 0)
})

test('getScopeInfo olayı, olay değerlerini, yerel değişkenleri ve options\'ları verir', async () => {
  const service = realService()
  const uri = 'file:///real/explain-scope.sk'
  const text = ['options:', '\tprefix: &a[Kit]', '', 'on join:', '\tset {_target} to player'].join('\n')
  service.openDocument(uri, text, 1)

  const info = await service.getScopeInfo(uri, { line: 4, character: 6 })
  assert.equal(info?.structure?.kind, 'event')
  assert.equal(info?.structure?.header, 'on join')
  assert.ok(info?.event?.matches.some((match) => match.id === 'join'))
  assert.ok(info?.event?.values.some((value) => value.name === 'player'))
  assert.ok(info?.variables.some((variable) => variable.name === '_target' && variable.access === 'write'))
  assert.deepEqual(info?.options, [{ name: 'prefix', value: '&a[Kit]' }])

  // Tetikleyici dışında yerel değişken ve olay bilgisi dönmez
  const outside = await service.getScopeInfo(uri, { line: 1, character: 2 })
  assert.equal(outside?.variables.length, 0)
  assert.equal(outside?.event, undefined)
})

test('getDiagnosticsForText açık belgeyi değiştirmeden verilen metni denetler', async () => {
  const service = realService()
  const uri = 'file:///real/explain-text.sk'
  service.openDocument(uri, ['on join:', '\tblorp the player with fish'].join('\n'), 1)

  const clean = await service.getDiagnosticsForText(uri, 'on join:\n\tsend "hi" to player\n')
  assert.ok(!clean.some((diagnostic) => diagnostic.code === 'unknown-syntax'), clean.map((d) => String(d.code)).join(','))

  const dirty = await service.getDiagnosticsForText(uri, 'on join:\n\tblorp the player with fish\n')
  assert.ok(dirty.some((diagnostic) => diagnostic.code === 'unknown-syntax'))

  // Açık belge hâlâ kendi (bozuk) metniyle denetlenir
  const open = await service.getDiagnostics(uri)
  assert.ok(open.some((diagnostic) => diagnostic.code === 'unknown-syntax'))
})
