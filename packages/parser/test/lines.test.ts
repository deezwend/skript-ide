import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from '../src/index'
import { assertDocumentRanges, diagnosticCodes } from './helpers'

test('boş belge tek boş satır üretir', () => {
  const doc = parseDocument('')
  assert.equal(doc.lines.length, 1)
  assert.equal(doc.lines[0]?.blank, true)
  assert.equal(doc.lines[0]?.text, '')
  assert.equal(doc.lines[0]?.start, 0)
  assert.deepEqual(doc.structures, [])
  assert.deepEqual(doc.diagnostics, [])
})

test('LF, CRLF ve tek CR aynı satır yapısını verir', () => {
  const texts = [
    'on join:\n\tsend "a" to player',
    'on join:\r\n\tsend "a" to player',
    'on join:\r\tsend "a" to player'
  ]
  for (const text of texts) {
    const doc = parseDocument(text)
    assert.equal(doc.lines.length, 2)
    assert.equal(doc.lines[0]?.text, 'on join:')
    assert.equal(doc.lines[1]?.indent, '\t')
    assert.equal(doc.lines[1]?.text, 'send "a" to player')
    assert.equal(doc.structures.length, 1)
    assert.equal(doc.structures[0]?.kind, 'event')
    assert.deepEqual(doc.diagnostics, [])
  }
})

test('sondaki satır sonu boş satır olarak temsil edilir', () => {
  const doc = parseDocument('on join:\n\tsend "a" to player\n')
  assert.equal(doc.lines.length, 3)
  assert.equal(doc.lines[2]?.blank, true)
})

test('UTF-8 BOM çıkarılır ama konumlar belgeyle hizalı kalır', () => {
  const text = '\uFEFFon join:\n\tsend "a" to player'
  const doc = parseDocument(text)
  assert.equal(doc.lines[0]?.text, 'on join:')
  assert.equal(doc.lines[0]?.start, 1)
  assert.equal(doc.structures.length, 1)
  assert.deepEqual(doc.structures[0]?.headerRange.start, {
    line: 0,
    character: 1
  })
  assert.deepEqual(doc.structures[0]?.headerRange.end, {
    line: 0,
    character: 8
  })
  assert.deepEqual(doc.diagnostics, [])
  assertDocumentRanges(doc, text)
})

test('BOM ilk boş olmayan satırdan çıkarılır', () => {
  const text = '\n\uFEFFon join:\n\tsend "a" to player'
  const doc = parseDocument(text)
  assert.equal(doc.lines[0]?.blank, true)
  assert.equal(doc.lines[1]?.text, 'on join:')
  assert.equal(doc.lines[1]?.start, 1)
  assert.equal(doc.structures.length, 1)
  assert.deepEqual(doc.structures[0]?.headerRange.start, {
    line: 1,
    character: 1
  })
  assertDocumentRanges(doc, text)
})

test('yorumlar, string içindeki # ve ## kaçışı doğru ayrılır', () => {
  const text = [
    '# tam yorum',
    '  # girintili yorum',
    'send "a # b" to player',
    'send "x" # kuyruk',
    'send x ## y # kuyruk',
    'send "a ## b" # kuyruk'
  ].join('\n')
  const doc = parseDocument(text)

  assert.equal(doc.lines[0]?.blank, true)
  assert.equal(doc.lines[0]?.commentStart, 0)
  assert.equal(doc.lines[1]?.blank, true)
  assert.equal(doc.lines[1]?.commentStart, 2)
  assert.equal(doc.lines[1]?.start, 2)

  assert.equal(doc.lines[2]?.text, 'send "a # b" to player')
  assert.equal(doc.lines[2]?.commentStart, undefined)

  assert.equal(doc.lines[3]?.text, 'send "x"')
  assert.equal(doc.lines[3]?.commentStart, 9)

  assert.equal(doc.lines[4]?.text, 'send x ## y')
  assert.equal(doc.lines[4]?.commentStart, 12)

  assert.equal(doc.lines[5]?.text, 'send "a ## b"')
  assert.equal(doc.lines[5]?.commentStart, 14)
  assertDocumentRanges(doc, text)
})

test('string içindeki %…% ifadesinde # yorum başlatır', () => {
  const text = 'send "%player # y%" to player'
  const doc = parseDocument(text)
  assert.equal(doc.lines[0]?.text, 'send "%player')
  assert.equal(doc.lines[0]?.commentStart, 14)
})

test('### blok yorumu satırları yorum sayar', () => {
  const text = [
    '###',
    'on join:',
    '\tsend "gizli" to player',
    '###',
    'command /x:',
    '\ttrigger:',
    '\t\tsend "açık" to player'
  ].join('\n')
  const doc = parseDocument(text)
  assert.equal(doc.structures.length, 1)
  assert.equal(doc.structures[0]?.kind, 'command')
  assert.equal(doc.lines[0]?.blank, true)
  assert.equal(doc.lines[1]?.blank, true)
  assert.equal(doc.lines[2]?.blank, true)
  assert.equal(doc.lines[3]?.blank, true)
  assert.deepEqual(diagnosticCodes(doc).filter((code) => code === 'unclosed-block-comment'), [])
  assertDocumentRanges(doc, text)
})

test('kapatılmamış blok yorumu tanılanır', () => {
  const text = '###\non join:\n\tsend "a" to player'
  const doc = parseDocument(text)
  assert.ok(diagnosticCodes(doc).includes('unclosed-block-comment'))
  assert.deepEqual(doc.structures, [])
  assertDocumentRanges(doc, text)
})
