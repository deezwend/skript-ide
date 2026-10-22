import { compactMessages } from './compaction'
import { changesDiffStat } from './diff-stat'
import { trimToolResults, type ContextLimits } from './context'
import { DEFAULT_PERMISSION_MODE, needsApproval, type PermissionMode } from './permission'
import { toolCalls, type Message, type ToolCallBlock, type ToolResultBlock } from './messages'
import type { ModelProvider, ModelResponse, StreamDelta, TokenUsage } from './provider'
import { validateInput, type ToolRegistry } from './registry'
import { ToolError, type FileChange, type ToolContext } from './tool'
import { estimateMessageTokens, estimateTextTokens, promptTokens } from './usage'

/** Arayüze aktarılan olaylar; IPC üzerinden tek bir kanaldan akıtılmak üzere tasarlandı. */
export type AgentEvent =
  /** Model yanıtı akarken gelen parça; ardından aynı yanıt `assistant-message` olarak tam gelir. */
  | { type: 'delta'; delta: StreamDelta }
  | { type: 'assistant-message'; message: Message }
  /** Bir model çağrısının token kullanımı (sağlayıcı bildirdiyse). */
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'tool-start'; call: ToolCallBlock }
  | { type: 'tool-result'; call: ToolCallBlock; result: ToolResultBlock }
  /** Bağlam dolmaya yaklaştığı için eski tool sonuçları kısaltıldı; `messages` artık kısaltılmış geçmiştir. */
  | { type: 'context-trimmed'; trimmed: number; messages: Message[] }
  /**
   * Kısaltma yetmediği için geçmişin eski kısmı özetlendi; `messages` artık özet + kuyruktan oluşur.
   * `summarizedMessages`: özete dönüşen mesaj sayısı (yeni geçmişteki özet mesajı hariç).
   */
  | { type: 'context-compacted'; messages: Message[]; summarizedMessages: number }
  | { type: 'done'; reason: AgentStopReason }

/** `context_full`: kısaltmaya rağmen geçmiş bağlam penceresine sığmıyor. */
export type AgentStopReason = 'end' | 'max_tokens' | 'max_turns' | 'refusal' | 'context_full'

export interface RunAgentOptions {
  provider: ModelProvider
  registry: ToolRegistry
  context: ToolContext
  system: string
  /** Önceki konuşma + yeni kullanıcı mesajı. Değiştirilmez; sonuç yeni dizi olarak döner. */
  messages: readonly Message[]
  /** İsteğe bağlı üst sınır (model çağrısı sayısı). Varsayılan sınırsız; durdurmak için signal kullanılır. */
  maxTurns?: number
  /** Her tool çağrısında okunur; çalışma sırasında değiştirilen mod bir sonraki çağrıdan itibaren geçerli olur. */
  permissionMode?: () => PermissionMode
  /**
   * Verilirse bağlam dolmaya yaklaşınca eski tool sonuçları kısaltılır, yetmezse geçmiş özetlenir;
   * özetleme de yetmezse tur `context_full` ile durur.
   */
  contextLimits?: ContextLimits & {
    /** İlk çağrıdan önceki bağlam boyu (önceki çağrının kesin kullanımından); yoksa tahmin edilir. */
    initialTokens?: number
  }
  onEvent?: (event: AgentEvent) => void
}

export interface RunAgentResult {
  messages: Message[]
  reason: AgentStopReason
}

const DEFAULT_MAX_TURNS = Infinity
/** Kısaltmadan sonra bağlam bu oranı aşıyorsa geçmiş özetlenir. */
const DEFAULT_COMPACT_AT = 0.8
/** Bir yanıttaki okuma çağrılarının aynı anda çalışabileceği üst sınır. */
const PARALLEL_TOOL_LIMIT = 8

