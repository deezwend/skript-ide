import type { ContentBlock, Message, ProviderDataBlock } from '../messages'
import {
  ProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamDelta,
  type TokenUsage
} from '../provider'

export interface CodexAuth {
  accessToken: string
  /** Faturalandırılan ChatGPT çalışma alanı; oturumdan okunur. */
  accountId?: string | null
}

export interface CodexProviderOptions {
  /** Katalog sağlayıcı kimliği; `provider_data` bloklarını eşlemek için. */
  providerId: string
  /** Her istekte çağrılır: süresi dolmuş jetonu çağıran yeniler. */
  auth: () => Promise<CodexAuth>
  /** ChatGPT arka ucunun kökü; sonuna `/responses` eklenir. */
  baseURL: string
  model: string
  /** Model düşünme seviyesi desteklemiyorsa `false`; `reasoning` alanı hiç gönderilmez. */
  reasoning?: boolean
  effort?: string
  /** Konuşma boyunca sabit kimlik; sunucunun önbellek isabeti için kullanılır. */
  sessionId?: string
  fetch?: typeof fetch
}

/** Responses API'ye gönderilen tek bir girdi öğesi. */
type ResponsesItem =
  | { type?: 'message'; role: 'user' | 'assistant'; content: { type: 'input_text' | 'output_text'; text: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  /** Düşünme öğesi: `store: false` ile tool döngüsünde aynen geri gönderilmeli. */
  | { type: 'reasoning'; id?: string; encrypted_content?: string | null; summary?: { type?: string; text?: string }[] }

export interface ResponsesBody {
  model: string
  instructions?: string
  input: ResponsesItem[]
  tools: { type: 'function'; name: string; description: string; parameters: unknown; strict: boolean }[]
  tool_choice: 'auto'
  parallel_tool_calls: boolean
  reasoning?: { effort?: string; summary: 'auto' }
  store: false
  stream: true
  include: string[]
  prompt_cache_key?: string
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens_details?: { reasoning_tokens?: number } | null
}

interface ResponsesOutputItem {
  type?: string
  role?: string
  content?: { type?: string; text?: string }[]
  summary?: { type?: string; text?: string }[]
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string | null
}

interface ResponsesResult {
  status?: string
  output?: ResponsesOutputItem[]
  usage?: ResponsesUsage | null
  incomplete_details?: { reason?: string } | null
  error?: { message?: string; code?: string } | string | null
}

/** Akıştaki tek bir `data:` olayı. */
interface ResponsesStreamEvent {
  type?: string
  delta?: string
  item?: ResponsesOutputItem
  response?: ResponsesResult
  error?: { message?: string } | string
  message?: string
}

/**
 * ChatGPT aboneliğiyle Codex arka ucunu konuşan adaptör. Chat Completions değil **Responses API**
 * kullanır (`POST <baseURL>/responses`); akış SSE olarak okunur, düşünme özeti canlı gösterilir.
 * `store: false` olduğu için düşünme öğeleri şifreli içerikleriyle birlikte geri gönderilir.
 */
export class CodexProvider implements ModelProvider {
  constructor(private readonly options: CodexProviderOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { baseURL, model, effort, reasoning, sessionId, providerId } = this.options
    const auth = await this.options.auth()
    const body = toResponsesBody(request, { providerId, model, effort, reasoning, sessionId })

    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${baseURL.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${auth.accessToken}`,
          originator: 'codex_cli_rs',
          'openai-beta': 'responses=experimental',
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
          ...(sessionId ? { 'session-id': sessionId } : {})
        },
        body: JSON.stringify(body),
        signal: request.signal
      })
    } catch (error) {
      if (request.signal.aborted) throw error
      throw new ProviderError(`ChatGPT arka ucuna bağlanılamadı: ${(error as Error).message}`)
    }

    if (!response.ok) {
      throw new ProviderError(describeHttpError(response.status, await response.text().catch(() => '')), response.status)
    }
    try {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        return fromResponsesResult((await response.json()) as ResponsesResult, providerId)
      }
      return fromResponsesResult(await readResponsesStream(response.body, request.onDelta), providerId)
    } catch (error) {
      if (request.signal.aborted || error instanceof ProviderError) throw error
      throw new ProviderError(`ChatGPT yanıtı okunamadı: ${(error as Error).message}`)
    }
  }
}

export function toResponsesBody(
  request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>,
  options: { providerId: string; model: string; effort?: string; reasoning?: boolean; sessionId?: string }
): ResponsesBody {
  const reasoning = options.reasoning === false ? undefined : { ...(options.effort ? { effort: options.effort } : {}), summary: 'auto' as const }
  return {
    model: options.model,
    ...(request.system ? { instructions: request.system } : {}),
    input: toResponsesInput(request.messages, options.providerId),
    tools: request.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false
    })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...(reasoning ? { reasoning } : {}),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(options.sessionId ? { prompt_cache_key: options.sessionId } : {})
  }
}

/**
 * Konuşmayı Responses API girdisine çevirir. Düşünme öğeleri yalnızca son kullanıcı mesajından
 * sonraki yanıtlarda geri gönderilir: tool döngüsünde gerekirler, eski turlarda gereksiz yer kaplar.
 */
export function toResponsesInput(messages: readonly Message[], providerId: string): ResponsesItem[] {
  const turnStart = messages.findLastIndex(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'text')
  )
  const input: ResponsesItem[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      // Sıra önemli: düşünme öğesi ardından gelen tool çağrısıyla birlikte gönderilmeli
      if (index > turnStart) {
        for (const block of message.content) {
          const item = reasoningItem(block, providerId)
          if (item) input.push(item)
        }
      }
      const text = joinText(message.content)
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const block of message.content) {
        if (block.type !== 'tool_call') continue
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        })
      }
      continue
    }
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.callId,
          output: block.isError ? `Error: ${block.content}` : block.content
        })
      }
    }
    const text = joinText(message.content)
    if (text) input.push({ role: 'user', content: [{ type: 'input_text', text }] })
  }
  return input
}

/** Aynı sağlayıcıdan gelen ve gövdesi geçerli bir Responses öğesi olan `provider_data` bloğu. */
function reasoningItem(block: ContentBlock, providerId: string): ResponsesItem | null {
  if (block.type !== 'provider_data' || block.provider !== providerId) return null
  const data = (block as ProviderDataBlock).data
  if (typeof data !== 'object' || data === null) return null
  const item = data as ResponsesItem
  return item.type === 'reasoning' ? item : null
}

/** SSE akışını okuyup son yanıtı tek bir sonuç nesnesinde toplar. */
export async function readResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: StreamDelta) => void
): Promise<ResponsesResult> {
  let result: ResponsesResult | null = null
  // `response.completed` her öğeyi içerir; yine de parça parça gelen akışlarda `done` olayları birikir
  const items = new Map<number, ResponsesOutputItem>()
  let nextIndex = 0

  const handle = (event: ResponsesStreamEvent) => {
    switch (event.type) {
      case 'response.output_item.done':
        if (event.item) items.set(nextIndex++, event.item)
        return
      case 'response.output_item.added':
        // Düşünme öğesinin şifreli gövdesi yalnızca `done` olayında gelir
        return
      case 'response.output_text.delta':
        if (event.delta) onDelta?.({ kind: 'text', text: event.delta })
        return
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) onDelta?.({ kind: 'reasoning', text: event.delta })
        return
      case 'response.completed':
      case 'response.incomplete':
        result = event.response ?? {}
        if (event.type === 'response.incomplete') result.status = 'incomplete'
        return
      case 'response.failed':
        throw new ProviderError(errorMessage(event.response?.error) ?? 'ChatGPT isteği başarısız oldu.')
      case 'error':
        throw new ProviderError(errorMessage(event.error) ?? event.message ?? 'ChatGPT akışı hata döndürdü.')
      default:
        return
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
      // Olay türü JSON gövdesinde de var; `event:` satırları ve yorumlar atlanır
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      handle(JSON.parse(data) as ResponsesStreamEvent)
    }
  }
  await reader.cancel().catch(() => {})

  const completed = result as ResponsesResult | null
  const output = completed?.output?.length ? completed.output : [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
  if (!completed && output.length === 0) throw new ProviderError('ChatGPT boş yanıt döndürdü.')
  return { ...completed, output }
}

/** Responses yanıtını ortak içerik bloklarına çevirir. */
export function fromResponsesResult(result: ResponsesResult, providerId: string): ModelResponse {
  if (result.error) throw new ProviderError(errorMessage(result.error) ?? 'ChatGPT isteği başarısız oldu.')
  const content: ContentBlock[] = []
  for (const item of result.output ?? []) {
    if (item.type === 'reasoning') {
      // Şifreli gövde sonraki turda geri gönderilir; özet metni arayüzde düşünme olarak görünür
      content.push({ type: 'provider_data', provider: providerId, data: item })
      const summary = joinItemText(item.summary)
      if (summary) content.push({ type: 'reasoning', provider: providerId, text: summary, field: 'reasoning' })
      continue
    }
    if (item.type === 'message' && item.role !== 'user') {
      const text = joinItemText(item.content)
      if (text) content.push({ type: 'text', text })
      continue
    }
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_call',
        id: item.call_id || item.id || `call_${content.length}`,
        name: item.name ?? '',
        input: parseArguments(item.arguments)
      })
    }
  }

  const hasCalls = content.some((block) => block.type === 'tool_call')
  const incomplete = result.status === 'incomplete'
  let stopReason: ModelResponse['stopReason']
  if (incomplete && result.incomplete_details?.reason === 'content_filter') stopReason = 'refusal'
  else if (incomplete) stopReason = 'max_tokens'
  else stopReason = hasCalls ? 'tool_use' : 'end'
  return { content, stopReason, usage: fromResponsesUsage(result.usage) }
}

export function fromResponsesUsage(usage: ResponsesUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? undefined
  return {
    // `input_tokens` önbellekten okunanı da içerir; `input` yalnızca tazelenen girdidir
    input: Math.max((usage.input_tokens ?? 0) - cacheRead, 0),
    cacheRead,
    // ChatGPT arka ucu önbelleğe yazmayı ayrıca ücretlendirmediği için bildirmez
    cacheWrite: 0,
    output: usage.output_tokens ?? 0,
    ...(reasoning === undefined ? {} : { reasoning })
  }
}

function joinText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function joinItemText(parts: { type?: string; text?: string }[] | undefined): string {
  return (parts ?? []).flatMap((part) => (part.text ? [part.text] : [])).join('\n')
}

function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(error: ResponsesResult['error']): string | null {
  if (!error) return null
  return typeof error === 'string' ? error : error.message ?? null
}

function describeHttpError(status: number, body: string): string {
  if (status === 401) return 'ChatGPT oturumu sona ermiş; agent ayarlarından yeniden giriş yap.'
  if (status === 403) return 'Bu ChatGPT hesabının Codex’e erişimi yok; planını kontrol et.'
  if (status === 404) return 'ChatGPT arka ucunda model ya da uç nokta bulunamadı.'
  if (status === 429) return 'ChatGPT kullanım sınırına ulaşıldı; biraz sonra yeniden deneyin.'
  if (status >= 500) return `ChatGPT arka ucu şu an yanıt vermiyor (HTTP ${status}).`
  let detail = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string }
    detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? parsed.message ?? parsed.detail ?? body
  } catch {}
  return `HTTP ${status}${detail ? `: ${detail.slice(0, 500)}` : ''}`
}
