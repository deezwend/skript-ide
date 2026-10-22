import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePattern, matchPattern } from '../src/index'

test('literal kısımlar büyük/küçük harf duyarsız ve boşluklara toleranslıdır', () => {
  const compiled = compilePattern('send %objects% to %players%')
  const match = matchPattern(compiled, 'SeNd   "hi"   TO player')
  assert.notEqual(match, null)
  assert.deepEqual(match?.placeholders.map(placeholder => placeholder.text), ['"hi"', 'player'])
})

test('baştaki boşluklar konumlara yansır', () => {
  const compiled = compilePattern('send %objects%')
  const match = matchPattern(compiled, '   send hi')
  assert.equal(match?.placeholders[0]?.text, 'hi')
  assert.equal(match?.placeholders[0]?.start, 8)
  assert.equal(match?.placeholders[0]?.end, 10)
})

test('seçimler geri izleme ile denenir', () => {
  assert.notEqual(matchPattern(compilePattern('(a|ab)'), 'ab'), null)
  assert.notEqual(matchPattern(compilePattern('(ab|a)b'), 'ab'), null)
  assert.equal(matchPattern(compilePattern('(a|ab)'), 'ac'), null)
})

test('opsiyoneller iki yandaki boşlukları birleştirir', () => {
  const compiled = compilePattern('a [b] c')
  assert.notEqual(matchPattern(compiled, 'a c'), null)
  assert.notEqual(matchPattern(compiled, 'a  c'), null)
  assert.notEqual(matchPattern(compiled, 'a b c'), null)
  assert.equal(matchPattern(compiled, 'ac'), null)
})

test('yer tutucu metni varsayılan olarak dengeli ve boş olmayandır', () => {
  const compiled = compilePattern('%objects%')
  assert.notEqual(matchPattern(compiled, '"hi"'), null)
  assert.notEqual(matchPattern(compiled, '{_x}'), null)
  assert.equal(matchPattern(compiled, ''), null)
  assert.equal(matchPattern(compiled, '"unclosed'), null)
})

test('özel yer tutucu doğrulayıcısı kullanılır', () => {
  const compiled = compilePattern('%number%')
  assert.equal(
    matchPattern(compiled, 'abc', { placeholder: () => false }),
    null
  )
  assert.notEqual(
    matchPattern(compiled, '123', { placeholder: text => /^\d+$/.test(text) }),
    null
  )
})

test('nullable yer tutucu boş metni kabul eder', () => {
  const compiled = compilePattern('a %-objects% b')
  assert.notEqual(matchPattern(compiled, 'a  b'), null)
  const nullable = matchPattern(compiled, 'a b')
  assert.notEqual(nullable, null)
})

test('regex yakalanan metni ve konumunu raporlar', () => {
  const compiled = compilePattern('value <\\d+> end')
  const match = matchPattern(compiled, 'value 42 end')
  assert.equal(match?.regexes.length, 1)
  assert.deepEqual(match?.regexes[0], { text: '42', start: 6, end: 8 })
})

test('parse mark XOR ve tag sırası korunur', () => {
  const marks = compilePattern('(1¦one|2¦two)')
  assert.equal(matchPattern(marks, 'one')?.mark, 1)
  assert.equal(matchPattern(marks, 'two')?.mark, 2)

  const tagged = compilePattern('x:value')
  const match = matchPattern(tagged, 'value')
  assert.equal(match?.mark, 0)
  assert.deepEqual(match?.tags, ['x'])
})

test('patolojik girdide adım bütçesi devreye girer', () => {
  const compiled = compilePattern('%a% %b% %c% %d% %e% %f% son')
  const input = Array.from({ length: 40 }, (_, index) => `x${index}`).join(' ')
  const start = performance.now()
  const match = matchPattern(compiled, input, { maxSteps: 500 })
  const elapsed = performance.now() - start
  assert.equal(match, null)
  assert.ok(elapsed < 2000, `eşleştirme çok uzun sürdü: ${elapsed}ms`)
})
