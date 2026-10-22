import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createService, database, CURRENT, OLD } from './helpers'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('bilinmeyen sürümde varsayılana dönülür ve uyarı kaydedilir', async () => {
  const service = createService({ skriptVersion: '9.9.9' })
  await service.setSkriptVersion('9.9.9')

  assert.equal(service.skriptVersion, CURRENT)
  assert.ok(service.versionWarning)
  assert.match(service.versionWarning?.message ?? '', /9\.9\.9/)
})

test('sürüm değişince tanı yeniden hesaplanır', async () => {
  const service = createService({ skriptVersion: CURRENT })
  const uri = 'file:///test/switch.sk'
  const text = ['on join:', '    new thing "x"', '    old thing "y"'].join('\n')
  service.openDocument(uri, text, 1)

  const currentDiagnostics = await service.getDiagnostics(uri)
  const currentWarnings = currentDiagnostics.filter((diagnostic) => diagnostic.code === 'version-syntax')
  assert.equal(currentWarnings.length, 1)
  assert.match(String(currentWarnings[0].message), /old thing|kaldırılmış/)

  await service.setSkriptVersion(OLD)
  assert.equal(service.skriptVersion, OLD)
  const oldDiagnostics = await service.getDiagnostics(uri)
  const oldWarnings = oldDiagnostics.filter((diagnostic) => diagnostic.code === 'version-syntax')
  assert.equal(oldWarnings.length, 1)
  assert.match(String(oldWarnings[0].message), /eklendi/)
})

test('geçerli sürüme dönünce uyarı temizlenir', async () => {
  const service = createService({ skriptVersion: CURRENT })
  await service.setSkriptVersion('9.9.9')
  assert.ok(service.versionWarning)
  await service.setSkriptVersion(CURRENT)
  assert.equal(service.skriptVersion, CURRENT)
  assert.equal(service.versionWarning, null)
})

test('yavaş yüklenen eski istek, sonra istenen sürümü ezmez', async () => {
  const service = createService({
    skriptVersion: CURRENT,
    loadDatabase: async (version) => {
      await delay(version === OLD ? 60 : 5)
      return database(version, [])
    }
  })

  const slow = service.setSkriptVersion(OLD)
  await delay(1)
  const fast = service.setSkriptVersion(CURRENT)
  await Promise.all([slow, fast])

  assert.equal(service.skriptVersion, CURRENT)
})

test('eski isteğin başarısızlığı yeni sürümün durumunu ezmez', async () => {
  const service = createService({
    skriptVersion: CURRENT,
    loadDatabase: async (version) => {
      if (version === '9.9.9') {
        await delay(60)
        throw new Error(`test veritabanı yok: ${version}`)
      }
      await delay(5)
      return database(version, [])
    }
  })

  const slow = service.setSkriptVersion('9.9.9')
  await delay(1)
  const fast = service.setSkriptVersion(CURRENT)
  await Promise.all([slow, fast])

  assert.equal(service.skriptVersion, CURRENT)
  assert.equal(service.versionWarning, null)
})
