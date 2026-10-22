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

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock

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
