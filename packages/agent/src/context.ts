/**
 * Bağlam penceresi yönetimi: konuşma pencereyi doldurmaya yaklaşınca eski tool sonuçlarının içeriği
 * kısa bir notla değiştirilir. Kısaltma öneki değiştirdiği için önbelleği bir kez geçersiz kılar; bu yüzden
 * her çağrıda değil, yalnızca eşik aşılınca ve hedefe kadar topluca yapılır.
 */
import type { Message } from './messages'
import { estimateTextTokens } from './usage'

/** Kısaltılan tool sonucunun yerine geçen metin. */
export const TRIMMED_RESULT = '[Earlier tool output removed to free up context. Run the tool again if you still need it.]'

export interface ContextLimits {
  /** Modelin bağlam penceresi (token). */
  window: number
  /** Pencerenin bu oranı aşılınca kısaltma başlar. */
  trimAt?: number
  /** Kısaltma, bağlam bu orana inene kadar sürer. */
  target?: number
  /** Son bu kadar tool sonucuna dokunulmaz; model az önce okuduğunu kaybetmesin. */
  keepRecent?: number
  /**
   * Kısaltmadan sonra bağlam hâlâ pencerenin bu oranını aşıyorsa geçmiş özetlenerek sıkıştırılır.
   * `1` (ya da üstü) sıkıştırmayı kapatır. Varsayılan 0.8.
   */
  compactAt?: number
}

const DEFAULT_TRIM_AT = 0.7
const DEFAULT_TARGET = 0.5
const DEFAULT_KEEP_RECENT = 6

export interface TrimResult {
  messages: Message[]
  /** Kısaltılan tool sonucu sayısı. */
  trimmed: number
  /** Kazanılan tahmini token. */
  saved: number
}

/**
 * `tokens` (şu anki bağlam boyu) eşiği aşıyorsa en eski tool sonuçlarından başlayarak kısaltır.
 * Eşik aşılmadıysa ya da kısaltılacak sonuç yoksa `null`. Girdi değiştirilmez.
 */
export function trimToolResults(messages: readonly Message[], tokens: number, limits: ContextLimits): TrimResult | null {
  const { window } = limits
  if (window <= 0 || tokens < window * (limits.trimAt ?? DEFAULT_TRIM_AT)) return null
  const goal = window * (limits.target ?? DEFAULT_TARGET)
  const stubTokens = estimateTextTokens(TRIMMED_RESULT)

  // Dokunulmayacak son sonuçlar
  let protectedCount = limits.keepRecent ?? DEFAULT_KEEP_RECENT
  const protectedFrom = new Map<number, number>()
  for (let i = messages.length - 1; i >= 0 && protectedCount > 0; i--) {
    const results = messages[i].content.filter((block) => block.type === 'tool_result').length
    if (results === 0) continue
    protectedFrom.set(i, Math.max(0, results - protectedCount))
    protectedCount -= Math.min(results, protectedCount)
  }

  const result = [...messages]
  let saved = 0
  let trimmed = 0
  for (let i = 0; i < result.length && tokens - saved > goal; i++) {
    const message = result[i]
    let resultIndex = 0
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      const index = resultIndex++
      const limit = protectedFrom.get(i)
      if (limit !== undefined && index >= limit) return block
      if (tokens - saved <= goal || block.content === TRIMMED_RESULT) return block
      const gain = estimateTextTokens(block.content) - stubTokens
      if (gain <= 0) return block
      saved += gain
      trimmed++
      changed = true
      return { ...block, content: TRIMMED_RESULT }
    })
    if (changed) result[i] = { ...message, content }
  }
  return trimmed > 0 ? { messages: result, trimmed, saved } : null
}
