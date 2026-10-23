import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  forgetTool,
  latestMemory,
  loadMemory,
  memoryEntries,
  memoryText,
  memoryUpdate,
  parseMemory,
  PROJECT_MEMORY_FILE,
  rememberTool,
  textMessage,
  type Message
} from '../src/index'
import { makeContext, makeProject } from './helpers'

test('notlar yalnızca madde satırlarıdır', () => {
  assert.deepEqual(memoryEntries('# Başlık\n\nAçıklama\n- tabs kullan\n* Paper 1.21\n-\n  - girintili'), [
    'tabs kullan',
    'Paper 1.21',
    'girintili'
  ])
})

test('remember ekler, aynısını tekrar eklemez, replaces ile günceller; forget siler', async () => {
  const project = await makeProject({})
  const ctx = { ...makeContext({ projectRoot: project.root }), userMemoryFile: join(project.root, '..', 'user-memory.md') }
  try {
    assert.match(await rememberTool.execute({ text: 'Kullanıcı  Türkçe\nyorum ister.', scope: 'user' }, ctx), /Saved/)
    assert.match(await rememberTool.execute({ text: 'kullanıcı türkçe yorum ister.', scope: 'user' }, ctx), /already/)
    await rememberTool.execute({ text: 'Sunucu Paper 1.20.', scope: 'project' }, ctx)
    await rememberTool.execute({ text: 'Sunucu Paper 1.21.', scope: 'project', replaces: 'paper 1.20' }, ctx)
    await rememberTool.execute({ text: 'Mesaj öneki &6[Shop].', scope: 'project' }, ctx)

    const user = await readFile(ctx.userMemoryFile, 'utf8')
    assert.deepEqual(memoryEntries(user), ['Kullanıcı Türkçe yorum ister.'])
    const projectFile = join(project.root, ...PROJECT_MEMORY_FILE.split('/'))
    assert.deepEqual(memoryEntries(await readFile(projectFile, 'utf8')), ['Sunucu Paper 1.21.', 'Mesaj öneki &6[Shop].'])

    await assert.rejects(forgetTool.execute({ match: 'yok böyle', scope: 'project' }, ctx), /No note matches/)
    await assert.rejects(forgetTool.execute({ match: '.', scope: 'project' }, ctx), /matches 2 notes/)
    assert.match(await forgetTool.execute({ match: 'öneki', scope: 'project' }, ctx), /Removed/)
    const after = await readFile(projectFile, 'utf8')
    assert.deepEqual(memoryEntries(after), ['Sunucu Paper 1.21.'])
    // Notların dışındaki satırlar (başlık, açıklama) korunur
    assert.match(after, /^# Skript IDE agent memory/)
  } finally {
    await project.cleanup()
  }
})

test('proje yokken proje kapsamı, kullanıcı dosyası yokken kullanıcı kapsamı reddedilir; uzun not reddedilir', async () => {
  const ctx = makeContext()
  await assert.rejects(rememberTool.execute({ text: 'x', scope: 'project' }, ctx), /No project/)
  await assert.rejects(rememberTool.execute({ text: 'x', scope: 'user' }, ctx), /not available/)
  await assert.rejects(rememberTool.execute({ text: 'x'.repeat(600), scope: 'user' }, { ...ctx, userMemoryFile: 'unused' }), /too long/)
})

test('loadMemory iki kapsamı tek blokta birleştirir; ikisi de yoksa null', async () => {
  const project = await makeProject({ [PROJECT_MEMORY_FILE]: '- proje notu\n' })
  try {
    const text = await loadMemory(join(project.root, 'yok.md'), project.root)
    assert.ok(text)
    assert.equal(parseMemory(text), `## Project (${PROJECT_MEMORY_FILE})\n- proje notu`)
    assert.equal(await loadMemory(null, null), null)
    assert.equal(memoryText('  ', null), null)
  } finally {
    await project.cleanup()
  }
})

test('hafıza yalnızca değiştiğinde ya da boşaldığında mesaja eklenir', () => {
  const block = memoryText('- a', null)!
  assert.equal(memoryUpdate([], null), null)
  assert.equal(memoryUpdate([], block), block)
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'merhaba' }, { type: 'text', text: block }] }]
  assert.equal(latestMemory(history), block)
  assert.equal(memoryUpdate(history, block), null)
  const changed = memoryText('- a\n- b', null)!
  assert.equal(memoryUpdate(history, changed), changed)
  const cleared = memoryUpdate(history, null)!
  assert.equal(parseMemory(cleared), null)
  assert.equal(memoryUpdate([...history, textMessage('user', cleared)], null), null)
})
