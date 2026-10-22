import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ADDON_COMPATIBILITY } from '../src/addon-compat'
import {
  ADDONS,
  checkAddonSelections,
  parseAddonSelections,
  recommendedAddonVersion,
  serializeAddonSelections
} from '../src/addons'

test('proje dosyasındaki addon alanı kanonik adlara çevrilir, bozuk girdiler uyarı olur', () => {
  const { selections, warnings } = parseAddonSelections({ skbee: '3.26.0', SkBee: '3.16.1', Foo: 3 })
  assert.deepEqual(selections, [{ name: 'SkBee', version: '3.26.0' }])
  assert.equal(warnings.length, 2)
  assert.deepEqual(serializeAddonSelections(selections), { SkBee: '3.26.0' })
  assert.equal(parseAddonSelections(['SkBee']).warnings.length, 1)
  assert.deepEqual(parseAddonSelections(undefined), { selections: [], warnings: [] })
})

test('seçim denetimi bilinmeyen addon ve desteklenmeyen sürümü bildirir, doğrulanmış seçimde sessiz kalır', () => {
  const issues = checkAddonSelections(
    [
      { name: 'Bilinmeyen', version: '1.0' },
      { name: 'SkBee', version: '0.0.1' },
      { name: 'skript-reflect', version: '2.6.3' }
    ],
    '2.17.1'
  )
  assert.deepEqual(
    issues.map((issue) => issue.kind),
    ['unknown-addon', 'unknown-version']
  )
})

test('uyumluluk tablosu yalnızca bilinen addon sürümlerini içerir ve her Skript sürümüne bir öneri vardır', () => {
  for (const entry of ADDON_COMPATIBILITY) {
    const addon = ADDONS.find((candidate) => candidate.id === entry.addon)
    assert.ok(addon, entry.addon)
    assert.ok(addon.versions.some((version) => version.version === entry.addonVersion), `${entry.addon} ${entry.addonVersion}`)
  }
  for (const skript of ['2.12.2', '2.14.3', '2.16.2', '2.17.1']) {
    for (const addon of ADDONS) assert.ok(recommendedAddonVersion(addon.id, skript), `${addon.id} @ ${skript}`)
  }
})
