import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { registerSkriptLanguage, SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import { extname } from './paths'
// Skript için yalnızca temel editör worker'ı gerekiyor (diff, kelime tabanlı öneriler vb.)
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

registerSkriptLanguage(monaco)

// Ctrl+Shift+O uygulama menüsünde "Klasör Aç" olarak kullanılıyor
monaco.editor.addKeybindingRule({
  keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO,
  command: '-editor.action.quickOutline'
})

// "Sembole Git…" (Ctrl+Alt+O): menüdeki kısayolla aynı. Ctrl+Shift+O "Klasör Aç"ta,
// Ctrl+R geliştirme menüsündeki "Yeniden Yükle"de, Ctrl+Shift+R Monaco'nun refactor komutunda.
monaco.editor.addKeybindingRule({
  keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyO,
  command: 'editor.action.quickOutline'
})

export function languageForPath(path: string): string {
  const ext = extname(path)
  if (ext === '.sk') return SKRIPT_LANGUAGE_ID
  const match = monaco.languages.getLanguages().find((lang) => lang.extensions?.includes(ext))
  return match?.id ?? 'plaintext'
}

export function languageName(languageId: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === languageId)
  return lang?.aliases?.[0] ?? languageId
}

export { monaco }
export { lsp } from 'monaco-editor'
