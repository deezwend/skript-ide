import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deleteFileTool,
  editFileTool,
  findFilesTool,
  moveFileTool,
  multiEditTool,
  searchFilesTool,
  type FileChange
} from '../src/index'
import { globToRegExp } from '../src/tools/core/paths'
import { makeContext, makeProject } from './helpers'

const FILES = {
  'main.sk': 'on join:\n\tsend "hi" to player\n\tgive_kit(player)\n',
  'lib/kits.sk': 'function give_kit(p: player):\n\tgive diamond to {_p}\n\tgive iron to {_p}\n',
  'lib/shop/shop.sk': 'command /shop:\n\ttrigger:\n\t\tsend "Shop" to player\n',
  'README.md': 'Shop docs\n',
  'node_modules/x/shop.sk': 'on join:\n'
}

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(FILES)
  try {
    await run(root)
  } finally {
    await cleanup()
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Tool'ların `onFilesChanged` ile bildirdiği değişiklikleri toplar. */
function recordingContext(root: string) {
  const changes: FileChange[] = []
  return { ctx: { ...makeContext({ projectRoot: root }), onFilesChanged: (list: readonly FileChange[]) => changes.push(...list) }, changes }
}

test('globToRegExp: /\'sız desen her derinlikte ad, ** klasör geçer, {a,b} ve [] çalışır', () => {
  assert.ok(globToRegExp('*.sk').test('lib/shop/shop.sk'))
  assert.ok(globToRegExp('*.sk').test('main.sk'))
  assert.ok(!globToRegExp('lib/*.sk').test('lib/shop/shop.sk'))
  assert.ok(globToRegExp('lib/**/*.sk').test('lib/kits.sk'))
  assert.ok(globToRegExp('lib/**/*.sk').test('lib/shop/shop.sk'))
  assert.ok(globToRegExp('*.{sk,md}').test('README.md'))
  assert.ok(globToRegExp('k?ts.sk').test('lib/kits.sk'))
  assert.ok(globToRegExp('[km]*.sk').test('main.sk'))
  assert.ok(!globToRegExp('[!km]*.sk').test('main.sk'))
  assert.ok(globToRegExp('SHOP*').test('lib/shop/shop.sk'))
  assert.ok(globToRegExp('./lib\\kits.sk').test('lib/kits.sk'))
  assert.ok(!globToRegExp('a.sk').test('xa.sk'))
})

test('find_files adla ve yolla bulur, node_modules\'u atlar, path ile daraltır', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    assert.equal(await findFilesTool.execute({ pattern: '*.sk' }, ctx), 'lib/kits.sk\nlib/shop/shop.sk\nmain.sk')
    assert.equal(await findFilesTool.execute({ pattern: 'shop*' }, ctx), 'lib/shop/shop.sk')
    assert.equal(await findFilesTool.execute({ pattern: 'lib/*.sk' }, ctx), 'lib/kits.sk')
    // Desen `path`e göre ya da köke göre yazılabilir
    assert.equal(await findFilesTool.execute({ pattern: 'shop/*.sk', path: 'lib' }, ctx), 'lib/shop/shop.sk')
    assert.equal(await findFilesTool.execute({ pattern: 'lib/shop/*.sk', path: 'lib' }, ctx), 'lib/shop/shop.sk')
    assert.equal(await findFilesTool.execute({ pattern: '*.yml' }, ctx), 'No files found.')
    await assert.rejects(findFilesTool.execute({ pattern: '*', path: 'main.sk' }, ctx), /not a directory/)
    await assert.rejects(findFilesTool.execute({ pattern: '*', path: '..' }, ctx), /outside the project/)
  }))

test('search_files büyük/küçük harf duyarlı arar, glob ile süzer, yalnızca dosyaları döndürür', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    assert.equal(
      (await searchFilesTool.execute({ query: 'shop' }, ctx)).split('\n').sort().join('\n'),
      'README.md:1: Shop docs\nlib/shop/shop.sk:1: command /shop:\nlib/shop/shop.sk:3: send "Shop" to player'
    )
    assert.equal(
      await searchFilesTool.execute({ query: 'Shop', case_sensitive: true, glob: '*.sk' }, ctx),
      'lib/shop/shop.sk:3: send "Shop" to player'
    )
    assert.equal(
      (await searchFilesTool.execute({ query: 'give', output: 'files' }, ctx)).split('\n').sort().join('\n'),
      'lib/kits.sk (3)\nmain.sk (1)'
    )
  }))

