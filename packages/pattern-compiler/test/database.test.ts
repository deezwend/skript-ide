import assert from 'node:assert/strict'
import test from 'node:test'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import type { SyntaxEntry } from '@skript-ide/syntax-db'
import { SyntaxMatcher } from '../src/index'

const versions = ['2.17.1', '2.16.2', '2.14.3', '2.12.2']

test('dört sürümdeki bütün patternler hatasız derlenir', async () => {
  for (const version of versions) {
    const database = await readSyntaxDatabase(version)
    const matcher = new SyntaxMatcher(database.entries)
    assert.deepEqual(
      matcher.patternErrors.map(error => `${error.entry.id}: ${error.message}`),
      [],
      `${version}: ${matcher.patternErrors.length} pattern derlenemedi`
    )
  }
})

test('2.17.1 üzerinde temsili satırlar doğru kayda eşleşir', async () => {
  const database = await readSyntaxDatabase('2.17.1')
  const matcher = new SyntaxMatcher(database.entries)

  const send = matcher.match('send "hi" to player', ['effect'])
  assert.equal(send[0]?.entry.id, 'EffMessage')
  assert.equal(send[0]?.confidence, 'exact')
  assert.deepEqual(send[0]?.match.placeholders.map(placeholder => placeholder.text), ['"hi"', 'player'])

  const change = matcher.match('set {_x} to 5', ['effect'])
  assert.equal(change[0]?.entry.id, 'EffChange')
  assert.equal(change[0]?.confidence, 'exact')
  assert.deepEqual(change[0]?.match.placeholders.map(placeholder => placeholder.text), ['{_x}', '5'])

  const permission = matcher.match('player has permission "a"', ['condition'])
  assert.equal(permission[0]?.entry.id, 'CondPermission')
  assert.equal(permission[0]?.confidence, 'exact')

  const give = matcher.match('give player 1 diamond', ['effect'])
  assert.ok(give.some(result => result.entry.id === 'EffChange'))
  assert.ok(give.some(result => result.confidence === 'structural'))

  const broadcast = matcher.match('broadcast "Welcome %player% to the server!"', ['effect'])
  assert.equal(broadcast[0]?.entry.id, 'EffBroadcast')
  assert.equal(broadcast[0]?.confidence, 'exact')
})

test('olay başlıkları StructEvent sarmalayıcısından soyulur', async () => {
  const database = await readSyntaxDatabase('2.17.1')
  const matcher = new SyntaxMatcher(database.entries)

  const click = matcher.matchEvent('on right click on stone')
  assert.equal(click[0]?.entry.id, 'click')
  assert.equal(click[0]?.confidence, 'exact')

  const periodical = matcher.matchEvent('every 5 seconds')
  assert.equal(periodical[0]?.entry.id, 'periodical')
  assert.equal(periodical[0]?.confidence, 'exact')

  const atTime = matcher.matchEvent('at 6:00')
  assert.equal(atTime[0]?.entry.id, 'at_time')

  const atTimeWithWorld = matcher.matchEvent('at 7am in "world"')
  assert.equal(atTimeWithWorld[0]?.entry.id, 'at_time')

  const priority = matcher.matchEvent('on join with priority high')
  assert.equal(priority[0]?.entry.id, 'join')

  const cancelled = matcher.matchEvent('on cancelled block break with priority lowest')
  assert.ok(cancelled.some(result => result.entry.id === 'break_mine' || result.entry.id === 'block_damage'))
})

test('matchExpression literal biçimlerini tanır', async () => {
  const database = await readSyntaxDatabase('2.17.1')
  const matcher = new SyntaxMatcher(database.entries)

  const cases: [string, string][] = [
    ['5', 'literal:number'],
    ['"metin"', 'literal:string'],
    ['"a ""quoted"" word"', 'literal:string'],
    ['"hi %player%"', 'literal:string'],
    ['{_x}', 'literal:variable'],
    ['{_x::*}', 'literal:variable'],
    ['{@option}', 'literal:option'],
    ['true', 'literal:boolean'],
    ['5 seconds', 'literal:timespan'],
    ['1 minute and 3 seconds', 'literal:timespan'],
    ['6:00', 'literal:clock'],
    ['arg-1', 'literal:argument'],
    ['event-player', 'literal:event-value'],
    ['loop-value', 'literal:loop-value'],
    ['is(5)', 'literal:function-call'],
    ['(1 + 2)', 'literal:parenthesized'],
    ['player and zombie', 'literal:list'],
    ['1, 2 or 3', 'literal:list']
  ]

  for (const [text, expectedId] of cases) {
    const results = matcher.matchExpression(text)
    assert.ok(
      results.some(result => result.entry.id === expectedId && result.confidence === 'exact'),
      `${text}: ${results.map(result => `${result.entry.id}/${result.confidence}`).join(', ')}`
    )
  }

  assert.ok(matcher.matchExpression('player').length > 0)
})

test('bilinmeyen ifade için kesin sonuç üretilmez', async () => {
  const database = await readSyntaxDatabase('2.17.1')
  const matcher = new SyntaxMatcher(database.entries)
  const results = matcher.matchExpression('zzz qqq')
  assert.ok(results.every(result => result.confidence !== 'exact'))
})

test('derlenemeyen pattern sessizce atlanır ama raporlanır', () => {
  const broken: SyntaxEntry = {
    kind: 'effect',
    id: 'broken',
    name: 'Broken',
    patterns: ['[broken'],
    description: '',
    examples: [],
    since: [],
    deprecated: false
  }
  const good: SyntaxEntry = {
    kind: 'effect',
    id: 'good',
    name: 'Good',
    patterns: ['do something %objects%'],
    description: '',
    examples: [],
    since: [],
    deprecated: false
  }

  const matcher = new SyntaxMatcher([broken, good])
  assert.equal(matcher.patternErrors.length, 1)
  assert.equal(matcher.patternErrors[0]?.entry.id, 'broken')
  assert.deepEqual(matcher.match('do something x', ['effect']).map(result => result.entry.id), ['good'])
})

test('kurulum ve eşleştirme makul sürede tamamlanır', async () => {
  const database = await readSyntaxDatabase('2.17.1')

  const buildStart = performance.now()
  const matcher = new SyntaxMatcher(database.entries)
  const buildTime = performance.now() - buildStart
  assert.ok(buildTime < 1000, `kurulum ${buildTime.toFixed(1)}ms`)

  const matchStart = performance.now()
  matcher.match('send "hi" to player', ['effect'])
  const matchTime = performance.now() - matchStart
  assert.ok(matchTime < 200, `ilk eşleştirme ${matchTime.toFixed(1)}ms`)
})

test('matchWithStatus bütçe tükenmesini bildirir; olay/döngü değeri değiştirilebilir sayılır', async () => {
  const database = await readSyntaxDatabase('2.17.1')
  const matcher = new SyntaxMatcher(database.entries)

  const unknown = matcher.matchWithStatus('zorp zorp zorp', ['effect', 'condition'])
  assert.deepEqual(unknown, { matches: [], complete: true })

  const tight = new SyntaxMatcher(database.entries, { maxSteps: 5 })
  assert.equal(tight.matchWithStatus('set {_x} to 5', ['effect']).complete, false)
  assert.equal(tight.matchEventWithStatus('on join').complete, false)

  assert.ok(matcher.match('set event-block to air', ['effect']).some(result => result.entry.id === 'EffChange'))
  assert.equal(matcher.matchEventWithStatus('on join').matches[0]?.entry.kind, 'event')
})
