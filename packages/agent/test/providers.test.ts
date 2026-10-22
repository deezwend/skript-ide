import test from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { fromAnthropicContent, fromAnthropicUsage, toAnthropicMessages, toAnthropicParams } from '../src/providers/anthropic'
import { fromChatUsage, OpenAICompatibleProvider, toChatMessages } from '../src/providers/openai-compatible'
import { ProviderError, textMessage, type Message, type ModelRequest } from '../src/index'

const conversation: Message[] = [
  textMessage('user', 'dosyayı oku'),
  {
    role: 'assistant',
    content: [
      { type: 'provider_data', provider: 'anthropic', data: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'provider_data', provider: 'other', data: { type: 'reasoning' } },
      { type: 'text', text: '' },
      { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.sk' } }
    ]
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', callId: 't1', content: 'yok', isError: true }]
  }
]

test('Anthropic: mesajlar API biçimine çevrilir, düşünme blokları korunur', () => {
  assert.deepEqual(toAnthropicMessages(conversation, 'anthropic'), [
    { role: 'user', content: [{ type: 'text', text: 'dosyayı oku' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.sk' } }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'yok', is_error: true }] }
  ])
})

const anthropicOptions = { providerId: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 1000 }
const readTool = { name: 'read_file', description: 'oku', inputSchema: { type: 'object' as const } }

test('Anthropic: sistem istemi ve konuşmanın son bloğu önbellek işareti alır', () => {
  const params = toAnthropicParams({ system: 'sistem', messages: conversation, tools: [readTool] }, { ...anthropicOptions, cacheTtl: '1h' })
  const cache = { type: 'ephemeral', ttl: '1h' }
  assert.deepEqual(params.system, [{ type: 'text', text: 'sistem', cache_control: cache }])
  assert.equal(params.tools?.[0].cache_control, undefined)
  const last = params.messages.at(-1)!.content as Anthropic.Beta.BetaContentBlockParam[]
  assert.deepEqual(last.at(-1), { type: 'tool_result', tool_use_id: 't1', content: 'yok', is_error: true, cache_control: cache })
  // Önceki mesajlarda işaret yok: önek her çağrıda aynı baytlarla gider
  assert.ok(!JSON.stringify(params.messages.slice(0, -1)).includes('cache_control'))
})

test('Anthropic: TTL verilmezse `ttl` gönderilmez; sistem istemi yoksa işaret son tool tanımına konur', () => {
  const params = toAnthropicParams({ system: '', messages: [textMessage('user', 'merhaba')], tools: [readTool] }, anthropicOptions)
  assert.equal(params.system, undefined)
  assert.deepEqual(params.tools?.[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(params.messages[0].content, [{ type: 'text', text: 'merhaba', cache_control: { type: 'ephemeral' } }])
})

test('Anthropic: art arda iki çağrının önekleri bayt bayt aynıdır', () => {
  const request = { system: 'sistem', tools: [readTool] }
  const first = toAnthropicParams({ ...request, messages: conversation.slice(0, 1) }, anthropicOptions)
  const second = toAnthropicParams({ ...request, messages: conversation }, anthropicOptions)
  const strip = (blocks: unknown) => JSON.stringify(blocks).replace(/,"cache_control":\{[^}]*\}/g, '')
  assert.equal(strip(second.messages.slice(0, 1)), strip(first.messages))
  assert.equal(JSON.stringify(second.system), JSON.stringify(first.system))
  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools))
})

test('Anthropic: yanıt blokları ortak biçime çevrilir', () => {
  const blocks = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'text', text: 'okuyorum', citations: null },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.sk' } }
  ] as unknown as Anthropic.Beta.BetaContentBlock[]
  assert.deepEqual(fromAnthropicContent(blocks, 'anthropic'), [
    { type: 'provider_data', provider: 'anthropic', data: blocks[0] },
    { type: 'text', text: 'okuyorum' },
    { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.sk' } }
  ])
})

test('Anthropic: yedek modele geçişten önceki düşünme ve tool_use blokları atılır', () => {
  const blocks = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'text', text: 'yarım', citations: null },
    { type: 'tool_use', id: 'old', name: 'read_file', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'tool_use', id: 'new', name: 'read_file', input: {} }
  ] as unknown as Anthropic.Beta.BetaContentBlock[]
  const content = fromAnthropicContent(blocks, 'anthropic')
  assert.deepEqual(
    content.map((block) => (block.type === 'tool_call' ? `call:${block.id}` : block.type)),
    ['text', 'provider_data', 'call:new']
  )
})

