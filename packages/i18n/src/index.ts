/**
 * Arayüz dili. Her süreç (Electron ana süreci, arayüz, dil sunucusu worker'ı) kendi kopyasını taşır;
 * dil açılışta bir kez `setLocale` ile belirlenir, değiştirmek uygulamanın yeniden başlatılmasını gerektirir.
 *
 * Metinler çağrı yerinde iki dilde yazılır: `l('Kaydet', 'Save')`. Modül düzeyindeki sabit tablolar
 * dil belirlenmeden değerlendirileceği için `l` çağrısını bir fonksiyonun ya da getter'ın içinde yapmalı.
 */

export type Locale = 'tr' | 'en'

export const LOCALES: readonly Locale[] = ['tr', 'en']

/** Dil seçicide gösterilen adlar; her dil kendi dilinde yazılır. */
export const LOCALE_NAMES: Record<Locale, string> = { tr: 'Türkçe', en: 'English' }

let current: Locale = 'tr'

/** `en-US`, `tr_TR` gibi değerleri desteklenen bir dile çevirir; tanınmayanlar `null` döner. */
export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null
  const language = value.trim().toLowerCase().split(/[-_]/)[0]
  return LOCALES.includes(language as Locale) ? (language as Locale) : null
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** Etkin dildeki metni döndürür. */
export function l(tr: string, en: string): string {
  return current === 'en' ? en : tr
}

/** Veri tablolarında iki dilde saklanan metin; gösterirken `localize` ile çözülür. */
export interface LocalizedText {
  tr: string
  en: string
}

export function localize(text: LocalizedText): string {
  return text[current]
}
