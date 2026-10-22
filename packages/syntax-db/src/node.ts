/**
 * Paketlenmeden doğrudan Node'da çalışan kullanıcılar (ör. ileride language server) için dosya sistemi tabanlı yükleyici.
 * Tarayıcı / Vite tarafı `loadSyntaxDatabase` (index.ts) kullanır.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { addonDatabaseKey, assertSyntaxDatabase, hasSyntaxDatabase } from './index'
import { ADDON_SYNTAX_DB_LOADERS } from './catalog'
import type { AddonSyntaxInfo, SyntaxDatabase } from './schema'

import { l } from '@skript-ide/i18n'
/** Bir sürümün veri dosyasının mutlak yolu. */
export function syntaxDataPath(skriptVersion: string): string {
  if (!hasSyntaxDatabase(skriptVersion)) throw new Error(l(`Skript ${skriptVersion} için syntax veritabanı yok.`, `No syntax database for Skript ${skriptVersion}.`))
  return fileURLToPath(new URL(`../data/skript-${skriptVersion}.json`, import.meta.url))
}

export async function readSyntaxDatabase(skriptVersion: string): Promise<SyntaxDatabase> {
  const text = await readFile(syntaxDataPath(skriptVersion), 'utf8')
  return assertSyntaxDatabase(JSON.parse(text), skriptVersion)
}

/** Addon veritabanını dosyadan okur (`resolveAddonDatabase` sonucunu alır). */
export async function readAddonDatabase(info: Pick<AddonSyntaxInfo, 'addon' | 'addonVersion' | 'skriptVersion'>): Promise<SyntaxDatabase> {
  const key = addonDatabaseKey(info)
  if (!Object.hasOwn(ADDON_SYNTAX_DB_LOADERS, key)) throw new Error(l(`${info.addon} ${info.addonVersion} (Skript ${info.skriptVersion}) için syntax veritabanı yok.`, `No syntax database for ${info.addon} ${info.addonVersion} (Skript ${info.skriptVersion}).`))
  const file = `${info.addon.toLowerCase()}-${info.addonVersion}@skript-${info.skriptVersion}.json`
  const text = await readFile(fileURLToPath(new URL(`../data/addons/${file}`, import.meta.url)), 'utf8')
  return assertSyntaxDatabase(JSON.parse(text), info.skriptVersion)
}
