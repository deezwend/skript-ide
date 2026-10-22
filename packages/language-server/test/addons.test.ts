/** Seçili addon'ların syntax'ları gerçek sürüm ve addon verisiyle tanınır. */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import { SkriptLanguageService } from '../src/index'

const TEXT = ['on pre creature spawn of a zombie:', '\tcancel event', '\tabort creature spawn'].join('\n')

function service(addons: { name: string; version: string }[]): SkriptLanguageService {
  return new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1', addons })
}

test('SkBee seçiliyken olayı ve efekti tanınır, uyarı yok', async () => {
  const ls = service([{ name: 'SkBee', version: '3.26.0' }])
  ls.openDocument('file:///addon/skbee.sk', TEXT, 1)
  const diagnostics = await ls.getDiagnostics('file:///addon/skbee.sk')
  assert.deepEqual(diagnostics.map((d) => String(d.code)), [])
  const status = ls.addonDataStatus()
  assert.equal(status[0]?.data, 'exact')
})

test('SkBee seçili değilken addon-syntax uyarısı addon adını verir', async () => {
  const ls = service([])
  ls.openDocument('file:///addon/none.sk', TEXT, 1)
  const diagnostics = await ls.getDiagnostics('file:///addon/none.sk')
  const addon = diagnostics.filter((d) => d.code === 'addon-syntax')
  assert.ok(addon.length > 0, diagnostics.map((d) => `${d.code}: ${String(d.message)}`).join('\n'))
  assert.match(String(addon[0]!.message), /SkBee/)
})
