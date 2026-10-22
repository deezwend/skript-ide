import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlock, Message } from '../messages'
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type TokenUsage } from '../provider'

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type ResponseBlock = Anthropic.Beta.BetaContentBlock

export interface AnthropicProviderOptions {
  /** Katalog sağlayıcı kimliği; `provider_data` bloklarını eşlemek için. */
  providerId: string
  apiKey: string
  /** `undefined`: Anthropic'in kendi API'si. Anthropic biçimli diğer sağlayıcılar kendi kökünü verir. */
  baseURL?: string
  model: string
  maxTokens: number
  effort?: string
  /**
   * Önbellek kayıtlarının ömrü. `undefined`: API varsayılanı (5 dakika); `ttl` alanı hiç gönderilmez,
   * çünkü Anthropic biçimli bazı sağlayıcılar onu tanımıyor.
   */
  cacheTtl?: '5m' | '1h'
}

type CacheControl = Anthropic.Beta.BetaCacheControlEphemeral
type MessageParams = Parameters<Anthropic['beta']['messages']['stream']>[0]

/** Sunucu tarafı reddetme yedeğini (refusal fallback) destekleyen modeller; yalnızca Anthropic API'sinde. */
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** Anthropic Messages API adaptörü. Uzun yanıtlarda zaman aşımına düşmemek için akış (streaming) kullanır. */
export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic
  private readonly fallbacks: boolean

  constructor(private readonly options: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL })
    this.fallbacks = options.providerId === 'anthropic' && SERVER_FALLBACK_MODELS.has(options.model)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      const stream = this.client.beta.messages.stream(toAnthropicParams(request, this.options, this.fallbacks), {
        signal: request.signal
      })
      const { onDelta } = request
      if (onDelta) {
        stream.on('text', (text) => onDelta({ kind: 'text', text }))
        stream.on('thinking', (text) => onDelta({ kind: 'reasoning', text }))
      }
      const message = await stream.finalMessage()
      return {
        content: fromAnthropicContent(message.content, this.options.providerId),
        stopReason: mapStopReason(message.stop_reason),
        usage: fromAnthropicUsage(message.usage)
      }
    } catch (error) {
      if (request.signal.aborted) throw error
      if (error instanceof Anthropic.APIError) {
        throw new ProviderError(describeError(error), error.status ?? undefined)
      }
      throw new ProviderError(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * İstek gövdesi. Önbellek bir önek eşleşmesidir (`tools → system → messages`); iki işaret konur:
 * sabit önekin (tool'lar + sistem istemi) sonuna ve konuşmanın son bloğuna. Böylece döngüdeki her
 * çağrı bir öncekinin yazdığı öneki okur, yalnızca yeni eklenen kısım önbelleğe yazılır.
 */
export function toAnthropicParams(
  request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>,
  options: AnthropicProviderOptions,
  fallbacks = false
): MessageParams {
  const { model, maxTokens, effort, cacheTtl, providerId } = options
  const cache: CacheControl = cacheTtl ? { type: 'ephemeral', ttl: cacheTtl } : { type: 'ephemeral' }
  const tools: Anthropic.Beta.BetaTool[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema
  }))
  // Sistem istemi yoksa sabit önek tool tanımlarında biter
  if (!request.system && tools.length > 0) tools[tools.length - 1].cache_control = cache
  return {
    model,
    max_tokens: maxTokens,
    system: request.system ? [{ type: 'text', text: request.system, cache_control: cache }] : undefined,
    messages: withCacheBreakpoint(toAnthropicMessages(request.messages, providerId), cache),
    tools,
    ...(effort ? { output_config: { effort: effort as 'high' } } : {}),
    // Model güvenlik gerekçesiyle reddederse API aynı isteği uygun bir yedek modelde çalıştırır
    ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
  }
}

/** Önbellek işareti alabilen bloklar; düşünme blokları alamaz. */
const CACHEABLE_BLOCKS = new Set(['text', 'image', 'tool_use', 'tool_result'])

/**
 * Son mesajın işaret alabilen son bloğuna `cache_control` koyar. Girdi değiştirilmez;
 * yalnızca o blok ve onu içeren mesaj kopyalanır.
 */
export function withCacheBreakpoint(messages: MessageParam[], cache: CacheControl): MessageParam[] {
  const last = messages.at(-1)
  if (!last || !Array.isArray(last.content)) return messages
  const content = [...(last.content as ContentBlockParam[])]
  const index = content.findLastIndex((block) => CACHEABLE_BLOCKS.has(block.type))
  if (index < 0) return messages
  content[index] = { ...content[index], cache_control: cache } as ContentBlockParam
  return [...messages.slice(0, -1), { ...last, content } as MessageParam]
}

export function toAnthropicMessages(messages: readonly Message[], providerId: string): MessageParam[] {
  const result: MessageParam[] = []
  for (const message of messages) {
    const content: ContentBlockParam[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          // API boş metin bloğunu reddeder
          if (block.text !== '') content.push({ type: 'text', text: block.text })
          break
        case 'image':
          content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } })
          break
        case 'tool_call':
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
          break
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: block.callId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {})
          })
          break
        case 'provider_data':
          // Düşünme blokları değiştirilmeden geri gönderilmeli; başka sağlayıcının blokları atlanır
          if (block.provider === providerId) content.push(block.data as ContentBlockParam)
          break
      }
    }
    if (content.length > 0) result.push({ role: message.role, content })
  }
  return result
}

export function fromAnthropicContent(blocks: readonly ResponseBlock[], providerId: string): ContentBlock[] {
  // Yanıt ortasında yedek modele geçildiyse, son `fallback` bloğundan önceki düşünme ve
  // tool_use blokları geri gönderilmemeli (reddeden modelin yarım çıktısı); metin kalır
  const boundary = blocks.findLastIndex((block) => block.type === 'fallback')
  const content: ContentBlock[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (index < boundary) {
      continue
    } else if (block.type === 'tool_use') {
      content.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input })
    } else {
      content.push({ type: 'provider_data', provider: providerId, data: block })
    }
  }
  return content
}

/** Sağlayıcının `usage` bloğu; 1 saatlik önbellek dilimi ve düşünme token'ları da taşınır. */
export function fromAnthropicUsage(usage: Anthropic.Beta.BetaUsage): TokenUsage {
  const reasoning = usage.output_tokens_details?.thinking_tokens ?? undefined
  return {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    // 1 saatlik ömür `cacheWrite`'ın içindedir; fiyatlamada iki katı girdi sayılır
    ...(usage.cache_creation ? { cacheWrite1h: usage.cache_creation.ephemeral_1h_input_tokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning })
  }
}

function mapStopReason(reason: string | null): ModelResponse['stopReason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'end'
  }
}

function describeError(error: InstanceType<typeof Anthropic.APIError>): string {
  if (error instanceof Anthropic.AuthenticationError) return 'API anahtarı geçersiz.'
  if (error instanceof Anthropic.PermissionDeniedError) return 'Bu API anahtarının bu modele erişimi yok.'
  if (error instanceof Anthropic.NotFoundError) return 'Model bulunamadı.'
  if (error instanceof Anthropic.RateLimitError) return 'İstek sınırına ulaşıldı; biraz sonra yeniden deneyin.'
  if (error instanceof Anthropic.APIConnectionError) return 'Sağlayıcıya bağlanılamadı.'
  return error.message
}
