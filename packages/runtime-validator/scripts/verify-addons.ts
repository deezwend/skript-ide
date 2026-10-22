/**
 * Addon ↔ Skript/Paper uyumluluğunu gerçek sunucuda dener ve `src/addon-compat.ts` dosyasını üretir.
 *
 * Her addon sürümü, uyumluluk tablosundaki (SKRIPT_RUNTIMES) her Skript/Paper ikilisinde tek başına kurulur.
 * Sonuç "ok" sayılması için iki koşul gerekir: Paper eklentiyi açtı (kendini kapatmadı) ve o addon'un
 * syntax'ını kullanan küçük bir betik `sk reload` ile hatasız yüklendi.
 *
 * Kullanım (depo kökünden):
 *   npm run verify-addons -w @skript-ide/runtime-validator -- --runtime-dir=<klasör>
 *   npm run verify-addons -w @skript-ide/runtime-validator -- --runtime-dir=<klasör> --skript=2.17.1 --addon=SkBee
 *
 * `--runtime-dir` içinde Minecraft EULA'sı daha önce kabul edilmiş olmalı; betik EULA'yı asla kendisi kabul etmez.
 * Filtre verilirse yalnızca o denemeler yapılır, tablodaki diğer satırlar korunur.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLocale, type LocalizedText } from '@skript-ide/i18n'
import { ADDON_COMPATIBILITY, ADDONS, type AddonCompatibility } from '../src/addons'
import { EulaRequiredError, SkriptServer } from '../src/server'
import { runtimeVersionsFor, SKRIPT_RUNTIMES } from '../src/versions'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_FILE = join(PACKAGE_DIR, 'src', 'addon-compat.ts')

/** Her addon'un kendi syntax'ını kullanan, iki sürümde de bulunan en küçük betik. */
const SMOKE_SCRIPTS: Record<string, { description: LocalizedText; script: string }> = {
  SkBee: {
    description: {
      tr: 'NBT bileşeni oluşturup etiketlerini okuyan betik',
      en: 'a script that creates an NBT compound and reads its tags'
    },
    script: ['on load:', '\tset {_nbt} to a new nbt compound', '\tset {_tags::*} to nbt tags of {_nbt}', ''].join('\n')
  },
  'skript-reflect': {
    description: { tr: '`import:` ile Java sınıfı çağıran betik', en: 'a script that calls a Java class via `import:`' },
    script: ['import:', '\tjava.lang.System', '', 'on load:', '\tset {_now} to System.currentTimeMillis()', ''].join('\n')
  }
}

interface Options {
  runtimeDir: string
  skript?: string
  addon?: string
}

function parseArgs(argv: string[]): Options {
  let runtimeDir: string | undefined
  let skript: string | undefined
  let addon: string | undefined
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s, 2)
    if (key === '--runtime-dir') runtimeDir = resolve(value)
    else if (key === '--skript') skript = value
    else if (key === '--addon') addon = value.toLowerCase()
    else throw new Error(`Bilinmeyen seçenek: ${arg}`)
  }
  if (!runtimeDir) throw new Error('--runtime-dir gerekli.')
  return { runtimeDir, skript, addon }
}

async function tryAddon(runtimeDir: string, skript: string, addon: string, version: string): Promise<AddonCompatibility> {
  const versions = { ...runtimeVersionsFor(skript), addons: [{ name: addon, version }] }
  const base = { addon, addonVersion: version, skript, minecraft: versions.minecraft }
  let log = ''
  const server = new SkriptServer({
    rootDir: runtimeDir,
    versions,
    onLog: (text) => {
      log += text
    }
  })
  try {
    await server.start()
    const status = server.addons[0]
    if (status?.state !== 'enabled') {
      return { ...base, status: 'failed', detail: same(status?.message) ?? { tr: 'Eklenti açılmadı.', en: 'Addon was not enabled.' } }
    }
    const smoke = SMOKE_SCRIPTS[addon]
    if (!smoke) return { ...base, status: 'ok', detail: { tr: 'Eklenti açıldı (deneme betiği yok).', en: 'Addon enabled (no test script).' } }
    const result = await server.validate('smoke', `${addon.toLowerCase()}-smoke.sk`, smoke.script)
    if (!result.ok) {
      const first = result.diagnostics.find((d) => d.severity === 'error')
      return {
        ...base,
        status: 'failed',
        detail: {
          tr: `Eklenti açıldı ama deneme betiği yüklenmedi: ${first?.message ?? 'bilinmeyen hata'}`,
          en: `Addon enabled but the test script did not load: ${first?.message ?? 'unknown error'}`
        }
      }
    }
    if (status.problems?.length) {
      const problems = status.problems.join(' / ')
      return {
        ...base,
        status: 'partial',
        detail: {
          tr: `Eklenti açıldı ama yüklenirken sorun bildirdi: ${problems}`.slice(0, 400),
          en: `Addon enabled but reported problems while loading: ${problems}`.slice(0, 400)
        }
      }
    }
    return {
      ...base,
      status: 'ok',
      detail: {
        tr: `Eklenti açıldı; ${smoke.description.tr} hatasız yüklendi.`,
        en: `Addon enabled; ${smoke.description.en} loaded without errors.`
      }
    }
  } catch (error) {
    if (error instanceof EulaRequiredError) {
      throw new Error(`${runtimeDir} için Minecraft EULA'sı kabul edilmemiş. Önce uygulamada kabul et; betik bunu senin yerine yapmaz.`)
    }
    const tail = log.split('\n').filter((line) => /error|exception|could not/i.test(line)).slice(-3).join(' ').trim()
    return { ...base, status: 'failed', detail: same(`${(error as Error).message}${tail ? ` ${tail.slice(0, 300)}` : ''}`) }
  } finally {
    await server.stop()
  }
}

