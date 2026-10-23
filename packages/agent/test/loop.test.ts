import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineTool,
  ProviderError,
  runAgent,
  textMessage,
  ToolError,
  ToolRegistry,
  type AgentEvent,
  type ModelResponse,
  type ToolResultBlock
} from '../src/index'
import { callTool, FakeProvider, reply } from './fakes/provider'
import { makeContext } from './helpers'

const echoTool = defineTool<{ text: string }>({
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  permission: 'read',
  async execute({ text }) {
    return `echo: ${text}`
  }
})

let executedWrites = 0
const writeTool = defineTool<{ value: string }>({
  name: 'set_value',
  description: 'Store a value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  permission: 'write',
  async preview({ value }) {
    return { summary: `Set value to ${value}` }
  },
  async execute() {
    executedWrites++
    return 'stored'
  }
})

const failingTool = defineTool<Record<string, never>>({
  name: 'fail',
  description: 'Always fails.',
  inputSchema: { type: 'object', properties: {} },
  permission: 'read',
  async execute() {
    throw new ToolError('nothing here')
  }
})

function lastToolResult(provider: FakeProvider): ToolResultBlock {
  const messages = provider.requests.at(-1)!.messages
  const block = messages.at(-1)!.content[0]
  assert.equal(block?.type, 'tool_result')
  return block as ToolResultBlock
}

const registry = new ToolRegistry([echoTool, writeTool, failingTool])

test('tool istemeyen yanıtta döngü tek turda biter', async () => {
  const provider = new FakeProvider([reply('merhaba')])
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: 'sys',
    messages: [textMessage('user', 'selam')]
  })
  assert.equal(result.reason, 'end')
  assert.equal(result.messages.length, 2)
  assert.equal(provider.requests.length, 1)
  assert.equal(provider.requests[0]?.system, 'sys')
  assert.deepEqual(
    provider.requests[0]?.tools.map((tool) => tool.name),
    ['echo', 'set_value', 'fail']
  )
})

test('tool sonucu modele geri verilir ve döngü sürer', async () => {
  const provider = new FakeProvider([callTool('echo', { text: 'a' }), reply('bitti')])
  const events: AgentEvent['type'][] = []
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')],
    onEvent: (event) => events.push(event.type)
  })
  assert.equal(result.reason, 'end')
  assert.equal(provider.requests.length, 2)
  const toolResult = lastToolResult(provider)
  assert.equal(toolResult.content, 'echo: a')
  assert.equal(toolResult.isError, undefined)
  assert.deepEqual(events, ['assistant-message', 'tool-start', 'tool-result', 'assistant-message', 'done'])
  // Girdi dizisi değiştirilmez
  assert.equal(result.messages.length, 4)
})

test('akan parçalar delta olayı olarak iletilir', async () => {
  const provider = new FakeProvider([
    (request) => {
      request.onDelta?.({ kind: 'reasoning', text: 'düşün' })
      request.onDelta?.({ kind: 'text', text: 'cevap' })
      return reply('cevap')
    }
  ])
  const events: AgentEvent[] = []
  await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')],
    onEvent: (event) => events.push(event)
  })
  assert.deepEqual(
    events.flatMap((event) => (event.type === 'delta' ? [event.delta] : [])),
    [
      { kind: 'reasoning', text: 'düşün' },
      { kind: 'text', text: 'cevap' }
    ]
  )
  assert.equal(events.at(-2)?.type, 'assistant-message')
})

test('bilinmeyen tool ve geçersiz girdi hata sonucu olarak döner', async () => {
  const provider = new FakeProvider([callTool('nope', {}), callTool('echo', { text: 5 }), reply('tamam')])
  await runAgent({ provider, registry, context: makeContext(), system: '', messages: [textMessage('user', 'x')] })

  const unknown = provider.requests[1]!.messages.at(-1)!.content[0] as ToolResultBlock
  assert.equal(unknown.isError, true)
  assert.match(unknown.content, /Unknown tool/)

  const invalid = lastToolResult(provider)
  assert.equal(invalid.isError, true)
  assert.match(invalid.content, /input\.text/)
})