test('OpenAI uyumlu: mesajlar Chat Completions biçimine çevrilir', () => {
  assert.deepEqual(toChatMessages('sys', conversation, 'deepseek'), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'dosyayı oku' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.sk"}' } }]
    },
    { role: 'tool', tool_call_id: 't1', content: 'Error: yok' }
  ])
})

function request(): ModelRequest {
  return {
    system: 'sys',
    messages: [textMessage('user', 'selam')],
    tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
    signal: new AbortController().signal
  }
}

test('OpenAI uyumlu: istek gönderilir, tool çağrısı çözülür', async () => {
  let sent: { url: string; init: RequestInit } | undefined
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = { url, init }
    return Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'bakıyorum',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } }]
          }
        }
      ]
    })
  }) as unknown as typeof fetch

  const provider = new OpenAICompatibleProvider({
    providerId: 'openai',
    apiKey: 'key',
    baseURL: 'https://api.example.com/v1/',
    model: 'gpt',
    maxTokens: 1000,
    effort: 'high',
    fetch: fakeFetch
  })
  const response = await provider.complete(request())

  assert.equal(sent?.url, 'https://api.example.com/v1/chat/completions')
  assert.equal((sent?.init.headers as Record<string, string>).authorization, 'Bearer key')
  const body = JSON.parse(String(sent?.init.body))
  assert.equal(body.model, 'gpt')
  assert.equal(body.max_completion_tokens, 1000)
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools[0].function.name, 'echo')

  assert.equal(response.stopReason, 'tool_use')
  assert.deepEqual(response.content, [
    { type: 'text', text: 'bakıyorum' },
    { type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'a' } }
  ])
})

test('OpenAI uyumlu: HTTP hataları ProviderError olur', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 })) as unknown as typeof fetch
  const provider = new OpenAICompatibleProvider({
    providerId: 'local',
    apiKey: '',
    baseURL: 'http://127.0.0.1:1234/v1',
    model: 'm',
    maxTokens: 10,
    fetch: fakeFetch
  })
  await assert.rejects(provider.complete(request()), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.equal(error.status, 400)
    assert.equal(error.message, 'HTTP 400: bad model')
    return true
  })
})

function sse(events: unknown[]): Response {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
  // Parçaların satır ortasından bölünmesi de sınanır
  const bytes = new TextEncoder().encode(`: OPENROUTER PROCESSING\n\n${text}`)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
      controller.close()
    }
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

test('OpenAI uyumlu: akış birleştirilir, düşünme metni ve tool çağrısı ayrılır', async () => {
  let sentBody: { stream?: boolean } | undefined
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body))
    return sse([
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'Önce ' } }] },
      { choices: [{ delta: { reasoning_content: 'dosyaya bakayım.' } }] },
      { choices: [{ delta: { content: 'Bakıyorum' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'echo', arguments: '{"te' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"ğ"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]'
    ])
  }) as unknown as typeof fetch

  const provider = new OpenAICompatibleProvider({
    providerId: 'deepseek',
    apiKey: 'key',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-reasoner',
    maxTokens: 1000,
    fetch: fakeFetch
  })
  const deltas: string[] = []
  const response = await provider.complete({ ...request(), onDelta: (delta) => deltas.push(`${delta.kind}:${delta.text}`) })

  assert.equal(sentBody?.stream, true)
  assert.deepEqual(deltas, ['reasoning:Önce ', 'reasoning:dosyaya bakayım.', 'text:Bakıyorum'])
  assert.equal(response.stopReason, 'tool_use')
  assert.deepEqual(response.content, [
    { type: 'reasoning', provider: 'deepseek', text: 'Önce dosyaya bakayım.', field: 'reasoning_content' },
    { type: 'text', text: 'Bakıyorum' },
    { type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'ğ' } }
  ])
})

