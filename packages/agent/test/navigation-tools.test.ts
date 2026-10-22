import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SkriptLanguageService } from '@skript-ide/language-server'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { findDefinitionTool, findReferencesTool, getOutlineTool, renameSymbolTool, type FileChange } from '../src/index'
import { makeContext, makeProject } from './helpers'

const FILES = {
  'main.sk': [
    'options:',
    '\tprefix: &a[Kit]',
    '',
    'on join:',
    '\tset {_target} to player',
    '\tgive_kit({_target})',
    '\tsend "{@prefix} welcome" to {_target}',
    ''
  ].join('\n'),
  'lib/kits.sk': [
    'function give_kit(p: player):',
    '\tgive diamond to {_p}',
    '\tadd 1 to {kits::%{_p}%}',
    '',
    'command /kit:',
    '\ttrigger:',
    '\t\tgive_kit(player)',
    ''
  ].join('\n')
}

async function withProject(run: (root: string, ctx: ReturnType<typeof context>) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(FILES)
  try {
    await run(root, context(root))
  } finally {
    await cleanup()
  }
}

function context(root: string) {
  const changes: FileChange[] = []
  const languageService = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1' })
  return {
    ...makeContext({ projectRoot: root }),
    languageService,
    changes,
    onFilesChanged: (list: readonly FileChange[]) => changes.push(...list)
  }
}

test('get_outline tek dosyada blokları satır aralıklarıyla, projede üst düzey yapıları listeler', () =>
  withProject(async (_root, ctx) => {
    const single = await getOutlineTool.execute({ path: 'lib/kits.sk' }, ctx)
    const lines = single.split('\n')
    assert.equal(lines[0], 'lib/kits.sk:')
    assert.match(lines[1], /^  1-3: give_kit.*\(.*give_kit\(p: player\)/)
    assert.ok(lines.some((line) => /^  5-7: .*kit/.test(line)), single)

    const all = await getOutlineTool.execute({}, ctx)
    assert.match(all, /^lib\/kits\.sk:\n  1-3: give_kit/m)
    assert.match(all, /^main\.sk:\n  1-2: options/m)
    assert.match(all, /^  4-7: on join/m)
    // Proje görünümünde iç öğeler gösterilmez
    assert.doesNotMatch(all, /^    /m)
  }))

test('find_definition başka dosyadaki fonksiyonu bulur', () =>
  withProject(async (_root, ctx) => {
    assert.equal(
      await findDefinitionTool.execute({ path: 'main.sk', symbol: 'give_kit' }, ctx),
      'lib/kits.sk:1:10: function give_kit(p: player):'
    )
    assert.match(await findDefinitionTool.execute({ path: 'main.sk', symbol: '{_target}', line: 7 }, ctx), /^main\.sk:5:\d+: set \{_target\} to player$/)
    await assert.rejects(findDefinitionTool.execute({ path: 'main.sk', symbol: 'nope' }, ctx), /does not appear in main\.sk/)
    await assert.rejects(findDefinitionTool.execute({ path: 'main.sk', symbol: 'give_kit', line: 2 }, ctx), /does not appear on line 2/)
  }))

test('find_references fonksiyonun tanımını ve tüm dosyalardaki çağrılarını verir', () =>
  withProject(async (_root, ctx) => {
    const result = await findReferencesTool.execute({ path: 'lib/kits.sk', symbol: 'give_kit(p: player)' }, ctx)
    const [header, ...rest] = result.split('\n')
    assert.equal(header, '3 references:')
    assert.deepEqual(rest.map((line) => line.replace(/:\d+: .*$/, '')).sort(), ['lib/kits.sk:1', 'lib/kits.sk:7', 'main.sk:6'])
  }))

test('rename_symbol fonksiyonu tüm dosyalarda tek onayla yeniden adlandırır', () =>
  withProject(async (root, ctx) => {
    const input = { path: 'main.sk', symbol: 'give_kit', new_name: 'give_starter_kit' }
    const preview = await renameSymbolTool.preview!(input, ctx)
    assert.equal(preview.summary, 'Rename give_kit → give_starter_kit in 2 files')
    assert.deepEqual(preview.changes!.map((c) => c.path).sort(), ['lib/kits.sk', 'main.sk'])

    assert.match(await renameSymbolTool.execute(input, ctx), /^Renamed give_kit → give_starter_kit in /)
    const kits = await readFile(join(root, 'lib/kits.sk'), 'utf8')
    assert.match(kits, /^function give_starter_kit\(p: player\):/)
    assert.match(kits, /\t\tgive_starter_kit\(player\)/)
    assert.match(await readFile(join(root, 'main.sk'), 'utf8'), /\tgive_starter_kit\(\{_target\}\)/)
    assert.equal(ctx.changes.length, 2)

    await assert.rejects(renameSymbolTool.execute({ ...input, symbol: 'give_starter_kit', new_name: '1bad' }, ctx), /only contain letters/)
  }))

test('rename_symbol yerel değişkeni yalnızca kendi tetikleyicisinde değiştirir', () =>
  withProject(async (root, ctx) => {
    await renameSymbolTool.execute({ path: 'main.sk', symbol: '{_target}', new_name: '_p' }, ctx)
    const main = await readFile(join(root, 'main.sk'), 'utf8')
    assert.equal((main.match(/\{_p\}/g) ?? []).length, 3)
    assert.doesNotMatch(main, /_target/)
    // Başka dosyadaki aynı adlı yerel değişkene dokunulmaz
    assert.equal(await readFile(join(root, 'lib/kits.sk'), 'utf8'), FILES['lib/kits.sk'])

    await assert.rejects(renameSymbolTool.execute({ path: 'main.sk', symbol: '{_p}', new_name: 'global' }, ctx), /must start with _|_ ile başlamalı/)
  }))

test('rename_symbol seçeneği tanımında ve kullanımında değiştirir', () =>
  withProject(async (root, ctx) => {
    await renameSymbolTool.execute({ path: 'main.sk', symbol: '{@prefix}', new_name: 'tag' }, ctx)
    const main = await readFile(join(root, 'main.sk'), 'utf8')
    assert.match(main, /^\ttag: &a\[Kit\]$/m)
    assert.match(main, /"\{@tag\} welcome"/)
  }))

test('navigasyon tool\'ları .sk olmayan dosyayı ve dil servisi yokluğunu reddeder', () =>
  withProject(async (root, ctx) => {
    await assert.rejects(getOutlineTool.execute({ path: 'main.txt' }, ctx), /not found/)
    await assert.rejects(getOutlineTool.execute({}, makeContext({ projectRoot: root })), /language service is not available/)
  }))
