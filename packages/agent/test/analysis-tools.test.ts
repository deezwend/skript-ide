import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SkriptLanguageService } from '@skript-ide/language-server'
import { readAddonDatabase, readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import type { SkriptServer } from '@skript-ide/runtime-validator'
import { createSkriptTools, formatScript, previewText, type AgentTool, type TextFetcher, type ToolContext } from '../src/index'
import { makeContext, makeProject } from './helpers'

const fetched: string[] = []
const fakeFetch: TextFetcher = async (url) => {
  fetched.push(url)
  if (url.endsWith('type-search-index.js')) {
    return 'typeSearchIndex = [{"p":"org.bukkit.entity","l":"Player","k":"10"},{"p":"org.bukkit.event.player","l":"PlayerJoinEvent"}];updateSearchResults();'
  }
  if (url.endsWith('member-search-index.js')) {
    return 'memberSearchIndex = [{"p":"org.bukkit.entity","c":"Player","l":"getHealth()"},{"p":"org.bukkit.entity","c":"Player","l":"sendMessage(String)"}];updateSearchResults();'
  }
  return [
    '<div class="type-signature"><span class="modifiers">public interface </span><span class="element-name">Player</span></div>',
    '<section class="class-description"><div class="block">Represents a player, connected or not. More text.</div></section>',
    '<section class="method-summary" id="method-summary"><div class="summary-table">',
    '<div class="col-first even-row-color"><code>double</code></div>',
    '<div class="col-second even-row-color"><code><a href="#getHealth()">getHealth</a>()</code></div>',
    '<div class="col-last even-row-color">\n<div class="block">Gets the health. Extra.</div>\n</div>',
    '<div class="col-first odd-row-color"><code>void</code></div>',
    '<div class="col-second odd-row-color"><code><a href="#kick()">kick</a>()</code></div>',
    '<div class="col-last odd-row-color">\n<div class="block">Kicks the player.</div>\n</div>',
    '</div></section>',
    '<h3 id="methods-inherited-from-interface-org.bukkit.entity.HumanEntity">x</h3>'
  ].join('\n')
}

const tools = new Map(
  createSkriptTools({ loadDatabase: readSyntaxDatabase, loadAddonDatabase: readAddonDatabase }, undefined, fakeFetch).map((tool) => [tool.name, tool])
)
const tool = (name: string): AgentTool => tools.get(name)!

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(files)
  try {
    await run(root)
  } finally {
    await cleanup()
  }
}

function serviceContext(root: string): ToolContext {
  return {
    ...makeContext({ projectRoot: root }),
    languageService: new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1', addons: [] })
  }
}

test('formatScript karışık girintiyi seviyelere göre düzeltir ve eksik ":" ekler', () => {
  const source = 'on join:\n    if player is op\n\t\tsend "hi"   \n    # yorum\n    send "x"\ncommand /a:\n  trigger:\n      send "b"\n'
  const result = formatScript(source, { indent: 'tab' })
  assert.equal(result.text, 'on join:\n\tif player is op:\n\t\tsend "hi"\n\t# yorum\n\tsend "x"\ncommand /a:\n\ttrigger:\n\t\tsend "b"\n')
  assert.deepEqual(result.colonsAdded, [2])
})

test('formatScript CRLF ve zaten düzgün dosyayı korur', () => {
  const source = 'on join:\r\n\tsend "hi"\r\n'
  assert.equal(formatScript(source).text, source)
})

test('format_script dosyayı yazar ve onay için diff verir', () =>
  withProject({ 'a.sk': 'on join:\n  send "a"\n\tsend "b"\n' }, async (root) => {
    const ctx = makeContext({ projectRoot: root })
    const preview = await tool('format_script').preview!({ path: 'a.sk', indent: '4' }, ctx)
    assert.equal(preview.changes?.[0].after, 'on join:\n    send "a"\n    send "b"\n')
    const result = await tool('format_script').execute({ path: 'a.sk', indent: '4' }, ctx)
    assert.match(result, /Formatted a\.sk/)
    assert.equal(await readFile(join(root, 'a.sk'), 'utf8'), 'on join:\n    send "a"\n    send "b"\n')
  }))

