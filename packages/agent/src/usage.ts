/**
 * Token kullanımının muhasebesi: fiyatlama, önbellek isabetsizliği ve bağlam boyu tahmini.
 * Sağlayıcı adaptörleri yalnızca ham `TokenUsage` üretir; fiyat ve yorum burada devreye girer.
 */
import type { Message } from './messages'
import type { TokenUsage } from './provider'

/** 1M token başına USD; katalogdaki `CatalogModel['cost']` ile aynı biçim. */
export interface PriceRates {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Bir çağrının USD cinsinden fiyat dökümü. */
export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/**
 * Çağrının maliyeti. Anthropic'te 1 saatlik önbellek yazımı iki katı girdi fiyatıyla ücretlenir;
 * `cacheRead`/`cacheWrite` fiyatı katalogda yoksa girdi fiyatına düşülür. Fiyat yoksa `null`.
 */
export function calculateCost(tokens: TokenUsage, price: PriceRates | undefined): UsageCost | null {
  if (!price) return null
  // 1h dilimi `cacheWrite`'ın içindedir; katalog dışı bir sayı gelirse yazmayı aşamaz
  const longWrite = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite)
  const shortWrite = tokens.cacheWrite - longWrite
  const cost = {
    input: (tokens.input * price.input) / 1_000_000,
    output: (tokens.output * price.output) / 1_000_000,
    cacheRead: (tokens.cacheRead * (price.cacheRead ?? price.input)) / 1_000_000,
    cacheWrite: (shortWrite * (price.cacheWrite ?? price.input) + longWrite * price.input * 2) / 1_000_000
  }
  return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }
}

/** İsteğin bağlamı dolduran girdi hacmi: önbellekten okunan ve önbelleğe yazılan dahil. */
export function promptTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite
}

/** Oturumdaki tek bir model çağrısı; diskte saklanır. */
export interface CallUsage {
  /** Çağrının bittiği an (ms). */
  at: number
  providerId: string
  modelId: string
  /** Çağrının ait olduğu tur: o sırada gönderilmiş kullanıcı metin mesajı sayısı. `/undo` bununla kırpar. */
  turn: number
  tokens: TokenUsage
  /** Fiyat katalogda yoksa `null`. */
  cost: UsageCost | null
}

/** Tek bir turda önbellek isabetsizliği. */
export interface CacheMiss {
  /** Önceki turun isteminde olup bu turda önbellekten okunmayan token'lar. */
  missedTokens: number
  /** Önbellek isabeti yerine ödenen fazla USD; fiyat bilinmiyorsa 0. */
  missedCost: number
  /** Önceki çağrıdan bu yana geçen süre (ms). */
  idleMs: number
  /** Model ya da sağlayıcı değişti mi. */
  modelChanged: boolean
}

export interface CacheWaste {
  missedTokens: number
  missedCost: number
  /** Sayılan miss sayısı (gürültü eşiğini geçenler). */
  missCount: number
  /** Çağrı nesnesine göre miss; transkript yeniden kurulurken kullanılır. */
  misses: Map<CallUsage, CacheMiss>
}

/** Bunun altındaki farklar önbellek işaretlerinin granülaritesidir, miss sayılmaz. */
export const CACHE_NOISE_FLOOR_TOKENS = 1024

/**
 * Çağrıları sırayla tarar ve "önceki istemde olup bu turda önbellekten okunmayan" token'ları toplar.
 *
 * Önbellek aktivitesi hiç raporlanmayan sağlayıcılarda sayım yapılmaz: `reportedCache` bir kez
 * görüldükten sonra yapışkan kalır, böylece "tam miss" ile "bu sağlayıcı önbelleği hiç bildirmiyor"
 * ayırt edilir. Model değişimi muaf değildir: istem baştan faturalanır, miss sayılır.
 */
