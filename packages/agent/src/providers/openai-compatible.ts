import { imageDataUrl, type ContentBlock, type Message, type ReasoningBlock } from '../messages'
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type StreamDelta, type TokenUsage } from '../provider'

export interface OpenAICompatibleProviderOptions {
  providerId: string
  /** Yerel sunucularda (LM Studio vb.) boş olabilir. */
  apiKey: string
  /** Örn. `https://api.openai.com/v1`; sonuna `/chat/completions` eklenir. */
  baseURL: string
  model: string
  maxTokens: number
  /** `reasoning_effort` olarak gönderilir; yalnızca kullanıcı seçtiyse. */
  effort?: string
  fetch?: typeof fetch
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Görsel içeren kullanıcı mesajında parça listesi. */
  content: string | null | ChatContentPart[]
  reasoning_content?: string
  reasoning?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** OpenAI biçimli `usage`; DeepSeek önbellek sayılarını kendi alanlarıyla da verir. */
interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  cached_tokens?: number
}

interface ChatCompletion {
  usage?: ChatUsage | null
  choices?: {
    finish_reason?: string | null
    message?: {
      content?: string | null
      /** DeepSeek, Moonshot, Qwen… */
      reasoning_content?: string | null
      /** OpenRouter, Groq, Ollama… */
      reasoning?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

/** Akıştaki tek bir `data:` parçası. */
interface ChatCompletionChunk {
  usage?: ChatUsage | null
  error?: { message?: string } | string
  choices?: {
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

/**
 * OpenAI Chat Completions biçimini konuşan sağlayıcılar (OpenAI, OpenRouter, DeepSeek, Groq, LM Studio…)
 * için adaptör. Bağımlılık eklememek için doğrudan `fetch` kullanır. Düşünme metni akarken
 * görünsün diye yanıtı akış (SSE) olarak ister; akışı desteklemeyen sunucuların düz JSON yanıtı da okunur.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly options: OpenAICompatibleProviderOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { providerId, apiKey, baseURL, model, maxTokens, effort } = this.options
    const body = {
      model,
      messages: toChatMessages(request.system, request.messages, providerId),
      // Boş `tools` dizisini reddeden sağlayıcılar var (özetleme çağrısı tool'suz)
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
            }))
          }
        : {}),
      // OpenAI'nin yeni modelleri `max_tokens`'ı reddediyor; diğerleri çoğunlukla yalnızca onu tanıyor
      ...(providerId === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(effort ? { reasoning_effort: effort } : {}),
      stream: true,
      stream_options: { include_usage: true }
    }

    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: request.signal
      })
    } catch (error) {
      if (request.signal.aborted) throw error
      throw new ProviderError(`Sağlayıcıya bağlanılamadı: ${(error as Error).message}`)
    }

    if (!response.ok) {
      throw new ProviderError(describeHttpError(response.status, await response.text().catch(() => '')), response.status)
    }
    try {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        return fromChatCompletion((await response.json()) as ChatCompletion, providerId)
      }
      return fromChatCompletion(await readStream(response.body, request.onDelta), providerId)
    } catch (error) {
      if (request.signal.aborted || error instanceof ProviderError) throw error
      throw new ProviderError(`Sağlayıcının yanıtı okunamadı: ${(error as Error).message}`)
    }
  }
}

/** SSE akışını parça parça okuyup tek bir `ChatCompletion` olarak birleştirir. */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: StreamDelta) => void
): Promise<ChatCompletion> {
  let content = ''
  let reasoning = ''
  let reasoningField: ReasoningBlock['field'] = 'reasoning_content'
  let finishReason: string | null = null
  const calls: { id?: string; name: string; arguments: string }[] = []

  let usage: ChatUsage | null | undefined
  const handle = (chunk: ChatCompletionChunk) => {
    if (chunk.usage) usage = chunk.usage
    if (chunk.error) {
      const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message
      throw new ProviderError(message || 'Sağlayıcı akış sırasında hata döndürdü.')
    }
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (!delta) return
    const thought = delta.reasoning_content || delta.reasoning
    if (thought) {
      if (!reasoning) reasoningField = delta.reasoning_content ? 'reasoning_content' : 'reasoning'
      reasoning += thought
      onDelta?.({ kind: 'reasoning', text: thought })
    }
    if (delta.content) {
      content += delta.content
      onDelta?.({ kind: 'text', text: delta.content })
    }
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index ?? Math.max(calls.length - 1, 0)] ??= { name: '', arguments: '' })
      if (part.id) call.id = part.id
      if (part.function?.name) call.name += part.function.name
      if (part.function?.arguments) call.arguments += part.function.arguments
    }
  }

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let done = false
  while (!done) {
    const read = await reader.read()
    buffer += decoder.decode(read.value, { stream: !read.done })
    if (read.done) {
      buffer += '\n'
      done = true
    }
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      // Boş satırlar olay ayırıcı, `:` ile başlayanlar yorum (OpenRouter'ın "işleniyor" satırı gibi)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        done = true
        break
      }
      if (data) handle(JSON.parse(data) as ChatCompletionChunk)
    }
  }
  await reader.cancel().catch(() => {})

  return {
    usage,
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content,
          [reasoningField]: reasoning,
          tool_calls: calls
            .filter(Boolean)
            .map((call) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } }))
        }
      }
    ]
  }
}

