import type { languages } from 'monaco-editor'

/**
 * Skript için Monarch tokenizer.
 *
 * Skript satır tabanlıdır: string, değişken ve ifade blokları asla bir sonraki
 * satıra taşmaz. Bu yüzden root dışındaki her state, yeni satırın başında
 * `@popall` ile root'a döner; kapanmamış bir `"` veya `{` sonraki satırları
 * bozmaz.
 *
 * Bu katman yalnızca sözcüksel renklendirme yapar. Bir kelimenin gerçekten
 * effect/condition/expression olup olmadığını Faz 4'teki parser (semantic
 * tokens) belirleyecek.
 */

const resetAtLineStart: languages.IMonarchLanguageRule = [/^/, { token: '', next: '@popall' }]

/** `{_yerel}` ve `{global}` değişkenleri aynı kurallarla, farklı token adlarıyla. */
function variableRules(kind: 'local' | 'global'): languages.IMonarchLanguageRule[] {
  return [
    resetAtLineStart,
    [/\}/, { token: `variable.${kind}.brace`, next: '@pop' }],
    [/::/, `variable.${kind}.delimiter`],
    [/%/, { token: 'delimiter.interpolation', next: '@interpolation' }],
    [/\{/, { token: `variable.${kind}.brace`, next: `@${kind}Variable` }],
    [/[^}%:{]+/, `variable.${kind}`],
    [/:/, `variable.${kind}`]
  ]
}

