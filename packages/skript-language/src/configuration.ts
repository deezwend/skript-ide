import type * as Monaco from 'monaco-editor'

/** Girintiyi artıran satır: `:` ile biten (sonda yorum olabilir), yorum olmayan satır. */
const opensBlock = /^(?!\s*#).*:\s*(#.*)?$/

export function createSkriptLanguageConfiguration(
  monaco: typeof Monaco
): Monaco.languages.LanguageConfiguration {
  return {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
      ['[', ']']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string', 'comment'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: '%', close: '%' }
    ],
    indentationRules: {
      increaseIndentPattern: opensBlock,
      // `else:` / `else if ...:` yazılınca bir seviye geri al
      decreaseIndentPattern: /^\s*else(\s+(parse\s+)?if\b.*)?\s*:\s*$/
    },
    onEnterRules: [
      {
        beforeText: opensBlock,
        action: { indentAction: monaco.languages.IndentAction.Indent }
      }
    ],
    // Skript girintiyle blok tanımlar; katlama da girintiye göre yapılır
    folding: { offSide: true },
    wordPattern: /[a-zA-Z_][\w-]*|\d+(\.\d+)?/
  }
}