test('inspect_variables yazım hatasını, okunmayan ve set edilmeyen yerelleri bulur', () =>
  withProject(
    {
      'a.sk': 'on join:\n\tset {coins::%player%} to 5\n\tadd 1 to {kills::%player%}\n\tsend "%{_msg}%"\n',
      'b.sk': 'command /c:\n\ttrigger:\n\t\tsend "%{coin::%player%}%"\n\t\tloop {coins::*}:\n\t\t\tsend "x"\n\t\tset {_a} to 1\n\t\tsend "%{_a}%"\n'
    },
    async (root) => {
      const result = await tool('inspect_variables').execute({}, makeContext({ projectRoot: root }))
      assert.match(result, /\{coins::\*\}: set 1×, read 1×; written as \{coins::%player%\}, \{coins::\*\}/)
      assert.match(result, /\{coin::%player%\} is read at b\.sk:3 but never set anywhere; did you mean \{coins::%player%\}\?/)
      assert.match(result, /\{kills::%player%\} is set at a\.sk:3 but never read/)
      assert.match(result, /\{_msg\} is read at a\.sk:4 in "on join" but never set there/)
      assert.doesNotMatch(result, /\{_a\} is read/)
    }
  ))

test('get_call_graph tanımsız çağrıyı, argüman sayısını, yerel fonksiyonu ve wait sorununu bildirir', () =>
  withProject(
    {
      'lib.sk': 'function give(p: player, n: number) :: number:\n\twait 1 tick\n\treturn 1\nlocal function secret():\n\tsend "x"\nfunction unused():\n\tsend "y"\n',
      'main.sk': 'on join:\n\tgive(player)\n\tmissing_fn()\n\tsecret()\n\tset {_r} to round(1.5)\n'
    },
    async (root) => {
      const result = await tool('get_call_graph').execute({}, serviceContext(root))
      assert.match(result, /main\.sk:2: give\(\) needs at least 2 arguments but gets 1/)
      assert.match(result, /main\.sk:3: missing_fn\(\) is not defined/)
      assert.match(result, /secret\(\) is a local function of lib\.sk/)
      assert.match(result, /function unused .* is never called/)
      assert.match(result, /function give returns a value but waits at lib\.sk:2/)
      assert.doesNotMatch(result, /round\(\) is not defined/)
      const one = await tool('get_call_graph').execute({ function: 'give' }, serviceContext(root))
      assert.match(one, /function give\(p: player, n: number\) :: number/)
      assert.match(one, /main\.sk:2 in on join/)
    }
  ))

test('list_commands çakışmaları bildirir', () =>
  withProject(
    {
      'a.sk': 'command /shop [<text>]:\n\tpermission: shop.use\n\taliases: market\n\ttrigger:\n\t\tsend "x"\n',
      'b.sk': 'command /market:\n\ttrigger:\n\t\tsend "y"\ncommand /tp:\n\ttrigger:\n\t\tsend "z"\ncommand /home:\n\tdescription: x\n'
    },
    async (root) => {
      const result = await tool('list_commands').execute({}, makeContext({ projectRoot: root }))
      assert.match(result, /\/shop \[<text>\] — a\.sk:1/)
      assert.match(result, /permission: shop\.use; aliases: market/)
      assert.match(result, /\/market is defined or aliased 2 times/)
      assert.match(result, /\/tp .* overrides a Minecraft/)
      assert.match(result, /\/home .* EssentialsX/)
      assert.match(result, /\/home .* has no trigger/)
    }
  ))

test('analyze_performance sık olaylardaki ve büyük döngülerdeki sorunları bulur', () =>
  withProject(
    {
      'a.sk': [
        'on any move:',
        '\tloop all players:',
        '\t\tsend "x"',
        '\tset {last::%player%} to now',
        'every 5 ticks:',
        '\tloop blocks in radius 30 around {spawn}:',
        '\t\tset loop-block to air',
        'command /x:',
        '\ttrigger:',
        '\t\tloop 50000 times:',
        '\t\t\tadd 1 to {_n}',
        '\t\twhile {_n} > 0:',
        '\t\t\tremove 1 from {_n}',
        'on join:',
        '\tloop 5 times:',
        '\t\tsend "ok"',
        ''
      ].join('\n')
    },
    async (root) => {
      const result = await tool('analyze_performance').execute({}, makeContext({ projectRoot: root }))
      assert.match(result, /\[high\] a\.sk:2 in on any move: Loop inside code that fires very often/)
      assert.match(result, /a\.sk:4 .*Writes a global variable/)
      assert.match(result, /a\.sk:6 .*every 5 ticks.*Radius 30/s)
      assert.match(result, /a\.sk:10 .*50,000 iterations without a wait/)
      assert.match(result, /a\.sk:12 .*while loop without a wait/)
      assert.doesNotMatch(result, /a\.sk:15/)
    }
  ))

