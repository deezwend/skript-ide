import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineTool,
  runAgent,
  textMessage,
  ToolError,
  ToolRegistry,
  type AgentEvent,
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
