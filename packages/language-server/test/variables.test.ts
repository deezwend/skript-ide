/**
 * Değişken analizi: okunmayan / yazılmayan / yazım hatası / kapsam uyarıları, hızlı düzeltme,
 * tanım, başvurular ve yeniden adlandırma. Gerçek parser ile çalışır.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver'
import { variableKey, keysOverlap } from '../src/variables'
import { createRealService, CURRENT, positionOf } from './helpers'

function variableDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => String(diagnostic.code ?? '').startsWith('variable-'))
}

async function analyze(text: string, uri = 'file:///vars/test.sk') {
  const service = createRealService({ skriptVersion: CURRENT })
  service.openDocument(uri, text, 1)
  return { service, uri, diagnostics: variableDiagnostics(await service.getDiagnostics(uri)) }
}

test('variableKey: dinamik parçalar joker, büyük/küçük harf duyarsız', () => {
  assert.equal(variableKey('Coins::%player%'), 'coins::%')
  assert.equal(variableKey('x::%{_a}%::{@b}'), 'x::%::%')
  assert.ok(keysOverlap('coins::*', 'coins::%'))
  assert.ok(keysOverlap('coins::%', 'coins::abc'))
  assert.ok(!keysOverlap('coins::%', 'money::abc'))
})

test('yazılmayan yerel değişken uyarı, okunmayan bilgi düzeyinde', async () => {
  const text = ['on join:', '    set {_unused} to 5', '    send "%{_never}%" to player'].join('\n')
  const { diagnostics } = await analyze(text)
  const unwritten = diagnostics.find((d) => d.code === 'variable-unwritten')
  const unread = diagnostics.find((d) => d.code === 'variable-unread')
  assert.ok(unwritten, 'yazılmayan değişken bildirilmeli')
  assert.equal(unwritten.severity, DiagnosticSeverity.Warning)
  assert.equal(unwritten.range.start.line, 2)
  assert.ok(unread, 'okunmayan değişken bildirilmeli')
  assert.equal(unread.severity, DiagnosticSeverity.Information)
})

test('yazım hatası önerisi ve hızlı düzeltme', async () => {
  const text = [
    'on join:',
    '    set {_counter} to 1',
    '    add 1 to {_counter}',
    '    send "%{_countr}%" to player'
  ].join('\n')
  const { service, uri, diagnostics } = await analyze(text)
  const typo = diagnostics.find((d) => d.code === 'variable-typo')
  assert.ok(typo)
  assert.match(String(typo.message), /şunu mu demek istedin: \{_counter\}\?/)
  const actions = await service.getCodeActions(uri, typo.range)
  assert.equal(actions.length, 1)
  const edit = actions[0]!.edit!.changes![uri]![0]!
  assert.equal(edit.newText, '{_counter}')
  assert.deepEqual(edit.range, typo.range)
})

test('tetikleyici dışındaki yerel değişken', async () => {
  // Girintisi kaybolmuş satır: yapı dışında kalır, `{_a}` orada anlamsızdır.
  const text = ['on join:', '    set {_a} to 1', '    send "%{_a}%" to player', 'send "%{_a}%" to player'].join('\n')
  const { diagnostics } = await analyze(text)
  const scope = diagnostics.filter((d) => d.code === 'variable-local-scope')
  assert.equal(scope.length, 1)
  assert.equal(scope[0]!.range.start.line, 3)
})

test('yanlış pozitif kalıpları: özellik ataması, liste parametresi, seçenek değeri, komut argümanı, delete', async () => {
  const text = [
    'options:',
    '    msg: Merhaba %{_name}%',
    'function show(lines: strings, unused: text):',
    '    loop {_lines::*}:',
    '        broadcast loop-value',
    'command /pkg [<target: text>]:',
    '    trigger:',
    '        send "%{_target}%" to player',
    'on join:',
    '    set {_name} to "x"',
    '    send "{@msg}" to player',
    '    set {_skull} to 1',
    '    set {_skull}\'s owner to player',
    '    set {_gone} to 1',
    '    delete {_gone}'
  ].join('\n')
  const { diagnostics } = await analyze(text)
  const messages = diagnostics.map((d) => `${d.range.start.line}: ${d.message}`)
  // {_skull} yalnızca bir kez yazılıyor, özelliği okunuyor: okunmayan uyarısı çıkmamalı.
  // {_gone} ise yazılıp silinmiş; okunmadığı için bilgi uyarısı beklenir.
  assert.deepEqual(
    diagnostics.map((d) => [d.code, d.range.start.line]),
    [['variable-unread', 13]],
    messages.join('\n')
  )
})

test('tanım, başvurular ve yeniden adlandırma (yerel)', async () => {
  const text = [
    'on join:',
    '    set {_list::a} to 1',
    '    add 2 to {_list::*}',
    '    send "%{_list::a}%" to player',
    'on quit:',
    '    set {_list::a} to 3',
    '    broadcast "%{_list::a}%"'
  ].join('\n')
  const { service, uri } = await analyze(text)
  const position = positionOf(text, '_list::a}%')
  const references = await service.getReferences(uri, position, true)
  assert.equal(references.length, 3, 'yalnızca aynı tetikleyicideki kullanımlar')
  const definition = await service.getDefinition(uri, position)
  assert.deepEqual(definition.map((location) => location.range.start.line), [1, 2])

  const prepared = await service.prepareRename(uri, position)
  assert.equal(prepared?.placeholder, '_list')
  const edit = await service.rename(uri, position, '_items')
  const edits = edit!.changes![uri]!
  assert.equal(edits.length, 3)
  assert.ok(edits.every((change) => change.newText === '_items'))
  await assert.rejects(service.rename(uri, position, 'global'), /_ ile başlamalı/)
})

test('genel değişken yeniden adlandırma çalışma alanı genelinde', async () => {
  const service = createRealService({ skriptVersion: CURRENT })
  const a = 'file:///vars/a.sk'
  const b = 'file:///vars/b.sk'
  const textA = ['on join:', '    set {coins::%player%} to 10'].join('\n')
  const textB = ['on quit:', '    send "%{coins::%player%}%" to player'].join('\n')
  service.setWorkspaceFiles([{ uri: a, text: textA }, { uri: b, text: textB }], true)
  service.openDocument(a, textA, 1)
  const edit = await service.rename(a, positionOf(textA, 'coins'), 'money')
  assert.deepEqual(Object.keys(edit!.changes!).sort(), [a, b])
  // Genel değişken her iki dosyada da yazılıp okunduğu için uyarı yok.
  assert.deepEqual(variableDiagnostics(await service.getDiagnostics(a)), [])
})

test('parametre adı yeniden adlandırılınca gövde de değişir', async () => {
  const text = ['function greet(who: player):', '    send "selam" to {_who}'].join('\n')
  const { service, uri, diagnostics } = await analyze(text)
  assert.deepEqual(diagnostics, [])
  const edit = await service.rename(uri, positionOf(text, 'who'), 'target')
  const edits = edit!.changes![uri]!
  assert.deepEqual(edits.map((change) => change.newText).sort(), ['_target', 'target'])
})
