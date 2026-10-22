import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  authorizationUrl,
  callbackUrl,
  CODEX_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_PROVIDER_ID,
  CodexProvider,
  codexCatalogProvider,
  createProvider,
  exchangeCode,
  generatePkce,
  needsRefresh,
  parseCallback,
  parseCodexModels,
  parseIdTokenClaims,
  refreshTokens,
  textMessage,
  type CatalogModel,
  type Message,
  type ModelRequest
} from '../src/index'
import { fromResponsesResult, readResponsesStream, toResponsesBody, toResponsesInput } from '../src/providers/codex'

/** İmzası doğrulanmayan test jetonu; yalnızca gövdesi okunur. */
function jwt(payload: unknown): string {
  return ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.')
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const pkce = { verifier: 'verifier', challenge: 'challenge' }

test('Codex: yetkilendirme adresi Codex CLI ile aynı parametreleri taşır', () => {
  const url = new URL(authorizationUrl({ redirectUri: callbackUrl(1455), pkce, state: 'st' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
  const q = url.searchParams
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
  assert.equal(q.get('code_challenge'), 'challenge')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('state'), 'st')
  assert.match(q.get('scope') ?? '', /offline_access/)
  assert.equal(q.get('originator'), 'codex_cli_rs')
})

test('Codex: PKCE çifti S256 özeti üretir', () => {
  const codes = generatePkce()
  assert.equal(codes.verifier.length, 86)
  assert.equal(codes.challenge, createHash('sha256').update(codes.verifier).digest('base64url'))
  assert.notEqual(codes.verifier, generatePkce().verifier)
})

test('Codex: geri dönüş sorgusu çözülür', () => {
  assert.deepEqual(parseCallback('/auth/callback?code=abc&state=st'), { code: 'abc', state: 'st' })
  assert.deepEqual(parseCallback('/auth/callback?error=access_denied&error_description=missing_codex_entitlement'), {
    error: 'access_denied',
    errorDescription: 'missing_codex_entitlement'
  })
})

const idToken = jwt({
  email: 'a@example.com',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus', chatgpt_user_id: 'u1' },
  exp: Math.floor(Date.now() / 1000) + 3600
})

test('Codex: kod değişimi form olarak gönderilir, hesap bilgisi id_token’dan okunur', async () => {
  let sent: { url: string; init: RequestInit } | undefined
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url, init }
    return tokenResponse({ access_token: 'access', refresh_token: 'refresh', id_token: idToken, expires_in: 3600 })
  }) as unknown as typeof fetch

  const tokens = await exchangeCode({ code: 'c', redirectUri: 'http://127.0.0.1:1455/auth/callback', verifier: 'v', fetch: fakeFetch })
  assert.equal(sent?.url, 'https://auth.openai.com/oauth/token')
  assert.equal((sent?.init.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(String(sent?.init.body))
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(form.get('code_verifier'), 'v')
  assert.equal(tokens.accessToken, 'access')
  assert.equal(tokens.refreshToken, 'refresh')
  assert.equal(tokens.accountId, 'acc-1')
  assert.equal(tokens.email, 'a@example.com')
  assert.equal(tokens.plan, 'plus')
  assert.ok((tokens.expiresAt ?? 0) > Date.now())
})

test('Codex: yenileme JSON gövdesiyle istenir, yeni refresh token yoksa eskisi korunur', async () => {
  let sent: RequestInit | undefined
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent = init
    return tokenResponse({ access_token: 'new-access', expires_in: 60 })
  }) as unknown as typeof fetch

  const tokens = await refreshTokens({ refreshToken: 'old-refresh', fetch: fakeFetch })
  assert.equal((sent?.headers as Record<string, string>)['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(sent?.body)), {
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: 'old-refresh'
  })
  assert.equal(tokens.accessToken, 'new-access')
  assert.equal(tokens.refreshToken, 'old-refresh')
})

