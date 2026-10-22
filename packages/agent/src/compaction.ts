/**
 * Bağlam sıkıştırma: kısaltma (context.ts) yetmediğinde konuşmanın eski kısmı aynı sağlayıcıya
 * ayrı bir çağrıyla özetletilir. Özet, geçmişin başına tek bir `user` mesajı olarak girer; böylece
 * sağlayıcıların rol sırası kuralları bozulmaz ve önceki önek önbellekte kalır.
 */
import { goalText, latestGoal } from './goal'
import type { Message } from './messages'
import type { ModelProvider, TokenUsage } from './provider'

const SUMMARY_PATTERN = /^<conversation_summary>\n([\s\S]*)\n<\/conversation_summary>$/

/** Özetleme çağrısının sistem istemi; araç kullanmaz, yalnızca metin üretir. */
export const COMPACTION_SYSTEM = [
  'You compress a long conversation between a user and an AI coding assistant so that work can continue in a smaller context window.',
  'Write plain text. Keep the language the conversation uses.',
  'Preserve, in this order: what the user asked for and their goals; decisions made and why; files created or changed and why; known errors, failing tests and open work; exact file paths, symbol names, commands and error messages.',
  'Do not invent anything, do not give advice and do not add commentary.'
].join('\n')

const COMPACTION_REQUEST =
  'Summarize the conversation above. Keep the summary under 800 words and make it dense enough that work can continue without the original messages.'

const DEFAULT_KEEP_RECENT = 8

export interface CompactionOptions {
  signal: AbortSignal
  /** Son bu kadar mesaj özetlenmez; son kullanıcı mesajı ve sonrası her durumda korunur. */
  keepRecent?: number
  /** Özetleme çağrısının token kullanımı; sağlayıcı bildirdiyse. */
  onUsage?: (usage: TokenUsage) => void
}

export interface CompactionResult {
  /** Özet mesajı + özetlenmeyen kuyruk. */
  messages: Message[]
  /** Özetlenen mesaj sayısı (yeni geçmişin başındaki özet hariç). */
  summarized: number
  summary: string
  usage?: TokenUsage
}

/** Metin bloğu bir konuşma özeti mi? Arayüz bu blokları sohbet balonunda göstermez. */
export function isConversationSummary(text: string): boolean {
  return SUMMARY_PATTERN.test(text)
}

/**
 * Eski geçmişi özetler. Özetlenecek bir şey yoksa (yalnızca son kullanıcı mesajı ve sonrası varsa)
 * `null` döner. Sağlayıcı hatası ve iptal olduğu gibi yukarı fırlatılır; çağıran eski davranışa düşer.
 */
export async function compactMessages(
  provider: ModelProvider,
  messages: readonly Message[],
  options: CompactionOptions
): Promise<CompactionResult | null> {
  const keepRecent = Math.max(1, options.keepRecent ?? DEFAULT_KEEP_RECENT)
  const cut = compactionCut(messages, keepRecent)
  if (cut <= 0) return null
  const summarized = messages.slice(0, cut)
  const transcript = serialize(summarized)
  if (!transcript.trim()) return null

  const goal = latestGoal(messages)
  const response = await provider.complete({
    system: COMPACTION_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${transcript}\n\n${COMPACTION_REQUEST}` }] }],
    tools: [],
    signal: options.signal
  })
  if (response.usage) options.onUsage?.(response.usage)
  const summary = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  if (!summary) throw new Error('The summarization response was empty.')

  const text = [`<conversation_summary>`, summary, `</conversation_summary>`].join('\n')
  const content: Message['content'] = [{ type: 'text', text }]
  // Hedef kaybolmasın: özet mesajının içinde aynı blok korunur, `latestGoal` onu bulmaya devam eder
  if (goal !== null) content.push({ type: 'text', text: goalText(goal) })
  const summaryMessage: Message = { role: 'user', content }
  return { messages: [summaryMessage, ...messages.slice(cut)], summarized: cut, summary, ...(response.usage ? { usage: response.usage } : {}) }
}

/**
 * Özetlenmeyen kuyruğun başlangıcı. Son kullanıcı mesajı ve sonrası her zaman korunur; ayrıca son
 * `keepRecent` mesaja dokunulmaz. Kesim, bir tool çağrısı ile sonucunu asla ayırmaz.
 */
function compactionCut(messages: readonly Message[], keepRecent: number): number {
  const lastUser = messages.findLastIndex(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'text')
  )
  if (lastUser <= 0) return 0
  let cut = Math.min(lastUser, Math.max(0, messages.length - keepRecent))
  // Kuyruk tool sonucuyla başlıyorsa çağrısı da kuyrukta kalsın
  while (cut > 0 && messages[cut].content.some((block) => block.type === 'tool_result')) cut--
  return cut
}

/** Özetlenecek geçmişi modele verilecek düz metne çevirir; tool çiftleri adlarıyla görünür. */
function serialize(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    const who = message.role === 'user' ? 'User' : 'Assistant'
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) parts.push(`${who}: ${block.text}`)
          break
        case 'image':
          parts.push(`${who}: [image]`)
          break
        case 'tool_call':
          parts.push(`Assistant called ${block.name} with ${json(block.input)}`)
          break
        case 'tool_result':
          parts.push(`Tool result${block.isError ? ' (error)' : ''}: ${block.content}`)
          break
        case 'reasoning':
        case 'provider_data':
          break
      }
    }
  }
  return parts.join('\n\n')
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
