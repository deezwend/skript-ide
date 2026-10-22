import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentText,
  formatMention,
  isProblemsMention,
  listProjectFiles,
  parseAttachment,
  parseMentions,
  problemsAttachmentText,
  readMentions
} from '../src/index'

test('parseMentions: kelime başındaki etiketler, tırnaklı yollar, sondaki noktalama', () => {
  assert.deepEqual(parseMentions('@skript.sk dosyasına bak, ayrıca @lib/util.sk.'), ['skript.sk', 'lib/util.sk'])
  assert.deepEqual(parseMentions('bak: @"my script.sk" ve @a.sk @a.sk'), ['my script.sk', 'a.sk'])
  assert.deepEqual(parseMentions('mail: ad@alan.com'), [])
})

test('formatMention boşluklu yolu tırnaklar', () => {
  assert.equal(formatMention('a.sk'), '@a.sk')
  assert.equal(formatMention('my script.sk'), '@"my script.sk"')
})

test('attachmentText / parseAttachment gidiş-dönüş', () => {
  const text = attachmentText('dir/a.sk', 'on load:\n\tbroadcast "hi"')
  assert.deepEqual(parseAttachment(text), { path: 'dir/a.sk', content: 'on load:\n\tbroadcast "hi"' })
  assert.equal(parseAttachment('düz metin'), null)
})

test('listProjectFiles ve readMentions proje içindeki dosyaları okur', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mentions-'))
  try {
    await mkdir(join(root, 'lib'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'skript.sk'), 'command /hi:')
    await writeFile(join(root, 'lib', 'util.sk'), 'function f():')
    await writeFile(join(root, 'node_modules', 'x.js'), '')
    assert.deepEqual(await listProjectFiles(root), ['lib/util.sk', 'skript.sk'])

    const result = await readMentions(root, '@skript.sk ve @lib/util.sk, @yok.sk @../dışarı.sk')
    assert.deepEqual(
      result.blocks.map((block) => parseAttachment(block.text)?.path),
      ['skript.sk', 'lib/util.sk']
    )
    assert.deepEqual(result.skipped, ['yok.sk', '../dışarı.sk'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('@Problems / @Problemler etiketi dosya sayılmaz, sorun listesi gidiş-dönüş', async () => {
  assert.ok(isProblemsMention('Problems'))
  assert.ok(isProblemsMention('problemler'))
  assert.ok(!isProblemsMention('problems.sk'))
  assert.deepEqual(parseMentions('@Problemler, düzelt'), ['Problemler'])

  const text = problemsAttachmentText([
    { path: 'futbol.sk', line: 4554, column: 3, severity: 'info', origin: 'static', message: '{_x} is never read' },
    { path: 'futbol.sk', line: 10, column: 0, severity: 'error', origin: 'server', message: "Can't understand", code: 'E1' }
  ])
  assert.deepEqual(parseAttachment(text), {
    path: 'Problems',
    content: "futbol.sk:4554:3 info [static] {_x} is never read\nfutbol.sk:10 error [server] Can't understand (E1)"
  })
  assert.equal(parseAttachment(problemsAttachmentText([]))?.content, 'No problems reported.')

  const root = await mkdtemp(join(tmpdir(), 'mentions-'))
  try {
    assert.deepEqual(await readMentions(root, '@Problems bak'), { blocks: [], skipped: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