test('ToolError mesajı modele aynen iletilir', async () => {
  const provider = new FakeProvider([callTool('fail', {}), reply('tamam')])
  await runAgent({ provider, registry, context: makeContext(), system: '', messages: [textMessage('user', 'x')] })
  const result = lastToolResult(provider)
  assert.equal(result.isError, true)
  assert.equal(result.content, 'nothing here')
})

test('write tool onay ister; reddedilirse çalışmaz', async () => {
  executedWrites = 0
  const context = makeContext({ approve: false })
  const provider = new FakeProvider([callTool('set_value', { value: 'x' }), reply('tamam')])
  await runAgent({ provider, registry, context, system: '', messages: [textMessage('user', 'x')] })

  assert.equal(executedWrites, 0)
  assert.equal(context.approvals.length, 1)
  assert.equal(context.approvals[0]?.summary, 'Set value to x')
  assert.match(lastToolResult(provider).content, /rejected/)
})

test('read tool onay istemez, onaylanan write tool çalışır', async () => {
  executedWrites = 0
  const context = makeContext({ approve: true })
  const provider = new FakeProvider([
    callTool('echo', { text: 'a' }),
    callTool('set_value', { value: 'y' }),
    reply('tamam')
  ])
  await runAgent({ provider, registry, context, system: '', messages: [textMessage('user', 'x')] })
  assert.equal(executedWrites, 1)
  assert.equal(context.approvals.length, 1)
})

test('always-ask: okuma tool\'u da onay ister', async () => {
  const context = makeContext({ approve: true })
  const provider = new FakeProvider([callTool('echo', { text: 'a' }), reply('tamam')])
  await runAgent({
    provider,
    registry,
    context,
    system: '',
    messages: [textMessage('user', 'x')],
    permissionMode: () => 'always-ask'
  })
  assert.equal(context.approvals.length, 1)
  assert.equal(context.approvals[0]?.tool, 'echo')
})

test('never-ask: write tool onaysız çalışır', async () => {
  executedWrites = 0
  const context = makeContext({ approve: false })
  const provider = new FakeProvider([callTool('set_value', { value: 'x' }), reply('tamam')])
  await runAgent({
    provider,
    registry,
    context,
    system: '',
    messages: [textMessage('user', 'x')],
    permissionMode: () => 'never-ask'
  })
  assert.equal(executedWrites, 1)
  assert.equal(context.approvals.length, 0)
})

test('maxTurns aşılınca durur', async () => {
  const provider = new FakeProvider(Array.from({ length: 5 }, () => callTool('echo', { text: 'a' })))
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')],
    maxTurns: 3
  })
  assert.equal(result.reason, 'max_turns')
  assert.equal(provider.requests.length, 3)
})

test('kesilen yanıttaki tool çağrısı çalıştırılmaz ve geçmişten çıkarılır', async () => {
  const provider = new FakeProvider([{ ...callTool('echo', { text: 'a' }, 'yarım'), stopReason: 'max_tokens' }])
  const events: AgentEvent['type'][] = []
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')],
    onEvent: (event) => events.push(event.type)
  })
  assert.equal(result.reason, 'max_tokens')
  assert.deepEqual(result.messages.at(-1)?.content, [{ type: 'text', text: 'yarım' }])
  assert.deepEqual(events, ['assistant-message', 'done'])
})

test('reddetme yanıtında döngü durur', async () => {
  const provider = new FakeProvider([{ content: [], stopReason: 'refusal' }])
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')]
  })
  assert.equal(result.reason, 'refusal')
})

test('iptal edilince AbortError fırlatır', async () => {
  const controller = new AbortController()
  const provider = new FakeProvider([
    () => {
      controller.abort()
      return callTool('echo', { text: 'a' })
    }
  ])
  await assert.rejects(
    runAgent({
      provider,
      registry,
      context: makeContext({ signal: controller.signal }),
      system: '',
      messages: [textMessage('user', 'x')]
    }),
    { name: 'AbortError' }
  )
})

test('registry geçersiz ya da tekrar eden adı reddeder', () => {
  assert.throws(() => new ToolRegistry([echoTool, echoTool]), /zaten kayıtlı/)
  assert.throws(() => new ToolRegistry([{ ...echoTool, name: 'Bad Name' }]), /Geçersiz tool adı/)
})


