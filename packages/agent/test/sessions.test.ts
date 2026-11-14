import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationTranscript } from '../src/conversations'
import { runAgent, textMessage, ToolRegistry, type AgentEvent, type ContentBlock } from '../src/index'
import { parseSessionMessage, sessionMessageText } from '../src/session-messages'
import { ToolError, type SessionPeer, type SessionSendRequest } from '../src/tool'
import { listSessionsTool, sendToSessionTool } from '../src/tools/sessions'
import { callTool, FakeProvider, reply } from './fakes/provider'
import { makeContext } from './helpers'

const PEERS: SessionPeer[] = [
  { id: '3f2a9c1d-0000-4000-8000-000000000001', title: 'GUI shop', updatedAt: 0, projectRoot: '/p', turns: 4, status: 'running', queued: 1 },
  { id: '7b11e0aa-0000-4000-8000-000000000002', title: 'Fix scoreboard', updatedAt: 0, projectRoot: '/p', turns: 2, status: 'idle', queued: 0 }
]

function contextWith(sent: SessionSendRequest[]) {
  return {
    ...makeContext(),
    sessions: {
      list: async () => PEERS,
      send: async (request: SessionSendRequest) => {
        sent.push(request)
        return `sent to ${request.session}`
      }
    }
  }
}

test('session messages round-trip and strip quotes from the title', () => {
  const text = sessionMessageText({ from: '3f2a9c1d', title: 'Say "hi"', replyReturned: true, body: 'line 1\nline 2' })
  assert.deepEqual(parseSessionMessage(text), { from: '3f2a9c1d', title: 'Say hi', replyReturned: true, body: 'line 1\nline 2' })
  const plain = parseSessionMessage(sessionMessageText({ from: 'abcd', title: 't', replyReturned: false, body: 'x' }))
  assert.equal(plain?.replyReturned, false)
  assert.equal(parseSessionMessage('hello'), null)
})

test('transcripts show session messages with their sender', () => {
  const text = sessionMessageText({ from: '3f2a9c1d', title: 'GUI shop', replyReturned: false, body: 'Done with the menu.' })
  assert.equal(conversationTranscript([textMessage('user', text)]), 'Message from session 3f2a9c1d ("GUI shop"): Done with the menu.')
})

test('list_sessions shows status and filters running ones', async () => {
  const ctx = contextWith([])
  const all = await listSessionsTool.execute({}, ctx)
  assert.match(all, /2 session\(s\)/)
  assert.match(all, /3f2a9c1d .*"GUI shop".*running, 1 queued message\(s\)/)
  assert.match(all, /7b11e0aa .*idle/)
  const running = await listSessionsTool.execute({ active_only: true }, ctx)
  assert.match(running, /1 session\(s\)/)
  assert.doesNotMatch(running, /Fix scoreboard/)
})

test('send_to_session trims input, waits by default and previews the target', async () => {
  const sent: SessionSendRequest[] = []
  const ctx = contextWith(sent)
  assert.equal(await sendToSessionTool.execute({ session: ' 7b11 ', message: ' Ping ' }, ctx), 'sent to 7b11')
  assert.deepEqual(sent[0], { session: '7b11', message: 'Ping', wait: true })
  await sendToSessionTool.execute({ session: '7b11', message: 'x', wait: false }, ctx)
  assert.equal(sent[1].wait, false)
  const preview = await sendToSessionTool.preview!({ session: '7B11', message: 'Please   check\nthis' }, ctx)
  assert.equal(preview.summary, 'Ask session "Fix scoreboard" (7b11e0aa): Please check this')
  await assert.rejects(sendToSessionTool.execute({ session: '7b11', message: ' ' }, ctx), ToolError)
})

test('session tools fail without a messenger', async () => {
  await assert.rejects(listSessionsTool.execute({}, makeContext()), ToolError)
  await assert.rejects(sendToSessionTool.execute({ session: 'abcd', message: 'x' }, makeContext()), ToolError)
})

test('runAgent appends inbox blocks after tool results', async () => {
  const tool = {
    name: 'noop',
    description: 'Does nothing.',
    inputSchema: { type: 'object' as const, properties: {} },
    permission: 'read' as const,
    execute: async () => 'ok'
  }
  const queue: ContentBlock[][] = [[{ type: 'text', text: 'incoming' }]]
  const provider = new FakeProvider([callTool('noop', {}), reply('done')])
  const events: AgentEvent[] = []
  const result = await runAgent({
    provider,
    registry: new ToolRegistry([tool]),
    context: makeContext(),
    system: 's',
    messages: [textMessage('user', 'go')],
    inbox: () => queue.shift() ?? [],
    onEvent: (event) => events.push(event)
  })
  const sentBack = provider.requests[1].messages.at(-1)!
  assert.deepEqual(
    sentBack.content.map((block) => block.type),
    ['tool_result', 'text']
  )
  assert.deepEqual(sentBack.content[1], { type: 'text', text: 'incoming' })
  assert.deepEqual(result.messages.at(-2), sentBack)
  assert.equal(events.filter((event) => event.type === 'inbox').length, 1)
})