test('previewText renkleri, etiketleri ve Skript tuhaflıklarını açıklar', () => {
  const preview = previewText('&a[Shop] <red><bold>Hi %player%<reset> <rainbow>x &#ff00aa!')
  assert.equal(preview.plain, '[Shop] Hi ‹player› <rainbow>x !')
  assert.deepEqual(preview.segments[0], { text: '[Shop] ', color: 'light green', formats: [], actions: [] })
  assert.deepEqual(preview.segments[1], { text: 'Hi ‹player›', color: 'dark red', formats: ['bold'], actions: [] })
  assert.ok(preview.notes.some((note) => note.includes('<red> is DARK red')))
  assert.ok(preview.notes.some((note) => note.includes('Unknown tag <rainbow>')))
  assert.ok(preview.notes.some((note) => note.includes('Mixes')))
  assert.equal(previewText('100%% done').plain, '100% done')
})

test('preview_text satırdaki string\'leri okur', () =>
  withProject({ 'a.sk': 'on join:\n\tsend "<light green>Hello" to player\n' }, async (root) => {
    const result = await tool('preview_text').execute({ path: 'a.sk', line: 2 }, makeContext({ projectRoot: root }))
    assert.match(result, /Shown as: "Hello"/)
    assert.match(result, /\[light green\] "Hello"/)
  }))

test('preview_gui slot ızgarasını, aralıkları ve döngüleri çizer', () =>
  withProject(
    {
      'gui.sk': [
        'command /menu:',
        '\ttrigger:',
        '\t\tset {_gui} to chest inventory with 3 rows named "&8Shop"',
        '\t\tset slots (integers between 0 and 8) of {_gui} to gray stained glass pane named " "',
        '\t\tset slot 13 of {_gui} to diamond sword named "&bSword" with lore "&7Sharp" and "&7Fast"',
        '\t\tloop 9 times:',
        '\t\t\tset slot loop-number + 17 of {_gui} to black stained glass pane',
        '\t\tset slot 30 of {_gui} to stone',
        '\t\tset slot 4 of {_gui} to emerald',
        '\t\topen {_gui} to player',
        ''
      ].join('\n')
    },
    async (root) => {
      const result = await tool('preview_gui').execute({ path: 'gui.sk' }, makeContext({ projectRoot: root }))
      assert.match(result, /\{_gui\} — chest, 3×9, title "&8Shop" → shown "Shop"/)
      assert.match(result, / {3}0 {2}A A A A B A A A A/)
      assert.match(result, / {3}9 {2}· · · · C · · · ·/)
      assert.match(result, / {2}18 {2}D D D D D D D D D/)
      assert.match(result, /C: diamond sword named "Sword"; lore: "Sharp" \/ "Fast" — slot 13/)
      assert.match(result, /slot 30 is outside this 3-row inventory/)
      assert.match(result, /slot 4 overrides what line 4 put there/)
    }
  ))

test('preview_gui skript-gui `create a gui ...:` bölümünü tek menü olarak çizer', () =>
  withProject(
    {
      'menu.sk': [
        'command /back:',
        '\ttrigger:',
        '\t\tcreate a gui with virtual chest inventory with 1 row named "Back":',
        '\t\t\tmake gui slot (integers from 0 to 8) with gray stained glass pane named "&a"',
        '\t\t\tif player has permission "back.tp":',
        '\t\t\t\tmake gui slot 4 with ender pearl named "&aTeleport":',
        '\t\t\t\t\tteleport player to spawn',
        '\t\t\telse:',
        '\t\t\t\tmake gui slot 4 with barrier named "&cNo"',
        '\t\topen last gui to player',
        ''
      ].join('\n')
    },
    async (root) => {
      const result = await tool('preview_gui').execute({ path: 'menu.sk' }, makeContext({ projectRoot: root }))
      assert.match(result, /chest, 1×9, title "Back"/)
      assert.doesNotMatch(result, /unknown/)
      assert.match(result, /Line 9: slot 4 overrides what line 6 put there/)
    }
  ))

test('lookup_minecraft_data belgelerdeki değer listelerinde arar', () =>
  withProject({}, async (root) => {
    const ctx = serviceContext(root)
    const list = await tool('lookup_minecraft_data').execute({}, ctx)
    assert.match(list, /Enchantment \(enchantment\): \d+ values/)
    const sharp = await tool('lookup_minecraft_data').execute({ type: 'enchant', query: 'sharp' }, ctx)
    assert.match(sharp, /sharpness/)
    const everywhere = await tool('lookup_minecraft_data').execute({ query: 'flame' }, ctx)
    assert.match(everywhere, /particle/i)
    const items = await tool('lookup_minecraft_data').execute({ type: 'item' }, ctx)
    assert.match(items, /dump_type_values/)
  }))

