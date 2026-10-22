import { strict as assert } from 'node:assert'
import test from 'node:test'
import { SymbolKind } from 'vscode-languageserver'
import { createService } from './helpers'

test('outline: yapılar, bölümler ve Türkçe ayrıntılar', async () => {
  const service = createService()
  const uri = 'file:///test/symbols.sk'
  const text = [
    'options:',
    '    isim: Merhaba',
    '',
    'on join:',
    '    if player is op:',
    '        send "x" to player',
    '',
    'command /heal:',
    '    permission: skript.admin',
    '    trigger:',
    '        send "y" to player',
    '',
    'function benim(a: number) :: text:',
    '    return "x"'
  ].join('\n')
  service.openDocument(uri, text, 1)

  const symbols = await service.getDocumentSymbols(uri)
  assert.deepEqual(
    symbols.map((symbol) => symbol.name),
    ['options', 'on join', '/heal', 'benim']
  )

  const options = symbols[0]
  assert.equal(options.kind, SymbolKind.Namespace)
  assert.equal(options.detail, 'seçenekler')
  assert.deepEqual(options.children?.map((child) => child.name), ['isim'])

  const event = symbols[1]
  assert.equal(event.kind, SymbolKind.Event)
  assert.equal(event.detail, 'olay')
  assert.deepEqual(event.children?.map((child) => child.name), ['if player is op'])
  assert.equal(event.children?.[0].kind, SymbolKind.Object)

  const command = symbols[2]
  assert.equal(command.kind, SymbolKind.Function)
  assert.equal(command.detail, 'komut')
  assert.deepEqual(command.children?.map((child) => child.name), ['trigger'])

  const fn = symbols[3]
  assert.equal(fn.kind, SymbolKind.Function)
  assert.match(String(fn.detail), /fonksiyon • benim\(a: number\) :: text/)
  assert.equal(fn.selectionRange.start.line, 12)
})

test('bilinmeyen dosyada outline boş', async () => {
  const service = createService()
  assert.deepEqual(await service.getDocumentSymbols('file:///test/yok.sk'), [])
})
