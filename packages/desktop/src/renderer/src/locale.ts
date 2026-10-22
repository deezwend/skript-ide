import { parseLocale, setLocale } from '@skript-ide/i18n'

// Bu modül main.ts'te ilk import edilir: diğer modüller yüklenirken etkin dil belli olmalı.
// Düz tarayıcıda (preload yok) `?lang=en` parametresi, yoksa tarayıcının dili kullanılır.
const locale =
  window.skriptIde?.locale ??
  parseLocale(new URLSearchParams(location.search).get('lang')) ??
  (parseLocale(navigator.language) === 'tr' ? 'tr' : 'en')
setLocale(locale)
document.documentElement.lang = locale

/**
 * index.html'deki sabit metinler Türkçe yazılır; İngilizcesi `data-en` (metin), `data-en-title`,
 * `data-en-placeholder` ve `data-en-aria-label` özniteliklerinde durur.
 */
if (locale === 'en') {
  for (const node of document.querySelectorAll<HTMLElement>('[data-en]')) node.textContent = node.dataset.en!
  for (const node of document.querySelectorAll<HTMLElement>('[data-en-title]')) node.title = node.dataset.enTitle!
  for (const node of document.querySelectorAll<HTMLInputElement>('[data-en-placeholder]')) node.placeholder = node.dataset.enPlaceholder!
  for (const node of document.querySelectorAll<HTMLElement>('[data-en-aria-label]')) node.setAttribute('aria-label', node.dataset.enAriaLabel!)
}
