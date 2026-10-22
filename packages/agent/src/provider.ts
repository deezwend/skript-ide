import type { ContentBlock, Message } from './messages'
import type { ToolDefinition } from './registry'

export interface ModelRequest {
  system: string
  messages: readonly Message[]
  tools: readonly ToolDefinition[]
  signal: AbortSignal
}

export interface ModelResponse {
  /** Yalnızca `text` ve `tool_call` blokları. */
  content: ContentBlock[]
  /** `tool_use`: model tool sonucu bekliyor; `end`: tur bitti; `max_tokens`: yanıt kesildi. */
  stopReason: 'end' | 'tool_use' | 'max_tokens'
}

/** LLM sağlayıcısı adaptörü (Anthropic, OpenAI, yerel model…). Döngü yalnızca bunu bilir. */
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>
}
