import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolError, type AgentLanguageService, type ToolMigrationItem, type ToolMigrationReport } from '../src/tool'
import { getMigrationNotesTool } from '../src/tools/skript/migration'
import { makeContext, makeProject } from './helpers'

function item(uri: string, line: number, status: ToolMigrationItem['status'], overrides: Partial<ToolMigrationItem> = {}): ToolMigrationItem {
  return {
    uri,
    line,
    text: 'the line',
    status,
    message: 'server message',
    entry: { id: 'EffExample', name: 'Example', kind: 'effect', patterns: ['example'] },
    ...overrides
  }
}

function makeService(
  build: (from: string, to: string) => ToolMigrationReport,
  version = '2.17.1'
): { service: AgentLanguageService; calls: [string, string][] } {
  const calls: [string, string][] = []
  const service = {
    skriptVersion: version,
    selectedAddons: [],
    setWorkspaceFiles: () => {},
    getMigrationReport: async (from: string, to: string) => {
      calls.push([from, to])
      return build(from, to)
    }
  } as unknown as AgentLanguageService
  return { service, calls }
}

test('get_migration_notes hedef sürümü projeden alır ve durumlara göre listeler', async () => {
  const uri = 'file:///C:/proj/main.sk'
  const { service, calls } = makeService((from, to) => ({
    from,
    to,
    files: 2,
    checkedLines: 10,
    counts: { removed: 1, changed: 1, new: 1 },
    items: [
      item(uri, 2, 'removed', { text: 'bungee command "spawn"', entry: { id: 'EffCommand', name: 'Command', kind: 'effect', patterns: [] } }),
      item(uri, 5, 'changed', {
        text: 'send action bar "hi"',
        entry: { id: 'EffBar', name: 'Bar', kind: 'effect', patterns: [] },
        target: { id: 'EffBar', name: 'Bar', kind: 'effect', patterns: ['send bar %text%'] },
        fix: { title: 'Use the new form', newText: 'send bar "hi"' }
      }),
      item(uri, 8, 'new', { entry: { id: 'EffNew', name: 'New Thing', kind: 'effect', patterns: [] } })
    ]
  }))
  const result = await getMigrationNotesTool.execute({ from: '2.12.2' }, { ...makeContext(), languageService: service })
  assert.deepEqual(calls, [['2.12.2', '2.17.1']])
  assert.match(result, /^Skript 2\.12\.2 → 2\.17\.1 migration: removed: 1, changed: 1, new: 1 in 2 files \(10 lines checked\)\./)
  assert.match(result, /main\.sk:3: "Command" was removed in Skript 2\.17\.1 — bungee command "spawn"/)
  assert.match(result, /main\.sk:6: "Bar" changed in Skript 2\.17\.1; it no longer matches \(now: send bar %text%\)/)
  assert.match(result, /main\.sk:9: "New Thing" is only valid in Skript 2\.17\.1/)
  assert.match(result, /1 of these lines have a suggested fix/)
})

test('get_migration_notes path verilirse yalnızca o dosyayı raporlar', async () => {
  const { root, cleanup } = await makeProject({ 'a.sk': 'on join:\n', 'dir/b.sk': 'on join:\n' })
  try {
    const a = pathToFileURL(join(root, 'a.sk')).href
    const b = pathToFileURL(join(root, 'dir', 'b.sk')).href
    const { service } = makeService((from, to) => ({
      from,
      to,
      files: 2,
      checkedLines: 4,
      counts: { removed: 2, changed: 0, new: 0 },
      items: [item(a, 0, 'removed'), item(b, 1, 'removed')]
    }))
    const result = await getMigrationNotesTool.execute(
      { from: '2.12.2', path: 'a.sk' },
      { ...makeContext({ projectRoot: root }), languageService: service }
    )
    assert.match(result, /Only a\.sk\./)
    assert.match(result, /a\.sk:1:/)
    assert.doesNotMatch(result, /b\.sk/)
  } finally {
    await cleanup()
  }
})

test('get_migration_notes desteklenmeyen sürümde ToolError verir', async () => {
  const { service } = makeService((_from, to) => {
    throw new Error(`No syntax data for Skript ${to}.`)
  })
  await assert.rejects(
    getMigrationNotesTool.execute({ from: '2.0' }, { ...makeContext(), languageService: service }),
    (error: unknown) => error instanceof ToolError && /No syntax data for Skript/.test(error.message)
  )
  await assert.rejects(
    getMigrationNotesTool.execute({ from: '  ' }, { ...makeContext(), languageService: service }),
    ToolError
  )
})

test('get_migration_notes listeyi sınırlar ve kalanı söyler', async () => {
  const uri = 'file:///C:/proj/main.sk'
  const { service } = makeService((from, to) => ({
    from,
    to,
    files: 1,
    checkedLines: 100,
    counts: { removed: 50, changed: 0, new: 0 },
    items: Array.from({ length: 50 }, (_, index) => item(uri, index, 'removed'))
  }))
  const result = await getMigrationNotesTool.execute({ from: '2.12.2', to: '2.17.1' }, { ...makeContext(), languageService: service })
  assert.match(result, /\(… 10 more\)/)
  assert.equal(result.split('\n').filter((line) => line.startsWith('- ')).length, 40)
})
