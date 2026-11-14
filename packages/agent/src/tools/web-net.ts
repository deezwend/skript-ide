/**
 * Web tool'larının ortak ağ katmanı: yalnızca http/https, yerel ağ adreslerine (SSRF) izin vermez, yönlendirmelerin her
 * adımını yeniden doğrular, yanıtı okurken boyut sınırı uygular. Testlerde `fetch` ve `lookup` sahtesi verilir.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ToolError } from '../tool'

export const USER_AGENT = 'skript-ide-agent/0.4'
const TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>
/** Ana makine adının IP adresleri. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>

export interface NetDeps {
  fetch: HttpFetch
  lookup: HostLookup
}

export const defaultNetDeps: NetDeps = {
  fetch: (url, init) => fetch(url, init),
  lookup: async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

function ipv4Blocked(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, bulut metadata servisleri
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast ve ayrılmış
  )
}

/** Yerel, özel ya da ayrılmış adres mi; agent'ın kullanıcının ağındaki servislere istek atmasını engeller. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return ipv4Blocked(address)
  if (kind !== 6) return true
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '::' || lower === '::1') return true
  const mapped = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return ipv4Blocked(mapped[1])
  // ::ffff:7f00:1 biçimi
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return ipv4Blocked(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  const first = parseInt(lower.split(':')[0] || '0', 16)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith('64:ff9b:') || // NAT64, IPv4'e çevrilebilir
    lower.startsWith('2002:') // 6to4
  )
}

/** Adresi ayrıştırır ve hedefin genel internette olduğunu doğrular. */
export async function assertPublicUrl(raw: string, lookup: HostLookup): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ToolError(`"${raw}" is not a valid URL. Use a full address such as https://example.com/page.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(`Only http and https URLs can be fetched, not ${url.protocol}`)
  if (url.username || url.password) throw new ToolError('URLs with credentials cannot be fetched.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ToolError(`${url.hostname} is a local address; web tools only reach the public internet.`)
  }
  let addresses: readonly string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await lookup(host)
    } catch {
      throw new ToolError(`Could not resolve ${host}. Check the address.`)
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new ToolError(`${url.hostname} points to a local or private network address; web tools only reach the public internet.`)
  }
  return url
}

export interface FetchedResponse {
  /** Son yönlendirmeden sonraki adres. */
  url: string
  status: number
  contentType: string
  body: string
  /** Boyut sınırı yüzünden kesildi. */
  truncated: boolean
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  /** Tüm istek (yönlendirmeler ve gövde dahil) için süre; varsayılan 30 sn. */
  timeoutMs?: number
  signal: AbortSignal
}

async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset ?? 'utf-8')
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return { text: decoder.decode(Buffer.concat(chunks)), truncated }
}

/** Güvenli istek: her yönlendirme adımı doğrulanır, gövde `maxBytes` ile sınırlanır. HTTP hata kodları da döner. */
export async function request(raw: string, options: RequestOptions, deps: NetDeps = defaultNetDeps): Promise<FetchedResponse> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)])
  let url = await assertPublicUrl(raw, deps.lookup)
  let method = options.method ?? 'GET'
  let body = options.body
  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      response = await deps.fetch(url.href, {
        method,
        body,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...options.headers }
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      const reason = signal.aborted ? 'timed out' : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
      throw new ToolError(`Request to ${url.host} failed: ${reason}`)
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) throw new ToolError(`Too many redirects starting from ${raw}.`)
      url = await assertPublicUrl(new URL(response.headers.get('location')!, url).href, deps.lookup)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    const { text, truncated } = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
    return { url: url.href, status: response.status, contentType: response.headers.get('content-type') ?? '', body: text, truncated }
  }
}

/** API'nin JSON hata gövdesindeki açıklama (`message`, `errors[].message`, `error`); yoksa boş. */
function apiErrorMessage(body: string): string {
  try {
    const data = JSON.parse(body) as { message?: unknown; error?: unknown; errors?: { message?: unknown }[] }
    const parts = [data.message, data.error, ...(Array.isArray(data.errors) ? data.errors.map((item) => item?.message) : [])]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length ? ` ${clip(parts.join(' — '), 300)}` : ''
  } catch {
    return ''
  }
}

/** JSON API çağrısı; başarısız durum kodunu okunur hataya çevirir. */
export async function requestJson<T>(url: string, options: RequestOptions, deps: NetDeps = defaultNetDeps): Promise<T> {
  const response = await request(url, { ...options, headers: { accept: 'application/json', ...options.headers } }, deps)
  if (response.status < 200 || response.status >= 300) {
    const host = new URL(response.url).host
    if (response.status === 403 || response.status === 429) throw new ToolError(`${host} refused the request (HTTP ${response.status}, probably a rate limit). Wait a minute and try again.`)
    throw new ToolError(`${host} answered HTTP ${response.status}.${apiErrorMessage(response.body)}`)
  }
  if (response.truncated) throw new ToolError(`The response from ${new URL(response.url).host} was too large.`)
  try {
    return JSON.parse(response.body) as T
  } catch {
    throw new ToolError(`${new URL(response.url).host} did not return valid JSON.`)
  }
}

/** Metni karakter sınırında keser. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
