/**
 * Desteklenen Skript addon'ları ve sürümleri. Saf veri + küçük yardımcılar; Node API'si kullanmaz,
 * böylece arayüz de (addon seçici) aynı tabloyu okuyabilir.
 *
 * Neden SkBee ve skript-reflect: `packages/corpus` içindeki 27 addon betiğinde en sık istenen iki addon
 * (her biri 6 dosyada; sonra SkQuery 5, skript-gui 3). İkisi de aktif bakımda ve Skript'in güncel
 * sürümlerini destekliyor. SkBee çok sayıda klasik syntax (NBT, metin bileşenleri, tarifler, scoreboard…),
 * skript-reflect ise farklı türde (Java erişimi, `import:` yapısı, özel syntax tanımlama) syntax ekler;
 * böylece addon desteği iki farklı uçta denenmiş olur.
 *
 * Her sürümün indirme dosyası sabitlenmiştir (Modrinth: SHA-512, GitHub: SHA-256); indirilen jar bu özetle
 * doğrulanır. Gerçek sunucuda hangi Skript/Paper ikilisiyle çalıştığı `addon-compat.ts` dosyasındadır
 * (`npm run verify-addons -w @skript-ide/runtime-validator` üretir).
 */

import { ADDON_COMPATIBILITY, type AddonCompatibility } from './addon-compat'

import { l, localize } from '@skript-ide/i18n'
export { ADDON_COMPATIBILITY, type AddonCompatibility }

export type AddonDownload =
  | { kind: 'modrinth'; url: string; file: string; sha512: string }
  | { kind: 'github'; url: string; file: string; sha256: string }

export interface AddonVersionProfile {
  version: string
  /** Addon'un kendi sürüm notlarında yazan gereksinimler (doğrulanmış uyumluluk `ADDON_COMPATIBILITY`'de). */
  requires: { skript: string; minecraft: string }
  download: AddonDownload
}

export interface AddonProfile {
  /** `skript-project.json` içindeki anahtar ve eklentinin `plugin.yml` adı. */
  id: string
  /** Proje dosyasında kabul edilen diğer yazımlar (küçük harf). */
  aliases: readonly string[]
  homepage: string
  license: string
  /** Arayüzde gösterilen kısa açıklama. */
  description: string
  /** En yeniden eskiye. */
  versions: readonly AddonVersionProfile[]
}

export interface AddonSelection {
  /** `AddonProfile.id` ya da (bilinmeyen addon'da) kullanıcının yazdığı ad. */
  name: string
  version: string
}