/**
 * Sunucunun ürettiği mesajlar (addon durumu, hata) tek dilde gelir; iki dilde de aynısı yazılır.
 * Betik bu mesajlar İngilizce üretilsin diye dili `en` yapar (Skript'in kendi hataları da İngilizce).
 */
function same(text: string): LocalizedText
function same(text: string | undefined): LocalizedText | undefined
function same(text: string | undefined): LocalizedText | undefined {
  return text === undefined ? undefined : { tr: text, en: text }
}

function render(entries: readonly AddonCompatibility[]): string {
  const lines = entries.map(
    (entry) =>
      `  { addon: ${JSON.stringify(entry.addon)}, addonVersion: ${JSON.stringify(entry.addonVersion)}, skript: ${JSON.stringify(entry.skript)}, minecraft: ${JSON.stringify(entry.minecraft)}, status: ${JSON.stringify(entry.status)}, detail: { tr: ${JSON.stringify(entry.detail.tr)}, en: ${JSON.stringify(entry.detail.en)} } }`
  )
  return [
    '// Bu dosya `npm run verify-addons -w @skript-ide/runtime-validator` tarafından üretilir; elle düzenleme.',
    '',
    "import type { LocalizedText } from '@skript-ide/i18n'",
    '',
    'export interface AddonCompatibility {',
    '  addon: string',
    '  addonVersion: string',
    '  skript: string',
    '  minecraft: string',
    '  /** `partial`: eklenti açıldı ve deneme betiği yüklendi ama bazı öğe grupları devre dışı kaldı. */',
    "  status: 'ok' | 'partial' | 'failed'",
    '  /** Kısa açıklama: başarılıysa denenen betik, değilse sunucunun verdiği hata. */',
    '  detail: LocalizedText',
    '}',
    '',
    'export const ADDON_COMPATIBILITY: readonly AddonCompatibility[] = [',
    lines.join(',\n'),
    ']',
    ''
  ].join('\n')
}

async function main(): Promise<void> {
  setLocale('en')
  const options = parseArgs(process.argv.slice(2))
  const results = new Map<string, AddonCompatibility>()
  const key = (entry: Pick<AddonCompatibility, 'addon' | 'addonVersion' | 'skript'>) => `${entry.addon}@${entry.addonVersion}@${entry.skript}`
  for (const entry of ADDON_COMPATIBILITY) results.set(key(entry), entry)

  for (const runtime of SKRIPT_RUNTIMES) {
    if (options.skript && runtime.skript !== options.skript) continue
    for (const addon of ADDONS) {
      if (options.addon && addon.id.toLowerCase() !== options.addon) continue
      for (const version of addon.versions) {
        process.stdout.write(`${addon.id} ${version.version} @ Skript ${runtime.skript} / Paper ${runtime.minecraft}… `)
        const result = await tryAddon(options.runtimeDir, runtime.skript, addon.id, version.version)
        console.log(`${result.status}: ${result.detail.tr}`)
        results.set(key(result), result)
      }
    }
  }

  // Tablo sırası: addon tanımlarındaki sıra, sonra sürüm tablosundaki Skript sırası
  const order = (entry: AddonCompatibility) => {
    const addonIndex = ADDONS.findIndex((addon) => addon.id === entry.addon)
    const versionIndex = ADDONS[addonIndex]?.versions.findIndex((v) => v.version === entry.addonVersion) ?? 0
    const runtimeIndex = SKRIPT_RUNTIMES.findIndex((runtime) => runtime.skript === entry.skript)
    return [addonIndex, versionIndex, runtimeIndex]
  }
  const sorted = [...results.values()].sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  const text = render(sorted)
  const previous = await readFile(OUTPUT_FILE, 'utf8').catch(() => '')
  if (previous !== text) await writeFile(OUTPUT_FILE, text, 'utf8')
  console.log(`${OUTPUT_FILE} ${previous === text ? 'değişmedi' : 'güncellendi'}.`)
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
