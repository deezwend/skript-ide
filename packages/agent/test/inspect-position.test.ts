import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectPositionTool } from '../src/tools/skript/inspect-position'
import { makeContext, makeProject } from './helpers'
import { fakeLanguageService } from './fakes/language-service'

const FILE = 'on join:\n\tset {_target} to player\n'

function contextFor(root: string) {
  return {
    ...makeContext({ projectRoot: root }),
    languageService: fakeLanguageService({
      hover: { contents: { value: '**Set** · efekt\n\n```skript\nset {_x} to 1\n```' } },
      scope: {
        structure: { kind: 'event', header: 'on join:' },
        event: {
          header: 'on join:',
          matches: [{ kind: 'event', id: 'Join', name: 'Join', addon: 'Skript' }],
          values: [{ name: 'player' }, { name: 'event-block' }]
        },
        variables: [{ name: '_target', local: true, list: false, access: 'write' }],
        options: [{ name: 'prefix', value: '&a[Kit]' }]
      },
      completions: [{ label: 'send %objects% to %players%', kind: 14, detail: 'efekt • Send' }]
    })
  }
}

test('inspect_position hover, olay, değişkenler, options ve tamamlamayı tek çıktıda verir', async () => {
  const { root, cleanup } = await makeProject({ 'a.sk': FILE })
  try {
    const result = await inspectPositionTool.execute({ path: 'a.sk', line: 2 }, contextFor(root))
    const lines = result.split('\n')
    assert.equal(lines[0], 'a.sk:2:2: set {_target} to player')
    assert.equal(lines[1], 'Hover: Set · efekt')
    assert.equal(lines[2], '')
    assert.equal(lines[3], 'set {_x} to 1')
    assert.equal(lines[4], 'Inside: event "on join:"')
    assert.equal(lines[5], 'Matched event: [event] Join (id: Join, Skript)')
    assert.equal(lines[6], 'Event values: player, event-block')
    assert.equal(lines[7], 'Local variables: {_target} (write)')
    assert.equal(lines[8], 'Options: {@prefix} = &a[Kit]')
    assert.equal(lines[9], 'Completions (showing 1 of 1):')
    assert.equal(lines[10], '  send %objects% to %players% [keyword] — efekt • Send')
  } finally {
    await cleanup()
  }
})

test('inspect_position sütunu ve sınırları uygular', async () => {
  const { root, cleanup } = await makeProject({ 'a.sk': FILE })
  try {
    const ctx = contextFor(root)
    assert.match(await inspectPositionTool.execute({ path: 'a.sk', line: 2, column: 4 }, ctx), /^a\.sk:2:4: /)
    // Satırdan uzun sütun satır sonuna kırpılır (satır 24 karakter)
    assert.match(await inspectPositionTool.execute({ path: 'a.sk', line: 2, column: 500 }, ctx), /^a\.sk:2:25: /)
    await assert.rejects(inspectPositionTool.execute({ path: 'a.sk', line: 0 }, ctx), /positive integer/)
    await assert.rejects(inspectPositionTool.execute({ path: 'a.sk', line: 9 }, ctx), /fewer than 9 lines/)
  } finally {
    await cleanup()
  }
})

test('inspect_position hover yoksa ve dil servisi eksikse anlaşılır davranır', async () => {
  const { root, cleanup } = await makeProject({ 'a.sk': FILE, 'notes.txt': 'x\n' })
  try {
    const noHover = {
      ...makeContext({ projectRoot: root }),
      languageService: fakeLanguageService({ scope: null, completions: [] })
    }
    const result = await inspectPositionTool.execute({ path: 'a.sk', line: 1 }, noHover)
    assert.match(result, /^a\.sk:1:\d+: on join:$/m)
    assert.match(result, /^Hover: \(none\)$/m)
    assert.match(result, /^Completions: none at this position\.$/m)

    await assert.rejects(inspectPositionTool.execute({ path: 'a.sk', line: 1 }, makeContext({ projectRoot: root })), /language service/)
    await assert.rejects(inspectPositionTool.execute({ path: 'notes.txt', line: 1 }, noHover), /not a \.sk file/)
  } finally {
    await cleanup()
  }
})