export const ADDONS: readonly AddonProfile[] = [
  {
    id: 'SkBee',
    aliases: ['skbee'],
    homepage: 'https://modrinth.com/plugin/skbee',
    license: 'GPL-3.0-only',
    get description() {
      return l(
        "NBT, metin bileşenleri, tarifler, scoreboard, bossbar, yapı ve dünya oluşturma syntax'ları",
        'Syntax for NBT, text components, recipes, scoreboards, boss bars, structures and world creation'
      )
    },
    versions: [
      {
        version: '3.26.0',
        requires: { skript: '2.15.0+', minecraft: '26.1 – 26.3' },
        download: {
          kind: 'modrinth',
          url: 'https://cdn.modrinth.com/data/a0tlbHZO/versions/FUHfTDWo/SkBee-3.26.0.jar',
          file: 'SkBee-3.26.0.jar',
          sha512:
            '58d9cc25206c19e7762cfbb3b80b7464755797da11fbb214136d1c89c7296443220f6caf0503f5c6336fadb01fad0798a262fce0383a8451795660e15bbc3193'
        }
      },
      {
        version: '3.16.1',
        requires: { skript: '2.12+', minecraft: '1.21.4 – 1.21.11' },
        download: {
          kind: 'modrinth',
          url: 'https://cdn.modrinth.com/data/a0tlbHZO/versions/YUe8KJhT/SkBee-3.16.1.jar',
          file: 'SkBee-3.16.1.jar',
          sha512:
            'e1e55263a5b71a69132b154bc56e8c235032f51e7341b070019e1bd2bd9715f0dcb62bc350c7545b7360644521d654ac6eb42e4209a62a99986dcb8430a4ffb6'
        }
      }
    ]
  },
  {
    id: 'skript-reflect',
    aliases: ['skript-reflect', 'skriptreflect', 'reflect'],
    homepage: 'https://github.com/SkriptLang/skript-reflect',
    license: 'MIT',
    get description() {
      return l(
        'Java sınıflarına erişim (`import:`), özel olay/efekt/ifade tanımlama, bölümler',
        'Access to Java classes (`import:`), custom events/effects/expressions, sections'
      )
    },
    versions: [
      {
        version: '2.6.3',
        requires: { skript: '2.14+', get minecraft() {
          return l('Skript ile aynı', 'Same as Skript')
        } },
        download: {
          kind: 'github',
          url: 'https://github.com/SkriptLang/skript-reflect/releases/download/v2.6.3/skript-reflect-2.6.3.jar',
          file: 'skript-reflect-2.6.3.jar',
          sha256: '0b422b828e17aac9e8417b6876924c1dcc221f6a065fb0a21b00da07fc298877'
        }
      },
      {
        version: '2.6.1',
        requires: { skript: '2.12 – 2.13', get minecraft() {
          return l('Skript ile aynı', 'Same as Skript')
        } },
        download: {
          kind: 'github',
          url: 'https://github.com/SkriptLang/skript-reflect/releases/download/v2.6.1/skript-reflect-2.6.1.jar',
          file: 'skript-reflect-2.6.1.jar',
          sha256: 'd951afceb551318486a037a233bb499bac7c0dedbcd231cb521b008d734e9707'
        }
      }
    ]
  }
]

/** Proje dosyasındaki adı (büyük/küçük harf duyarsız, takma adlar dahil) bilinen addon'a çevirir. */
export function findAddon(name: string): AddonProfile | undefined {
  const key = name.trim().toLowerCase()
  return ADDONS.find((addon) => addon.id.toLowerCase() === key || addon.aliases.includes(key))
}

export function findAddonVersion(name: string, version: string): AddonVersionProfile | undefined {
  return findAddon(name)?.versions.find((candidate) => candidate.version === version.trim())
}

/** Gerçek sunucuda denenmiş sonuç; denenmemişse `undefined`. */
export function addonCompatibility(name: string, version: string, skriptVersion: string): AddonCompatibility | undefined {
  const addon = findAddon(name)
  if (!addon) return undefined
  return ADDON_COMPATIBILITY.find(
    (entry) => entry.addon === addon.id && entry.addonVersion === version.trim() && entry.skript === skriptVersion
  )
}

/** Bu Skript sürümüyle gerçek sunucuda çalıştığı doğrulanmış en yeni addon sürümü. */
export function recommendedAddonVersion(name: string, skriptVersion: string): string | undefined {
  const addon = findAddon(name)
  return addon?.versions.find((candidate) => addonCompatibility(addon.id, candidate.version, skriptVersion)?.status === 'ok')
    ?.version
}

/**
 * `skript-project.json` içindeki `addons` alanını okur: `{ "SkBee": "3.26.0" }`.
 * Bilinen addon adları kanonik yazımına çevrilir; bozuk girdiler atlanıp uyarı olarak döner.
 */
export function parseAddonSelections(raw: unknown): { selections: AddonSelection[]; warnings: string[] } {
  const selections: AddonSelection[] = []
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { selections, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(l('"addons" alanı { "AddonAdı": "sürüm" } biçiminde bir nesne olmalı.', 'The "addons" field must be an object of the form { "AddonName": "version" }.'))
    return { selections, warnings }
  }
  const seen = new Set<string>()
  for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof version !== 'string' || !version.trim()) {
      warnings.push(l(`"${name}" addon'u için sürüm bir metin olmalı (ör. "1.0.0").`, `The version of the "${name}" addon must be a string (e.g. "1.0.0").`))
      continue
    }
    const canonical = findAddon(name)?.id ?? name.trim()
    if (seen.has(canonical.toLowerCase())) {
      warnings.push(l(`"${canonical}" addon'u birden çok kez yazılmış; ilki kullanılıyor.`, `The "${canonical}" addon is listed more than once; using the first one.`))
      continue
    }
    seen.add(canonical.toLowerCase())
    selections.push({ name: canonical, version: version.trim() })
  }
  return { selections, warnings }
}

