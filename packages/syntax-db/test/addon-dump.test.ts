import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertAddonDump, humanizeClassName, isUsablePattern, type RegistryDump } from '../src/addon-dump'
import { SCHEMA_VERSION, type SyntaxDatabase } from '../src/schema'

const base: SyntaxDatabase = {
  schemaVersion: SCHEMA_VERSION,
  skriptVersion: '2.17.1',
  source: { kind: 'local-server', url: 'test', sha256: 'x', jsonFormat: '2.0' },
  counts: { event: 0, condition: 0, effect: 0, expression: 0, section: 0, structure: 0, type: 1, function: 1 },
  entries: [
    { kind: 'type', id: 'number', name: 'Number', patterns: [], description: '', examples: [], since: [], deprecated: false },
    { kind: 'function', id: 'floor', name: 'floor', patterns: ['floor(n: number)'], description: '', examples: [], since: [], deprecated: false }
  ]
}

const dump: RegistryDump = {
  skript: '2.17.1',
  syntaxes: [
    { kind: 'effect', origin: 'Skript', class: 'ch.njol.skript.effects.EffBroadcast', patterns: ['broadcast %objects%'] },
    {
      kind: 'expression',
      origin: 'SkBee',
      class: 'com.shanebeestudios.skbee.elements.ExprAbsorption',
      patterns: ['[the] absorption amount of %entities%'],
      returns: 'number'
    },
    { kind: 'condition', origin: 'SkBee', class: 'com.shanebeestudios.skbee.elements.CondNbtFile', patterns: ['nbt file %string% (exists|1:doesn\'t exist)'] },
    { kind: 'event', origin: 'SkBee', class: 'com.shanebeestudios.skbee.PlayerEvents', patterns: ['[skbee] anvil prepare'], name: 'On Anvil Prepare' },
    { kind: 'event', origin: 'SkBee', class: 'com.shanebeestudios.skbee.PlayerEvents', patterns: ['[skbee] block damage abort'], name: 'On Block Damage Abort' },
    { kind: 'effect', origin: 'skript-reflect', class: 'org.skriptlang.reflect.EffAwait', patterns: ['[1:await] <.+>'] },
    { kind: 'effect', origin: 'skript-reflect', class: 'org.skriptlang.reflect.EffNegateCondition', patterns: ['negate [the] [current] condition', 'this is here because at least one pattern is required'] }
  ],
  types: [
    { codeName: 'number', docName: 'Number', class: 'java.lang.Number', patterns: ['numbers?'] },
    { codeName: 'event', docName: null, class: 'org.bukkit.event.Event', patterns: [] },
    { codeName: 'nbtcompound', docName: 'NBT Compound', class: 'com.shanebeestudios.skbee.api.nbt.NBTCompound', patterns: ['nbt ?compounds?'] },
    { codeName: 'bossbar', docName: 'Boss Bar', class: 'org.bukkit.boss.BossBar', patterns: ['boss ?bars?'] },
    { codeName: 'javatype', docName: 'Java Type', class: 'org.skriptlang.reflect.java.JavaType', patterns: [] }
  ],
  functions: [
    { name: 'floor', class: 'ch.njol.skript.lang.function.SimpleJavaFunction', signature: 'floor(n: number)', returns: 'long' },
    { name: 'bukkitColor', class: 'ch.njol.skript.lang.function.SimpleJavaFunction', signature: 'bukkitColor(alpha: number, red: number)' }
  ]
}

/** Aynı sunucunun yalnızca skript-reflect kurulu hali. */
const reference: RegistryDump = {
  skript: '2.17.1',
  syntaxes: [],
  types: dump.types.filter((type) => type.codeName !== 'nbtcompound' && type.codeName !== 'bossbar'),
  functions: dump.functions!.filter((fn) => fn.name === 'floor')
}

const source = { kind: 'addon-server' as const, url: 'test', sha256: 'x' }

