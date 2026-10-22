/**
 * models.dev kataloğundan agent'ın kullanabileceği sağlayıcı ve modelleri çıkarır.
 * Yalnızca tool çağırabilen, kullanımdan kalkmamış sohbet modelleri ve bizim konuşabildiğimiz
 * iki API biçiminden biriyle (Anthropic Messages, OpenAI uyumlu Chat Completions) erişilenler kalır.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json'

export type ProviderProtocol = 'anthropic' | 'openai-compatible' | 'codex'

export interface CatalogModel {
  id: string
  name: string
  family?: string
  protocol: ProviderProtocol
  /** API kökü; `undefined`: protokolün varsayılanı (yalnızca Anthropic'in kendisi). */
  baseURL?: string
  reasoning: boolean
  /** Desteklenen `effort` seviyeleri (düşükten yükseğe); yoksa effort gönderilmez. */
  effortLevels?: string[]
  contextWindow: number
  maxOutput: number
  /** 1M token başına USD. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  releaseDate?: string
  status?: 'beta' | 'alpha'
}

export interface CatalogProvider {
  id: string
  name: string
  /** API anahtarının okunabileceği ortam değişkenleri. */
  env: string[]
  doc?: string
  /** `chatgpt`: API anahtarı yerine ChatGPT aboneliğiyle giriş yapılır (Codex). */
  login?: 'chatgpt'
  models: CatalogModel[]
}

/** npm paketi API biçimini ama kök adresi vermeyen sağlayıcıların OpenAI uyumlu uç noktaları. */
const KNOWN_OPENAI_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  perplexity: 'https://api.perplexity.ai'
}

const OPENAI_STYLE_PACKAGES = new Set(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@openrouter/ai-sdk-provider'])

interface RawProvider {
  id?: unknown
  name?: unknown
  env?: unknown
  npm?: unknown
  api?: unknown
  doc?: unknown
  models?: Record<string, RawModel>
}

interface RawModel {
  id?: unknown
  name?: unknown
  family?: unknown
  tool_call?: unknown
  reasoning?: unknown
  reasoning_options?: { type?: unknown; values?: unknown }[]
  status?: unknown
  type?: unknown
  modalities?: { output?: unknown }
  limit?: { context?: unknown; output?: unknown }
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown }
  release_date?: unknown
  provider?: { npm?: unknown; api?: unknown; shape?: unknown }
}

/** `https://models.dev/api.json` içeriğini çözümler. Bozuk girdiler sessizce atlanır. */
export function parseCatalog(raw: unknown): CatalogProvider[] {
  if (!isRecord(raw)) throw new Error('models.dev: beklenmeyen katalog biçimi')
  const providers: CatalogProvider[] = []

  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const p = value as RawProvider
    const id = str(p.id) ?? key
    const models: CatalogModel[] = []

    for (const [modelKey, m] of Object.entries(p.models ?? {})) {
      if (!isRecord(m)) continue
      const model = parseModel(id, p, modelKey, m)
      if (model) models.push(model)
    }
    if (models.length === 0) continue

    models.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.name.localeCompare(b.name))
    providers.push({
      id,
      name: str(p.name) ?? id,
      env: Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === 'string') : [],
      doc: str(p.doc),
      models
    })
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name))
}

function parseModel(providerId: string, p: RawProvider, key: string, m: RawModel): CatalogModel | null {
  if (m.tool_call !== true) return null
  if (m.status === 'deprecated') return null
  if (m.type !== undefined && m.type !== 'chat') return null
  const outputs = m.modalities?.output
  if (Array.isArray(outputs) && !outputs.includes('text')) return null
  // Yalnızca OpenAI Responses API'siyle çalışan modeller Chat Completions'ta çalışmaz
  if (m.provider?.shape === 'responses') return null

  const npm = str(m.provider?.npm) ?? str(p.npm)
  const api = str(m.provider?.api) ?? str(p.api)
  let protocol: ProviderProtocol
  let baseURL: string | undefined
  if (npm === '@ai-sdk/anthropic') {
    protocol = 'anthropic'
    baseURL = api
    // Kök adresi olmayan Anthropic biçimli sağlayıcı yalnızca Anthropic'in kendisi olabilir
    if (!baseURL && providerId !== 'anthropic') return null
  } else if (npm && (OPENAI_STYLE_PACKAGES.has(npm) || KNOWN_OPENAI_BASE_URLS[providerId])) {
    protocol = 'openai-compatible'
    baseURL = api ?? KNOWN_OPENAI_BASE_URLS[providerId]
    if (!baseURL) return null
  } else {
    return null
  }

  const effort = m.reasoning_options?.find((option) => option.type === 'effort')
  const effortLevels = Array.isArray(effort?.values)
    ? effort.values.filter((v): v is string => typeof v === 'string' && v !== 'none')
    : undefined
  const costInput = num(m.cost?.input)
  const costOutput = num(m.cost?.output)

  return {
    id: str(m.id) ?? key,
    name: str(m.name) ?? key,
    family: str(m.family),
    protocol,
    baseURL,
    reasoning: m.reasoning === true,
    effortLevels: effortLevels?.length ? effortLevels : undefined,
    contextWindow: num(m.limit?.context) ?? 0,
    maxOutput: num(m.limit?.output) ?? 0,
    cost:
      costInput !== undefined && costOutput !== undefined
        ? { input: costInput, output: costOutput, ...optional('cacheRead', num(m.cost?.cache_read)), ...optional('cacheWrite', num(m.cost?.cache_write)) }
        : undefined,
    releaseDate: str(m.release_date),
    status: m.status === 'beta' || m.status === 'alpha' ? m.status : undefined
  }
}

/** Kataloğu indirir ve çözümler. Dosya ~6 MB; çağıran sonucu önbelleğe almalı. */
export async function fetchCatalog(signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<CatalogProvider[]> {
  const response = await fetchImpl(MODELS_DEV_URL, { signal })
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`)
  return parseCatalog(await response.json())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: number })
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
