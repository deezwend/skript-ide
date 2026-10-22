import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCost,
  estimateContextTokens,
  promptTokens,
  scanCacheMisses,
  type CallUsage,
  type PriceRates,
  type TokenUsage
} from '../src/index'

// Anthropic Sonnet sınıfı fiyatlar: 1M token başına USD
const PRICE: PriceRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

function usage(tokens: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...tokens }
}

function call(at: number, tokens: Partial<TokenUsage>, overrides: Partial<CallUsage> = {}): CallUsage {
  const full = usage(tokens)
  return {
    at,
    providerId: 'anthropic',
    modelId: 'claude-sonnet',
    turn: 1,
    tokens: full,
    cost: calculateCost(full, PRICE),
    ...overrides
  }
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`)
}

test('calculateCost: token türlerini ayrı fiyatlar', () => {
  const cost = calculateCost(usage({ input: 1000, cacheRead: 5000, cacheWrite: 2000, output: 500 }), PRICE)
  assert.ok(cost)
  close(cost.input, 0.003)
  close(cost.output, 0.0075)
  close(cost.cacheRead, 0.0015)
  close(cost.cacheWrite, 0.0075)
  close(cost.total, 0.0195)
})

test('calculateCost: 1 saatlik önbellek yazımı iki katı girdi fiyatıyla ücretlenir', () => {
  const cost = calculateCost(usage({ cacheWrite: 2000, cacheWrite1h: 1000 }), PRICE)
  assert.ok(cost)
  // 1000 token 5 dakikalık (3.75) + 1000 token 1 saatlik (3 × 2)
  close(cost.cacheWrite, 0.00375 + 0.006)
})

test('calculateCost: fiyatı olmayan dilim girdi fiyatına düşer', () => {
  const cost = calculateCost(usage({ cacheRead: 1000, cacheWrite: 1000 }), { input: 2, output: 10 })
  assert.ok(cost)
  close(cost.cacheRead, 0.002)
  close(cost.cacheWrite, 0.002)
})

test('calculateCost: 1h dilimi yazmayı aşamaz, fiyat yoksa null', () => {
  const cost = calculateCost(usage({ cacheWrite: 100, cacheWrite1h: 900 }), PRICE)
  assert.ok(cost)
  close(cost.cacheWrite, (100 * 3 * 2) / 1_000_000)
  assert.equal(calculateCost(usage({ input: 10 }), undefined), null)
})

test('scanCacheMisses: önbelleği okuyan sağlıklı turlarda hiçbir şey saymaz', () => {
  const calls = [
    call(1_000, { input: 2_000, cacheWrite: 10_000, output: 100 }),
    call(2_000, { input: 1_500, cacheRead: 12_000, output: 100 }),
    call(3_000, { input: 800, cacheRead: 13_500, output: 100 })
  ]
  const waste = scanCacheMisses(calls, () => PRICE)
  assert.equal(waste.missCount, 0)
  assert.equal(waste.missedTokens, 0)
  assert.equal(waste.missedCost, 0)
})

test('scanCacheMisses: ilk turda ve tek çağrıda miss aranmaz', () => {
  assert.equal(scanCacheMisses([], () => PRICE).missCount, 0)
  const waste = scanCacheMisses([call(1_000, { input: 5_000, cacheWrite: 5_000 })], () => PRICE)
  assert.equal(waste.missCount, 0)
})

test('scanCacheMisses: önceki istemin tamamı yeniden faturalanırsa miss sayar', () => {
  const previous = call(1_000, { input: 2_000, cacheWrite: 10_000 })
  // 7 dakika sonra: önbellek düşmüş, istem baştan faturalanmış
  const missed = call(1_000 + 7 * 60_000, { input: 12_500 }, { turn: 2 })
  const waste = scanCacheMisses([previous, missed], () => PRICE)

  assert.equal(waste.missCount, 1)
  assert.equal(waste.missedTokens, 12_000)
  const miss = waste.misses.get(missed)
  assert.ok(miss)
  assert.equal(miss.idleMs, 7 * 60_000)
  assert.equal(miss.modelChanged, false)
  // 12k token, 3 $ yerine 0.3 $ önbellek fiyatıyla okunacağı için fazladan ~$0.0324
  close(miss.missedCost, (12_000 * (3 - 0.3)) / 1_000_000)
})

test('scanCacheMisses: önbellek raporlamayan sağlayıcıda yanlış alarm vermez', () => {
  const calls = [call(1_000, { input: 5_000 }), call(2_000, { input: 6_000 }, { turn: 2 })]
  const waste = scanCacheMisses(calls, () => PRICE)
  assert.equal(waste.missCount, 0)
})

test('scanCacheMisses: gürültü eşiğinin altındaki farkı saymaz', () => {
  const previous = call(1_000, { input: 5_000, cacheWrite: 5_000 })
  const tiny = call(2_000, { input: 100, cacheRead: 9_500 }, { turn: 2 })
  assert.equal(scanCacheMisses([previous, tiny], () => PRICE).missCount, 0)

  // aynı fark eşiğin üstüne çıkınca sayılır
  const above = call(2_000, { input: 1_300, cacheRead: 8_000 }, { turn: 2 })
  assert.equal(scanCacheMisses([previous, above], () => PRICE).missCount, 1)
})

test('scanCacheMisses: model değişimini miss olarak işaretler', () => {
  const previous = call(1_000, { input: 2_000, cacheWrite: 10_000 })
  const switched = call(2_000, { input: 14_000 }, { modelId: 'claude-opus', turn: 2 })
  const waste = scanCacheMisses([previous, switched], () => PRICE)
  const miss = waste.misses.get(switched)
  assert.ok(miss)
  assert.equal(miss.modelChanged, true)
  assert.equal(miss.missedTokens, 12_000)
})

test('scanCacheMisses: istem küçüldüğünde yalnızca yeni istem kadarı sayılır', () => {
  const previous = call(1_000, { input: 2_000, cacheWrite: 18_000 })
  const shrunk = call(2_000, { input: 8_000 }, { turn: 2 })
  const miss = scanCacheMisses([previous, shrunk], () => PRICE).misses.get(shrunk)
  assert.ok(miss)
  assert.equal(miss.missedTokens, 8_000)
})

test('scanCacheMisses: fiyat bilinmiyorsa token sayılır, maliyet 0 kalır', () => {
  const previous = call(1_000, { input: 2_000, cacheWrite: 10_000 }, { cost: null })
  const missed = call(2_000, { input: 12_500 }, { cost: null, turn: 2 })
  const miss = scanCacheMisses([previous, missed], () => undefined).misses.get(missed)
  assert.ok(miss)
  assert.equal(miss.missedTokens, 12_000)
  assert.equal(miss.missedCost, 0)
})

test('promptTokens: önbellekli ve önbelleksiz girdiyi toplar', () => {
  assert.equal(promptTokens(usage({ input: 100, cacheRead: 50, cacheWrite: 25 })), 175)
})

test('estimateContextTokens: son çağrının hacmi + sonrasındaki mesajlar', () => {
  const messages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(1_400) }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'tamam' }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, callId: 'c1', content: 'y'.repeat(700) }] }
  ]
  const lastCall = call(1_000, { input: 1_000, output: 50 })
  // 1_000 girdi + 50 çıktı + ~200 token tool sonucu
  assert.equal(estimateContextTokens(messages, lastCall), 1_250)
})

test('estimateContextTokens: geçmiş yoksa mesajları tahmin eder', () => {
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'z'.repeat(3_500) }] }]
  assert.equal(estimateContextTokens(messages), 1_000)
})
