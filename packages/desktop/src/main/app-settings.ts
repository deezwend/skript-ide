import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Uygulama ayarları (dil, son açılan klasör); proje ayarlarından (`skript-project.json`) ayrı, kullanıcıya özel. */
const settingsPath = () => join(app.getPath('userData'), 'settings.json')

export function readAppSettings(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Verilen alanları mevcut ayarların üstüne yazar; diğer alanlar korunur. */
export function updateAppSettings(patch: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify({ ...readAppSettings(), ...patch }, null, 2) + '\n', 'utf8')
}
