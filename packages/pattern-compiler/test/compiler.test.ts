import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compilePattern,
  matchPattern,
  PatternSyntaxError,
  patternToLabel,
  patternToSnippet,
  type PlaceholderNode,
  type SequenceNode
} from '../src/index'

test('literal ve yer tutucular derlenir', () => {
  const compiled = compilePattern('send %objects% to %players%')
  assert.equal(compiled.ast.type, 'sequence')
  const sequence = compiled.ast as SequenceNode
  assert.deepEqual(sequence.nodes.map(node => node.type), ['literal', 'placeholder', 'literal', 'placeholder'])
  assert.deepEqual(compiled.requiredWords, ['send', 'to'])
  assert.equal(compiled.placeholderCount, 2)

  const second = sequence.nodes[3] as PlaceholderNode
  assert.deepEqual(second.info.types, ['players'])
  assert.equal(second.info.plural, true)
  assert.equal(second.info.nullable, false)
  assert.equal(second.info.literalOnly, false)
  assert.equal(second.info.changeable, false)
})

test('opsiyonel, grup ve seçim iç içe derlenir', () => {
  const compiled = compilePattern('[the] (a|b) [[c] d]')
  const sequence = compiled.ast as SequenceNode
  assert.deepEqual(
    sequence.nodes.map(node => node.type),
    ['optional', 'literal', 'group', 'literal', 'optional']
  )
  assert.equal(matchPattern(compiled, 'a c d') !== null, true)
  assert.equal(matchPattern(compiled, 'the b d') !== null, true)
  // Skript'te baştaki/sondaki pattern boşlukları yok sayılır.
  assert.equal(matchPattern(compiled, 'b') !== null, true)
  assert.equal(matchPattern(compiled, 'x') !== null, false)
})

test('tür bayrakları ve zaman eki okunur', () => {
  const compiled = compilePattern('%-objects% %*texts% %~players% %numbers@-1%')
  const sequence = compiled.ast as SequenceNode
  const infos = sequence.nodes
    .filter((node): node is PlaceholderNode => node.type === 'placeholder')
    .map(node => node.info)
  assert.equal(infos[0]?.nullable, true)
  assert.equal(infos[1]?.literalOnly, true)
  assert.equal(infos[2]?.changeable, true)
  assert.equal(infos[3]?.time, -1)
})

test('çoklu türler / ile ayrılır', () => {
  const compiled = compilePattern('%entity types/entity snapshots%')
  const node = (compiled.ast as SequenceNode).nodes[0] as PlaceholderNode
  assert.deepEqual(node.info.types, ['entity types', 'entity snapshots'])
  assert.equal(node.info.plural, true)
})

test('regex düğümü ve kaçışlar', () => {
  const regex = compilePattern('<\\d+>')
  const regexSequence = regex.ast as SequenceNode
  assert.equal(regexSequence.nodes[0]?.type, 'regex')
  assert.equal(matchPattern(regex, '123') !== null, true)
  assert.equal(matchPattern(regex, 'a1') !== null, false)

  const escaped = compilePattern('\\[literal\\] 50\\% \\(x\\)')
  assert.equal(matchPattern(escaped, '[LITERAL] 50% (x)') !== null, true)
})

test('parse mark ve tag eşleşmeye yansır', () => {
  const mark = compilePattern('(1¦neither|) %objects%')
  assert.equal(matchPattern(mark, 'neither a')?.mark, 1)
  assert.equal(matchPattern(mark, 'a')?.mark, 0)

  const tags = compilePattern('foo:bar')
  const tagged = matchPattern(tags, 'bar')
  assert.deepEqual(tagged?.tags, ['foo'])

  const inferred = compilePattern('hello [a:world]')
  assert.deepEqual(matchPattern(inferred, 'hello world')?.tags, ['a'])

  const choiceTag = compilePattern('(a|:b)')
  assert.deepEqual(matchPattern(choiceTag, 'b')?.tags, ['b'])

  const numericTag = compilePattern('1:value')
  assert.equal(matchPattern(numericTag, 'value')?.mark, 1)
  assert.deepEqual(matchPattern(numericTag, 'value')?.tags, ['1'])
})

test('snippet ve etiket üretilir', () => {
  const compiled = compilePattern('send [the] (message|chat) %objects% to %players%')
  assert.equal(patternToSnippet(compiled), 'send message ${1:objects} to ${2:players}')
  assert.equal(patternToLabel(compiled), 'send message … to …')
})

test('hatalı patternler PatternSyntaxError verir', () => {
  const cases: [string, string][] = [
    ['[abc', "'['"],
    ['(abc', "'('"],
    ['%number', "'%'"],
    ['<[>', 'regex'],
    ['abc¦', 'parse mark'],
    ['%number@x%', 'zaman eki'],
    ['%%', 'Boş yer tutucu'],
    ['<abc', 'regex'],
    ['abc\\', 'kaçış']
  ]

  for (const [pattern, expected] of cases) {
    assert.throws(
      () => compilePattern(pattern),
      (error: unknown) => {
        assert.ok(error instanceof PatternSyntaxError)
        assert.ok(error.message.includes(expected), `${pattern}: ${error.message}`)
        assert.equal(error.pattern, pattern)
        assert.ok(error.offset >= 0)
        return true
      }
    )
  }
})

test('toleranslı derleme doküman çıktısındaki bilinen bozuklukları kabul eder', () => {
  const markLoss = compilePattern('x <)', { tolerant: true })
  assert.equal(matchPattern(markLoss, 'x <)') !== null, true)

  const emptyPlaceholder = compilePattern('a %% b', { tolerant: true })
  assert.equal(matchPattern(emptyPlaceholder, 'a % b') !== null, true)
})

test('boş ve yalnızca opsiyonel patternler eşleşir', () => {
  assert.equal(matchPattern(compilePattern(''), '') !== null, true)
  assert.equal(matchPattern(compilePattern('[a]'), '') !== null, true)
  assert.equal(matchPattern(compilePattern('[a]'), 'a') !== null, true)
})
