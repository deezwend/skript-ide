import type { CatalogModel, CatalogProvider } from './catalog'

/**
 * ChatGPT aboneliğiyle (Plus/Pro) çalışan sağlayıcı. models.dev'de yok: modeller OpenAI'nin
 * Codex arka ucundan gelir ve API anahtarı yerine OAuth oturumuyla erişilir.
 */

export const CODEX_PROVIDER_ID = 'openai-codex'
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_MODELS_VERSION = '1.0.0'

/**
 * Hesabın model listesi `/models` uç noktasından indirilir; bu liste yalnızca indirme başarısız
 * olduğunda (çevrimdışı, eski sürüm) kullanılır. Codex CLI'nin o an listelediği modeller.
 */
/** Codex modellerinin bağlam penceresi (Codex CLI'nin model listesiyle aynı). */
const CODEX_CONTEXT_WINDOW = 272_000

export const CODEX_FALLBACK_MODELS: readonly CatalogModel[] = [
  codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-6-astra', 'GPT-6-Astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-6-sol', 'GPT-6-Sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-6-luna', 'GPT-6-Luna', ['low', 'medium', 'high', 'xhigh', 'max']),
  codexModel('gpt-5.6-sol', 'GPT-5.6-Sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-terra', 'GPT-5.6-Terra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-luna', 'GPT-5.6-Luna', ['low', 'medium', 'high', 'xhigh', 'max']),
  codexModel('gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high', 'xhigh'])
]

function codexModel(id: string, name: string, effortLevels: string[]): CatalogModel {
  return {
    id,
    name,
    protocol: 'codex',
    baseURL: CODEX_BASE_URL,
    reasoning: true,
    effortLevels,
    contextWindow: CODEX_CONTEXT_WINDOW,
    // Abonelikte fatura token başına değil, plan üzerinden; katalog fiyatı yok
    maxOutput: 0
  }
}

export function codexModelsUrl(clientVersion = CODEX_MODELS_VERSION): string {
  return `${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(clientVersion)}`
}

/** `/models` yanıtını çözer: `{ models: [{ slug, display_name, supported_reasoning_levels… }] }`. */
export function parseCodexModels(raw: unknown): CatalogModel[] {
  const list = isRecord(raw) && Array.isArray(raw.models) ? raw.models : []
  const models: CatalogModel[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    // `hide`: yalnızca iç kullanımda; `supported_in_api: false`: Responses API'ye kapalı
    if (entry.visibility === 'hide' || entry.supported_in_api === false) continue
    const slug = str(entry.slug) ?? str(entry.id)
    if (!slug) continue
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.flatMap((preset) => {
          const effort = isRecord(preset) ? str(preset.effort) : undefined
          return effort && effort !== 'none' ? [effort] : []
        })
      : []
    models.push({
      id: slug,
      name: str(entry.display_name) ?? slug,
      protocol: 'codex',
      baseURL: CODEX_BASE_URL,
      reasoning: true,
      effortLevels: levels.length ? levels : undefined,
      contextWindow: num(entry.context_window) ?? CODEX_CONTEXT_WINDOW,
      maxOutput: 0,
      status: entry.status === 'beta' || entry.status === 'alpha' ? entry.status : undefined
    })
  }
  return models
}

/** Ayar ekranında ve model seçicide görünen sahte katalog girdisi. */
export function codexCatalogProvider(models: readonly CatalogModel[] = CODEX_FALLBACK_MODELS): CatalogProvider {
  return {
    id: CODEX_PROVIDER_ID,
    name: 'ChatGPT (Codex)',
    env: [],
    doc: 'https://chatgpt.com/codex',
    login: 'chatgpt',
    models: [...models]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
