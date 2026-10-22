import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineTool,
  runAgent,
  textMessage,
  ToolRegistry,
  TRIMMED_RESULT,
  trimToolResults,
  type AgentEvent,
  type Message,
  type ToolResultBlock
} from '../src/index'
import { callTool, FakeProvider, reply } from './fakes/provider'
import { makeContext } from './helpers'

/** Her biri ~1000 token'lık (3500 karakter) sonuç taşıyan tool turları. */
function history(results: number): Message[] {
  const messages: Message[] = [textMessage('user', 'start')]
  for (let i = 0; i < results; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 'big', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', callId: `c${i}`, content: String(i).repeat(3500) }] })
  }
  return messages
}

const resultContents = (messages: readonly Message[]) =>
  messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result').map((b) => b.content))

test('eşiğin altında kısaltma yapılmaz', () => {
  assert.equal(trimToolResults(history(5), 6000, { window: 10_000 }), null)
})

test('eşik aşılınca en eski sonuçlar hedefe inene kadar kısaltılır, son sonuçlara dokunulmaz', () => {
  const messages = history(10)
  const trim = trimToolResults(messages, 10_000, { window: 12_000, keepRecent: 2 })
  assert.ok(trim)
  const contents = resultContents(trim.messages)
  // 10000 → hedef 6000: en az 4 sonuç kısaltılmalı, en eskiden başlayarak
  assert.equal(trim.trimmed, 5)
  assert.deepEqual(contents.slice(0, 5), Array(5).fill(TRIMMED_RESULT))
  assert.notEqual(contents[5], TRIMMED_RESULT)
  // Girdi değiştirilmez
  assert.notEqual(resultContents(messages)[0], TRIMMED_RESULT)
})

test('yalnızca korunan sonuçlar varsa kısaltma yapılmaz', () => {
  assert.equal(trimToolResults(history(2), 10_000, { window: 10_000, keepRecent: 2 }), null)
})

const bigTool = defineTool<Record<string, never>>({
  name: 'big',
  description: 'Returns a lot of text.',
  inputSchema: { type: 'object', properties: {} },
  permission: 'read',
  async execute() {
    return 'x'.repeat(35_000)
  }
})

test('döngü bağlam dolunca eski tool sonuçlarını kısaltıp modele kısaltılmış geçmişi gönderir', async () => {
  const registry = new ToolRegistry()
  registry.register(bigTool)
  const provider = new FakeProvider([callTool('big', {}), callTool('big', {}), callTool('big', {}), reply('done')])
  const events: AgentEvent[] = []
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: 'sys',
    messages: [textMessage('user', 'go')],
    contextLimits: { window: 30_000, keepRecent: 1 },
    onEvent: (event) => events.push(event)
  })
  assert.equal(result.reason, 'end')
  // Üç sonuç ~30K token: eşik (21K) aşıldı, ilk ikisi kısaltıldı, sonuncusu korundu
  assert.deepEqual(resultContents(provider.requests[3].messages), [TRIMMED_RESULT, TRIMMED_RESULT, 'x'.repeat(35_000)])
  assert.deepEqual(resultContents(provider.requests[2].messages).includes(TRIMMED_RESULT), false)
  const trimmed = events.filter((event) => event.type === 'context-trimmed')
  assert.equal(trimmed.length, 1)
  assert.deepEqual(resultContents(result.messages).slice(0, 2), [TRIMMED_RESULT, TRIMMED_RESULT])
})

test('kısaltmaya rağmen sığmayan geçmişte tur context_full ile durur', async () => {
  const registry = new ToolRegistry()
  const provider = new FakeProvider([reply('never')])
  const result = await runAgent({
    provider,
    registry,
    context: makeContext(),
    system: 'sys',
    messages: [textMessage('user', 'y'.repeat(40_000))],
    contextLimits: { window: 10_000 },
    onEvent: () => {}
  })
  assert.equal(result.reason, 'context_full')
  assert.equal(provider.requests.length, 0)
})
