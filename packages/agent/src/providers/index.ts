import type { CatalogModel, CatalogProvider } from '../catalog'
import { CODEX_BASE_URL } from '../codex-catalog'
import { ProviderError, type ModelProvider } from '../provider'
import { AnthropicProvider } from './anthropic'
import { CodexProvider, type CodexAuth } from './codex'
import { OpenAICompatibleProvider } from './openai-compatible'

export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic'
export { CodexProvider, type CodexAuth, type CodexProviderOptions } from './codex'
export { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from './openai-compatible'

/** İki adaptör de akış kullandığı için uzun yanıtlar zaman aşımına düşmez; düşünme metni de bu sınırda. */
const MAX_TOKENS = { anthropic: 64000, 'openai-compatible': 64000 } as const
const FALLBACK_MAX_TOKENS = 8192

export interface CreateProviderOptions {
  apiKey: string
  /** Modelin desteklediği seviyelerden biri; desteklemiyorsa yok sayılır. */
  effort?: string
  /** `codex` protokolünde: her çağrıda geçerli (gerekirse yenilenmiş) ChatGPT oturumunu verir. */
  codexAuth?: () => Promise<CodexAuth>
  /** Konuşma boyunca sabit önbellek kimliği (codex istemlerinde `prompt_cache_key`). */
  sessionId?: string
}

/** Katalogdaki sağlayıcı/model için uygun adaptörü kurar. */
export function createProvider(
  provider: CatalogProvider,
  model: CatalogModel,
  options: CreateProviderOptions
): ModelProvider {
  const effort = options.effort && model.effortLevels?.includes(options.effort) ? options.effort : undefined

  if (model.protocol === 'codex') {
    if (!options.codexAuth) throw new ProviderError('ChatGPT aboneliğiyle giriş yapılmamış.')
    return new CodexProvider({
      providerId: provider.id,
      auth: options.codexAuth,
      baseURL: model.baseURL ?? CODEX_BASE_URL,
      model: model.id,
      // Abonelik modelleri düşünme özellikli; yine de katalog aksini söylüyorsa alan gönderilmez
      reasoning: model.reasoning,
      effort,
      sessionId: options.sessionId
    })
  }

  const limit = MAX_TOKENS[model.protocol]
  const maxTokens = model.maxOutput > 0 ? Math.min(model.maxOutput, limit) : FALLBACK_MAX_TOKENS
  if (model.protocol === 'anthropic') {
    return new AnthropicProvider({
      providerId: provider.id,
      apiKey: options.apiKey,
      baseURL: model.baseURL,
      model: model.id,
      maxTokens,
      effort,
      // IDE'de kullanıcı yanıtı okurken 5 dakikayı kolayca aşar; 1 saatlik kayıt sonraki mesajda da okunur.
      // Diğer Anthropic biçimli sağlayıcılar `ttl`'yi tanımayabilir, onlarda varsayılan kalır.
      cacheTtl: provider.id === 'anthropic' ? '1h' : undefined
    })
  }
  return new OpenAICompatibleProvider({
    providerId: provider.id,
    apiKey: options.apiKey,
    baseURL: model.baseURL!,
    model: model.id,
    maxTokens,
    effort
  })
}
