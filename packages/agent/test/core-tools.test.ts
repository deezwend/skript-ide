import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { editFileTool, listDirTool, readFileTool, searchFilesTool, ToolError } from '../src/index'
import { makeContext, makeProject } from './helpers'

const FILES = {
  'main.sk': 'on join:\n\tsend "hoş geldin" to player\n',
  'lib/util.sk': 'function hi():\n\tbroadcast "hi"\n\tbroadcast "hi"\n',
  'notes.txt': 'join notes\n',
  'node_modules/x/index.sk': 'on join:\n'
}

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(FILES)
  try {
    await run(root)
  } finally {
    await cleanup()
  }
}

test('read_file satır numaralarıyla okur, offset/limit uygular', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    assert.equal(
      await readFileTool.execute({ path: 'main.sk' }, ctx),
      '1\ton join:\n2\t\tsend "hoş geldin" to player\n3\t'
    )
    assert.equal(
      await readFileTool.execute({ path: 'lib/util.sk', offset: 2, limit: 1 }, ctx),
      '2\t\tbroadcast "hi"\n(… 2 more lines)'
    )
  }))

test('proje dışına çıkan yollar reddedilir', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await assert.rejects(readFileTool.execute({ path: '../outside.sk' }, ctx), ToolError)
    await assert.rejects(readFileTool.execute({ path: join(root, '..') }, ctx), /outside the project/)
    await assert.rejects(readFileTool.execute({ path: 'yok.sk' }, ctx), /not found/)
  }))

test('proje açık değilse dosya tool\'ları hata verir', async () => {
  await assert.rejects(readFileTool.execute({ path: 'main.sk' }, makeContext()), /No project folder/)
})

test('list_dir klasörleri önce, yok sayılanları atlayarak listeler', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    assert.equal(await listDirTool.execute({}, ctx), './\n  lib/\n  main.sk\n  notes.txt')
    assert.equal(await listDirTool.execute({ path: 'lib' }, ctx), 'lib/\n  util.sk')
  }))

test('search_files eşleşmeleri bulur, uzantıya göre süzer, node_modules\'u atlar', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    const all = await searchFilesTool.execute({ query: 'JOIN' }, ctx)
    assert.deepEqual(all.split('\n').sort(), ['main.sk:1: on join:', 'notes.txt:1: join notes'])

    const sk = await searchFilesTool.execute({ query: 'join', extensions: ['.sk'] }, ctx)
    assert.equal(sk, 'main.sk:1: on join:')

    const regex = await searchFilesTool.execute({ query: '^function \\w+', regex: true }, ctx)
    assert.equal(regex, 'lib/util.sk:1: function hi():')

    assert.equal(await searchFilesTool.execute({ query: 'yokböylebirşey' }, ctx), 'No matches.')
    await assert.rejects(searchFilesTool.execute({ query: '(', regex: true }, ctx), /Invalid regex/)
  }))

test('edit_file benzersiz metni değiştirir, önizleme diff verir', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    const input = { path: 'main.sk', old_text: '"hoş geldin"', new_text: '"merhaba"' }

    const preview = await editFileTool.preview!(input, ctx)
    assert.equal(preview.change?.path, 'main.sk')
    assert.match(preview.change!.after, /merhaba/)

    await editFileTool.execute(input, ctx)
    assert.equal(await readFile(join(root, 'main.sk'), 'utf8'), 'on join:\n\tsend "merhaba" to player\n')
  }))

test('edit_file bulunamayan ya da birden çok geçen metni reddeder', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await assert.rejects(
      editFileTool.execute({ path: 'main.sk', old_text: 'yok', new_text: 'x' }, ctx),
      /not found/
    )
    await assert.rejects(
      editFileTool.execute({ path: 'lib/util.sk', old_text: 'broadcast "hi"', new_text: 'x' }, ctx),
      /more than once/
    )
    assert.equal(await readFile(join(root, 'lib/util.sk'), 'utf8'), FILES['lib/util.sk'])
  }))