export function toChatMessages(system: string, messages: readonly Message[], providerId: string): ChatMessage[] {
  const result: ChatMessage[] = system ? [{ role: 'system', content: system }] : []
  // Düşünme metni yalnızca son kullanıcı mesajından sonraki (tool döngüsündeki) yanıtlarda geri gönderilir:
  // DeepSeek ve Kimi tool çağrıları arasında bunu bekler, önceki turlardakini ise istemez
  const turnStart = messages.findLastIndex(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'text')
  )
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      const text = joinText(message.content)
      const calls = message.content.flatMap((block) =>
        block.type === 'tool_call'
          ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
          : []
      )
      if (!text && calls.length === 0) continue
      const reasoning =
        index > turnStart
          ? message.content.find(
              (block): block is ReasoningBlock => block.type === 'reasoning' && block.provider === providerId
            )
          : undefined
      result.push({
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { [reasoning.field]: reasoning.text } : {}),
        ...(calls.length ? { tool_calls: calls } : {})
      })
      continue
    }
    // Tool sonuçları ayrı `tool` mesajları olarak, ardından varsa kullanıcı metni
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const content = block.isError ? `Error: ${block.content}` : block.content
        result.push({ role: 'tool', tool_call_id: block.callId, content })
      }
    }
    const text = joinText(message.content)
    const images = message.content.flatMap((block): ChatContentPart[] =>
      block.type === 'image' ? [{ type: 'image_url', image_url: { url: imageDataUrl(block) } }] : []
    )
    if (images.length) result.push({ role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...images] })
    else if (text) result.push({ role: 'user', content: text })
  }
  return result
}

export function fromChatCompletion(completion: ChatCompletion, providerId: string): ModelResponse {
  const choice = completion.choices?.[0]
  if (!choice?.message) throw new ProviderError('Sağlayıcı boş yanıt döndürdü.')
  const content: ContentBlock[] = []
  const { reasoning_content, reasoning } = choice.message
  if (reasoning_content || reasoning) {
    content.push({
      type: 'reasoning',
      provider: providerId,
      text: (reasoning_content || reasoning)!,
      field: reasoning_content ? 'reasoning_content' : 'reasoning'
    })
  }
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
    content.push({
      type: 'tool_call',
      id: call.id || `call_${index}`,
      name: call.function?.name ?? '',
      input: parseArguments(call.function?.arguments)
    })
  }

  const hasCalls = content.some((block) => block.type === 'tool_call')
  let stopReason: ModelResponse['stopReason']
  switch (choice.finish_reason) {
    case 'length':
      stopReason = 'max_tokens'
      break
    case 'content_filter':
      stopReason = 'refusal'
      break
    default:
      // Bazı sağlayıcılar tool çağrısında da `stop` döndürüyor
      stopReason = hasCalls ? 'tool_use' : 'end'
  }
  return { content, stopReason, usage: fromChatUsage(completion.usage) }
}

export function fromChatUsage(usage: ChatUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  // Aynı sayı sağlayıcıya göre farklı yerde duruyor: OpenAI/OpenRouter `prompt_tokens_details.cached_tokens`,
  // DeepSeek `prompt_cache_hit_tokens`, Kimi üst düzey `cached_tokens`.
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0
  // OpenAI yazmayı hiç bildirmez; OpenRouter uyumlu sağlayıcılar ayrı alanla verebilir
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  const prompt = usage.prompt_tokens ?? cacheRead + cacheWrite + (usage.prompt_cache_miss_tokens ?? 0)
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? undefined
  return {
    // `prompt_tokens` önbellekten okunanı da yazılanı da içerir; `input` yalnızca tazelenen girdidir
    input: Math.max(prompt - cacheRead - cacheWrite, 0),
    cacheRead,
    cacheWrite,
    output: usage.completion_tokens ?? 0,
    ...(reasoning === undefined ? {} : { reasoning })
  }
}

/** Bozuk JSON'u ham metin olarak bırakır; şema denetimi hatayı modele geri bildirir. */
function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function joinText(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

function describeHttpError(status: number, body: string): string {
  if (status === 401) return 'API anahtarı geçersiz.'
  if (status === 403) return 'Bu API anahtarının bu modele erişimi yok.'
  if (status === 404) return 'Model ya da uç nokta bulunamadı.'
  if (status === 429) return 'İstek sınırına ulaşıldı; biraz sonra yeniden deneyin.'
  let detail = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? parsed.message ?? body
  } catch {}
  return `HTTP ${status}${detail ? `: ${detail.slice(0, 500)}` : ''}`
}
