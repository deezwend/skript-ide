import { toolCalls, type Message, type ToolCallBlock, type ToolResultBlock } from './messages'
import type { ModelProvider, ModelResponse } from './provider'
import { validateInput, type ToolRegistry } from './registry'
import { ToolError, type ToolContext } from './tool'

/** Arayüze aktarılan olaylar; IPC üzerinden tek bir kanaldan akıtılmak üzere tasarlandı. */
export type AgentEvent =
  | { type: 'assistant-message'; message: Message }
  | { type: 'tool-start'; call: ToolCallBlock }
  | { type: 'tool-result'; call: ToolCallBlock; result: ToolResultBlock }
  | { type: 'done'; reason: AgentStopReason }

export type AgentStopReason = 'end' | 'max_tokens' | 'max_turns'

export interface RunAgentOptions {
  provider: ModelProvider
  registry: ToolRegistry
  context: ToolContext
  system: string
  /** Önceki konuşma + yeni kullanıcı mesajı. Değiştirilmez; sonuç yeni dizi olarak döner. */
  messages: readonly Message[]
  /** Sonsuz tool döngüsüne karşı üst sınır (model çağrısı sayısı). */
  maxTurns?: number
  onEvent?: (event: AgentEvent) => void
}

export interface RunAgentResult {
  messages: Message[]
  reason: AgentStopReason
}

const DEFAULT_MAX_TURNS = 25

/**
 * Agent döngüsü: modeli çağırır, istediği tool'ları sırayla çalıştırır, sonuçları geri verir;
 * model tool istemeyi bırakana kadar sürer. İptal `context.signal` ile yapılır ve `AbortError` fırlatır.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, registry, context, system, onEvent } = options
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const messages = [...options.messages]
  const tools = registry.definitions()

  const finish = (reason: AgentStopReason): RunAgentResult => {
    onEvent?.({ type: 'done', reason })
    return { messages, reason }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    context.signal.throwIfAborted()
    const response: ModelResponse = await provider.complete({
      system,
      messages,
      tools,
      signal: context.signal
    })
    context.signal.throwIfAborted()

    const assistant: Message = { role: 'assistant', content: response.content }
    messages.push(assistant)
    onEvent?.({ type: 'assistant-message', message: assistant })

    const calls = toolCalls(assistant)
    if (calls.length === 0) return finish(response.stopReason === 'max_tokens' ? 'max_tokens' : 'end')

    const results: ToolResultBlock[] = []
    for (const call of calls) {
      context.signal.throwIfAborted()
      onEvent?.({ type: 'tool-start', call })
      const result = await runToolCall(registry, context, call)
      results.push(result)
      onEvent?.({ type: 'tool-result', call, result })
    }
    messages.push({ role: 'user', content: results })
  }

  return finish('max_turns')
}

async function runToolCall(
  registry: ToolRegistry,
  context: ToolContext,
  call: ToolCallBlock
): Promise<ToolResultBlock> {
  const fail = (content: string): ToolResultBlock => ({ type: 'tool_result', callId: call.id, content, isError: true })

  const tool = registry.get(call.name)
  if (!tool) return fail(`Unknown tool: ${call.name}`)

  const problem = validateInput(tool.inputSchema, call.input)
  if (problem) return fail(`Invalid input: ${problem}`)

  try {
    if (tool.permission !== 'read') {
      const preview = tool.preview
        ? await tool.preview(call.input, context)
        : { summary: `${tool.name} ${JSON.stringify(call.input)}` }
      const approved = await context.requestApproval({ tool: tool.name, input: call.input, ...preview })
      if (!approved) return fail('The user rejected this action.')
    }
    const content = await tool.execute(call.input, context)
    return { type: 'tool_result', callId: call.id, content }
  } catch (error) {
    // İptal döngüyü durdurmalı, LLM'e hata olarak gitmemeli
    if (context.signal.aborted) throw error
    if (error instanceof ToolError) return fail(error.message)
    return fail(`Tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
