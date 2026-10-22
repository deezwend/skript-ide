import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { SyntaxDatabase } from '@skript-ide/syntax-db'
import { createService, CURRENT, DATABASES } from './helpers'
import { createFakeCompiler } from './fakes/compiler'

test('geçici matcher hatası hover önbelleğini kalıcı boşaltmaz', async () => {
  const fake = createFakeCompiler()
  let fail = true
  const compiler = {
    ...fake,
    createMatcher: (entries: Parameters<typeof fake.createMatcher>[0]) => {
      if (fail) {
        fail = false
        throw new Error('geçici matcher hatası')
      }
      return fake.createMatcher(entries)
    }
  }
  const service = createService({ patternCompiler: compiler })
  const uri = 'file:///test/o6-hover.sk'
  const text = ['on join:', '    send "x" to player'].join('\n')
  service.openDocument(uri, text, 1)

  const first = await service.getHover(uri, { line: 1, character: 8 })
  assert.equal(first, null)
  const second = await service.getHover(uri, { line: 1, character: 8 })
  assert.ok(second, 'ikinci hover matcher oluşturmayı yeniden denemeli')
  assert.match(JSON.stringify(second), /Send/)
})

test('geçici veritabanı hatası tamamlama önbelleğini kalıcı boşaltmaz', async () => {
  const base = DATABASES.get(CURRENT)!
  let fail = true
  const flaky = {
    ...base,
    get entries() {
      if (fail) {
        fail = false
        throw new Error('geçici girdi hatası')
      }
      return base.entries
    }
  } as SyntaxDatabase
  const service = createService({ loadDatabase: async () => flaky })
  const uri = 'file:///test/o6-completion.sk'
  service.openDocument(uri, ['on join:', '    send "x" to player'].join('\n'), 1)

  const first = await service.getCompletions(uri, { line: 1, character: 8 })
  assert.ok(!first.some((item) => item.label.startsWith('send')), 'ilk istek geçici olarak boş döner')
  const second = await service.getCompletions(uri, { line: 1, character: 8 })
  assert.ok(
    second.some((item) => item.label.startsWith('send')),
    'ikinci istekte önbellek yeniden denenmeli'
  )
})
