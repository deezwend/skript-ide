/**
 * Geçiş asistanı: gerçek 2.12.2 ve 2.17.1 syntax verisi + gerçek parser/compiler.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { SkriptLanguageService } from '../src/index'

test('2.12.2 → 2.17.1: değişen satır, yalnızca hedefte tanınan satır ve doğrulanmış hızlı düzeltme', async () => {
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.12.2' })
  const uri = 'file:///migration/test.sk'
  const text = [
    'on load:',
    '    command "say hi" by console',
    '    set {_x} to 5',
    '    broadcast "%{_x}%"',
    'on join:',
    '    make the brewing stand consume its fuel'
  ].join('\n')
  service.openDocument(uri, text, 1)
  const report = await service.getMigrationReport('2.12.2', '2.17.1')
  assert.equal(report.files, 1)
  assert.deepEqual(
    report.items.map((item) => [item.line, item.status, item.entry?.id]),
    [
      [1, 'changed', 'EffCommand'],
      [5, 'new', 'EffBrewingConsume']
    ]
  )
  const changed = report.items[0]!
  assert.ok(changed.target && changed.target.patterns.some((pattern) => pattern.startsWith('execute')))
  assert.equal(changed.fix?.newText, 'execute command "say hi" by console')

  const actions = await service.getCodeActions(uri, changed.range)
  assert.deepEqual(actions.map((action) => action.title), ['Skript 2.17.1 geçişi: Başına "execute" ekle'])

  // Satır düzeltildikten sonra eski rapordaki düzeltme sunulmaz.
  service.updateDocument(uri, text.replace('    command', '    execute command'), 2)
  assert.deepEqual(await service.getCodeActions(uri, changed.range), [])
})

test('bilinmeyen sürüm reddedilir', async () => {
  const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1' })
  await assert.rejects(service.getMigrationReport('2.12.2', '9.9.9'), /syntax verisi yok/)
})
