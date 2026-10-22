/**
 * Gerçek `@skript-ide/parser` + `@skript-ide/pattern-compiler` ile çekirdek servis testleri.
 * (Diğer test dosyaları hızlı ve deterministik olması için sahte uygulamaları kullanır.)
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CompletionItemKind, DiagnosticSeverity, SymbolKind } from 'vscode-languageserver'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { SkriptLanguageService } from '../src/index'
import { createRealService, CURRENT, OLD, positionOf } from './helpers'
import { SEMANTIC_TOKENS_LEGEND } from '../src/semantic-tokens'

test('gerçek parser/compiler: tanılar', async () => {
  const service = createRealService({ skriptVersion: CURRENT })
  const uri = 'file:///real/diagnostics.sk'
  const text = [
    'options:',
    '    prefix: &6Merhaba',
    '',
    'on join:',
    '    send "{@prefix} hoş geldin" to player',
    '    floor(1.5)',
    '    bilinmeyenFonksiyon(1)',
    '    {@eksik}',
    '    send "tırnak'
  ].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  const codes = diagnostics.map((diagnostic) => String(diagnostic.code))
  assert.ok(codes.includes('parse/unclosed-string'), codes.join(','))
  assert.ok(codes.includes('undefined-function'), codes.join(','))
  assert.ok(codes.includes('undefined-option'), codes.join(','))
  const undefinedFunction = diagnostics.find((diagnostic) => diagnostic.code === 'undefined-function')
  assert.equal(undefinedFunction?.severity, DiagnosticSeverity.Warning)
  assert.equal(undefinedFunction?.source, 'skript-ls')
})

test('gerçek parser/compiler: sürüm uyarıları ve if koşulu', async () => {
  const newer = createRealService({ skriptVersion: OLD })
  const addedUri = 'file:///real/added.sk'
  newer.openDocument(addedUri, ['on join:', '    new thing "x"'].join('\n'), 1)
  const added = await newer.getDiagnostics(addedUri)
  assert.ok(added.some((diagnostic) => diagnostic.code === 'version-syntax'))
  assert.match(String(added.find((diagnostic) => diagnostic.code === 'version-syntax')?.message), /eklendi/)

  const current = createRealService({ skriptVersion: CURRENT })
  const conditionUri = 'file:///real/condition.sk'
  current.openDocument(
    conditionUri,
    ['on join:', '    if player is op:', '        send "x" to player'].join('\n'),
    1
  )
  const conditionDiagnostics = await current.getDiagnostics(conditionUri)
  assert.ok(!conditionDiagnostics.some((diagnostic) => diagnostic.code === 'version-syntax'))
})

test('gerçek parser/compiler: tamamlama ve snippet', async () => {
  const service = createRealService({ skriptVersion: CURRENT })
  const uri = 'file:///real/completion.sk'
  const text = ['on join:', '    se'].join('\n')
  service.openDocument(uri, text, 1)

  const body = await service.getCompletions(uri, { line: 1, character: 6 })
  const send = body.find((item) => item.label.startsWith('send'))
  assert.ok(send, body.map((item) => item.label).join(' | '))
  assert.ok(send?.textEdit && 'newText' in send.textEdit && send.textEdit.newText.includes('${1:'))

  const top = await service.getCompletions(uri, { line: 0, character: 0 })
  assert.ok(top.some((item) => item.kind === CompletionItemKind.Event))
  assert.ok(top.some((item) => item.kind === CompletionItemKind.Module))
})

test('gerçek parser/compiler: hover', async () => {
  const service = createRealService({ skriptVersion: CURRENT })
  const uri = 'file:///real/hover.sk'
  const text = ['on join:', '    send "x" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const event = await service.getHover(uri, positionOf(text, 'join'))
  assert.match(JSON.stringify(event), /Join/)
  const effect = await service.getHover(uri, { line: 1, character: 8 })
  assert.match(JSON.stringify(effect), /Send/)
})

test('gerçek sürüm veritabanı: satır içi bölüm ve implicit işareti yanlış pozitif üretmez', async () => {
  const service = new SkriptLanguageService({
    loadDatabase: readSyntaxDatabase,
    skriptVersion: CURRENT
  })
  const uri = 'file:///real/real-db.sk'
  const text = ['on join:', '\twait 2 seconds', '\ttamamen bilinmeyen addon satırı'].join('\n')
  service.openDocument(uri, text, 1)

  // `implicit:<.+>` her satırı yutsaydı bilinmeyen satır da "anlaşılır" görünürdü.
  const diagnostics = await service.getDiagnostics(uri)
  assert.deepEqual(
    diagnostics.map((diagnostic) => `${diagnostic.range.start.line}:${String(diagnostic.code)}`),
    ['2:unknown-syntax']
  )

  const hover = await service.getHover(uri, { line: 1, character: 2 })
  assert.match(JSON.stringify(hover), /Delay/)
})

test('gerçek parser/compiler: tanım, referans, outline ve semantic tokens', async () => {
  const service = createRealService({ skriptVersion: CURRENT })
  const lib = 'file:///real/lib.sk'
  const libText = [
    'function genel(a: number) :: text:',
    '    return "x"',
    '',
    'on join:',
    '    genel(1)'
  ].join('\n')
  const consumer = 'file:///real/consumer.sk'
  const consumerText = ['on join:', '    genel(1)'].join('\n')
  service.openDocument(lib, libText, 1)
  service.openDocument(consumer, consumerText, 1)
  service.setWorkspaceFiles([], true)

  const definition = await service.getDefinition(consumer, positionOf(consumerText, 'genel'))
  assert.equal(definition.length, 1)
  assert.equal(definition[0].uri, lib)

  const references = await service.getReferences(lib, positionOf(libText, 'genel'), true)
  assert.equal(references.length, 3)

  const symbols = await service.getDocumentSymbols(lib)
  assert.equal(symbols[0].kind, SymbolKind.Function)
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['genel', 'on join'])

  const tokens = await service.getSemanticTokens(lib)
  assert.equal(tokens.data.length % 5, 0)
  const types = new Set<number>()
  for (let index = 3; index < tokens.data.length; index += 5) types.add(tokens.data[index])
  assert.ok(types.has(SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf('function')))
  assert.ok(types.has(SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf('parameter')))
})

test('bütçesi tükenen syntax eşleşmesi yanlış sürüm uyarısı üretmez', async () => {
  // 2.17.1 matcher'ı ortak 20.000 adım bütçesini tüketiyor; 2.12.2 aynı satırı eşleştiriyor.
  // Eski davranış "bu syntax seçili sürümde yok" uyarısı veriyordu.
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: CURRENT })
  const uri = 'file:///real/budget.sk'
  const text = ['on join:', `\tloop ${Array.from({ length: 39 }, (_, index) => `x${index}`).join(',')}`].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(
    !diagnostics.some((diagnostic) => diagnostic.code === 'version-syntax'),
    diagnostics.map((diagnostic) => String(diagnostic.code)).join(',')
  )
})

test('gerçek veri: tamamlama bağlamı boş girintili satırlarda ve komut gövdesinde doğru', async () => {
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1' })
  const uri = 'file:///real/completion-context.sk'
  const text = [
    'function selamla(p: player) :: text:',
    '\treturn "x"',
    '',
    'on join:',
    '\tsela',
    '\t',
    '',
    'command /a:',
    '\t',
    '\ttrigger:',
    '\t\t',
    ''
  ].join('\n')
  service.openDocument(uri, text, 1)
  const labels = async (line: number, character: number) =>
    (await service.getCompletions(uri, { line, character })).map((item) => String(item.label))

  // Satır başındaki fonksiyon çağrısı da bir effect'tir
  assert.ok((await labels(4, 5)).includes('selamla(p: player) :: text'))
  // Olay gövdesindeki boş satır: olay değil effect/koşul önerilir
  const body = await labels(5, 1)
  assert.ok(body.some((label) => label.startsWith('send ')), 'gövdede send önerilmeli')
  assert.ok(!body.includes('anvil damage'), 'gövdede olay önerilmemeli')
  // Üst seviye: olaylar, ama yalnızca yer tutucudan oluşan "…" etiketi yok
  const top = await labels(6, 0)
  assert.ok(top.includes('anvil damage'))
  assert.ok(!top.includes('…'))
  // Komutun girdileri ve trigger gövdesi
  assert.ok((await labels(8, 1)).includes('permission:'))
  const trigger = await labels(10, 2)
  assert.ok(!trigger.includes('permission:') && trigger.some((label) => label.startsWith('send ')))
})

test('gerçek veri: hiçbir syntax\'a uymayan satır anında unknown-syntax hatası verir', async () => {
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: CURRENT })
  const uri = 'file:///real/unknown.sk'
  const text = [
    'on join:',
    '    send "merhaba" to player',
    '    blorp the player with fish',
    '    yardimci(player)',
    '    {_list}.add(player)',
    '    display scale: vector(1, 1, 1)',
    '    if any:',
    '        player is op',
    '    {_x} is set:',
    '        set event-block to air',
    '',
    'function yardimci(p: player):',
    '    send "x" to {_p}',
    '',
    'if {a} is 1:',
    '    send "y" to all players'
  ].join('\n')
  service.openDocument(uri, text, 1)

  const unknown = (await service.getDiagnostics(uri)).filter((diagnostic) => diagnostic.code === 'unknown-syntax')
  assert.deepEqual(
    unknown.map((diagnostic) => diagnostic.range.start.line),
    [2, 14],
    unknown.map((diagnostic) => `${diagnostic.range.start.line}: ${diagnostic.message}`).join('\n')
  )
  assert.ok(unknown.every((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error))
})

test('verisi olmayan addon ya da skript-reflect özel syntax\'ı varken unknown-syntax verilmez', async () => {
  const line = ['on join:', '    blorp the player with fish'].join('\n')

  const withAddon = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: CURRENT, addons: [{ name: 'SkGUI', version: '1.0.0' }] })
  withAddon.openDocument('file:///real/addon.sk', line, 1)
  const addonDiagnostics = await withAddon.getDiagnostics('file:///real/addon.sk')
  assert.ok(!addonDiagnostics.some((diagnostic) => diagnostic.code === 'unknown-syntax'))

  const reflect = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: CURRENT })
  reflect.openDocument('file:///real/reflect.sk', `effect blorp %player% with fish:\n    trigger:\n        stop\n\n${line}`, 1)
  const reflectDiagnostics = await reflect.getDiagnostics('file:///real/reflect.sk')
  assert.ok(!reflectDiagnostics.some((diagnostic) => diagnostic.code === 'unknown-syntax'))
})
