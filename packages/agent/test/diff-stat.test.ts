import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changesDiffStat,
  defineTool,
  lineDiffStat,
  runAgent,
  textMessage,
  ToolRegistry,
  type ToolResultBlock
} from '../src/index'
import { callTool, FakeProvider, reply } from './fakes/provider'
import { makeContext } from './helpers'

test('lineDiffStat değişen satırları sayar', () => {
  assert.deepEqual(lineDiffStat('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 })
  assert.deepEqual(lineDiffStat('a\nb\n', 'a\nx\ny\nb\n'), { added: 2, removed: 0 })
  assert.deepEqual(lineDiffStat('a\nb\nc', 'c'), { added: 0, removed: 2 })
  assert.deepEqual(lineDiffStat('', 'a\nb\n'), { added: 2, removed: 0 })
  assert.deepEqual(lineDiffStat('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 })
  // Ortadaki eşleşen satır korunur: a b c → b x
  assert.deepEqual(lineDiffStat('a\nb\nc', 'b\nx'), { added: 1, removed: 2 })
})

test('changesDiffStat taşınan dosyayı eski içeriğiyle karşılaştırır', () => {
  assert.deepEqual(
    changesDiffStat([
      { path: 'a.sk', before: 'x\ny\n', after: '', deleted: true },
      { path: 'b.sk', before: '', after: 'x\ny\n', created: true, movedFrom: 'a.sk' }
    ]),
    { added: 0, removed: 0 }
  )
  assert.deepEqual(
    changesDiffStat([
      { path: 'a.sk', before: 'x\n', after: 'y\nz\n' },
      { path: 'b.sk', before: 'q\n', after: '', deleted: true }
    ]),
    { added: 2, removed: 2 }
  )
})

test('dosya değiştiren tool sonucuna diff istatistiği eklenir', async () => {
  const touchTool = defineTool<Record<string, never>>({
    name: 'touch',
    description: 'Change a file.',
    inputSchema: { type: 'object', properties: {} },
    permission: 'read',
    async execute(_, ctx) {
      ctx.onFilesChanged?.([{ path: 'a.sk', before: 'a\nb\n', after: 'a\nc\nd\n' }])
      return 'done'
    }
  })
  const seen: string[] = []
  const context = { ...makeContext(), onFilesChanged: (changes: readonly { path: string }[]) => seen.push(...changes.map((c) => c.path)) }
  const provider = new FakeProvider([callTool('touch', {}), reply('ok')])
  await runAgent({ provider, registry: new ToolRegistry([touchTool]), context, system: '', messages: [textMessage('user', 'x')] })
  const result = provider.requests.at(-1)!.messages.at(-1)!.content[0] as ToolResultBlock
  assert.deepEqual(result.diff, { added: 2, removed: 1 })
  // Asıl bağlamın bildirimi de çalışır
  assert.deepEqual(seen, ['a.sk'])
})
