import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactMessages,
  COMPACTION_SYSTEM,
  isConversationSummary,
  latestGoal,
  runAgent,
  textMessage,
  ToolRegistry,
  type AgentEvent,
  type Message,
  type TextBlock
} from '../src/index'
import { goalText } from '../src/goal'
import { FakeProvider, reply } from './fakes/provider'
import { makeContext } from './helpers'

const summaryReply = (text: string) => ({ content: [{ type: 'text' as const, text }], stopReason: 'end' as const })

function textOf(message: Message): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

const history: Message[] = [
  textMessage('user', 'first request'),
  textMessage('assistant', 'old answer'),
  { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.sk' } }] },
  { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'file body' }] },
  textMessage('user', 'second request')
]

test('özet mesajı geçmişin başına tek bir user mesajı olarak girer, tool çifti bölünmez', async () => {
  const provider = new FakeProvider([summaryReply('We read a.sk.')])
  const result = await compactMessages(provider, history, { signal: new AbortController().signal, keepRecent: 2 })
  assert.ok(result)
  assert.equal(result.summarized, 2)
  // Özet isteği toolsuz ve özet sistem istemiyle gider; son kullanıcı mesajı özete girmez
  assert.deepEqual(provider.requests[0]!.tools, [])
  assert.equal(provider.requests[0]!.system, COMPACTION_SYSTEM)
  const prompt = textOf(provider.requests[0]!.messages[0]!)
  assert.match(prompt, /first request/)
  assert.doesNotMatch(prompt, /second request/)

  assert.equal(result.messages[0]!.role, 'user')
  assert.equal(result.messages[0]!.content[0]!.type, 'text')
  const block = result.messages[0]!.content[0] as TextBlock
  assert.equal(isConversationSummary(block.text), true)
  assert.match(block.text, /We read a\.sk\./)
  assert.equal(result.messages[1]!.content[0]!.type, 'tool_call')
  assert.equal(result.messages[2]!.content[0]!.type, 'tool_result')
  assert.equal(textOf(result.messages[3]!), 'second request')
})

test('aktif hedef özetin yanında korunur ve latestGoal onu bulmaya devam eder', async () => {
  const goal = 'ship the parser fix'
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'start' }, { type: 'text', text: goalText(goal) }] },
    textMessage('assistant', 'ok'),
    textMessage('user', 'newest request')
  ]
  const provider = new FakeProvider([summaryReply('older work')])
  const result = await compactMessages(provider, messages, { signal: new AbortController().signal, keepRecent: 1 })
  assert.ok(result)
  assert.equal(latestGoal(result.messages), goal)
  const blocks = result.messages[0]!.content as TextBlock[]
  assert.equal(isConversationSummary(blocks[0]!.text), true)
  assert.equal(blocks[1]!.text, goalText(goal))
})

test('özetlenecek eski mesaj yoksa null döner ve sağlayıcı çağrılmaz', async () => {
  const provider = new FakeProvider([])
  const result = await compactMessages(provider, [textMessage('user', 'only request')], {
    signal: new AbortController().signal
  })
  assert.equal(result, null)
  assert.equal(provider.requests.length, 0)
})

test('boş özet hataya dönüşür', async () => {
  const provider = new FakeProvider([summaryReply('')])
  await assert.rejects(compactMessages(provider, history, { signal: new AbortController().signal, keepRecent: 2 }), /empty/)
})

test('döngü eşiği aşınca özetler, context-compacted ve usage olayı yayınlar', async () => {
  let i = 0
  const messages: Message[] = [textMessage('user', 'start')]
  for (; i < 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 'noop', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', callId: `c${i}`, content: String(i).repeat(3500) }] })
  }
  messages.push(textMessage('user', 'continue'))

  const provider = new FakeProvider([
    {
      content: [{ type: 'text', text: 'Summary of the older work.' }],
      stopReason: 'end',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 }
    },
    reply('done')
  ])
  const events: AgentEvent[] = []
  const result = await runAgent({
    provider,
    registry: new ToolRegistry(),
    context: makeContext(),
    system: 'sys',
    messages,
    contextLimits: { window: 10_000, trimAt: 1.1, compactAt: 0.5 },
    onEvent: (event) => events.push(event)
  })

  assert.equal(result.reason, 'end')
  const compacted = events.filter((event) => event.type === 'context-compacted')
  assert.equal(compacted.length, 1)
  assert.ok(compacted[0].type === 'context-compacted' && compacted[0].summarizedMessages > 0)
  assert.equal(result.messages.findIndex((message) => textOf(message).includes('<conversation_summary>')), 0)
  assert.deepEqual(provider.requests[0]!.tools, [])
  assert.match(textOf(provider.requests[1]!.messages[0]!), /<conversation_summary>/)
  assert.ok(
    events.some((event) => event.type === 'usage' && event.usage.input === 100),
    'özetleme çağrısının kullanımı bildirilmeli'
  )
})

test('özetleme başarısız olursa kısaltılmış geçmişle devam edilir, sığmıyorsa context_full', async () => {
  const messages: Message[] = [textMessage('user', 'start')]
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 'noop', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', callId: `c${i}`, content: 'x'.repeat(3500) }] })
  }
  messages.push(textMessage('user', 'continue'))
  const provider = new FakeProvider([
    () => {
      throw new Error('boom')
    }
  ])
  const result = await runAgent({
    provider,
    registry: new ToolRegistry(),
    context: makeContext(),
    system: 'sys',
    messages,
    contextLimits: { window: 1000, trimAt: 1.1, compactAt: 0.5 }
  })
  assert.equal(result.reason, 'context_full')
  assert.equal(provider.requests.length, 1)
})

test('özetleme iptal edilirse AbortError yeniden fırlatılır', async () => {
  const controller = new AbortController()
  let i = 0
  const messages: Message[] = [textMessage('user', 'start')]
  for (; i < 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 'noop', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', callId: `c${i}`, content: 'x'.repeat(3500) }] })
  }
  messages.push(textMessage('user', 'continue'))

  const provider = new FakeProvider([
    () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }
  ])
  await assert.rejects(
    runAgent({
      provider,
      registry: new ToolRegistry(),
      context: makeContext({ signal: controller.signal }),
      system: 'sys',
      messages,
      contextLimits: { window: 10_000, trimAt: 1.1, compactAt: 0.5 }
    }),
    { name: 'AbortError' }
  )
})
