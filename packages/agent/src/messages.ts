/** Sağlayıcıdan bağımsız konuşma biçimi. Her provider adaptörü kendi API biçimine bundan çevirir. */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  /** Sağlayıcının verdiği kimlik; sonuç bu kimlikle eşlenir. */
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  callId: string
  content: string
  isError?: boolean
}

/**
 * Sağlayıcıya özgü, bizim yorumlamadığımız blok (örn. Anthropic'in `thinking` blokları).
 * Aynı sağlayıcıya sonraki isteklerde aynen geri gönderilmeli; diğer sağlayıcılar yok sayar.
 */
export interface ProviderDataBlock {
  type: 'provider_data'
  /** Bloğu üreten katalog sağlayıcısı (`anthropic`, `minimax`…). */
  provider: string
  data: unknown
}

/**
 * Modelin düşünme (reasoning) metni; OpenAI uyumlu sağlayıcıların `reasoning_content` / `reasoning`
 * alanından gelir. Arayüzde gösterilir; yalnızca aynı sağlayıcıya ve aynı tur içinde geri gönderilir.
 */
export interface ReasoningBlock {
  type: 'reasoning'
  provider: string
  text: string
  /** Sağlayıcının kullandığı alan adı; geri gönderirken aynısı kullanılır. */
  field: 'reasoning_content' | 'reasoning'
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ProviderDataBlock | ReasoningBlock

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export function textMessage(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

export function toolCalls(message: Message): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === 'tool_call')
}