test('Codex: reddedilen yenileme anlaşılır hataya dönüşür', async () => {
  const fakeFetch = (async () => tokenResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch
  await assert.rejects(refreshTokens({ refreshToken: 'r', fetch: fakeFetch }), /oturumu artık geçerli değil/)
})

test('Codex: jeton bitişi ve yenileme eşiği', () => {
  const claims = parseIdTokenClaims(idToken)
  assert.equal(claims.accountId, 'acc-1')
  assert.equal(claims.expiresAt! > Date.now(), true)
  assert.equal(needsRefresh({ accessToken: idToken }), false)
  const soon = jwt({ exp: Math.floor(Date.now() / 1000) + 30 })
  assert.equal(needsRefresh({ accessToken: soon }), true)
  // Bitiş bilgisi okunamıyorsa erken yenilenmez
  assert.equal(needsRefresh({ accessToken: 'not-a-jwt' }), false)
})

test('Codex: hesabın model listesi çözülür, gizli ve API dışı modeller atlanır', () => {
  const models = parseCodexModels({
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'api-off', display_name: 'API off', supported_in_api: false },
      { slug: 'plain', context_window: 1000 }
    ]
  })
  assert.deepEqual(
    models.map((m) => [m.id, m.name, m.protocol, m.effortLevels, m.contextWindow]),
    [
      ['gpt-6.1-sol', 'GPT-6.1-Sol', 'codex', ['low', 'high'], 272_000],
      ['plain', 'plain', 'codex', undefined, 1000]
    ]
  )
  assert.equal(models[0].baseURL, CODEX_BASE_URL)
})

test('Codex: katalog sağlayıcısı abonelik girişiyle işaretlenir', () => {
  const provider = codexCatalogProvider()
  assert.equal(provider.id, CODEX_PROVIDER_ID)
  assert.equal(provider.login, 'chatgpt')
  assert.ok(provider.models.length > 0)
})