test('search_files bağlam satırlarını girintiyle verir, bitişik pencereleri birleştirir', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await writeFile(join(root, 'long.sk'), ['a', 'hit 1', 'b', 'c', 'd', 'e', '\thit 2', 'f'].join('\n'), 'utf8')
    assert.equal(
      await searchFilesTool.execute({ query: 'hit', glob: 'long.sk', context_lines: 1 }, ctx),
      ['long.sk-1- a', 'long.sk:2: hit 1', 'long.sk-3- b', '--', 'long.sk-6- e', 'long.sk:7: \thit 2', 'long.sk-8- f'].join('\n')
    )
    assert.equal(
      await searchFilesTool.execute({ query: 'hit', glob: 'long.sk', context_lines: 2 }, ctx),
      ['long.sk-1- a', 'long.sk:2: hit 1', 'long.sk-3- b', 'long.sk-4- c', 'long.sk-5- d', 'long.sk-6- e', 'long.sk:7: \thit 2', 'long.sk-8- f'].join('\n')
    )
  }))

test('edit_file replace_all her geçişi değiştirir, line ile birlikte reddedilir', () =>
  withProject(async (root) => {
    const { ctx, changes } = recordingContext(root)
    const result = await editFileTool.execute({ path: 'lib/kits.sk', old_text: '{_p}', new_text: '{_target}', replace_all: true }, ctx)
    assert.equal(result, 'Edited lib/kits.sk (2 replacements).')
    assert.equal(
      await readFile(join(root, 'lib/kits.sk'), 'utf8'),
      'function give_kit(p: player):\n\tgive diamond to {_target}\n\tgive iron to {_target}\n'
    )
    assert.deepEqual(changes.map((c) => c.path), ['lib/kits.sk'])
    assert.equal(changes[0].before, FILES['lib/kits.sk'])
    await assert.rejects(
      editFileTool.execute({ path: 'lib/kits.sk', old_text: 'give', new_text: 'x', replace_all: true, line: 2 }, ctx),
      /either line or replace_all/
    )
  }))

test('multi_edit düzenlemeleri sırayla tek onayla uygular', () =>
  withProject(async (root) => {
    const { ctx, changes } = recordingContext(root)
    const input = {
      path: 'lib/kits.sk',
      edits: [
        { old_text: 'diamond', new_text: 'emerald' },
        { old_text: 'iron', new_text: 'gold' },
        // Önceki düzenlemenin sonucuna uygulanır
        { old_text: 'emerald to {_p}', new_text: 'emerald to {_p}\n\tsend "kit" to {_p}' }
      ]
    }
    const preview = await multiEditTool.preview!(input, ctx)
    assert.equal(preview.summary, 'Edit lib/kits.sk (3 edits)')
    assert.equal(preview.changes?.length, 1)
    assert.equal(await multiEditTool.execute(input, ctx), 'Edited lib/kits.sk (3 replacements).')
    const expected = 'function give_kit(p: player):\n\tgive emerald to {_p}\n\tsend "kit" to {_p}\n\tgive gold to {_p}\n'
    assert.equal(await readFile(join(root, 'lib/kits.sk'), 'utf8'), expected)
    assert.equal(preview.changes![0].after, expected)
    assert.equal(changes.length, 1)
  }))

