import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, fetchCatalog, parseCatalog, AnthropicProvider, OpenAICompatibleProvider } from '../src/index'

const chatModel = (extra: Record<string, unknown> = {}) => ({
  name: 'Model',
  tool_call: true,
  release_date: '2026-01-01',
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 200000, output: 128000 },
  cost: { input: 1, output: 5 },
  ...extra
})

const RAW = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'claude-new': chatModel({
        id: 'claude-new',
        name: 'Claude New',
        release_date: '2026-09-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }]
      }),
      'claude-old': chatModel({ id: 'claude-old', name: 'Claude Old', status: 'deprecated' }),
      'claude-notools': chatModel({ id: 'claude-notools', tool_call: false })
    }
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    npm: '@ai-sdk/openai',
    models: {
      'gpt-chat': chatModel({
        id: 'gpt-chat',
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }]
      }),
      'gpt-responses-only': chatModel({ id: 'gpt-responses-only', provider: { shape: 'responses' } }),
      'gpt-embed': chatModel({ id: 'gpt-embed', type: 'embedding' })
    }
  },
  local: {
    id: 'local',
    name: 'Local',
    env: [],
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1234/v1',
    models: { qwen: chatModel({ id: 'qwen', limit: { context: 32000, output: 0 } }) }
  },
  'anthropic-proxy': {
    id: 'anthropic-proxy',
    name: 'Proxy',
    env: [],
    npm: '@ai-sdk/anthropic',
    models: { m: chatModel({ id: 'm' }) }
  },
  bedrock: {
    id: 'bedrock',
    name: 'Bedrock',
    env: [],
    npm: '@ai-sdk/amazon-bedrock',
    models: { m: chatModel({ id: 'm' }) }
  }
}

test('katalog tool çağırabilen, desteklenen modelleri süzer', () => {
  const providers = parseCatalog(RAW)
  assert.deepEqual(
    providers.map((p) => p.id),
    ['anthropic', 'local', 'openai']
  )

  const anthropic = providers.find((p) => p.id === 'anthropic')!
  assert.deepEqual(anthropic.env, ['ANTHROPIC_API_KEY'])
  assert.deepEqual(anthropic.models.map((m) => m.id), ['claude-new'])
  assert.deepEqual(anthropic.models[0], {
    id: 'claude-new',
    name: 'Claude New',
    family: undefined,
    protocol: 'anthropic',
    baseURL: undefined,
    reasoning: true,
    effortLevels: ['low', 'medium', 'high'],
    contextWindow: 200000,
    maxOutput: 128000,
    images: false,
    cost: { input: 1, output: 5 },
    releaseDate: '2026-09-01',
    status: undefined
  })

  const openai = providers.find((p) => p.id === 'openai')!
  assert.deepEqual(openai.models.map((m) => m.id), ['gpt-chat'])
  assert.equal(openai.models[0]?.baseURL, 'https://api.openai.com/v1')
  assert.deepEqual(openai.models[0]?.effortLevels, ['low', 'high'])

  assert.equal(providers.find((p) => p.id === 'local')?.models[0]?.baseURL, 'http://127.0.0.1:1234/v1')
})

test('bozuk katalog reddedilir, bozuk girdiler atlanır', () => {
  assert.throws(() => parseCatalog([]), /beklenmeyen/)
  assert.deepEqual(parseCatalog({ x: 5, y: { models: { a: 'bad' } } }), [])
})

test('fetchCatalog models.dev adresini indirir', async () => {
  let requested = ''
  const fakeFetch = (async (url: string) => {
    requested = url
    return new Response(JSON.stringify(RAW))
  }) as typeof fetch
  const providers = await fetchCatalog(undefined, fakeFetch)
  assert.equal(requested, 'https://models.dev/api.json')
  assert.equal(providers.length, 3)

  const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
  await assert.rejects(fetchCatalog(undefined, failing), /HTTP 503/)
})

test('createProvider protokole göre adaptör seçer', () => {
  const providers = parseCatalog(RAW)
  const anthropic = providers.find((p) => p.id === 'anthropic')!
  const local = providers.find((p) => p.id === 'local')!
  assert.ok(createProvider(anthropic, anthropic.models[0]!, { apiKey: 'k' }) instanceof AnthropicProvider)
  assert.ok(createProvider(local, local.models[0]!, { apiKey: '' }) instanceof OpenAICompatibleProvider)
})
