import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLocale, setLocale, type Locale } from '@skript-ide/i18n'

/** Uygulama ayarları; proje ayarlarından (`skript-project.json`) ayrı, kullanıcıya özel. */
const settingsPath = () => join(app.getPath('userData'), 'settings.json')

function readSettings(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Kayıtlı dili, yoksa sistem dilini etkin dil yapar. Türkçe olmayan sistemlerde İngilizce açılır.
 * `app.getLocale()` hazır olmadan çağrılamadığı için sistem dili Intl'den okunur.
 */
export function initLocale(): Locale {
  const locale =
    parseLocale(readSettings().locale) ?? (parseLocale(Intl.DateTimeFormat().resolvedOptions().locale) === 'tr' ? 'tr' : 'en')
  setLocale(locale)
  return locale
}

/** Seçimi kaydeder; yeni dil uygulama yeniden başlatılınca geçerli olur. */
export function saveLocale(locale: Locale): void {
  writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), locale }, null, 2) + '\n', 'utf8')
}
