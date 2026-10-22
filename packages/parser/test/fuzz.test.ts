import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDocument } from '../src/index'
import { assertDocumentRanges } from './helpers'

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const examples = [
  readFileSync(new URL('../../../examples/ornek.sk', import.meta.url), 'utf8'),
  readFileSync(new URL('../../../examples/hatali.sk', import.meta.url), 'utf8')
]

const alphabet = '"{}%:#=()[]<>@,.\t\n\r abcXYZ019_-é漢🎉'

test('fuzz: rastgele kesilmiş/bozulmuş binlerce girdi exception atmaz', () => {
  const random = mulberry32(0x5eed1234)
  for (let iteration = 0; iteration < 2500; iteration++) {
    const base = examples[iteration % examples.length] ?? ''
    const mode = iteration % 5
    let input: string

    if (mode === 0) {
      input = base.slice(0, Math.floor(random() * (base.length + 1)))
    } else if (mode === 1) {
      let mutated = ''
      for (let index = 0; index < base.length; index++) {
        mutated +=
          random() < 0.03
            ? (alphabet[Math.floor(random() * alphabet.length)] ?? '')
            : base.charAt(index)
      }
      input = mutated
    } else if (mode === 2) {
      let mutated = ''
      for (let index = 0; index < base.length; index++) {
        mutated += base.charAt(index)
        if (random() < 0.02) {
          mutated += alphabet[Math.floor(random() * alphabet.length)] ?? ''
        }
      }
      input = mutated
    } else if (mode === 3) {
      const first = Math.floor(random() * (base.length + 1))
      const second = Math.floor(random() * (base.length + 1))
      input = base.slice(0, Math.min(first, second)) + base.slice(Math.max(first, second))
    } else {
      const position = Math.floor(random() * (base.length + 1))
      input = base.slice(0, position) + '\uFEFF' + base.slice(position)
    }

    const doc = parseDocument(input)
    const internal = doc.diagnostics.find((diagnostic) => diagnostic.code === 'internal-error')
    assert.equal(internal, undefined, `iç hata: ${JSON.stringify(input.slice(0, 80))}`)
    assertDocumentRanges(doc, input)
  }
})

test('fuzz: aynı girdi aynı belgeyi üretir', () => {
  const random = mulberry32(0xabcdef01)
  for (let iteration = 0; iteration < 100; iteration++) {
    const base = examples[iteration % examples.length] ?? ''
    const position = Math.floor(random() * (base.length + 1))
    const input = base.slice(0, position) + base.slice(position + 10)
    assert.equal(
      JSON.stringify(parseDocument(input)),
      JSON.stringify(parseDocument(input))
    )
  }
})

test('fuzz: CRLF, BOM ve eksik kapanışlar birlikte', () => {
  const cases = [
    '\uFEFFon join:\r\n\tsend "a%{_x}% to player',
    '\uFEFF###\r\non join:\r\n\tcommand /x:\r\n\t\ttrigger:',
    '"%{a::%{_b}%}%',
    'options:\r\n\ta:\r\n\t\tb: 1\r\nvariables:\r\n\t{x} =',
    '\t\t\t\t\t\t\t\t\t'
  ]
  for (const input of cases) {
    const doc = parseDocument(input)
    assert.equal(
      doc.diagnostics.some((diagnostic) => diagnostic.code === 'internal-error'),
      false
    )
    assertDocumentRanges(doc, input)
  }
})
