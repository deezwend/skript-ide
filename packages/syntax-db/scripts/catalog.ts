/**
 * `src/catalog.ts` üreticisi: `data/` (Skript) ve `data/addons/` (addon) klasörlerindeki dosyalardan sürüm
 * kataloğunu ve tembel yükleyicileri yazar. `generate.ts` ve `generate-addons.ts` ortak kullanır.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMA_VERSION, SYNTAX_KINDS, type SyntaxDatabase, type SyntaxEntry } from '../src/schema'

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = join(PACKAGE_DIR, 'data')
export const ADDON_DATA_DIR = join(DATA_DIR, 'addons')
export const CATALOG_FILE = join(PACKAGE_DIR, 'src', 'catalog.ts')

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number(part) || 0)
  const pb = b.split(/[.-]/).map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

// --- Çıktı ---

/** Üst alanlar okunaklı, kayıtlar satır başına bir tane: farklar küçük ve okunur kalsın. */
export function serialize(db: SyntaxDatabase): string {
  const { entries, ...meta } = db
  const head = JSON.stringify({ ...meta, entries: [] }, null, 2)
  const body = entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
  return head.replace(/"entries": \[\]\n\}$/, `"entries": [\n${body}\n  ]\n}`) + '\n'
}

/** Depodaki ve yeni üretilen kayıtlar arasındaki farkların kısa özeti; aynıysa `null`. */
export function diffEntries(before: SyntaxEntry[], after: SyntaxEntry[]): string | null {
  const key = (entry: SyntaxEntry) => `${entry.kind}:${entry.id}`
  const old = new Map(before.map((entry) => [key(entry), JSON.stringify(entry)]))
  const now = new Map(after.map((entry) => [key(entry), JSON.stringify(entry)]))
  const removed = [...old.keys()].filter((k) => !now.has(k))
  const added = [...now.keys()].filter((k) => !old.has(k))
  const changed = [...now.keys()].filter((k) => old.has(k) && old.get(k) !== now.get(k))
  if (!removed.length && !added.length && !changed.length) return null
  const list = (items: string[]) => items.slice(0, 20).join(' ') + (items.length > 20 ? ` … (+${items.length - 20})` : '')
  return [
    removed.length ? `    yalnız depoda (${removed.length}): ${list(removed)}` : '',
    added.length ? `    yalnız yeni üretimde (${added.length}): ${list(added)}` : '',
    changed.length ? `    içeriği farklı (${changed.length}): ${list(changed)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Addon veri dosyasının adı: `skbee-3.26.0@skript-2.17.1.json`. */
export function addonDataFile(addon: string, addonVersion: string, skriptVersion: string): string {
  return `${addon.toLowerCase()}-${addonVersion}@skript-${skriptVersion}.json`
}

async function readDatabase(file: string): Promise<SyntaxDatabase> {
  const db = JSON.parse(await readFile(file, 'utf8')) as SyntaxDatabase
  if (db.schemaVersion !== SCHEMA_VERSION) throw new Error(`${file}: eski şema sürümü (${db.schemaVersion}); yeniden üret.`)
  return db
}

const countsText = (counts: SyntaxDatabase['counts']) => `{ ${SYNTAX_KINDS.map((kind) => `${kind}: ${counts[kind]}`).join(', ')} }`

/** Kataloğu yeniden üretir ve dosya yolunu döndürür. */
export async function writeCatalog(): Promise<string> {
  const skript: { skriptVersion: string; counts: SyntaxDatabase['counts']; source: string; file: string }[] = []
  for (const file of (await readdir(DATA_DIR)).filter((name) => /^skript-.+\.json$/.test(name))) {
    const db = await readDatabase(join(DATA_DIR, file))
    skript.push({ skriptVersion: db.skriptVersion, counts: db.counts, source: db.source.kind, file })
  }
  skript.sort((a, b) => compareVersions(b.skriptVersion, a.skriptVersion))

  const addons: { addon: string; addonVersion: string; skriptVersion: string; counts: SyntaxDatabase['counts']; file: string }[] = []
  if (existsSync(ADDON_DATA_DIR)) {
    for (const file of (await readdir(ADDON_DATA_DIR)).filter((name) => name.endsWith('.json'))) {
      const db = await readDatabase(join(ADDON_DATA_DIR, file))
      if (!db.addon) throw new Error(`${file}: addon bilgisi yok.`)
      addons.push({ addon: db.addon.name, addonVersion: db.addon.version, skriptVersion: db.skriptVersion, counts: db.counts, file })
    }
  }
  addons.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon, 'en', { sensitivity: 'base' }) ||
      compareVersions(b.addonVersion, a.addonVersion) ||
      compareVersions(b.skriptVersion, a.skriptVersion)
  )

  const lines = [
    '// Bu dosya `npm run generate -w @skript-ide/syntax-db` ve `generate-addons` tarafından üretilir; elle düzenleme.',
    '',
    "import type { AddonSyntaxInfo, SyntaxVersionInfo } from './schema'",
    '',
    '/** Veritabanı olan Skript sürümleri, en yeniden eskiye. */',
    'export const SYNTAX_DB_VERSIONS: readonly SyntaxVersionInfo[] = [',
    ...skript.map((info) => `  { skriptVersion: '${info.skriptVersion}', source: '${info.source}', counts: ${countsText(info.counts)} },`),
    ']',
    '',
    '/**',
    ' * Her sürümün verisi ayrı bir parça olarak, yalnızca istendiğinde yüklenir (Vite / tsx / paketleyiciler için).',
    " * `with { type: 'json' }` bilerek yok: Vite geliştirme modunda JSON'u JS modülü olarak sunuyor ve tarayıcı",
    ' * öznitelikli içe aktarmayı reddediyor. Paketlenmemiş düz Node için `@skript-ide/syntax-db/node` kullanılır.',
    ' */',
    'export const SYNTAX_DB_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {',
    ...skript.map((info) => `  '${info.skriptVersion}': () => import('../data/${info.file}'),`),
    '}',
    '',
    '/** Addon veritabanları: addon adına, addon sürümüne (yeniden eskiye) ve Skript sürümüne göre. */',
    'export const ADDON_SYNTAX_DBS: readonly AddonSyntaxInfo[] = [',
    ...addons.map(
      (info) =>
        `  { addon: '${info.addon}', addonVersion: '${info.addonVersion}', skriptVersion: '${info.skriptVersion}', counts: ${countsText(info.counts)} },`
    ),
    ']',
    '',
    '/** Anahtar: `<addon küçük harf>@<addon sürümü>@<Skript sürümü>`. */',
    'export const ADDON_SYNTAX_DB_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {',
    ...addons.map(
      (info) => `  '${info.addon.toLowerCase()}@${info.addonVersion}@${info.skriptVersion}': () => import('../data/addons/${info.file}'),`
    ),
    '}',
    ''
  ]
  const text = lines.join('\n').replace(/,\n\]/g, '\n]').replace(/,\n\}/g, '\n}')
  await writeFile(CATALOG_FILE, text, 'utf8')
  return CATALOG_FILE
}