test('OpenAI uyumlu: akış içindeki hata ProviderError olur', async () => {
  const fakeFetch = (async () => sse([{ error: { message: 'overloaded' } }])) as unknown as typeof fetch
  const provider = new OpenAICompatibleProvider({
    providerId: 'x',
    apiKey: 'k',
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    maxTokens: 10,
    fetch: fakeFetch
  })
  await assert.rejects(provider.complete(request()), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.equal(error.message, 'overloaded')
    return true
  })
})

test('OpenAI uyumlu: düşünme metni yalnızca aynı sağlayıcıya ve son tur içinde geri gönderilir', () => {
  const reasoning = (text: string, provider = 'deepseek') =>
    ({ type: 'reasoning', provider, text, field: 'reasoning_content' }) as const
  const history: Message[] = [
    textMessage('user', 'ilk soru'),
    { role: 'assistant', content: [reasoning('eski'), { type: 'text', text: 'eski cevap' }] },
    textMessage('user', 'ikinci soru'),
    {
      role: 'assistant',
      content: [reasoning('yeni'), { type: 'tool_call', id: 't1', name: 'echo', input: {} }]
    },
    { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'ok' }] },
    { role: 'assistant', content: [reasoning('başka', 'other'), { type: 'text', text: 'ara' }] }
  ]
  const assistants = toChatMessages('', history, 'deepseek').filter((message) => message.role === 'assistant')
  assert.deepEqual(
    assistants.map((message) => message.reasoning_content),
    [undefined, 'yeni', undefined]
  )
})

test('OpenAI uyumlu: akışsız yanıttaki `reasoning` alanı okunur', async () => {
  const fakeFetch = (async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'tamam', reasoning: 'hmm' } }] })) as unknown as typeof fetch
  const provider = new OpenAICompatibleProvider({
    providerId: 'openrouter',
    apiKey: 'k',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'm',
    maxTokens: 10,
    fetch: fakeFetch
  })
  const response = await provider.complete(request())
  assert.deepEqual(response.content, [
    { type: 'reasoning', provider: 'openrouter', text: 'hmm', field: 'reasoning' },
    { type: 'text', text: 'tamam' }
  ])
})

test('Anthropic: 1 saatlik önbellek dilimi ve düşünme token’ları kullanıma taşınır', () => {
  const usage = fromAnthropicUsage({
    input_tokens: 12,
    output_tokens: 40,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
    output_tokens_details: { thinking_tokens: 25 }
  } as Anthropic.Beta.BetaUsage)

  assert.deepEqual(usage, {
    input: 12,
    cacheRead: 500,
    cacheWrite: 300,
    output: 40,
    cacheWrite1h: 200,
    reasoning: 25
  })

  // Dilim bildirilmezse alan hiç yazılmaz: "bilinmiyor" ile "sıfır" karışmasın
  const plain = fromAnthropicUsage({
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    cache_creation: null,
    output_tokens_details: null
  } as unknown as Anthropic.Beta.BetaUsage)
  assert.deepEqual(plain, { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 })
})

test('OpenAI uyumlu: usage önbellekli ve önbelleksiz girdiyi ayırır', () => {
  assert.deepEqual(fromChatUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }), {
    input: 40,
    cacheRead: 60,
    cacheWrite: 0,
    output: 7
  })
  // DeepSeek kendi alanlarını verir
  assert.deepEqual(fromChatUsage({ prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }), {
    input: 20,
    cacheRead: 80,
    cacheWrite: 0,
    output: 3
  })
  assert.equal(fromChatUsage(undefined), undefined)
  // OpenRouter uyumlu sağlayıcılar önbellek yazımını ayrı alanla verir; girdiden düşülür
  assert.deepEqual(
    fromChatUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } }),
    { input: 10, cacheRead: 60, cacheWrite: 30, output: 5 }
  )
  // Kimi üst düzey `cached_tokens` alanını kullanır; düşünme token'ları da taşınır
  assert.deepEqual(
    fromChatUsage({ prompt_tokens: 50, completion_tokens: 9, cached_tokens: 20, completion_tokens_details: { reasoning_tokens: 4 } }),
    { input: 30, cacheRead: 20, cacheWrite: 0, output: 9, reasoning: 4 }
  )
})
