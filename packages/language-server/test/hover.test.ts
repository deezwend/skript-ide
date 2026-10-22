import { strict as assert } from 'node:assert'
import test from 'node:test'
import { MarkupKind } from 'vscode-languageserver'
import { createRealService, createService, CURRENT, positionOf } from './helpers'

function value(hover: { contents: unknown } | null): string {
  assert.ok(hover)
  const contents = hover.contents as { kind?: string; value?: string }
  assert.equal(contents.kind, MarkupKind.Markdown)
  return contents.value ?? ''
}

test('olay başlığında hover: ad, açıklama, örnek ve olay değerleri', async () => {
  const service = createService()
  const uri = 'file:///test/hover-event.sk'
  const text = ['on join:', '    send "x" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const hover = await service.getHover(uri, positionOf(text, 'join'))
  const markdown = value(hover)
  assert.match(markdown, /\*\*Join\*\*/)
  assert.match(markdown, /olay/)
  assert.match(markdown, /```skript/)
  assert.match(markdown, /Olay değerleri/)
})

test('efekt satırında hover', async () => {
  const service = createService()
  const uri = 'file:///test/hover-effect.sk'
  const text = ['on join:', '    send "x" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const markdown = value(await service.getHover(uri, { line: 1, character: 8 }))
  assert.match(markdown, /\*\*Send\*\*/)
  assert.match(markdown, /efekt/)
  assert.match(markdown, /Eklendiği sürüm: 2\.0/)
})

test('yerleşik fonksiyon çağrısında imza hover', async () => {
  const service = createService()
  const uri = 'file:///test/hover-function.sk'
  const text = ['on join:', '    floor(1)'].join('\n')
  service.openDocument(uri, text, 1)

  const markdown = value(await service.getHover(uri, positionOf(text, 'floor')))
  assert.match(markdown, /floor\(n: number\)/)
  assert.match(markdown, /\*\*floor\*\*/)
  assert.match(markdown, /fonksiyon/)
})

test('option referansında değer hover', async () => {
  const service = createService()
  const uri = 'file:///test/hover-option.sk'
  const text = ['options:', '    isim: Merhaba', '', 'on join:', '    send "{@isim}" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const markdown = value(await service.getHover(uri, positionOf(text, '{@isim}')))
  assert.match(markdown, /\{@isim\}/)
  assert.match(markdown, /Merhaba/)
})

test('fonksiyon tanımında imza hover', async () => {
  const service = createService()
  const uri = 'file:///test/hover-def.sk'
  const text = ['function benim(a: number) :: text:', '    return "x"'].join('\n')
  service.openDocument(uri, text, 1)

  const markdown = value(await service.getHover(uri, positionOf(text, 'benim')))
  assert.match(markdown, /benim\(a: number\) :: text/)
  assert.match(markdown, /Yerel fonksiyon|Fonksiyon/)
})

test('eşleşmeyen satırda hover yok', async () => {
  const service = createService()
  const uri = 'file:///test/hover-none.sk'
  const text = ['on join:', '    tamamen bilinmeyen addon satırı'].join('\n')
  service.openDocument(uri, text, 1)

  assert.equal(await service.getHover(uri, { line: 1, character: 10 }), null)
})

test('fonksiyon hover konumu okunur etiketle gösterilir (inmemory adresi sızmaz)', async () => {
  const { locationLabel } = await import('../src/markdown')
  assert.equal(locationLabel('inmemory://model/1', { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }), 'kaydedilmemiş dosya, satır 5')
  assert.equal(locationLabel('file:///c%3A/x/lib%20a.sk', undefined), '`lib a.sk`')
  assert.equal(locationLabel('file:///c%3A/x/a.sk', { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, 'file:///C%3A/x/a.sk'), 'bu dosya, satır 1')

  const service = createRealService({ skriptVersion: CURRENT })
  const uri = 'inmemory://model/1'
  const text = ['function greet(p: player):', '    send "x" to {_p}', 'on join:', '    greet(player)'].join('\n')
  service.openDocument(uri, text, 1)
  const hover = await service.getHover(uri, positionOf(text, 'greet', 1))
  const value = JSON.stringify(hover)
  assert.match(value, /bu dosya, satır 1/)
  assert.doesNotMatch(value, /inmemory/)
})