/** Seçimi proje dosyasına yazılacak nesneye çevirir (sıra korunur). */
export function serializeAddonSelections(selections: readonly AddonSelection[]): Record<string, string> {
  return Object.fromEntries(selections.map((selection) => [selection.name, selection.version]))
}

export type AddonIssueKind = 'unknown-addon' | 'unknown-version' | 'incompatible' | 'partial' | 'unverified'

export interface AddonIssue {
  kind: AddonIssueKind
  addon: string
  message: string
}

/** Seçili addon'ların seçili Skript sürümüyle durumu: bilinmeyen, uyumsuz ya da denenmemiş olanlar. */
export function checkAddonSelections(selections: readonly AddonSelection[], skriptVersion: string): AddonIssue[] {
  const issues: AddonIssue[] = []
  for (const selection of selections) {
    const addon = findAddon(selection.name)
    if (!addon) {
      issues.push({
        kind: 'unknown-addon',
        addon: selection.name,
        message: l(`"${selection.name}" addon'u için syntax verisi ve indirme bilgisi yok; doğrulama sunucusuna kurulmaz ve syntax'ları tanınmaz.`, `There is no syntax data or download info for the "${selection.name}" addon; it will not be installed on the validation server and its syntax will not be recognized.`)
      })
      continue
    }
    if (!addon.versions.some((version) => version.version === selection.version)) {
      issues.push({
        kind: 'unknown-version',
        addon: addon.id,
        message: l(`${addon.id} ${selection.version} desteklenmiyor. Desteklenen sürümler: ${addon.versions.map((v) => v.version).join(', ')}.`, `${addon.id} ${selection.version} is not supported. Supported versions: ${addon.versions.map((v) => v.version).join(', ')}.`)
      })
      continue
    }
    const compatibility = addonCompatibility(addon.id, selection.version, skriptVersion)
    if (!compatibility) {
      issues.push({
        kind: 'unverified',
        addon: addon.id,
        message: l(`${addon.id} ${selection.version} Skript ${skriptVersion} ile gerçek sunucuda denenmedi.`, `${addon.id} ${selection.version} has not been tested with Skript ${skriptVersion} on a real server.`)
      })
    } else if (compatibility.status === 'partial') {
      const recommended = recommendedAddonVersion(addon.id, skriptVersion)
      issues.push({
        kind: 'partial',
        addon: addon.id,
        message:
          l(`${addon.id} ${selection.version}, Skript ${skriptVersion} (Paper ${compatibility.minecraft}) ile kısmen çalışıyor: ${localize(compatibility.detail)}`, `${addon.id} ${selection.version} partially works with Skript ${skriptVersion} (Paper ${compatibility.minecraft}): ${localize(compatibility.detail)}`) +
          (recommended && recommended !== selection.version ? l(` Bu sürüm için ${addon.id} ${recommended} önerilir.`, ` ${addon.id} ${recommended} is recommended for this version.`) : '')
      })
    } else if (compatibility.status !== 'ok') {
      const recommended = recommendedAddonVersion(addon.id, skriptVersion)
      issues.push({
        kind: 'incompatible',
        addon: addon.id,
        message:
          l(`${addon.id} ${selection.version}, Skript ${skriptVersion} (Paper ${compatibility.minecraft}) ile çalışmıyor: ${localize(compatibility.detail)}`, `${addon.id} ${selection.version} does not work with Skript ${skriptVersion} (Paper ${compatibility.minecraft}): ${localize(compatibility.detail)}`) +
          (recommended ? l(` Bu sürüm için ${addon.id} ${recommended} önerilir.`, ` ${addon.id} ${recommended} is recommended for this version.`) : '')
      })
    }
  }
  return issues
}
