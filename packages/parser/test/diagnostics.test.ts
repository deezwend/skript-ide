import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setLocale } from '@skript-ide/i18n'
import { parseDocument } from '../src/index'
import { assertDocumentRanges, diagnosticCodes } from './helpers'

test('geçerli örnek dosyalarda tanılama yok', () => {
  for (const name of ['ornek.sk', 'hatali.sk']) {
    const text = readFileSync(new URL(`../../../examples/${name}`, import.meta.url), 'utf8')
    const doc = parseDocument(text)
    assert.deepEqual(doc.diagnostics, [], `${name} beklenmedik tanılama üretti`)
    assertDocumentRanges(doc, text)
  }
})

test('karışık tab/boşluk girintisi tanılanır', () => {
  const text = 'on join:\n\tsend "a" to player\n\t send "b" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-mixed'])
  assertDocumentRanges(doc, text)
})

test('ilk gövde satırındaki karışık girinti tanılanır', () => {
  const text = 'on join:\n\t send "a" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-mixed'])
})

test('karışık ilk satırdan sonra birim sonraki satırdan alınır', () => {
  const text = [
    'on join:',
    '\t send "a" to player',
    '\tsend "b" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-mixed'])
})

test('üst düzeyde beklenmeyen girinti tanılanır', () => {
  const text = ' on join:\n  send "a" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-unexpected'])
  assert.equal(doc.structures.length, 1)
  assert.equal(doc.structures[0]?.kind, 'event')
})

test('beklenenden fazla girinti tanılanır', () => {
  const text = [
    'on join:',
    '\tsend "a" to player',
    '\t\tsend "b" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-inconsistent'])
  assertDocumentRanges(doc, text)
})

test('tutarsız girinti (satır sayısı uyuşmuyor) tanılanır', () => {
  const text = [
    'on join:',
    '    send "a" to player',
    '  send "b" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-inconsistent'])
})

test('tab ile başlayan gövdede boşluk girintisi tutarsızdır', () => {
  const text = [
    'on join:',
    '\tsend "a" to player',
    '    send "b" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-inconsistent'])
})

test('iç içe bölümde fazla girinti tanılanır', () => {
  const text = [
    'on join:',
    '\tif player is op:',
    '\t\t\tsend "a" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['indent-inconsistent'])
})

test('geçerli iç içe girinti tanılama üretmez', () => {
  const text = [
    'on join:',
    '\tif player is op:',
    '\t\tif player is sneaking:',
    '\t\t\tsend "a" to player',
    '\t\telse:',
    '\t\t\tsend "b" to player',
    '\telse:',
    '\t\tsend "c" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(doc.diagnostics, [])
  assertDocumentRanges(doc, text)
})

test('boş event ve boş trigger uyarı üretir', () => {
  const text = [
    'on join:',
    '',
    'command /x:',
    '\tpermission: p',
    '\ttrigger:'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['empty-section', 'empty-section'])
  for (const diagnostic of doc.diagnostics) {
    assert.equal(diagnostic.severity, 'warning')
  }
  assertDocumentRanges(doc, text)
})

test('kapanmamış string, değişken ve yüzde işareti tanılanır', () => {
  const text = [
    'on join:',
    '\tsend "abc to player',
    '\tset {x to 1',
    '\tsend "50%" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc).sort(), [
    'unclosed-percent',
    'unclosed-string',
    'unclosed-variable'
  ])
  assertDocumentRanges(doc, text)
})

test('yorumdaki kapanmamış string tanılanmaz', () => {
  const text = 'on join:\n\t# send "abc\n\tsend "ok" to player'
  const doc = parseDocument(text)
  assert.deepEqual(doc.diagnostics, [])
})

test('string içindeki kapanmamış değişken yüzde hatasına dönüşmez', () => {
  const text = 'on join:\n\tsend "%{x%" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['unclosed-variable'])
})

test('%% kaçışı ve string içindeki süslü parantez sorun çıkarmaz', () => {
  const text = 'on join:\n\tsend "%%50 {x} %player%" to player'
  const doc = parseDocument(text)
  assert.deepEqual(doc.diagnostics, [])
})

test('üst düzeyde : ile bitmeyen satır tanılanır', () => {
  const text = 'send "x" to player\nfoo: bar\non join:\n\tsend "ok" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['top-level-statement', 'top-level-statement'])
})

test('#-# ile devre dışı bırakılan üst düzey başlık yapı oluşturmaz', () => {
  const doc = parseDocument('on join: #-# devre dışı')
  assert.equal(doc.structures.length, 0)
  assert.deepEqual(diagnosticCodes(doc), ['top-level-statement'])
})

test('kapatılmamış blok yorumu tanılanır', () => {
  const text = '###\non join:\n\tsend "a" to player'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['unclosed-block-comment'])
  assert.equal(doc.diagnostics[0]?.severity, 'error')
})

