import type { ContentBlock, Message } from './messages'
import type { ToolDefinition } from './registry'

export interface ModelRequest {
  system: string
  messages: readonly Message[]
  tools: readonly ToolDefinition[]
  signal: AbortSignal
  /** Yanıt akarken gelen parçalar; yalnızca canlı gösterim içindir, son yanıt yine `complete`'ten döner. */
  onDelta?: (delta: StreamDelta) => void
}

export interface StreamDelta {
  kind: 'text' | 'reasoning'
  text: string
}

/** Bir model çağrısında harcanan token'lar. `input` önbellekten gelmeyen girdidir. */
export interface TokenUsage {
  /** Önbelleğe isabet etmeyen girdi token'ları. */
  input: number
  /** Önbellekten okunan girdi token'ları. */
  cacheRead: number
  /** Önbelleğe yazılan girdi token'ları (yalnızca yazmayı ayrıca ücretlendiren sağlayıcılarda). */
  cacheWrite: number
  output: number
  /** `cacheWrite`'ın 1 saatlik ömürlü dilimi (`cacheWrite`'a dahil); yalnızca Anthropic bildirir. */
  cacheWrite1h?: number
  /** `output`'un içindeki düşünme token'ları; bildirmeyen sağlayıcılarda yok. */
  reasoning?: number
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** Toplamlar; `cacheWrite1h`/`reasoning` yalnızca taraflardan biri bildirdiyse sonuca yazılır. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const { cacheWrite1h, reasoning } = addOptional(a, b)
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning })
  }
}

function addOptional(a: TokenUsage, b: TokenUsage): { cacheWrite1h?: number; reasoning?: number } {
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  return { cacheWrite1h: sum(a.cacheWrite1h, b.cacheWrite1h), reasoning: sum(a.reasoning, b.reasoning) }
}

export interface ModelResponse {
  /** `text`, `tool_call`, `reasoning` ve sağlayıcıya özgü `provider_data` blokları. */
  content: ContentBlock[]
  /**
   * `tool_use`: model tool sonucu bekliyor; `end`: tur bitti; `max_tokens`: yanıt kesildi;
   * `refusal`: model güvenlik gerekçesiyle yanıtlamayı reddetti.
   */
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal'
  /** Sağlayıcı bildirdiyse bu çağrının token kullanımı. */
  usage?: TokenUsage
}

/** LLM sağlayıcısı adaptörü (Anthropic, OpenAI uyumlu…). Döngü yalnızca bunu bilir. */
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>
}

/** Kısa süre sonra yeniden denenince geçebilecek HTTP durumları (zaman aşımı, sınır, sunucu hataları). */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529])

/** Sağlayıcı API'sinden dönen hata; arayüz `message`'ı kullanıcıya gösterir. */
export class ProviderError extends Error {
  /** Aynı istek yeniden gönderilirse geçebilir (bağlantı kopması, aşırı yük…). */
  readonly retryable: boolean

  constructor(
    message: string,
    /** HTTP durumu; ağ hatalarında yok. */
    readonly status?: number,
    options: { retryable?: boolean } = {}
  ) {
    super(message)
    this.name = 'ProviderError'
    this.retryable = options.retryable ?? (status !== undefined && RETRYABLE_STATUSES.has(status))
  }
}

/**
 * `fetch` hatasının mesajı ve asıl nedeni. Node'un `fetch`'i (undici) yalnızca "terminated" ya da
 * "fetch failed" der; gerçek neden (`other side closed`, `ECONNRESET`, `UND_ERR_BODY_TIMEOUT`…) `cause`'tadır.
 */
export function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const detail = causeText((error as { cause?: unknown } | null)?.cause)
  return detail && !message.includes(detail) ? `${message} (${detail})` : message
}

function causeText(cause: unknown, depth = 0): string | undefined {
  if (cause === undefined || cause === null || depth > 3) return undefined
  // Birden çok adres denendiğinde (IPv4/IPv6) neden bir AggregateError olur; mesajı boştur
  if (cause instanceof AggregateError && cause.errors.length > 0) return causeText(cause.errors[0], depth + 1)
  if (!(cause instanceof Error)) return String(cause)
  const code = (cause as { code?: unknown }).code
  const parts = [cause.message]
  if (typeof code === 'string' && !cause.message.includes(code)) parts.push(code)
  const nested = causeText((cause as { cause?: unknown }).cause, depth + 1)
  if (nested && !cause.message.includes(nested)) parts.push(nested)
  return parts.filter(Boolean).join(', ') || undefined
}

export interface RetryInfo {
  /** Başarısız olan denemenin sırası (1'den başlar). */
  attempt: number
  /** Toplam deneme hakkı (ilk istek dahil). */
  maxAttempts: number
  /** Bir sonraki denemeden önceki bekleme. */
  delayMs: number
  error: ProviderError
}

/** Yeniden denemeler arasındaki varsayılan beklemeler; uzunluğu yeniden deneme sayısıdır. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000]

/**
 * `provider.complete`'i geçici hatalarda (bağlantı kopması, 429/5xx) bekleyerek yeniden dener.
 * Yanıtın bir kısmı akmış olabilir; `onRetry` arayüzün o yarım yanıtı silmesi için çağrılır.
 * İptal beklemeyi de keser.
 */
export async function completeWithRetry(
  provider: ModelProvider,
  request: ModelRequest,
  options: { delaysMs?: readonly number[]; onRetry?: (info: RetryInfo) => void } = {}
): Promise<ModelResponse> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.complete(request)
    } catch (error) {
      if (request.signal.aborted || !(error instanceof ProviderError) || !error.retryable || attempt > delays.length) {
        throw error
      }
      const delayMs = delays[attempt - 1]
      options.onRetry?.({ attempt, maxAttempts: delays.length + 1, delayMs, error })
      await sleep(delayMs, request.signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