export function scanCacheMisses(
  calls: readonly CallUsage[],
  priceOf: (call: CallUsage) => PriceRates | undefined
): CacheWaste {
  const misses = new Map<CallUsage, CacheMiss>()
  let missedTokens = 0
  let missedCost = 0
  let reportedCache = false
  let previous: CallUsage | undefined
  for (const call of calls) {
    const miss = detectMiss(previous, call, reportedCache, priceOf(call))
    if (miss) {
      misses.set(call, miss)
      missedTokens += miss.missedTokens
      missedCost += miss.missedCost
    }
    reportedCache ||= call.tokens.cacheRead + call.tokens.cacheWrite > 0
    previous = call
  }
  return { missedTokens, missedCost, missCount: misses.size, misses }
}

function detectMiss(
  previous: CallUsage | undefined,
  call: CallUsage,
  reportedCache: boolean,
  price: PriceRates | undefined
): CacheMiss | undefined {
  const { tokens } = call
  const prompt = promptTokens(tokens)
  if (!previous || prompt <= 0) return undefined
  if (tokens.cacheRead + tokens.cacheWrite === 0 && !reportedCache) return undefined

  // Önceki istemde olan her token bu turda önbellekten okunmalıydı; istem küçüldüyse fazlası sayılmaz
  const missedTokens = Math.min(promptTokens(previous.tokens), prompt) - tokens.cacheRead
  if (missedTokens <= CACHE_NOISE_FLOOR_TOKENS) return undefined

  const rates = perTokenRates(call, price)
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, rates.paid - rates.read),
    idleMs: Math.max(0, call.at - previous.at),
    modelChanged: `${call.providerId}/${call.modelId}` !== `${previous.providerId}/${previous.modelId}`
  }
}

/**
 * Token başına ödenen ve önbellekten okumanın gerçek fiyatı. Ödenen tutar çağrının kendi
 * dökümünden gelir; okuma oranı bu çağrıda cache-read yoksa katalogdan alınır.
 */
function perTokenRates(call: CallUsage, price: PriceRates | undefined): { paid: number; read: number } {
  const { tokens, cost } = call
  const paidTokens = tokens.input + tokens.cacheWrite
  const paid = paidTokens > 0 && cost ? (cost.input + cost.cacheWrite) / paidTokens : 0
  const read =
    tokens.cacheRead > 0 && cost
      ? cost.cacheRead / tokens.cacheRead
      : (price?.cacheRead ?? price?.input ?? 0) / 1_000_000
  return { paid, read }
}

const CHARS_PER_TOKEN = 3.5
/** Görsel başına kaba tahmin; sağlayıcılar ~1568 px'e küçültülmüş bir görseli bu civarda sayar. */
const IMAGE_TOKENS = 1600

/** Kaba token tahmini; yalnızca bağlam yüzdesi için, faturaya girmez. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        chars += block.text.length
        break
      case 'tool_result':
        chars += block.content.length
        break
      case 'tool_call':
        chars += block.name.length + jsonLength(block.input)
        break
      case 'provider_data':
        chars += jsonLength(block.data)
        break
      case 'image':
        chars += IMAGE_TOKENS * CHARS_PER_TOKEN
        break
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Bağlam boyu: son çağrının sağlayıcıdan gelen kesin hacmi (girdi + önbellek + çıktı) ve ondan
 * sonra eklenen mesajların tahmini. `messages` son çağrıdan sonraki asistan mesajını da içerir;
 * onun token'ları `output` içinde olduğu için yalnızca sonrası sayılır.
 */
export function estimateContextTokens(messages: readonly Message[], lastCall?: CallUsage): number {
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant')
  const trailing = lastAssistant < 0 ? messages : messages.slice(lastAssistant + 1)
  const used = lastCall ? promptTokens(lastCall.tokens) + lastCall.tokens.output : 0
  let estimated = 0
  for (const message of trailing) estimated += estimateMessageTokens(message)
  return used + estimated
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}
