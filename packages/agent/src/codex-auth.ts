import { createHash, randomBytes } from 'node:crypto'
import { ProviderError } from './provider'

/**
 * ChatGPT aboneliğiyle (Plus/Pro) giriş. Codex CLI'nin kullandığı OAuth istemcisi ve PKCE akışı
 * aynen uygulanır: tarayıcıda OpenAI oturumu açılır, dönen kod jetonlara çevrilir ve API anahtarı
 * yerine bu jetonlar ChatGPT arka ucuna taşınır. Jetonlar bu modülde saklanmaz; çağıran saklar.
 */

export const CODEX_ISSUER = 'https://auth.openai.com'

/** Codex CLI'nin herkese açık OAuth istemcisi; ChatGPT aboneliği bu istemciye bağlı. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** İsteğe eklenen istemci adı; ChatGPT arka ucu Codex trafiğini bununla tanır. */
export const CODEX_ORIGINATOR = 'codex_cli_rs'

export const CODEX_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

/** Tarayıcının döndüğü yerel adres; yetkilendirme adresindeki `redirect_uri` ile aynı olmalı. */
export const CODEX_CALLBACK_PORT = 1455
export const CODEX_FALLBACK_CALLBACK_PORT = 1457

export interface PkceCodes {
  verifier: string
  challenge: string
}

/** S256 PKCE çifti: 64 rastgele bayt ve bunun SHA-256 özeti, ikisi de base64url. */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(64).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function generateState(): string {
  return randomBytes(32).toString('base64url')
}

export function callbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/auth/callback`
}

export interface AuthorizationUrlOptions {
  redirectUri: string
  pkce: PkceCodes
  state: string
  issuer?: string
}

/** Tarayıcıda açılacak yetkilendirme adresi. Parametreler Codex CLI ile aynı kümede. */
export function authorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(`${trimSlash(options.issuer ?? CODEX_ISSUER)}/oauth/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CODEX_CLIENT_ID)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('code_challenge', options.pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', options.state)
  url.searchParams.set('scope', CODEX_SCOPES)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', CODEX_ORIGINATOR)
  return url.toString()
}

export interface CodexCallback {
  code?: string
  /** ChatGPT girişi reddettiyse dönen hata kodu. */
  error?: string
  errorDescription?: string
  state?: string
}

/** Yerel sunucuya düşen `?code=…&state=…` sorgusunu çözer. */
export function parseCallback(url: string): CodexCallback {
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://127.0.0.1').searchParams
  } catch {
    return {}
  }
  const callback: CodexCallback = {}
  const code = params.get('code')
  const error = params.get('error')
  const errorDescription = params.get('error_description')
  const state = params.get('state')
  if (code !== null) callback.code = code
  if (error !== null) callback.error = error
  if (errorDescription !== null) callback.errorDescription = errorDescription
  if (state !== null) callback.state = state
  return callback
}

/** ChatGPT oturumunun jetonları; `expiresAt` epoch ms. */
export interface CodexTokens {
  accessToken: string
  /** Yenileme yanıtında gelmeyebilir; o durumda eskisi korunur. */
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  /** Faturalandırılan ChatGPT çalışma alanı; isteğe `chatgpt-account-id` olarak eklenir. */
  accountId?: string
  email?: string
  /** `plus`, `pro`, `team`… yalnızca arayüzde gösterilir. */
  plan?: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

export interface TokenRequestOptions {
  issuer?: string
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** Yetkilendirme kodunu jetonlara çevirir (form kodlaması). */
export async function exchangeCode(
  options: TokenRequestOptions & { code: string; redirectUri: string; verifier: string }
): Promise<CodexTokens> {
  return requestTokens(
    {
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier
    },
    options,
    'form'
  )
}

/** Süresi dolmak üzere olan erişim jetonunu yeniler (JSON kodlaması; ChatGPT yenilemesi böyle ister). */
export async function refreshTokens(
  options: TokenRequestOptions & { refreshToken: string }
): Promise<CodexTokens> {
  const tokens = await requestTokens(
    { grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: options.refreshToken },
    options,
    'json'
  )
  return { ...tokens, refreshToken: tokens.refreshToken ?? options.refreshToken }
}

async function requestTokens(
  fields: Record<string, string>,
  options: TokenRequestOptions,
  encoding: 'form' | 'json'
): Promise<CodexTokens> {
  const url = `${trimSlash(options.issuer ?? CODEX_ISSUER)}/oauth/token`
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: encoding === 'form' ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
      signal: options.signal
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ProviderError(`ChatGPT giriş sunucusuna bağlanılamadı: ${(error as Error).message}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ProviderError(describeTokenError(response.status, detail), response.status)
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse
  if (!body.access_token) throw new ProviderError('ChatGPT giriş sunucusu erişim jetonu döndürmedi.')

  const claims = body.id_token ? parseIdTokenClaims(body.id_token) : {}
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : accessTokenExpiry(body.access_token),
    accountId: claims.accountId,
    email: claims.email,
    plan: claims.plan
  }
}

export interface CodexClaims {
  accountId?: string
  email?: string
  plan?: string
  userId?: string
  expiresAt?: number
}

/** İmza doğrulanmaz: jeton zaten giriş sunucusundan geldi, buradan yalnızca gösterilecek bilgiler okunur. */
export function parseIdTokenClaims(idToken: string): CodexClaims {
  const payload = decodeJwt(idToken)
  if (!payload) return {}
  // ChatGPT alanları `https://api.openai.com/auth` başlığı altında durur
  const auth = isRecord(payload['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'] : {}
  return {
    accountId: str(auth.chatgpt_account_id),
    plan: str(auth.chatgpt_plan_type),
    userId: str(auth.chatgpt_user_id),
    email: str(payload.email),
    expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  }
}

/** Erişim jetonunun bitiş zamanı (epoch ms); okunamazsa `undefined`. */
export function accessTokenExpiry(accessToken: string): number | undefined {
  const exp = decodeJwt(accessToken)?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

/** Jetonun bitmesine `marginMs` ya da daha az kaldıysa yenilenmeli. */
export function needsRefresh(tokens: Pick<CodexTokens, 'accessToken' | 'expiresAt'>, marginMs = 2 * 60 * 1000): boolean {
  const expiresAt = tokens.expiresAt ?? accessTokenExpiry(tokens.accessToken)
  // Bitiş bilgisi yoksa erken yenilemek yerine isteği olduğu gibi denemek daha az kesinti yaratır
  return expiresAt !== undefined && expiresAt - Date.now() <= marginMs
}

function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

function describeTokenError(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown }
    const error = parsed.error
    detail = str(parsed.error_description) ?? (typeof error === 'string' ? error : '')
  } catch {
    detail = body.trim().slice(0, 200)
  }
  if (status === 400 && /invalid_grant/i.test(body)) {
    return 'ChatGPT oturumu artık geçerli değil; yeniden giriş yapılmalı.'
  }
  return `ChatGPT girişi başarısız (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
