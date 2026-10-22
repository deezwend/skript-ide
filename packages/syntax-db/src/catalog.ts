// Bu dosya `npm run generate -w @skript-ide/syntax-db` ve `generate-addons` tarafından üretilir; elle düzenleme.

import type { AddonSyntaxInfo, SyntaxVersionInfo } from './schema'

/** Veritabanı olan Skript sürümleri, en yeniden eskiye. */
export const SYNTAX_DB_VERSIONS: readonly SyntaxVersionInfo[] = [
  { skriptVersion: '2.17.1', source: 'skript-docs-archive', counts: { event: 183, condition: 167, effect: 144, expression: 530, section: 11, structure: 8, type: 125, function: 45 } },
  { skriptVersion: '2.16.2', source: 'skript-docs-archive', counts: { event: 182, condition: 166, effect: 144, expression: 522, section: 9, structure: 8, type: 124, function: 45 } },
  { skriptVersion: '2.14.3', source: 'skript-docs-archive', counts: { event: 179, condition: 165, effect: 144, expression: 494, section: 8, structure: 8, type: 120, function: 44 } },
  { skriptVersion: '2.12.2', source: 'skript-docs-archive', counts: { event: 177, condition: 153, effect: 133, expression: 443, section: 8, structure: 6, type: 107, function: 42 } }
]

/**
 * Her sürümün verisi ayrı bir parça olarak, yalnızca istendiğinde yüklenir (Vite / tsx / paketleyiciler için).
 * `with { type: 'json' }` bilerek yok: Vite geliştirme modunda JSON'u JS modülü olarak sunuyor ve tarayıcı
 * öznitelikli içe aktarmayı reddediyor. Paketlenmemiş düz Node için `@skript-ide/syntax-db/node` kullanılır.
 */
export const SYNTAX_DB_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  '2.17.1': () => import('../data/skript-2.17.1.json'),
  '2.16.2': () => import('../data/skript-2.16.2.json'),
  '2.14.3': () => import('../data/skript-2.14.3.json'),
  '2.12.2': () => import('../data/skript-2.12.2.json')
}

/** Addon veritabanları: addon adına, addon sürümüne (yeniden eskiye) ve Skript sürümüne göre. */
export const ADDON_SYNTAX_DBS: readonly AddonSyntaxInfo[] = [
  { addon: 'SkBee', addonVersion: '3.26.0', skriptVersion: '2.17.1', counts: { event: 69, condition: 31, effect: 77, expression: 258, section: 60, structure: 2, type: 77, function: 0 } },
  { addon: 'SkBee', addonVersion: '3.26.0', skriptVersion: '2.16.2', counts: { event: 69, condition: 31, effect: 77, expression: 258, section: 59, structure: 2, type: 77, function: 0 } },
  { addon: 'SkBee', addonVersion: '3.16.1', skriptVersion: '2.14.3', counts: { event: 56, condition: 27, effect: 72, expression: 243, section: 51, structure: 2, type: 66, function: 9 } },
  { addon: 'SkBee', addonVersion: '3.16.1', skriptVersion: '2.12.2', counts: { event: 56, condition: 27, effect: 74, expression: 240, section: 47, structure: 2, type: 73, function: 13 } },
  { addon: 'skript-reflect', addonVersion: '2.6.3', skriptVersion: '2.17.1', counts: { event: 1, condition: 2, effect: 7, expression: 27, section: 1, structure: 6, type: 4, function: 0 } },
  { addon: 'skript-reflect', addonVersion: '2.6.3', skriptVersion: '2.16.2', counts: { event: 1, condition: 2, effect: 7, expression: 27, section: 1, structure: 6, type: 4, function: 0 } },
  { addon: 'skript-reflect', addonVersion: '2.6.3', skriptVersion: '2.14.3', counts: { event: 1, condition: 2, effect: 7, expression: 27, section: 1, structure: 6, type: 4, function: 0 } },
  { addon: 'skript-reflect', addonVersion: '2.6.1', skriptVersion: '2.12.2', counts: { event: 1, condition: 3, effect: 8, expression: 27, section: 1, structure: 6, type: 4, function: 0 } }
]

/** Anahtar: `<addon küçük harf>@<addon sürümü>@<Skript sürümü>`. */
export const ADDON_SYNTAX_DB_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  'skbee@3.26.0@2.17.1': () => import('../data/addons/skbee-3.26.0@skript-2.17.1.json'),
  'skbee@3.26.0@2.16.2': () => import('../data/addons/skbee-3.26.0@skript-2.16.2.json'),
  'skbee@3.16.1@2.14.3': () => import('../data/addons/skbee-3.16.1@skript-2.14.3.json'),
  'skbee@3.16.1@2.12.2': () => import('../data/addons/skbee-3.16.1@skript-2.12.2.json'),
  'skript-reflect@2.6.3@2.17.1': () => import('../data/addons/skript-reflect-2.6.3@skript-2.17.1.json'),
  'skript-reflect@2.6.3@2.16.2': () => import('../data/addons/skript-reflect-2.6.3@skript-2.16.2.json'),
  'skript-reflect@2.6.3@2.14.3': () => import('../data/addons/skript-reflect-2.6.3@skript-2.14.3.json'),
  'skript-reflect@2.6.1@2.12.2': () => import('../data/addons/skript-reflect-2.6.1@skript-2.12.2.json')
}