test('multi_edit bir düzenleme başarısızsa hiçbirini yazmaz, hangisi olduğunu söyler', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await assert.rejects(
      multiEditTool.execute(
        { path: 'lib/kits.sk', edits: [{ old_text: 'diamond', new_text: 'emerald' }, { old_text: 'diamond', new_text: 'x' }] },
        ctx
      ),
      /edits\[1\]: old_text was not found.*No edits were applied/
    )
    await assert.rejects(multiEditTool.execute({ path: 'lib/kits.sk', edits: [] }, ctx), /must not be empty/)
    await assert.rejects(
      multiEditTool.execute({ path: 'lib/kits.sk', edits: [{ old_text: 'iron', new_text: 'x' }, { old_text: '', new_text: 'x' }] }, ctx),
      /edits\[1\]: old_text must not be empty/
    )
    assert.equal(await readFile(join(root, 'lib/kits.sk'), 'utf8'), FILES['lib/kits.sk'])
  }))

test('multi_edit CRLF dosyada satır sonlarını korur', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await writeFile(join(root, 'crlf.sk'), 'on join:\r\n\tsend "a"\r\n\tsend "b"\r\n', 'utf8')
    await multiEditTool.execute(
      { path: 'crlf.sk', edits: [{ old_text: '\tsend "a"\n', new_text: '\tsend "a"\n\tsend "a2"\n' }, { old_text: '"b"', new_text: '"c"' }] },
      ctx
    )
    assert.equal(await readFile(join(root, 'crlf.sk'), 'utf8'), 'on join:\r\n\tsend "a"\r\n\tsend "a2"\r\n\tsend "c"\r\n')
  }))

test('delete_file dosyayı siler, önizlemede içeriği verir, klasörü reddeder', () =>
  withProject(async (root) => {
    const { ctx, changes } = recordingContext(root)
    const preview = await deleteFileTool.preview!({ path: 'README.md' }, ctx)
    assert.deepEqual(preview.changes, [{ path: 'README.md', before: FILES['README.md'], after: '', deleted: true }])
    assert.equal(await deleteFileTool.execute({ path: 'README.md' }, ctx), 'Deleted README.md.')
    assert.equal(await exists(join(root, 'README.md')), false)
    assert.deepEqual(changes, preview.changes)

    await assert.rejects(deleteFileTool.execute({ path: 'lib' }, ctx), /is a directory/)
    await assert.rejects(deleteFileTool.execute({ path: 'yok.sk' }, ctx), /not found/)
    await assert.rejects(deleteFileTool.execute({ path: '..' }, ctx), /outside the project/)
  }))

test('move_file eksik klasörleri oluşturarak taşır, var olan hedefi reddeder', () =>
  withProject(async (root) => {
    const { ctx, changes } = recordingContext(root)
    const input = { from: 'lib/kits.sk', to: 'scripts/kits/kits.sk' }
    const preview = await moveFileTool.preview!(input, ctx)
    assert.equal(preview.summary, 'Move lib/kits.sk → scripts/kits/kits.sk')
    assert.deepEqual(preview.changes, [
      { path: 'lib/kits.sk', before: FILES['lib/kits.sk'], after: '', deleted: true },
      { path: 'scripts/kits/kits.sk', before: '', after: FILES['lib/kits.sk'], created: true, movedFrom: 'lib/kits.sk' }
    ])
    assert.equal(await moveFileTool.execute(input, ctx), 'Moved lib/kits.sk → scripts/kits/kits.sk.')
    assert.equal(await exists(join(root, 'lib/kits.sk')), false)
    assert.equal(await readFile(join(root, 'scripts/kits/kits.sk'), 'utf8'), FILES['lib/kits.sk'])
    assert.deepEqual(changes, preview.changes)

    await assert.rejects(moveFileTool.execute({ from: 'main.sk', to: 'README.md' }, ctx), /already exists/)
    await assert.rejects(moveFileTool.execute({ from: 'main.sk', to: '../main.sk' }, ctx), /outside the project/)
    await assert.rejects(moveFileTool.execute({ from: 'lib', to: 'lib2' }, ctx), /is a directory/)
  }))

test('move_file yalnızca harf büyüklüğünü değiştirebilir', () =>
  withProject(async (root) => {
    const ctx = makeContext({ projectRoot: root })
    await moveFileTool.execute({ from: 'main.sk', to: 'Main.sk' }, ctx)
    assert.equal(await readFile(join(root, 'Main.sk'), 'utf8'), FILES['main.sk'])
  }))
