import type { SyntaxDatabase, SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'
import { SkriptLanguageService, type LanguageServiceOptions } from '../src/index'
import { parseDocument } from './fakes/parser'
import { createFakeCompiler, syntaxEntry } from './fakes/compiler'

export const CURRENT = '2.17.1'
export const OLD = '2.12.2'

const BASE: SyntaxEntry[] = [
  syntaxEntry('event', 'join', 'Join', ['join'], {
    description: 'Bir oyuncu sunucuya katıldığında çalışır.',
    examples: ['on join:\n\tsend "merhaba" to player'],
    since: ['1.0'],
    eventValues: [{ id: 'player', name: 'player' }]
  }),
  syntaxEntry('event', 'load', 'Load', ['load']),
  syntaxEntry('event', 'periodical', 'Every X Seconds', ['every %time span%']),
  syntaxEntry('effect', 'send', 'Send', ['send %objects% to %players%'], {
    description: 'Bir mesajı oyunculara gönderir.',
    examples: ['send "merhaba" to player'],
    since: ['2.0']
  }),
  syntaxEntry('effect', 'broadcast', 'Broadcast', ['broadcast %objects%']),
  syntaxEntry('condition', 'is_op', 'Is Op', ['%player% is op']),
  syntaxEntry('section', 'loop', 'Loop', ['loop %objects%']),
  syntaxEntry('section', 'if_section', 'Conditionals', ['[parse] if <.+>']),
  syntaxEntry('section', 'while_section', 'While Loop', ['[do] while <.+>']),
  syntaxEntry('structure', 'command', 'Command', ['command <.+>']),
  syntaxEntry('structure', 'function', 'Function', ['[local] function <.+>']),
  syntaxEntry('structure', 'options', 'Options', ['options']),
  syntaxEntry('structure', 'variables', 'Variables', ['variables']),
  syntaxEntry('structure', 'aliases', 'Aliases', ['aliases']),
  syntaxEntry('function', 'floor', 'floor', ['floor(n: number)'], {
    returnType: { id: 'long', name: 'long' },
    since: ['2.0']
  }),
  syntaxEntry('function', 'ping', 'ping', ['ping()']),
  syntaxEntry('expression', 'player_expr', 'Player', ['player']),
  syntaxEntry('expression', 'number_expr', 'Number', ['number'])
]

const NEW_EFFECT = syntaxEntry('effect', 'new_thing', 'New Thing', ['new thing %text%'], {
  since: ['2.17']
})
const OLD_EFFECT = syntaxEntry('effect', 'old_thing', 'Old Thing', ['old thing %text%'], {
  since: ['1.0']
})

export function database(version: string, entries: SyntaxEntry[]): SyntaxDatabase {
  const counts: Record<SyntaxKind, number> = {
    event: 0,
    condition: 0,
    effect: 0,
    expression: 0,
    section: 0,
    structure: 0,
    type: 0,
    function: 0
  }
  for (const entry of entries) counts[entry.kind] += 1
  return {
    schemaVersion: 1,
    skriptVersion: version,
    source: {
      kind: 'skript-docs-archive',
      url: 'test://db',
      sha256: '0'.repeat(64),
      jsonFormat: '2.0'
    },
    counts,
    entries
  }
}

export const DATABASES = new Map<string, SyntaxDatabase>([
  [CURRENT, database(CURRENT, [...BASE, NEW_EFFECT])],
  [OLD, database(OLD, [...BASE, OLD_EFFECT])]
])

export function createService(overrides: Partial<LanguageServiceOptions> = {}): SkriptLanguageService {
  return new SkriptLanguageService({
    loadDatabase: async (version) => {
      const found = DATABASES.get(version)
      if (!found) throw new Error(`test veritabanı yok: ${version}`)
      return found
    },
    parser: { parseDocument },
    patternCompiler: createFakeCompiler(),
    ...overrides
  })
}

/** Gerçek `@skript-ide/parser` ve `@skript-ide/pattern-compiler` ile servis (test DB'leri üzerinde). */
export function createRealService(overrides: Partial<LanguageServiceOptions> = {}): SkriptLanguageService {
  return new SkriptLanguageService({
    loadDatabase: async (version) => {
      const found = DATABASES.get(version)
      if (!found) throw new Error(`test veritabanı yok: ${version}`)
      return found
    },
    ...overrides
  })
}

export function positionOf(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  const lines = text.split(/\r\n|\n|\r/)
  let remaining = occurrence
  for (let line = 0; line < lines.length; line += 1) {
    let from = 0
    for (;;) {
      const index = lines[line].indexOf(needle, from)
      if (index === -1) break
      if (remaining === 0) return { line, character: index }
      remaining -= 1
      from = index + 1
    }
  }
  throw new Error(`Metin bulunamadı: ${needle}`)
}
