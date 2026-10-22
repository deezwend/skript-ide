import type * as Monaco from 'monaco-editor'
import { createSkriptLanguageConfiguration } from './configuration'
import { skriptMonarchLanguage } from './monarch'
import { SKRIPT_DARK_THEME_ID, skriptDarkTheme } from './theme'

export const SKRIPT_LANGUAGE_ID = 'skript'
export { SKRIPT_DARK_THEME_ID, skriptDarkTheme, skriptMonarchLanguage, createSkriptLanguageConfiguration }

/** Skript dilini ve temasını verilen Monaco örneğine kaydeder (tekrar çağrılırsa bir şey yapmaz). */
export function registerSkriptLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === SKRIPT_LANGUAGE_ID)) return

  monaco.languages.register({
    id: SKRIPT_LANGUAGE_ID,
    extensions: ['.sk'],
    aliases: ['Skript', 'skript']
  })
  monaco.languages.setMonarchTokensProvider(SKRIPT_LANGUAGE_ID, skriptMonarchLanguage)
  monaco.languages.setLanguageConfiguration(SKRIPT_LANGUAGE_ID, createSkriptLanguageConfiguration(monaco))
  monaco.editor.defineTheme(SKRIPT_DARK_THEME_ID, skriptDarkTheme)
}