// --- Paralel okuma çağrıları ---

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let active = 0
let maxActive = 0
const runLog: string[] = []

/** Eşzamanlılığı ölçmek için gecikmeli okuma tool'u. */
const slowRead = defineTool<{ name: string }>({
  name: 'slow_read',
  description: 'Read slowly.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  permission: 'read',
  async execute({ name }) {
    active++
    maxActive = Math.max(maxActive, active)
    runLog.push(`start:${name}`)
    await delay(15)
    runLog.push(`end:${name}`)
    active--
    return name
  }
})

let writeActive = 0
let maxWriteActive = 0
const slowWrite = defineTool<{ name: string }>({
  name: 'slow_write',
  description: 'Write slowly.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  permission: 'write',
  async preview({ name }) {
    return { summary: name }
  },
  async execute({ name }) {
    writeActive++
    maxWriteActive = Math.max(maxWriteActive, writeActive)
    runLog.push(`start:${name}`)
    await delay(10)
    runLog.push(`end:${name}`)
    writeActive--
    return name
  }
})

/** Tek yanıtta birden çok tool çağrısı üretir. */
function batch(names: { name: string; write?: boolean }[]): ModelResponse {
  return {
    content: names.map(({ name, write }, index) => ({
      type: 'tool_call' as const,
      id: `c${index}`,
      name: write ? 'slow_write' : 'slow_read',
      input: { name }
    })),
    stopReason: 'tool_use'
  }
}

const parallelRegistry = new ToolRegistry([slowRead, slowWrite])

test('ardışık okuma çağrıları eşzamanlı çalışır ve en fazla 8 tanesi aynı anda koşar', async () => {
  active = 0
  maxActive = 0
  runLog.length = 0
  const provider = new FakeProvider([batch(Array.from({ length: 10 }, (_, i) => ({ name: String(i) }))), reply('done')])
  const result = await runAgent({
    provider,
    registry: parallelRegistry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')]
  })
  assert.equal(result.reason, 'end')
  assert.equal(maxActive, 8)
  const blocks = provider.requests[1]!.messages.at(-1)!.content as ToolResultBlock[]
  assert.deepEqual(
    blocks.map((block) => block.callId),
    Array.from({ length: 10 }, (_, i) => `c${i}`)
  )
  assert.deepEqual(
    blocks.map((block) => block.content),
    Array.from({ length: 10 }, (_, i) => String(i))
  )
})

test('write çağrısı bariyer gibidir: önceki okumalar biter, sonraki okuma ondan sonra başlar', async () => {
  active = 0
  maxActive = 0
  writeActive = 0
  maxWriteActive = 0
  runLog.length = 0
  const provider = new FakeProvider([batch([{ name: 'a' }, { name: 'b' }, { name: 'w', write: true }, { name: 'c' }]), reply('done')])
  await runAgent({
    provider,
    registry: parallelRegistry,
    context: makeContext({ approve: true }),
    system: '',
    messages: [textMessage('user', 'x')]
  })

  assert.equal(maxActive, 2)
  assert.equal(maxWriteActive, 1)
  assert.ok(runLog.indexOf('start:w') > runLog.indexOf('start:a'))
  assert.ok(runLog.indexOf('start:w') > runLog.indexOf('start:b'))
  assert.ok(runLog.indexOf('start:w') > runLog.indexOf('end:a'))
  assert.ok(runLog.indexOf('start:w') > runLog.indexOf('end:b'))
  assert.ok(runLog.indexOf('start:c') > runLog.indexOf('end:w'))
})

