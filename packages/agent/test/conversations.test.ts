import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachedConversationText,
  attachmentText,
  conversationMention,
  conversationMentionRef,
  conversationTranscript,
  CONVERSATION_PAGE_CHARS,
  memoryText,
  parseAttachment,
  readConversationTool,
  readMentions,
  searchConversationsTool,
  textMessage,
  type ConversationArchive,
  type ConversationInfo,
  type Message
} from '../src/index'
import { makeContext, makeProject } from './helpers'

const ID_A = '3f2a9c1d-0000-4000-8000-000000000001'
const ID_B = '7b11e0aa-0000-4000-8000-000000000002'

const conversations: Record<string, { info: ConversationInfo; messages: Message[] }> = {
  [ID_A]: {
    info: { id: ID_A, title: 'Shop komutu', updatedAt: Date.UTC(2026, 9, 20), projectRoot: '/srv/proj', turns: 1 },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '/shop komutu yaz' },
          { type: 'text', text: attachmentText('shop.sk', 'command /shop:') },
          { type: 'text', text: memoryText('- gizli not', null)! }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Shop komutunu ekliyorum.' },
          { type: 'tool_call', id: 'c1', name: 'write_file', input: { path: 'shop.sk' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'uzun tool çıktısı' }] }
    ]
  },
  [ID_B]: {
    info: { id: ID_B, title: 'Join mesajı', updatedAt: Date.UTC(2026, 9, 22), projectRoot: null, turns: 1 },
    messages: [textMessage('user', 'on join mesajı ekle'), textMessage('assistant', 'x'.repeat(CONVERSATION_PAGE_CHARS + 50))]
  }
}

const archive: ConversationArchive = {
  list: async () => Object.values(conversations).map((c) => c.info).sort((a, b) => b.updatedAt - a.updatedAt),
  read: async (id) => conversations[id] ?? null
}

test('döküm metinleri ve tool çağrılarını içerir; bağlam blokları ve tool çıktıları yazılmaz', () => {
  const transcript = conversationTranscript(conversations[ID_A].messages)
  assert.match(transcript, /^User: \/shop komutu yaz/)
  assert.match(transcript, /\[attached shop\.sk\]/)
  assert.match(transcript, /Assistant: Shop komutunu ekliyorum\./)
  assert.match(transcript, /\[tool write_file \{"path":"shop.sk"\}\]/)
  assert.doesNotMatch(transcript, /gizli not|uzun tool çıktısı/)
})

test('search_conversations tüm terimleri arar; boş sorgu son konuşmaları listeler', async () => {
  const ctx = { ...makeContext(), conversations: archive }
  const found = await searchConversationsTool.execute({ query: 'SHOP komut' }, ctx)
  assert.match(found, /1 conversation\(s\) match/)
  assert.match(found, /3f2a9c1d · 2026-10-20 00:00 UTC · "Shop komutu"/)
  assert.match(await searchConversationsTool.execute({ query: 'shop join' }, ctx), /No saved conversation/)
  const recent = await searchConversationsTool.execute({}, ctx)
  assert.ok(recent.indexOf('7b11e0aa') < recent.indexOf('3f2a9c1d'))
  await assert.rejects(searchConversationsTool.execute({}, makeContext()), /not available/)
})

test('read_conversation kısa kimlikle okur ve sayfalar', async () => {
  const ctx = { ...makeContext(), conversations: archive }
  const first = await readConversationTool.execute({ id: '7b11e0aa' }, ctx)
  assert.match(first, /User: on join mesajı ekle/)
  const next = /offset=(\d+)/.exec(first)
  assert.ok(next)
  const second = await readConversationTool.execute({ id: '@chat:7b11', offset: Number(next[1]) }, ctx)
  assert.doesNotMatch(second, /offset=/)
  await assert.rejects(readConversationTool.execute({ id: 'ffffffff' }, ctx), /No saved conversation/)
  await assert.rejects(readConversationTool.execute({ id: 'not an id' }, ctx), /not a conversation id/)
})

test('@chat etiketi: biçim, ayrıştırma, ek gidiş-dönüşü; dosya eki sayılmaz', async () => {
  assert.equal(conversationMention(ID_A), '@chat:3f2a9c1d')
  assert.equal(conversationMentionRef('chat:3F2A9C1D'), '3f2a9c1d')
  assert.equal(conversationMentionRef('chat:shop'), null)
  assert.equal(conversationMentionRef('shop.sk'), null)

  const { info, messages } = conversations[ID_A]
  const parsed = parseAttachment(attachedConversationText(info, messages))
  assert.ok(parsed?.conversation)
  assert.deepEqual(parsed.conversation, { id: '3f2a9c1d', title: 'Shop komutu' })
  assert.equal(parsed.path, 'chat:3f2a9c1d')
  assert.match(parsed.content, /Shop komutunu ekliyorum/)

  const project = await makeProject({ 'a.sk': 'x' })
  try {
    const result = await readMentions(project.root, 'bak @chat:3f2a9c1d ve @a.sk')
    assert.deepEqual(result.skipped, [])
    assert.equal(result.blocks.length, 1)
  } finally {
    await project.cleanup()
  }
})