test('options, variables, aliases ve command satır hataları tanılanır', () => {
  const text = [
    'options:',
    '\tgecersiz',
    'variables:',
    '\t{x}: 1',
    'aliases:',
    '\tgecersiz',
    'command /x:',
    '\ttrigger:',
    '\t\tsend "a" to player',
    '\tgecersiz'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc).sort(), [
    'invalid-alias-line',
    'invalid-command-line',
    'invalid-option-line',
    'invalid-variable-line'
  ])
})

test('süslü parantezsiz değişken adı uyarır', () => {
  const text = 'variables:\n\ty = 2'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc), ['variable-missing-brackets'])
  assert.equal(doc.diagnostics[0]?.severity, 'warning')
  assert.equal(doc.variables.length, 0)
})

test('variables içindeki bölüm geçersiz satır sayılır', () => {
  const text = 'variables:\n\t{x}:'
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc).sort(), [
    'empty-section',
    'invalid-variable-line'
  ])
})

test('fonksiyon parametresi ve imza hataları tanılanır', () => {
  const text = [
    'function f(a text):',
    '\treturn 1',
    'function g(a: text, a: text):',
    '\treturn 1',
    'function h(a: text) birsey:',
    '\treturn 1'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(diagnosticCodes(doc).sort(), [
    'function-duplicate-parameter',
    'function-invalid-parameter',
    'function-invalid-signature'
  ])
})

test('function f(a: text) geçerli imzadır', () => {
  const doc = parseDocument('function f(a: text):\n\treturn "x"')
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.functions.length, 1)
})

test('parametresiz fonksiyon geçerlidir', () => {
  for (const header of ['function f():', 'function f( ):']) {
    const doc = parseDocument(`${header}\n\treturn "x"`)
    assert.deepEqual(doc.diagnostics, [])
    assert.equal(doc.functions.length, 1)
    assert.deepEqual(doc.functions[0]?.parameters, [])
  }
})

test('bilinmeyen yapı gövdesi ham olabileceği için sözcüksel tanılama üretmez', () => {
  const text = [
    'eklenti yapisi:',
    '\taciklama: {kapanmamis',
    '\tsend "%" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.variables.length, 0)
  assert.equal(doc.functionCalls.length, 0)
})

test('girinti hatalı satır atlanır, sonraki geçerli satırlar zincirleme hata almaz', () => {
  // Gerçek korpus örneği (keyall_command.sk): 8 boşluklu gövdede 2 tab'lı satırlar
  const text = [
    'command /keyall:',
    '    permission: op',
    '    trigger:',
    '        send "a" to player',
    '\t\tplay sound "x" to player',
    '        wait 1 second',
    '        send "b" to player'
  ].join('\r\n')
  const doc = parseDocument(text)
  assert.deepEqual(
    doc.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range.start.line]),
    [['indent-inconsistent', 4]]
  )
  const trigger = doc.structures[0]!.children.at(-1)
  assert.equal(trigger?.type, 'entry')
  assert.equal(trigger?.type === 'entry' ? trigger.children?.length : -1, 3)
  assertDocumentRanges(doc, text)
})

test('yalnızca yorum içeren trigger için boş bölüm uyarısı yok, olay için var', () => {
  const command = parseDocument(['command /a:', '    trigger:', '        # Mantık', '', 'on join:', '    send "x"'].join('\n'))
  assert.deepEqual(diagnosticCodes(command), [])
  const event = parseDocument(['on join:', '    # Koşullar', '', 'on quit:', '    send "x"'].join('\n'))
  assert.deepEqual(diagnosticCodes(event), ['empty-section'])
})

test('komutta tekrarlanan girdi tanılanır', () => {
  // Gerçek korpus örneği (plotgen.sk): sunucu "Unexpected entry" ile komutu yüklemiyor
  const text = [
    'command /a:',
    '    permission:    x.a',
    '    Permission: x.b',
    '    trigger:',
    '        send "a"'
  ].join('\n')
  const doc = parseDocument(text)
  assert.deepEqual(
    doc.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range.start.line]),
    [['duplicate-command-entry', 2]]
  )
})

test('tanı mesajları etkin dilde üretilir', () => {
  const text = 'on join:\n\tsend "a" to player\n\t send "b" to player'
  try {
    setLocale('en')
    assert.equal(parseDocument(text).diagnostics[0]?.message, 'Tabs and spaces cannot be mixed in indentation.')
    setLocale('tr')
    assert.equal(parseDocument(text).diagnostics[0]?.message, 'Girintide tab ve boşluk karıştırılamaz.')
  } finally {
    setLocale('tr')
  }
})
