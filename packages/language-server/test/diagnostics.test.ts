import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DiagnosticSeverity } from 'vscode-languageserver'
import { collectDiagnostics, VersionChecker } from '../src/diagnostics'
import type { MatcherAdapter } from '../src/contracts'
import { createService, OLD, CURRENT, positionOf } from './helpers'
import { parseDocument } from './fakes/parser'

function codes(diagnostics: { code?: unknown }[]): string[] {
  return diagnostics.map((diagnostic) => String(diagnostic.code))
}

test('parser, tanımsız fonksiyon ve tanımsız option tanıları', async () => {
  const service = createService()
  const uri = 'file:///test/a.sk'
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
  const found = codes(diagnostics)
  assert.ok(found.includes('parse/unclosed-string'), found.join(','))
  assert.ok(found.includes('undefined-function'), found.join(','))
  assert.ok(found.includes('undefined-option'), found.join(','))
  assert.ok(!found.some((code) => code.startsWith('version-')), found.join(','))

  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.source, 'skript-ls')
  }
  const undefinedFunction = diagnostics.find((diagnostic) => diagnostic.code === 'undefined-function')
  assert.equal(undefinedFunction?.severity, DiagnosticSeverity.Warning)
  assert.match(String(undefinedFunction?.message), /bilinmeyenFonksiyon/)
  const undefinedOption = diagnostics.find((diagnostic) => diagnostic.code === 'undefined-option')
  assert.match(String(undefinedOption?.message), /eksik/)
  assert.deepEqual(undefinedOption?.range, {
    start: positionOf(text, '{@eksik}'),
    end: { line: 7, character: positionOf(text, '{@eksik}').character + 8 }
  })
})

test('çalışma alanı listesi tam değilse tanımsız fonksiyon uyarısı verilmez', async () => {
  const service = createService()
  const uri = 'file:///test/b.sk'
  const text = ['on join:', '    bilinmeyenFonksiyon(1)'].join('\n')
  service.openDocument(uri, text, 1)
  service.setWorkspaceFiles([{ uri: 'file:///test/diger.sk', text: 'on join:\n    send "x" to player' }], false)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(!codes(diagnostics).includes('undefined-function'))

  service.setWorkspaceFiles([{ uri: 'file:///test/diger.sk', text: 'on join:\n    send "x" to player' }], true)
  const completeDiagnostics = await service.getDiagnostics(uri)
  assert.ok(codes(completeDiagnostics).includes('undefined-function'))
})

test('çalışma alanındaki fonksiyonlar geneldir; local function yalnızca kendi dosyasında geçerlidir', async () => {
  const service = createService()
  service.openDocument(
    'file:///test/lib.sk',
    [
      'function genel(a: number) :: text:',
      '    return "x"',
      '',
      'local function sadeceBuDosya() :: text:',
      '    return "y"'
    ].join('\n'),
    1
  )
  const consumer = 'file:///test/kullan.sk'
  service.openDocument(consumer, ['on join:', '    genel(1)', '    sadeceBuDosya()'].join('\n'), 1)
  service.setWorkspaceFiles([], true)

  const diagnostics = await service.getDiagnostics(consumer)
  const undefinedCalls = diagnostics.filter((diagnostic) => diagnostic.code === 'undefined-function')
  assert.equal(undefinedCalls.length, 1)
  assert.match(String(undefinedCalls[0].message), /sadeceBuDosya/)
})

test('seçili sürümde olmayan syntax için sürüm uyarısı (eklendi)', async () => {
  const service = createService({ skriptVersion: OLD })
  const uri = 'file:///test/yeni.sk'
  const text = ['on join:', '    new thing "x"'].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  const warning = diagnostics.find((diagnostic) => diagnostic.code === 'version-syntax')
  assert.ok(warning, codes(diagnostics).join(','))
  assert.equal(warning?.severity, DiagnosticSeverity.Warning)
  assert.match(String(warning?.message), /eklendi/)
  assert.match(String(warning?.message), /2\.17/)
})

test('seçili sürümde kaldırılmış syntax için sürüm uyarısı', async () => {
  const service = createService({ skriptVersion: CURRENT })
  const uri = 'file:///test/eski.sk'
  const text = ['on join:', '    old thing "x"'].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  const warning = diagnostics.find((diagnostic) => diagnostic.code === 'version-syntax')
  assert.ok(warning, codes(diagnostics).join(','))
  assert.match(String(warning?.message), /kaldırılmış/)
})

test('hiçbir sürümde eşleşmeyen satır için uyarı yok', async () => {
  const service = createService({ skriptVersion: CURRENT })
  const uri = 'file:///test/addon.sk'
  const text = ['on join:', '    addon komutu burada', '    alias bir şey'].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.equal(diagnostics.length, 0, codes(diagnostics).join(','))
})

