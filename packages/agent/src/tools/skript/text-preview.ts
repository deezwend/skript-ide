import { readFile } from 'node:fs/promises'
import { defineTool, ToolError } from '../../tool'
import { resolveInProject } from '../core/paths'

/** Skript renk adları ve karşılık gelen eski kodlar (Skript'te `red` koyu kırmızıdır). */
const COLORS: readonly [code: string, names: readonly string[]][] = [
  ['0', ['black']],
  ['8', ['dark grey', 'dark gray']],
  ['7', ['grey', 'light grey', 'gray', 'light gray', 'silver']],
  ['f', ['white']],
  ['1', ['blue', 'dark blue']],
  ['3', ['cyan', 'aqua', 'dark cyan', 'dark aqua']],
  ['b', ['light blue', 'light cyan', 'light aqua']],
  ['2', ['green', 'dark green']],
  ['a', ['light green', 'lime', 'lime green']],
  ['e', ['yellow', 'light yellow']],
  ['6', ['orange', 'gold', 'dark yellow']],
  ['4', ['red', 'dark red']],
  ['c', ['pink', 'light red']],
  ['5', ['purple', 'dark purple']],
  ['d', ['magenta', 'light purple']]
]

const CODE_NAME: Record<string, string> = {
  '0': 'black', '1': 'dark blue', '2': 'dark green', '3': 'dark aqua', '4': 'dark red', '5': 'dark purple', '6': 'gold',
  '7': 'gray', '8': 'dark gray', '9': 'blue (&9)', a: 'light green', b: 'light aqua', c: 'light red', d: 'light purple',
  e: 'yellow', f: 'white'
}

const COLOR_BY_NAME = new Map<string, string>()
for (const [code, names] of COLORS) for (const name of names) COLOR_BY_NAME.set(name, code)
// MiniMessage biçimindeki alt çizgili adlar da kabul edilir
for (const [name, code] of [...COLOR_BY_NAME]) COLOR_BY_NAME.set(name.replace(/ /g, '_'), code)
COLOR_BY_NAME.set('brown', '6')