export const skriptMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.sk',
  ignoreCase: true,

  controlKeywords: [
    'if', 'else', 'loop', 'while', 'do', 'return', 'stop', 'exit', 'continue',
    'wait', 'then', 'parse', 'section', 'sections', 'loops', 'trigger', 'halt'
  ],

  effectKeywords: [
    'set', 'add', 'remove', 'delete', 'clear', 'reset', 'send', 'message', 'broadcast',
    'give', 'teleport', 'kill', 'cancel', 'uncancel', 'execute', 'make', 'spawn', 'drop',
    'play', 'apply', 'open', 'close', 'push', 'heal', 'damage', 'ignite', 'extinguish',
    'kick', 'ban', 'unban', 'op', 'deop', 'log', 'enchant', 'disenchant', 'equip',
    'shoot', 'strike', 'create', 'load', 'unload', 'launch', 'hide', 'reveal', 'force',
    'allow', 'disallow', 'toggle', 'wipe', 'sort', 'replace', 'increase', 'decrease',
    'reduce', 'feed', 'repair', 'shear', 'tame', 'untame', 'ride', 'dismount', 'leash',
    'unleash', 'grow', 'generate', 'copy', 'register', 'unregister', 'transfer'
  ],

  operatorKeywords: [
    'is', 'isn\'t', 'are', 'aren\'t', 'was', 'were', 'not', 'and', 'or', 'nor', 'contains',
    'contain', 'has', 'have', 'does', 'doesn\'t', 'can', 'can\'t', 'cannot',
    'greater', 'less', 'more', 'than', 'equal', 'equals', 'between', 'within', 'exists',
    'exist'
  ],

  particles: [
    'to', 'from', 'of', 'in', 'at', 'by', 'for', 'with', 'the', 'a', 'an', 'all',
    'every', 'times', 'as', 'into', 'on'
  ],

  constants: ['true', 'false', 'yes', 'no', 'off', 'none', 'nothing', 'null'],

  predefinedValues: [
    'player', 'victim', 'attacker', 'target', 'shooter', 'projectile', 'entity', 'block',
    'world', 'console', 'server', 'executor', 'sender', 'command', 'event', 'now', 'me',
    'my', 'it', 'its', 'loop-value', 'loop-index', 'loop-number', 'loop-iteration'
  ],

  types: [
    'number', 'numbers', 'integer', 'integers', 'text', 'texts', 'string', 'strings',
    'boolean', 'booleans', 'object', 'objects', 'players', 'offlineplayer', 'offlineplayers',
    'entities', 'livingentity', 'livingentities', 'item', 'items', 'itemtype', 'itemtypes',
    'blocks', 'location', 'locations', 'worlds', 'timespan', 'timespans', 'date', 'dates',
    'vector', 'vectors', 'inventory', 'inventories', 'slot', 'slots', 'entitytype',
    'entitytypes', 'potioneffecttype', 'potioneffect', 'biome', 'color', 'colors', 'gamemode',
    'direction', 'region', 'regions', 'commandsender', 'time', 'weathertype', 'chunk'
  ],

  // Değeri Skript kodu olan komut girdileri
  codeEntries: /trigger|cooldown storage|cooldown/,
  // Değeri düz metin olan komut girdileri (renk kodları dışında yorumlanmaz)
  textEntries: /permission message|permission|usage|description|aliases|executable by|cooldown message|cooldown bypass|prefix/,

  timeUnits: /ticks?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?/,

  brackets: [
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '[', close: ']', token: 'delimiter.square' }
  ],

  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],

      // Yapı başlıkları (her zaman satır başında, girintisiz)
      [/^(on)(\s+)(.+?)(\s*:)(?=\s*(?:#.*)?$)/, ['keyword.structure', 'white', 'event', 'delimiter']],
      [/^(every|at)(\s+)(.+?)(\s*:)(?=\s*(?:#.*)?$)/, ['keyword.structure', 'white', 'event', 'delimiter']],
      [/^(command)(\s+)(\/?[^\s:]+)/, ['keyword.structure', 'white', { token: 'command.name', next: '@commandHeader' }]],
      [/^((?:local\s+)?function)(\s+)(\w+)/, ['keyword.structure', 'white', { token: 'function.name', next: '@functionSignature' }]],
      [/^(options)(\s*)(:)/, ['keyword.structure', 'white', { token: 'delimiter', next: '@optionsBlock' }]],
      [/^(variables|aliases|import|using)(\s*)(:)/, ['keyword.structure', 'white', 'delimiter']],
      [/^(using)(\s+)(.+)$/, ['keyword.structure', 'white', 'event']],

      // Komut girdileri: trigger:, permission:, usage: ...
      [/^(\s+)(@codeEntries)(\s*)(:)/, ['white', 'keyword.entry', 'white', 'delimiter']],
      [/^(\s+)(@textEntries)(\s*)(:)/, ['white', 'keyword.entry', 'white', { token: 'delimiter', next: '@rawText' }]],

      { include: '@expression' }
    ],

    expression: [
      [/\s+/, 'white'],
      [/#.*$/, 'comment'],
      [/"/, { token: 'string.quote', next: '@string' }],

      [/\{@[^}]*\}/, 'variable.option'],
      [/\{_/, { token: 'variable.local.brace', next: '@localVariable' }],
      [/\{/, { token: 'variable.global.brace', next: '@globalVariable' }],

      [/\d+(?:\.\d+)?\s*(?:(?:real|rl|irl|minecraft|mc)\s+)?(?:@timeUnits)\b/, 'number.timespan'],
      [/\d+(?:\.\d+)?/, 'number'],

      [/(?:event|arg|argument|loop)-[\w-]+/, 'variable.predefined'],
      [/'s\b/, 'keyword.particle'],

      [/[a-z_]\w*(?=\()/, 'function.call'],
      [/[a-z_][\w-]*(?:'t)?/, {
        cases: {
          '@controlKeywords': 'keyword.control',
          '@effectKeywords': 'keyword.effect',
          '@operatorKeywords': 'keyword.operator',
          '@particles': 'keyword.particle',
          '@constants': 'constant',
          '@predefinedValues': 'variable.predefined',
          '@types': 'type',
          '@default': 'identifier'
        }
      }],

      [/[()[\]]/, '@brackets'],
      [/[<>!=]=?|->|[+\-*/^]/, 'operator'],
      [/[,:]/, 'delimiter'],
      [/./, '']
    ],

    // command /isim <player> [<text>]:
    commandHeader: [
      resetAtLineStart,
      [/#.*$/, 'comment'],
      [/<[^>]+>/, 'type'],
      [/[[\]]/, 'delimiter.square'],
      [/:/, 'delimiter'],
      [/[^<[\]:#]+/, 'white']
    ],

    // function isim(p: player, n: number = 1) :: text:
    functionSignature: [
      resetAtLineStart,
      [/#.*$/, 'comment'],
      // Satır sonundaki `:` başlığı kapatır; dönüş tipi parametre sanılmasın
      [/\w+(?=\s*:(?!:)(?!\s*(?:#.*)?$))/, 'variable.parameter'],
      [/::/, 'delimiter'],
      [/[:,=]/, 'delimiter'],
      [/[()]/, 'delimiter.parenthesis'],
      [/"/, { token: 'string.quote', next: '@string' }],
      [/\d+(?:\.\d+)?/, 'number'],
      [/[a-z_][\w ]*?(?=\s*[,)=:]|\s*$)/, {
        cases: {
          '@constants': 'constant',
          '@default': 'type'
        }
      }],
      [/\s+/, 'white']
    ],

    // options: altındaki `isim: değer` satırları; girintisiz ilk satırda biter
    optionsBlock: [
      [/^(?=\S)/, { token: '', next: '@pop' }],
      [/^\s*#.*$/, 'comment'],
      [/^(\s+)([^:#]+?)(\s*)(:)/, ['white', 'variable.option', 'white', { token: 'delimiter', next: '@rawText' }]],
      [/.+/, '']
    ],

    // Skript'in olduğu gibi kullandığı metin: komut mesajları, option değerleri
    rawText: [
      // Yalnızca bir seviye geri dön; optionsBlock içinden gelindiyse blok devam eder
      [/^/, { token: '', next: '@pop' }],
      [/&#[0-9a-f]{6}/, 'string.color'],
      [/#.*$/, 'comment'],
      [/(?:&|§)[0-9a-fk-or]/, 'string.color'],
      [/[^&§#]+/, 'string.unquoted'],
      [/./, 'string.unquoted']
    ],

    string: [
      resetAtLineStart,
      [/""/, 'string.escape'],
      [/%%/, 'string.escape'],
      [/\{@[^}]*\}/, 'variable.option'],
      [/%/, { token: 'delimiter.interpolation', next: '@interpolation' }],
      [/(?:&|§)[0-9a-fk-or]/, 'string.color'],
      [/&#[0-9a-f]{6}|<##?[0-9a-f]{6}>/, 'string.color'],
      [/<\/?[a-z_ ]+(?::[^>]*)?>/, 'string.tag'],
      [/[^"%&§<{]+/, 'string'],
      [/[&§<{]/, 'string'],
      [/"/, { token: 'string.quote', next: '@pop' }]
    ],

    // "...%ifade%..." veya {liste::%ifade%} içindeki kod
    interpolation: [
      resetAtLineStart,
      [/%/, { token: 'delimiter.interpolation', next: '@pop' }],
      { include: '@expression' }
    ],

    localVariable: variableRules('local'),
    globalVariable: variableRules('global')
  }
}