test('Codex: createProvider abonelik adaptörünü kurar, jeton çağrı anında sorulur', async () => {
  const model: CatalogModel = { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', protocol: 'codex', reasoning: true, contextWindow: 0, maxOutput: 0 }
  let asked = 0
  const provider = createProvider(codexCatalogProvider([model]), model, {
    apiKey: '',
    codexAuth: async () => {
      asked++
      return { accessToken: 'token', accountId: 'acc' }
    }
  })
  assert.equal(asked, 0)
  assert.equal(provider.constructor.name, 'CodexProvider')
})

const readTool = { name: 'read_file', description: 'oku', inputSchema: { type: 'object' as const } }

const conversation: Message[] = [
  textMessage('user', 'dosyayı oku'),
  {
    role: 'assistant',
    content: [
      { type: 'provider_data', provider: 'openai-codex', data: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' } },
      { type: 'text', text: 'bakıyorum' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.sk' } }
    ]
  },
  { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', content: 'yok', isError: true }] },
  {
    role: 'assistant',
    content: [
      { type: 'provider_data', provider: 'other', data: { type: 'reasoning', encrypted_content: 'x' } },
      { type: 'provider_data', provider: 'openai-codex', data: { type: 'reasoning', id: 'rs_2', encrypted_content: 'enc2' } }
    ]
  }
]

test('Codex: mesajlar Responses girdisine çevrilir, düşünme yalnızca son turda geri gönderilir', () => {
  assert.deepEqual(toResponsesInput(conversation, 'openai-codex'), [
    { role: 'user', content: [{ type: 'input_text', text: 'dosyayı oku' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'bakıyorum' }] },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.sk"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Error: yok' },
    { type: 'reasoning', id: 'rs_2', encrypted_content: 'enc2' }
  ])
})

test('Codex: istek gövdesi sistem istemini, araçları ve önbellek anahtarını taşır', () => {
  const body = toResponsesBody(
    { system: 'sistem', messages: [textMessage('user', 'selam')], tools: [readTool] },
    { providerId: 'openai-codex', model: 'gpt-6.1-sol', effort: 'high', sessionId: 'session-1' }
  )
  assert.equal(body.instructions, 'sistem')
  assert.equal(body.model, 'gpt-6.1-sol')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(body.prompt_cache_key, 'session-1')
  assert.deepEqual(body.tools[0], {
    type: 'function',
    name: 'read_file',
    description: 'oku',
    parameters: { type: 'object' },
    strict: false
  })
  // Düşünme desteklemeyen modelde `reasoning` hiç gönderilmez
  const noReasoning = toResponsesBody({ system: '', messages: [], tools: [] }, { providerId: 'p', model: 'm', reasoning: false })
  assert.equal(noReasoning.reasoning, undefined)
  assert.equal(noReasoning.instructions, undefined)
})

function sse(events: unknown[]): Response {
  const text = events.map((event) => `event: ${(event as { type?: string }).type ?? 'x'}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5))
      controller.close()
    }
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function request(): ModelRequest {
  return {
    system: 'sys',
    messages: [textMessage('user', 'selam')],
    tools: [readTool],
    signal: new AbortController().signal
  }
}

test('Codex: akış okunur, tool çağrısı ve kullanım ayrıştırılır', async () => {
  let sent: { url: string; init: RequestInit } | undefined
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url, init }
    return sse([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'Önce ' },
      { type: 'response.reasoning_summary_text.delta', delta: 'dosyaya bakayım.' },
      { type: 'response.output_text.delta', delta: 'Okuyorum' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [{ type: 'summary_text', text: 'Önce dosyaya bakayım.' }] }
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.sk"}' }
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [{ type: 'summary_text', text: 'Önce dosyaya bakayım.' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Okuyorum' }] },
            { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.sk"}' }
          ],
          usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 3 } }
        }
      }
    ])
  }) as unknown as typeof fetch

  const codex = new CodexProvider({
    providerId: 'openai-codex',
    auth: async () => ({ accessToken: 'token', accountId: 'acc' }),
    baseURL: CODEX_BASE_URL,
    model: 'gpt-6.1-sol',
    reasoning: true,
    effort: 'high',
    sessionId: 'session-1',
    fetch: fakeFetch
  })

  const deltas: string[] = []
  const response = await codex.complete({ ...request(), onDelta: (delta) => deltas.push(`${delta.kind}:${delta.text}`) })

  assert.equal(sent?.url, `${CODEX_BASE_URL}/responses`)
  const headers = sent?.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer token')
  assert.equal(headers['chatgpt-account-id'], 'acc')
  assert.equal(headers.originator, 'codex_cli_rs')
  assert.equal(headers['session-id'], 'session-1')
  const body = JSON.parse(String(sent?.init.body))
  assert.equal(body.instructions, 'sys')
  assert.equal(body.reasoning.effort, 'high')

  assert.deepEqual(deltas, ['reasoning:Önce ', 'reasoning:dosyaya bakayım.', 'text:Okuyorum'])
  assert.equal(response.stopReason, 'tool_use')
  assert.deepEqual(
    response.content.map((block) => block.type),
    ['provider_data', 'reasoning', 'text', 'tool_call']
  )
  assert.deepEqual(
    response.content.filter((block) => block.type !== 'reasoning'),
    [
      { type: 'provider_data', provider: 'openai-codex', data: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [{ type: 'summary_text', text: 'Önce dosyaya bakayım.' }] } },
      { type: 'text', text: 'Okuyorum' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.sk' } }
    ]
  )
  assert.deepEqual(response.usage, { input: 40, cacheRead: 60, cacheWrite: 0, output: 7, reasoning: 3 })
})

test('Codex: kesilen ve filtrelenen yanıtlar ayrı durur', () => {
  const incomplete = fromResponsesResult({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'openai-codex')
  assert.equal(incomplete.stopReason, 'max_tokens')
  const filtered = fromResponsesResult({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'openai-codex')
  assert.equal(filtered.stopReason, 'refusal')
  // `failed` yanıtı içerik üretmez: hata olarak yüzeye çıkar
  assert.throws(() => fromResponsesResult({ status: 'failed', output: [], error: { message: 'denied' } }, 'openai-codex'), /denied/)
})

test('Codex: akış içindeki hata ProviderError olur', async () => {
  const fakeFetch = (async () =>
    sse([{ type: 'response.failed', response: { status: 'failed', error: { message: 'quota' } } }])) as unknown as typeof fetch
  const codex = new CodexProvider({
    providerId: 'openai-codex',
    auth: async () => ({ accessToken: 'token' }),
    baseURL: CODEX_BASE_URL,
    model: 'm',
    fetch: fakeFetch
  })
  await assert.rejects(codex.complete(request()), /quota/)
})

test('Codex: HTTP hataları ProviderError olur', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })) as unknown as typeof fetch
  const codex = new CodexProvider({
    providerId: 'openai-codex',
    auth: async () => ({ accessToken: 'token' }),
    baseURL: CODEX_BASE_URL,
    model: 'm',
    fetch: fakeFetch
  })
  await assert.rejects(codex.complete(request()), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 404)
    return true
  })
})

test('Codex: akışsız JSON yanıtı da okunur', async () => {
  const fakeFetch = (async () =>
    Response.json({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'tamam' }] }]
    })) as unknown as typeof fetch
  const codex = new CodexProvider({
    providerId: 'openai-codex',
    auth: async () => ({ accessToken: 'token' }),
    baseURL: CODEX_BASE_URL,
    model: 'm',
    fetch: fakeFetch
  })
  const response = await codex.complete(request())
  assert.equal(response.stopReason, 'end')
  assert.deepEqual(response.content, [{ type: 'text', text: 'tamam' }])
  // `readResponsesStream` doğrudan da kullanılabilir
  assert.ok(typeof readResponsesStream === 'function')
})
