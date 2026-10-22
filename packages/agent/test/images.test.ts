import test from 'node:test'
import assert from 'node:assert/strict'
import { toAnthropicMessages } from '../src/providers/anthropic'
import { toResponsesInput } from '../src/providers/codex'
import { toChatMessages } from '../src/providers/openai-compatible'
import { estimateMessageTokens, MAX_IMAGE_BASE64_LENGTH, parseImageInput, type Message } from '../src/index'

const withImage: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'bu ne?' },
    { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
  ]
}

test('Görsel: Anthropic base64 kaynağına çevrilir', () => {
  assert.deepEqual(toAnthropicMessages([withImage], 'anthropic')[0].content, [
    { type: 'text', text: 'bu ne?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  ])
})

test('Görsel: OpenAI uyumlu mesaj parça listesi olur; görselsiz mesaj düz metin kalır', () => {
  const [withParts, plain] = toChatMessages('', [withImage, { role: 'user', content: [{ type: 'text', text: 'selam' }] }], 'x')
  assert.deepEqual(withParts.content, [
    { type: 'text', text: 'bu ne?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
  ])
  assert.equal(plain.content, 'selam')
})

test('Görsel: Codex `input_image` öğesi olur; metinsiz görsel de gönderilir', () => {
  const imageOnly: Message = { role: 'user', content: [{ type: 'text', text: '' }, withImage.content[1]] }
  assert.deepEqual(toResponsesInput([withImage, imageOnly], 'openai-codex'), [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'bu ne?' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' }
      ]
    },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' }] }
  ])
})

test('Görsel: token tahminine sabit pay olarak girer', () => {
  assert.ok(estimateMessageTokens(withImage) > 1000)
})

test('Görsel girdisi doğrulanır', () => {
  assert.deepEqual(parseImageInput(undefined), [])
  assert.deepEqual(parseImageInput([{ mediaType: 'image/jpeg', data: 'AAAA' }]), [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }])
  assert.throws(() => parseImageInput([{ mediaType: 'image/bmp', data: 'AAAA' }]))
  assert.throws(() => parseImageInput([{ mediaType: 'image/png', data: 'not base64!' }]))
  assert.throws(() => parseImageInput([{ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 1) }]))
  assert.throws(() => parseImageInput(Array.from({ length: 11 }, () => ({ mediaType: 'image/png', data: 'AAAA' }))))
})