test('kalıp süzgeci yer tutucuları ve her şeyi yakalayan pattern\'leri atar', () => {
  assert.equal(isUsablePattern('[1:await] <.+>'), false)
  assert.equal(isUsablePattern('[the] [event-]<.+>'), false)
  assert.equal(isUsablePattern('this is here because at least one pattern is required'), false)
  assert.equal(isUsablePattern('import <[\\w.]+>'), true)
  assert.equal(isUsablePattern('negate [the] [current] condition'), true)
})

test('sınıf adları okunur hale gelir', () => {
  assert.equal(humanizeClassName('org.skriptlang.reflect.EffNegateCondition'), 'Negate Condition')
  assert.equal(humanizeClassName('com.x.ExprNBTCompound'), 'NBT Compound')
})

test('SkBee: syntax kökene göre, tür ve fonksiyon referans dökümüyle farktan; doküman eşleşir', () => {
  const db = convertAddonDump({
    addon: 'SkBee',
    addonVersion: '3.26.0',
    dump,
    docs: {
      conditions: [{ name: 'NBT File Exists', description: ['Dosya var mı.'], since: ['3.0.0'], patterns: ['nbt file %string% (exists|doesn\'t exist)'] }],
      events: [{ name: 'Anvil Prepare', patterns: ['[on] [skbee] anvil prepare'], cancellable: false }],
      functions: [{ name: 'Bukkit Color', description: ['Renk oluşturur.'], patterns: ['bukkitColor(alpha: number, red: number)'] }]
    },
    base,
    reference,
    packages: ['com.shanebeestudios.skbee.'],
    source,
    jsonFormat: 'test'
  })
  assert.deepEqual(db.addon, { name: 'SkBee', version: '3.26.0' })
  assert.equal(db.counts.expression, 1)
  assert.equal(db.counts.event, 2)
  const condition = db.entries.find((entry) => entry.kind === 'condition')!
  assert.equal(condition.name, 'NBT File Exists')
  assert.equal(condition.description, 'Dosya var mı.')
  // Pattern'ler kayıt defterindeki hali (ayrıştırma etiketleriyle)
  assert.deepEqual(condition.patterns, ["nbt file %string% (exists|1:doesn't exist)"])
  const expression = db.entries.find((entry) => entry.kind === 'expression')!
  assert.deepEqual(expression.returnType, { id: 'number', name: 'Number' })
  // Aynı sınıfı paylaşan olaylar ayrı kimlik alır
  const events = db.entries.filter((entry) => entry.kind === 'event')
  assert.equal(new Set(events.map((entry) => entry.id)).size, 2)
  assert.deepEqual(
    db.entries.filter((entry) => entry.kind === 'type').map((entry) => entry.id).sort(),
    ['bossbar', 'nbtcompound']
  )
  const fn = db.entries.find((entry) => entry.kind === 'function')!
  assert.equal(fn.id, 'bukkitColor')
  assert.equal(fn.description, 'Renk oluşturur.')
  assert.ok(db.entries.every((entry) => entry.addon === 'SkBee'))
})

test('skript-reflect: yer tutucu ve her şeyi yakalayan kayıtlar düşer, türler paket adından', () => {
  const db = convertAddonDump({
    addon: 'skript-reflect',
    addonVersion: '2.6.3',
    dump,
    base,
    packages: ['org.skriptlang.reflect.'],
    source,
    jsonFormat: 'test'
  })
  assert.equal(db.counts.effect, 1)
  assert.deepEqual(db.entries.find((entry) => entry.kind === 'effect')!.patterns, ['negate [the] [current] condition'])
  // Referans yokken kökeni bilinmeyen (Bukkit sınıflı) türler alınmaz
  assert.deepEqual(db.entries.filter((entry) => entry.kind === 'type').map((entry) => entry.id), ['javatype'])
  assert.equal(db.counts.function, 0)
})