test('if/while başlıkları koşul olarak eşleştirilir', async () => {
  const service = createService({ skriptVersion: OLD })
  const uri = 'file:///test/kosul.sk'
  const text = [
    'on join:',
    '    if player is op:',
    '        send "x" to player',
    '        while player is op:',
    '            send "y" to player'
  ].join('\n')
  service.openDocument(uri, text, 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(!codes(diagnostics).includes('version-syntax'), codes(diagnostics).join(','))
})

test('options yapısı yokken {@x} tanımsız option uyarısı üretmez', async () => {
  const service = createService()
  const uri = 'file:///test/options-yok.sk'
  service.openDocument(uri, ['on join:', '    send "{@x}" to player'].join('\n'), 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(!codes(diagnostics).includes('undefined-option'), codes(diagnostics).join(','))
})

test('boş options yapısı varsa {@x} tanımsız option uyarısı üretir', async () => {
  const service = createService()
  const uri = 'file:///test/options-bos.sk'
  service.openDocument(uri, ['options:', '', 'on join:', '    send "{@x}" to player'].join('\n'), 1)

  const diagnostics = await service.getDiagnostics(uri)
  assert.ok(codes(diagnostics).includes('undefined-option'), codes(diagnostics).join(','))
})

function emptyMatcher(): MatcherAdapter {
  return {
    match: () => [],
    matchEvent: () => [],
    matchExpression: () => []
  }
}

function addonDocument(lines: number) {
  const text = [
    'on join:',
    ...Array.from({ length: lines }, (_, index) => `    addon satiri ${index}`)
  ].join('\n')
  return parseDocument(text)
}

test('uzun belgede sürüm denetimi olay döngüsüne döner', async () => {
  const doc = addonDocument(200)
  let timerTicks = 0
  const timer = setInterval(() => {
    timerTicks += 1
  }, 0)

  try {
    const diagnostics = await collectDiagnostics(doc, {
      currentVersion: '2.0',
      versionChecker: new VersionChecker('2.0', [], async () => emptyMatcher()),
      builtinFunctions: null,
      definedFunctions: new Set(),
      checkUndefinedFunctions: false
    })
    assert.equal(diagnostics.length, 0)
  } finally {
    clearInterval(timer)
  }

  assert.ok(timerTicks > 0, 'sürüm denetimi boyunca zamanlayıcılar çalışabilmeli')
})

test('belge sürümü değişince sürüm taraması erken biter', async () => {
  const doc = addonDocument(200)
  let matchCalls = 0
  const matcher: MatcherAdapter = {
    match: () => {
      matchCalls += 1
      return []
    },
    matchEvent: () => [],
    matchExpression: () => []
  }

  const diagnostics = await collectDiagnostics(doc, {
    currentVersion: '2.0',
    versionChecker: new VersionChecker('2.0', [], async () => matcher),
    builtinFunctions: null,
    definedFunctions: new Set(),
    checkUndefinedFunctions: false,
    isCurrent: () => matchCalls < 10
  })

  assert.equal(diagnostics.length, 0)
  assert.ok(matchCalls < 400, `eski belge için tüm satırlar taranmamalı: ${matchCalls}`)
})

test('başka dosyadaki fonksiyon çağrısı: imza ve dosya bağımlılığı denetimleri', async () => {
  const service = createService()
  service.openDocument(
    'file:///test/kaydirak/kaydirak-cizim.sk',
    ['function kaydirak_ciz(origin: location, yaw: number = 0) :: entities:', '    return {_x::*}'].join('\n'),
    1
  )
  service.openDocument('file:///test/-kapali.sk', ['function kapali(a: number):', '    stop'].join('\n'), 1)
  const consumer = 'file:///test/kaydirak.sk'
  service.openDocument(
    consumer,
    [
      'on join:',
      '    set {_d::*} to kaydirak_ciz({_yer}, yaw of {_yer})',
      '    kaydirak_ciz({_yer})',
      '    kaydirak_ciz({_yer}, 1, 2)',
      '    kaydirak_ciz()',
      '    kaydirak_ciz("burası", 5)',
      '    kapali(1)'
    ].join('\n'),
    1
  )
  service.setWorkspaceFiles([], true)

  const diagnostics = await service.getDiagnostics(consumer)
  const at = (code: string) => diagnostics.filter((d) => d.code === code).map((d) => d.range.start.line)

  assert.deepEqual(at('function-other-file'), [1])
  const other = diagnostics.find((d) => d.code === 'function-other-file')
  assert.equal(other?.severity, DiagnosticSeverity.Information)
  assert.match(String(other?.message), /kaydirak\/kaydirak-cizim\.sk/)
  assert.deepEqual(at('function-arguments'), [3, 4])
  assert.deepEqual(at('function-argument-type'), [5])
  assert.deepEqual(at('function-disabled-file'), [6])
  assert.ok(!at('undefined-function').length, codes(diagnostics).join(','))
})

test('tek parametreli liste fonksiyonu ve "and" listeleri yanlış pozitif üretmez', async () => {
  const service = createService()
  const uri = 'file:///test/liste.sk'
  service.openDocument(
    uri,
    [
      'function topla(n: numbers) :: number:',
      '    return 0',
      'function iki(a: number, b: number) :: number:',
      '    return 0',
      'on join:',
      '    topla(1, 2, 3)',
      '    iki(1 and 2)',
      '    iki(f(1, 2), "a,b" parsed as number)'
    ].join('\n'),
    1
  )
  service.setWorkspaceFiles([], true)
  const diagnostics = await service.getDiagnostics(uri)
  const found = codes(diagnostics)
  assert.ok(!found.includes('function-arguments'), found.join(','))
  assert.ok(!found.includes('function-other-file'), found.join(','))
})
