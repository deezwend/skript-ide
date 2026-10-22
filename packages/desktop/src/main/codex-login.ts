import { createServer, type Server } from 'node:http'
import {
  authorizationUrl,
  callbackUrl,
  CODEX_CALLBACK_PORT,
  CODEX_FALLBACK_CALLBACK_PORT,
  exchangeCode,
  generatePkce,
  generateState,
  parseCallback,
  ProviderError,
  type CodexTokens
} from '@skript-ide/agent'
import { l } from '@skript-ide/i18n'

/**
 * ChatGPT aboneliğiyle giriş: tarayıcıda OpenAI oturumu açılır, dönen kod yerel bir geri dönüş
 * sunucusunda yakalanıp jetonlara çevrilir. Jetonları çağıran (ana süreç) şifreleyip saklar.
 */
export interface CodexLoginOptions {
  /** Tarayıcıda açılacak adres. Açılamazsa kullanıcı adresi kendisi açabilir. */
  onAuthUrl: (url: string) => void
  signal?: AbortSignal
  /** Kullanıcı girişi tamamlamazsa bu süre sonunda vazgeçilir. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export async function loginWithChatGPT(options: CodexLoginOptions): Promise<CodexTokens> {
  const pkce = generatePkce()
  const state = generateState()
  const { server, port } = await listen(CODEX_CALLBACK_PORT)
  const redirectUri = callbackUrl(port)
  const authUrl = authorizationUrl({ redirectUri, pkce, state })

  try {
    return await new Promise<CodexTokens>((resolve, reject) => {
      let settled = false
      /** Tarayıcı yanıtı okuyabilsin diye bağlantılar hemen kesilmez. */
      const shutdown = () => {
        server.close()
        setTimeout(() => server.closeAllConnections(), 1500).unref()
      }
      const finish = (result: { tokens: CodexTokens } | { error: Error }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        shutdown()
        if ('error' in result) reject(result.error)
        else resolve(result.tokens)
      }
      const onAbort = () => finish({ error: new ProviderError('ChatGPT girişi iptal edildi.') })
      const timer = setTimeout(
        () => finish({ error: new ProviderError('ChatGPT girişi zaman aşımına uğradı; yeniden deneyin.') }),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
        return
      }

      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/auth/callback') {
          const callback = parseCallback(request.url ?? '')
          if (callback.state !== state) {
            response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('State mismatch')
            finish({ error: new ProviderError('ChatGPT girişi doğrulanamadı (state uyuşmuyor); yeniden deneyin.') })
            return
          }
          if (callback.error) {
            const message = describeCallbackError(callback.error, callback.errorDescription)
            sendPage(response, message, false)
            finish({ error: new ProviderError(message) })
            return
          }
          if (!callback.code) {
            sendPage(response, l('Giriş kodu gelmedi.', 'No sign-in code was returned.'), false)
            finish({ error: new ProviderError('ChatGPT girişinden kod dönmedi; yeniden deneyin.') })
            return
          }
          exchangeCode({ code: callback.code, redirectUri, verifier: pkce.verifier })
            .then((tokens) => {
              sendPage(response, l('Giriş tamam. Bu sekmeyi kapatıp Skript IDE’ye dönebilirsin.', 'Signed in. You can close this tab and return to Skript IDE.'), true)
              finish({ tokens })
            })
            .catch((error: Error) => {
              sendPage(response, error.message, false)
              finish({ error })
            })
          return
        }
        if (url.pathname === '/cancel') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Cancelled')
          finish({ error: new ProviderError('ChatGPT girişi iptal edildi.') })
          return
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
      })

      options.onAuthUrl(authUrl)
    })
  } finally {
    // Yanıt gönderildikten sonra kapanış; `finish` zaten kapattıysa zararsız
    server.close()
    setTimeout(() => server.closeAllConnections(), 1500).unref()
  }
}

/** 1455 doluysa Codex CLI ile aynı yedek bağlantı noktasına geçilir. */
function listen(preferred: number): Promise<{ server: Server; port: number }> {
  const ports = preferred === CODEX_CALLBACK_PORT ? [CODEX_CALLBACK_PORT, CODEX_FALLBACK_CALLBACK_PORT] : [preferred]
  return new Promise((resolve, reject) => {
    const attempt = (index: number) => {
      const server = createServer()
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && index + 1 < ports.length) {
          server.close()
          attempt(index + 1)
          return
        }
        reject(
          error.code === 'EADDRINUSE'
            ? new ProviderError(
                l(
                  `ChatGPT girişi için ${ports.join(' ve ')} bağlantı noktaları kullanımda. Başka bir Codex oturumunu kapatın.`,
                  `Ports ${ports.join(' and ')} are in use, so ChatGPT sign-in cannot listen. Close other Codex sessions.`
                )
              )
            : new ProviderError(l(`ChatGPT giriş sunucusu açılamadı: ${error.message}`, `Could not start the ChatGPT sign-in server: ${error.message}`))
        )
      })
      server.listen(ports[index], '127.0.0.1', () => {
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address ? address.port : ports[index] })
      })
    }
    attempt(0)
  })
}

function sendPage(response: import('node:http').ServerResponse, message: string, success: boolean): void {
  const title = success ? l('Giriş tamamlandı', 'Signed in') : l('Giriş tamamlanamadı', 'Sign-in failed')
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#1e1e1e;color:#ddd}
main{max-width:32rem;padding:2rem;border:1px solid #333;border-radius:8px}h1{font-size:1.1rem;margin:0 0 .75rem}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(html)
}

/** ChatGPT girişi reddettiyse kullanıcıya anlaşılır neden gösterilir. */
function describeCallbackError(code: string, description: string | undefined): string {
  if (code === 'access_denied' && /missing_codex_entitlement/i.test(description ?? '')) {
    return l(
      'Bu ChatGPT çalışma alanında Codex etkin değil; çalışma alanı yöneticinden erişim isteyin.',
      'Codex is not enabled for this ChatGPT workspace; ask your workspace administrator for access.'
    )
  }
  return l(`ChatGPT girişi reddedildi (${code}${description ? `: ${description}` : ''}).`, `ChatGPT sign-in was rejected (${code}${description ? `: ${description}` : ''}).`)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}