test('paralel grupta iptal AbortError fırlatır', async () => {
  const controller = new AbortController()
  const provider = new FakeProvider([batch([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), reply('done')])
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(
    runAgent({
      provider,
      registry: parallelRegistry,
      context: makeContext({ signal: controller.signal }),
      system: '',
      messages: [textMessage('user', 'x')]
    }),
    { name: 'AbortError' }
  )
  assert.equal(provider.requests.length, 1)
})

test('bilinmeyen tool ve geçersiz girdi, paralel okumaların arasında sırasıyla hata döner', async () => {
  const registry = new ToolRegistry([slowRead])
  const provider = new FakeProvider([
    {
      content: [
        { type: 'tool_call', id: 'a', name: 'slow_read', input: { name: 'a' } },
        { type: 'tool_call', id: 'x', name: 'nope', input: {} },
        { type: 'tool_call', id: 'i', name: 'slow_read', input: { name: 5 } },
        { type: 'tool_call', id: 'b', name: 'slow_read', input: { name: 'b' } }
      ],
      stopReason: 'tool_use'
    },
    reply('done')
  ])
  await runAgent({ provider, registry, context: makeContext(), system: '', messages: [textMessage('user', 'x')] })
  const blocks = provider.requests[1]!.messages.at(-1)!.content as ToolResultBlock[]
  assert.deepEqual(
    blocks.map((block) => block.callId),
    ['a', 'x', 'i', 'b']
  )
  assert.equal(blocks[1]!.isError, true)
  assert.match(blocks[1]!.content, /Unknown tool/)
  assert.equal(blocks[2]!.isError, true)
  assert.match(blocks[2]!.content, /input\.name/)
  assert.equal(blocks[0]!.content, 'a')
  assert.equal(blocks[3]!.content, 'b')
})

test('always-ask modunda okuma çağrıları paralel çalışmaz', async () => {
  active = 0
  maxActive = 0
  const registry = new ToolRegistry([slowRead])
  const provider = new FakeProvider([batch([{ name: 'a' }, { name: 'b' }]), reply('done')])
  await runAgent({
    provider,
    registry,
    context: makeContext({ approve: true }),
    system: '',
    messages: [textMessage('user', 'x')],
    permissionMode: () => 'always-ask'
  })
  assert.equal(maxActive, 1)
})

test('geçici sağlayıcı hatası retry olayıyla yeniden denenir', async () => {
  const provider = new FakeProvider([
    () => {
      throw new ProviderError('Sağlayıcının yanıtı okunamadı: terminated', undefined, { retryable: true })
    },
    reply('tamam')
  ])
  const events: AgentEvent[] = []
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: '',
    messages: [textMessage('user', 'x')],
    retryDelaysMs: [0, 0],
    onEvent: (event) => events.push(event)
  })
  assert.equal(result.reason, 'end')
  assert.equal(provider.requests.length, 2)
  assert.deepEqual(
    events.find((event) => event.type === 'retry'),
    { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 0, error: 'Sağlayıcının yanıtı okunamadı: terminated' }
  )
})

test('yeniden deneme hakkı bitince ya da hata kalıcıysa hata fırlatılır', async () => {
  const transient = () => {
    throw new ProviderError('koptu', undefined, { retryable: true })
  }
  const exhausted = new FakeProvider([transient, transient, transient])
  await assert.rejects(
    runAgent({ provider: exhausted, registry, context: makeContext(), system: '', messages: [textMessage('user', 'x')], retryDelaysMs: [0, 0] }),
    /koptu/
  )
  assert.equal(exhausted.requests.length, 3)

  const permanent = new FakeProvider([
    () => {
      throw new ProviderError('API anahtarı geçersiz.', 401)
    }
  ])
  await assert.rejects(
    runAgent({ provider: permanent, registry, context: makeContext(), system: '', messages: [textMessage('user', 'x')], retryDelaysMs: [0, 0] }),
    /API anahtarı/
  )
  assert.equal(permanent.requests.length, 1)
})

test('iptal yeniden deneme beklemesini keser', async () => {
  const controller = new AbortController()
  const provider = new FakeProvider([
    () => {
      throw new ProviderError('koptu', undefined, { retryable: true })
    },
    reply('ulaşılmamalı')
  ])
  await assert.rejects(
    runAgent({
      provider,
      registry,
      context: makeContext({ signal: controller.signal }),
      system: '',
      messages: [textMessage('user', 'x')],
      retryDelaysMs: [60_000],
      onEvent: (event) => {
        if (event.type === 'retry') controller.abort()
      }
    }),
    { name: 'AbortError' }
  )
  assert.equal(provider.requests.length, 1)
})
