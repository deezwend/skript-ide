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

/** Sağlayıcı API'sinden dönen hata; arayüz `message`'ı kullanıcıya gösterir. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** HTTP durumu; ağ hatalarında yok. */
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