test('dump_type_values sunucudan değerleri toplar ve lookup_minecraft_data\'da aranabilir yapar', () =>
  withProject({}, async (root) => {
    const commands: string[] = []
    const server = {
      currentStatus: { state: 'ready', message: '', versions: { skript: '2.17.1', minecraft: '26.3' }, eulaUrl: '' },
      isEulaAccepted: async () => true,
      validate: async (source: string, fileName: string, content: string) => {
        assert.match(content, /loop all item types:/)
        return { source, stagedName: fileName, diagnostics: [], ok: true, durationMs: 1 }
      },
      runCommands: async (list: readonly string[]) => {
        commands.push(...list)
        return {
          output: ['SKRIPT_IDE_VALUES:diamond sword|oak log', 'SKRIPT_IDE_VALUES:stone', 'SKRIPT_IDE_VALUES_END'],
          timedOut: false,
          durationMs: 1,
          acknowledged: true,
          matchedUntil: true
        }
      },
      readLog: () => []
    } as unknown as Pick<SkriptServer, 'currentStatus' | 'isEulaAccepted' | 'validate' | 'runCommands' | 'readLog'>
    const ctx = { ...serviceContext(root), server }
    const result = await tool('dump_type_values').execute({ type: 'item types' }, ctx)
    assert.match(result, /all item types on Skript 2\.17\.1: 3 values/)
    assert.match(result, /diamond sword, oak log, stone/)
    assert.ok(commands.some((command) => command.startsWith('sk disable')))
    const search = await tool('lookup_minecraft_data').execute({ type: 'item types', query: 'oak' }, ctx)
    assert.match(search, /oak log/)
  }))

test('search_java_api ve get_java_class javadoc indeksini kullanır', async () => {
  const ctx = makeContext()
  const search = await tool('search_java_api').execute({ query: 'org.bukkit.entity.Player.getHealth', version: '26.3' }, ctx)
  assert.match(search, /org\.bukkit\.entity\.Player#getHealth\(\)/)
  const classes = await tool('search_java_api').execute({ query: 'PlayerJoin', version: '26.3' }, ctx)
  assert.match(classes, /org\.bukkit\.event\.player\.PlayerJoinEvent/)
  const page = await tool('get_java_class').execute({ class_name: 'Player', version: '26.3', filter: 'health' }, ctx)
  assert.match(page, /public interface Player/)
  assert.match(page, /Represents a player, connected or not\./)
  assert.match(page, /- double getHealth\(\) — Gets the health\./)
  assert.doesNotMatch(page, /kick/)
  assert.match(page, /Also inherits members from: org\.bukkit\.entity\.HumanEntity/)
  assert.ok(fetched.includes('https://jd.papermc.io/paper/26.3/org/bukkit/entity/Player.html'))
})

test('checkpoint kaydeder ve değişen, silinen dosyaları geri yükler', () =>
  withProject({ 'a.sk': 'on join:\n\tsend "a"\n', 'b.sk': 'on quit:\n\tsend "b"\n' }, async (root) => {
    const ctx = makeContext({ projectRoot: root })
    assert.match(await tool('create_checkpoint').execute({ name: 'before' }, ctx), /2 files/)
    await writeFile(join(root, 'a.sk'), 'changed', 'utf8')
    await import('node:fs/promises').then((fs) => fs.rm(join(root, 'b.sk')))
    await writeFile(join(root, 'c.sk'), 'new', 'utf8')
    assert.match(await tool('list_checkpoints').execute({}, ctx), /"before" .*2 differ now/)
    const preview = await tool('restore_checkpoint').preview!({ name: 'before' }, ctx)
    assert.equal(preview.changes?.length, 2)
    const result = await tool('restore_checkpoint').execute({ name: 'before' }, ctx)
    assert.match(result, /Restored 2 files/)
    assert.match(result, /Created after the checkpoint \(left as is\): c\.sk/)
    assert.equal(await readFile(join(root, 'a.sk'), 'utf8'), 'on join:\n\tsend "a"\n')
    assert.equal(await readFile(join(root, 'b.sk'), 'utf8'), 'on quit:\n\tsend "b"\n')
  }))
