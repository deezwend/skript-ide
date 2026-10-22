import type { editor } from 'monaco-editor'

export const SKRIPT_DARK_THEME_ID = 'skript-dark'

export const skriptDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },

    { token: 'keyword.structure', foreground: 'C586C0', fontStyle: 'bold' },
    { token: 'keyword.entry', foreground: '9CDCFE' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'keyword.effect', foreground: '569CD6' },
    { token: 'keyword.operator', foreground: 'D7BA7D' },
    { token: 'keyword.particle', foreground: '8B949E' },

    { token: 'event', foreground: 'DCDCAA' },
    { token: 'command.name', foreground: 'DCDCAA', fontStyle: 'bold' },
    { token: 'function.name', foreground: 'DCDCAA', fontStyle: 'bold' },
    { token: 'function.call', foreground: 'DCDCAA' },
    { token: 'variable.parameter', foreground: '9CDCFE' },

    { token: 'type', foreground: '4EC9B0' },
    { token: 'constant', foreground: '569CD6' },
    { token: 'variable.predefined', foreground: '4FC1FF' },

    { token: 'variable.global', foreground: 'F0A35E' },
    { token: 'variable.local', foreground: '7FD8BE' },
    { token: 'variable.option', foreground: 'E5C07B', fontStyle: 'bold' },

    { token: 'string', foreground: 'CE9178' },
    { token: 'string.quote', foreground: 'CE9178' },
    { token: 'string.unquoted', foreground: 'D9B99B' },
    { token: 'string.escape', foreground: 'D7BA7D' },
    { token: 'string.color', foreground: 'FF79C6' },
    { token: 'string.tag', foreground: 'FF79C6' },
    { token: 'delimiter.interpolation', foreground: 'FFD700', fontStyle: 'bold' },

    { token: 'number', foreground: 'B5CEA8' },
    { token: 'number.timespan', foreground: 'B5CEA8', fontStyle: 'italic' },
    { token: 'operator', foreground: 'D4D4D4' },
    { token: 'delimiter', foreground: 'D4D4D4' }
  ],
  colors: {
    'editor.background': '#1e1e1e',
    'editorWhitespace.foreground': '#3b3b3b'
  }
}
