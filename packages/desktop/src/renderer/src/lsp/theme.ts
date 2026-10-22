import { skriptDarkTheme } from '@skript-ide/skript-language'
import { monaco } from '../monaco'

/** Skript temasının semantic token kurallarıyla genişletilmiş hali. */
export const SKRIPT_LSP_THEME_ID = 'skript-dark-lsp'

export interface SemanticTokensLegend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

/** LSP'nin standart token türleri; sunucunun legend'i bunların bir alt kümesini içerir. */
const TOKEN_COLORS: Record<string, { foreground: string; fontStyle?: string }> = {
  namespace: { foreground: '4EC9B0' },
  type: { foreground: '4EC9B0' },
  class: { foreground: '4EC9B0' },
  enum: { foreground: '4EC9B0' },
  interface: { foreground: '4EC9B0' },
  struct: { foreground: '4EC9B0' },
  typeParameter: { foreground: '4EC9B0' },
  parameter: { foreground: '9CDCFE' },
  variable: { foreground: '9CDCFE' },
  property: { foreground: '9CDCFE' },
  enumMember: { foreground: '4FC1FF' },
  event: { foreground: 'DCDCAA' },
  function: { foreground: 'DCDCAA' },
  method: { foreground: 'DCDCAA' },
  macro: { foreground: 'DCDCAA' },
  keyword: { foreground: 'C586C0' },
  modifier: { foreground: '569CD6' },
  comment: { foreground: '6A9955', fontStyle: 'italic' },
  string: { foreground: 'CE9178' },
  number: { foreground: 'B5CEA8' },
  regexp: { foreground: 'D16969' },
  operator: { foreground: 'D4D4D4' },
  decorator: { foreground: 'DCDCAA' }
}

const MODIFIER_STYLES: Record<string, string> = {
  declaration: 'bold',
  definition: 'bold',
  readonly: '',
  static: '',
  deprecated: 'strikethrough'
}

/**
 * Sunucunun legend'ine göre tema kurallarını üretir. Legend gelmeden önce bilinen tüm
 * standart türler için kurallar tanımlanır; böylece ilk boyamada da renkler yerinde olur.
 */
export function applySemanticTheme(legend?: SemanticTokensLegend): void {
  const types = legend?.tokenTypes?.length ? legend.tokenTypes : Object.keys(TOKEN_COLORS)
  const modifiers = legend?.tokenModifiers?.length ? legend.tokenModifiers : Object.keys(MODIFIER_STYLES)
  const rules = [...skriptDarkTheme.rules]

  for (const type of types) {
    const color = TOKEN_COLORS[type]
    if (!color) continue
    rules.push({ token: type, foreground: color.foreground, fontStyle: color.fontStyle })
    for (const modifier of modifiers) {
      const style = MODIFIER_STYLES[modifier]
      if (!style) continue
      rules.push({ token: `${type}.${modifier}`, foreground: color.foreground, fontStyle: style })
    }
  }

  monaco.editor.defineTheme(SKRIPT_LSP_THEME_ID, {
    ...skriptDarkTheme,
    rules,
    colors: { ...skriptDarkTheme.colors }
  })
}
