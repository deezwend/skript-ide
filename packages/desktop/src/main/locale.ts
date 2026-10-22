import { parseLocale, setLocale, type Locale } from '@skript-ide/i18n'
import { readAppSettings, updateAppSettings } from './app-settings'

/**
 * Kayıtlı dili, yoksa sistem dilini etkin dil yapar. Türkçe olmayan sistemlerde İngilizce açılır.
 * `app.getLocale()` hazır olmadan çağrılamadığı için sistem dili Intl'den okunur.
 */
export function initLocale(): Locale {
  const locale =
    parseLocale(readAppSettings().locale) ?? (parseLocale(Intl.DateTimeFormat().resolvedOptions().locale) === 'tr' ? 'tr' : 'en')
  setLocale(locale)
  return locale
}

/** Seçimi kaydeder; yeni dil uygulama yeniden başlatılınca geçerli olur. */
export function saveLocale(locale: Locale): void {
  updateAppSettings({ locale })
}