/**
 * Agent döngüsü: modeli çağırır, istediği tool'ları çalıştırır (onaysız okumalar eşzamanlı, gerisi
 * sırayla), sonuçları geri verir; model tool istemeyi bırakana kadar sürer. Bağlam dolmaya
 * yaklaşınca önce eski tool çıktıları kısaltılır, yetmezse geçmiş özetlenir. İptal `context.signal`
 * ile yapılır ve `AbortError` fırlatır.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, registry, context, system, onEvent } = options
  const permissionMode = options.permissionMode ?? (() => DEFAULT_PERMISSION_MODE)
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const messages = [...options.messages]
  const tools = registry.definitions()
  const limits = options.contextLimits
  const overhead = estimateTextTokens(system) + estimateTextTokens(JSON.stringify(tools))
  // Son çağrının sağlayıcıdan gelen kesin bağlam boyu ve o anki geçmiş uzunluğu; sonrası tahmin edilir
  let measured: { tokens: number; length: number } | null =
    limits?.initialTokens !== undefined ? { tokens: limits.initialTokens, length: messages.length } : null
  const contextTokens = () => {
    const since = measured ? messages.slice(measured.length) : messages
    let tokens = measured ? measured.tokens : overhead
    for (const message of since) tokens += estimateMessageTokens(message)
    return tokens
  }

  const finish = (reason: AgentStopReason): RunAgentResult => {
    onEvent?.({ type: 'done', reason })
    return { messages, reason }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    context.signal.throwIfAborted()
    if (limits && limits.window > 0) {
      const trim = trimToolResults(messages, contextTokens(), limits)
      if (trim) {
        messages.splice(0, messages.length, ...trim.messages)
        // Önek değişti; kesin ölçüm artık geçersiz
        measured = null
        onEvent?.({ type: 'context-trimmed', trimmed: trim.trimmed, messages: [...messages] })
      }
      // Kısaltma yetmediyse eski geçmişi özetlet; başarısız olursa eski davranış (context_full) geçerli
      const compactAt = limits.compactAt ?? DEFAULT_COMPACT_AT
      if (compactAt < 1 && contextTokens() > limits.window * compactAt) {
        try {
          const compacted = await compactMessages(provider, messages, {
            signal: context.signal,
            onUsage: (usage) => onEvent?.({ type: 'usage', usage })
          })
          if (compacted) {
            messages.splice(0, messages.length, ...compacted.messages)
            measured = null
            onEvent?.({ type: 'context-compacted', messages: [...messages], summarizedMessages: compacted.summarized })
          }
        } catch (error) {
          // İptal döngüyü durdurur; diğer hatalarda kısaltılmış geçmişle devam edilir
          if (context.signal.aborted) throw error
        }
      }
      if (contextTokens() > limits.window * 0.95) return finish('context_full')
    }
    const response: ModelResponse = await provider.complete({
      system,
      messages,
      tools,
      signal: context.signal,
      onDelta: onEvent ? (delta) => onEvent({ type: 'delta', delta }) : undefined
    })
    if (response.usage) onEvent?.({ type: 'usage', usage: response.usage })
    context.signal.throwIfAborted()

    // Kesilen yanıttaki tool çağrılarının girdisi eksik olabilir; çalıştırılmaz ve geçmişe de
    // sonuçsuz tool çağrısı bırakılmaz (sonraki istekte sağlayıcı bunu reddeder)
    const content =
      response.stopReason === 'max_tokens'
        ? response.content.filter((block) => block.type !== 'tool_call')
        : response.content
    const assistant: Message = { role: 'assistant', content }
    messages.push(assistant)
    if (response.usage) measured = { tokens: promptTokens(response.usage) + response.usage.output, length: messages.length }
    onEvent?.({ type: 'assistant-message', message: assistant })

    if (response.stopReason === 'max_tokens' || response.stopReason === 'refusal') {
      return finish(response.stopReason)
    }
    const calls = toolCalls(assistant)
    if (calls.length === 0) return finish('end')

    const results = await runToolCalls(calls, registry, context, permissionMode, onEvent)
    messages.push({ role: 'user', content: results })
  }

  return finish('max_turns')
}

/**
 * Bir yanıttaki tool çağrılarını çalıştırır. Onay gerektirmeyen okuma çağrıları art arda geldiğinde
 * eşzamanlı (en fazla `PARALLEL_TOOL_LIMIT`), diğerleri bariyer gibi sırayla çalışır. Sonuçlar her
 * zaman çağrı sırasıyla döner.
 */
async function runToolCalls(
  calls: readonly ToolCallBlock[],
  registry: ToolRegistry,
  context: ToolContext,
  mode: () => PermissionMode,
  onEvent?: (event: AgentEvent) => void
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = []
  let index = 0
  while (index < calls.length) {
    context.signal.throwIfAborted()
    if (!runsInParallel(registry, calls[index], mode())) {
      const call = calls[index++]
      onEvent?.({ type: 'tool-start', call })
      const result = await runToolCall(registry, context, call, mode)
      results.push(result)
      onEvent?.({ type: 'tool-result', call, result })
      continue
    }
    const group: ToolCallBlock[] = []
    while (index < calls.length && group.length < PARALLEL_TOOL_LIMIT && runsInParallel(registry, calls[index], mode())) {
      group.push(calls[index++])
    }
    for (const call of group) onEvent?.({ type: 'tool-start', call })
    const settled = await Promise.all(
      group.map(async (call) => {
        const result = await runToolCall(registry, context, call, mode)
        onEvent?.({ type: 'tool-result', call, result })
        return result
      })
    )
    context.signal.throwIfAborted()
    results.push(...settled)
  }
  return results
}

/** Onay gerektirmeyen, bilinen ve girdisi geçerli çağrı eşzamanlı gruba girebilir. */
function runsInParallel(registry: ToolRegistry, call: ToolCallBlock, mode: PermissionMode): boolean {
  const tool = registry.get(call.name)
  if (!tool) return false
  if (validateInput(tool.inputSchema, call.input)) return false
  return !needsApproval(mode, tool.permission)
}

async function runToolCall(
  registry: ToolRegistry,
  context: ToolContext,
  call: ToolCallBlock,
  mode: () => PermissionMode
): Promise<ToolResultBlock> {
  const fail = (content: string): ToolResultBlock => ({ type: 'tool_result', callId: call.id, content, isError: true })

  const tool = registry.get(call.name)
  if (!tool) return fail(`Unknown tool: ${call.name}`)

  const problem = validateInput(tool.inputSchema, call.input)
  if (problem) return fail(`Invalid input: ${problem}`)

  try {
    if (needsApproval(mode(), tool.permission)) {
      const preview = tool.preview
        ? await tool.preview(call.input, context)
        : { summary: `${tool.name} ${JSON.stringify(call.input)}` }
      const approved = await context.requestApproval({ tool: tool.name, input: call.input, ...preview })
      if (!approved) return fail('The user rejected this action.')
    }
    // Arayüzdeki +eklenen -silinen sayısı için bu çağrının yazdığı dosyalar toplanır
    const changes: FileChange[] = []
    const callContext: ToolContext = {
      ...context,
      onFilesChanged: (changed) => {
        changes.push(...changed)
        context.onFilesChanged?.(changed)
      }
    }
    const content = await tool.execute(call.input, callContext)
    const result: ToolResultBlock = { type: 'tool_result', callId: call.id, content }
    if (changes.length > 0) result.diff = changesDiffStat(changes)
    return result
  } catch (error) {
    // İptal döngüyü durdurmalı, LLM'e hata olarak gitmemeli
    if (context.signal.aborted) throw error
    if (error instanceof ToolError) return fail(error.message)
    return fail(`Tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