const FORMATS: Record<string, string> = {
  bold: 'bold', b: 'bold',
  italic: 'italic', italics: 'italic', i: 'italic', o: 'italic', em: 'italic',
  underlined: 'underlined', underline: 'underlined', u: 'underlined',
  strikethrough: 'strikethrough', strike: 'strikethrough', s: 'strikethrough', st: 'strikethrough',
  obfuscated: 'obfuscated', magic: 'obfuscated', obf: 'obfuscated', k: 'obfuscated'
}
const LEGACY_FORMATS: Record<string, string> = { k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' }

/** Değer alan etkileşim etiketleri (`<link:…>`, `<tooltip:…>` …). */
const ACTION_TAGS = new Set([
  'link', 'open url', 'url', 'run command', 'command', 'cmd', 'suggest command', 'sgt', 'suggest', 'change page', 'page',
  'tooltip', 'show text', 'ttp', 'tip', 'font', 'f', 'insertion', 'insert', 'ins', 'translate', 'tr', 'lang', 'keybind',
  'key', 'copy to clipboard', 'copy', 'clipboard', 'color', 'colour', 'hover', 'click'
])

interface Segment {
  text: string
  color: string
  formats: string[]
  actions: string[]
}

export interface TextPreview {
  plain: string
  segments: Segment[]
  notes: string[]
}

/**
 * Skript string'inin oyunda nasıl görüneceğini çıkarır: `&`/`§` kodları, `&#rrggbb`, `<renk>`, `<#rrggbb>`,
 * `<##rrggbb>`, biçim ve etkileşim etiketleri. `%ifade%` parçaları `‹ifade›` olarak gösterilir.
 */
export function previewText(source: string): TextPreview {
  const notes = new Set<string>()
  const segments: Segment[] = []
  let color = 'white'
  let formats: string[] = []
  let actions: string[] = []
  let buffer = ''
  let usedLegacy = false
  let usedTags = false
  const flush = () => {
    if (buffer) segments.push({ text: buffer, color, formats: [...formats], actions: [...actions] })
    buffer = ''
  }
  const setColor = (next: string) => {
    flush()
    color = next
    // Eski kodlarda renk biçimleri sıfırlar
    formats = []
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '%') {
      if (source[i + 1] === '%') {
        buffer += '%'
        i++
        continue
      }
      const end = source.indexOf('%', i + 1)
      if (end === -1) {
        notes.add('Unclosed % (write %% for a literal percent sign).')
        buffer += source.slice(i)
        break
      }
      buffer += `‹${source.slice(i + 1, end)}›`
      i = end
      continue
    }
    if ((ch === '&' || ch === '§') && i + 1 < source.length) {
      const next = source[i + 1].toLowerCase()
      const hex = /^#([0-9a-f]{6})/i.exec(source.slice(i + 1))
      if (hex) {
        usedLegacy = true
        setColor(`#${hex[1].toLowerCase()}`)
        i += 7
        continue
      }
      if (next === 'x' && /^([&§][0-9a-f]){6}/i.test(source.slice(i + 2))) {
        usedLegacy = true
        const digits = source.slice(i + 2, i + 14).replace(/[&§]/g, '')
        setColor(`#${digits.toLowerCase()}`)
        i += 13
        continue
      }
      if (CODE_NAME[next]) {
        usedLegacy = true
        setColor(CODE_NAME[next])
        i++
        continue
      }
      if (LEGACY_FORMATS[next]) {
        usedLegacy = true
        flush()
        if (!formats.includes(LEGACY_FORMATS[next])) formats.push(LEGACY_FORMATS[next])
        i++
        continue
      }
      if (next === 'r') {
        usedLegacy = true
        setColor('white')
        actions = []
        i++
        continue
      }
    }
    if (ch === '<') {
      const end = source.indexOf('>', i + 1)
      if (end !== -1) {
        const raw = source.slice(i + 1, end)
        const closing = raw.startsWith('/')
        const body = (closing ? raw.slice(1) : raw).trim()
        const lower = body.toLowerCase()
        const colon = lower.indexOf(':')
        const name = (colon === -1 ? lower : lower.slice(0, colon)).trim()
        const hex = /^#{1,2}([0-9a-f]{6})$/i.exec(body)
        let handled = true
        if (hex) {
          setColor(`#${hex[1].toLowerCase()}`)
        } else if (lower === 'reset' || lower === 'r') {
          setColor('white')
          actions = []
        } else if (COLOR_BY_NAME.has(lower)) {
          if (closing) {
            flush()
            color = 'white'
          } else {
            const code = COLOR_BY_NAME.get(lower)!
            if (lower === 'red') notes.add('<red> is DARK red in Skript (&4); for bright red use <light red>, <pink> or &c.')
            if (lower === 'blue') notes.add('<blue> is DARK blue in Skript (&1); for &9 blue use <##5555ff> or &9, for light blue <light blue>.')
            if (lower === 'green') notes.add('<green> is DARK green in Skript (&2); for bright green use <light green>, <lime> or &a.')
            setColor(CODE_NAME[code])
          }
        } else if ((name === 'color' || name === 'colour') && colon !== -1) {
          const value = lower.slice(colon + 1).trim()
          const code = COLOR_BY_NAME.get(value)
          const valueHex = /^#{1,2}([0-9a-f]{6})$/.exec(value)
          if (code) setColor(CODE_NAME[code])
          else if (valueHex) setColor(`#${valueHex[1]}`)
          else notes.add(`Unknown color in <${body}>.`)
        } else if (FORMATS[lower]) {
          flush()
          if (closing) formats = formats.filter((format) => format !== FORMATS[lower])
          else if (!formats.includes(FORMATS[lower])) formats.push(FORMATS[lower])
        } else if (ACTION_TAGS.has(name)) {
          flush()
          if (closing) actions = actions.filter((action) => !action.startsWith(name))
          else {
            if (colon === -1 && name !== 'reset') notes.add(`<${body}> needs a value, e.g. <${name}:...>.`)
            actions.push(colon === -1 ? name : `${name}: ${body.slice(colon + 1).trim()}`)
          }
        } else {
          handled = false
          if (/^[a-z_ #]+(:.*)?$/i.test(body)) notes.add(`Unknown tag <${raw}>: Skript shows it as literal text.`)
        }
        if (handled) {
          usedTags = true
          i = end
          continue
        }
      }
    }
    buffer += ch
  }
  flush()
  if (usedLegacy && usedTags) notes.add('Mixes &-codes and <tags>; both work, but one style is easier to maintain.')
  if (segments.some((segment) => segment.color.startsWith('#'))) notes.add('Hex colors need Minecraft 1.16+; clients show them exactly.')
  return { plain: segments.map((segment) => segment.text).join(''), segments, notes: [...notes] }
}

/** Satırdaki string sabitleri (`""` kaçışı çözülür); `%…%` içindeki iç string'ler ayrı sayılmaz. */
export function stringLiterals(line: string): string[] {
  const out: string[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '"') continue
    let value = ''
    let inExpression = false
    let j = i + 1
    for (; j < line.length; j++) {
      const ch = line[j]
      if (ch === '%') inExpression = !inExpression
      if (ch === '"' && !inExpression) {
        if (line[j + 1] === '"') {
          value += '"'
          j++
          continue
        }
        break
      }
      value += ch
    }
    out.push(value)
    i = j
  }
  return out
}

function describe(preview: TextPreview): string[] {
  const lines = [`Shown as: ${JSON.stringify(preview.plain)}`]
  if (preview.segments.length > 1 || preview.segments.some((segment) => segment.color !== 'white' || segment.formats.length)) {
    lines.push('Segments:')
    for (const segment of preview.segments) {
      const style = [segment.color, ...segment.formats].join(' ')
      const actions = segment.actions.length ? ` {${segment.actions.join('; ')}}` : ''
      lines.push(`  [${style}] ${JSON.stringify(segment.text)}${actions}`)
    }
  }
  if (preview.notes.length) lines.push('Notes:', ...preview.notes.map((note) => `- ${note}`))
  return lines
}

interface PreviewTextInput {
  text?: string
  path?: string
  line?: number
}

export const previewTextTool = defineTool<PreviewTextInput>({
  name: 'preview_text',
  description:
    'Show how a Skript message string will look in game: the visible text with colors and styles per segment, ' +
    'resolving &-codes, §-codes, &#rrggbb, <color> tags, <#rrggbb>/<##rrggbb>, <bold>/<italic>/..., <reset>, ' +
    'and click/hover tags (<link:...>, <tooltip:...>, <run command:...>). %expressions% are shown as ‹expression›. ' +
    'Also warns about Skript quirks such as <red> being dark red, unknown tags shown literally and unclosed %. ' +
    'Pass text (the string content without the outer quotes) or path and line to check every string on that line.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The string content, without the surrounding quotes.' },
      path: { type: 'string', description: 'A .sk file relative to the project root.' },
      line: { type: 'integer', description: '1-based line in path whose strings to preview.' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    if (input.text !== undefined) return describe(previewText(input.text)).join('\n')
    if (input.path === undefined || input.line === undefined) throw new ToolError('Pass text, or path and line.')
    const file = await resolveInProject(ctx, input.path)
    const source = (await readFile(file, 'utf8')).split(/\r\n|\n|\r/)[input.line - 1]
    if (source === undefined) throw new ToolError(`${input.path} has no line ${input.line}.`)
    const strings = stringLiterals(source.replace(/^\s+/, ''))
    if (strings.length === 0) return `Line ${input.line} has no string.`
    return strings.map((value, index) => [`String ${index + 1}: "${value}"`, ...describe(previewText(value))].join('\n')).join('\n\n')
  }
})
