import type { BodyNode, StructureNode } from '@skript-ide/parser'
import { defineTool, ToolError } from '../../tool'
import { clip, maskNested, readProjectScripts, structureAt, structureLabel } from './script-scan'
import { previewText, stringLiterals } from './text-preview'

const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

interface SlotItem {
  item: string
  name?: string
  lore: string[]
  line: number
}

interface Gui {
  key: string
  kind: string
  rows: number
  columns: number
  title?: string
  line: number
  structure: StructureNode
  slots: Map<number, SlotItem>
  warnings: string[]
}

/** Envanter türünün düzeni; sandık dışındakiler sabit boyutludur. */
function layout(kind: string, rows: number | undefined): { rows: number; columns: number } {
  const k = kind.toLowerCase().trim()
  if (k === 'hopper') return { rows: 1, columns: 5 }
  if (k === 'dispenser' || k === 'dropper' || k === 'workbench' || k === 'crafting table') return { rows: 3, columns: 3 }
  if (k === 'double chest') return { rows: 6, columns: 9 }
  return { rows: Math.min(6, Math.max(1, rows ?? 3)), columns: 9 }
}

function titleOf(text: string): string | undefined {
  const masked = maskNested(text)
  const at = /\b(?:named|with (?:the )?(?:display )?name)\s+"/i.exec(masked)
  if (!at) return undefined
  return stringLiterals(text.slice(at.index + at[0].length - 1))[0]
}

/** `0, 1 and 2`, `integers between 0 and 8`, `(9 to 17)`, `loop-number - 1` → slot numaraları. */
export function parseSlots(expression: string, loops: readonly number[][]): { slots: number[]; unknown: string[] } {
  let text = expression.trim().replace(/^\((.*)\)$/s, '$1')
  const slots: number[] = []
  const unknown: string[] = []
  text = text.replace(/\b(?:all\s+)?(?:integers|numbers)\s+(?:between|from)\s+(-?\d+)\s+(?:and|to)\s+(-?\d+)/gi, (_, a, b) => {
    for (let n = Number(a); n <= Number(b); n++) slots.push(n)
    return ''
  })
  text = text.replace(/\b(\d+)\s+to\s+(\d+)\b/gi, (_, a, b) => {
    for (let n = Number(a); n <= Number(b); n++) slots.push(n)
    return ''
  })
  for (const part of text.split(/,|\band\b|\bor\b/i).map((p) => p.trim().replace(/^\(|\)$/g, '').trim()).filter(Boolean)) {
    if (/^-?\d+$/.test(part)) {
      slots.push(Number(part))
      continue
    }
    const loop = /^loop-(?:value|integer|number|index)(?:-\d+)?\s*(?:([+-])\s*(\d+))?$/i.exec(part)
    const values = loops[loops.length - 1]
    if (loop && values) {
      const offset = loop[1] ? (loop[1] === '-' ? -1 : 1) * Number(loop[2]) : 0
      slots.push(...values.map((value) => value + offset))
      continue
    }
    unknown.push(part)
  }
  return { slots, unknown }
}

/** `loop integers between 0 and 8:` / `loop 9 times:` başlığının döngü değerleri. */
function loopValues(header: string): number[] | null {
  const range = /^loop\s+(?:all\s+)?(?:integers|numbers)\s+(?:between|from)\s+(-?\d+)\s+(?:and|to)\s+(-?\d+)$/i.exec(header.trim())
  if (range) {
    const out: number[] = []
    for (let n = Number(range[1]); n <= Number(range[2]) && out.length < 200; n++) out.push(n)
    return out
  }
  const times = /^loop\s+(\d+)\s+times$/i.exec(header.trim())
  if (times) return Array.from({ length: Math.min(200, Number(times[1])) }, (_, i) => i + 1)
  return null
}

function parseItem(text: string, line: number): SlotItem {
  const masked = maskNested(text)
  const cut = /\s+(?:named|with (?:the )?(?:display )?name|with (?:the )?lore|with custom model data|with (?:all )?(?:the )?item flags?)\b/i.exec(masked)
  const item = (cut ? text.slice(0, cut.index) : text).trim()
  const name = titleOf(text)
  const loreAt = /\bwith (?:the )?lore\s+/i.exec(masked)
  const lore = loreAt ? stringLiterals(text.slice(loreAt.index + loreAt[0].length)) : []
  return { item, name, lore, line }
}

const CREATE = /^(?:set\s+(.+?)\s+to\s+|create\s+(?:a\s+)?(?:new\s+)?gui\s+with\s+)(?:an?\s+)?(?:new\s+)?(?:virtual\s+)?([a-z ]*?)\s*inventory\b(.*)$/i
const OPEN_DIRECT = /^open\s+(?:an?\s+)?(?:virtual\s+)?([a-z ]*?)\s*inventory\b(.*?)\s+to\s+(.+)$/i
const SET_SLOT = /^(?:set|format)\s+(?:the\s+)?(?:gui\s+)?slots?\s+(.+?)\s+of\s+(.+?)\s+(?:to|with)\s+(.+)$/i
const MAKE_GUI_SLOT = /^(?:make|format)\s+(?:the\s+)?(?:next\s+)?gui\s+(?:slots?\s+)?(.+?)\s+with\s+(.+?):?$/i

function normalizeTarget(target: string): string {
  const t = target.trim().toLowerCase()
  if (/(current|top|open(ed)?) inventory|inventory of player|player's inventory/.test(t)) return "player's open inventory"
  return target.trim()
}

/** Bir yapının gövdesindeki GUI oluşturma ve slot atamalarını sırasıyla izler. */
function scanStructure(structure: StructureNode): Gui[] {
  const guis = new Map<string, Gui>()
  const order: Gui[] = []
  let lastGui: Gui | undefined

  const create = (key: string, kind: string, rest: string, line: number) => {
    const rowsMatch = /with\s+(\d+)\s+rows?/i.exec(rest) ?? /with\s+(?:a\s+)?size\s+(?:of\s+)?(\d+)/i.exec(rest)
    let rows = rowsMatch ? Number(rowsMatch[1]) : undefined
    if (rowsMatch && /size/i.test(rowsMatch[0])) rows = Math.ceil(Number(rowsMatch[1]) / 9)
    const gui: Gui = {
      key,
      kind: kind.trim() || 'chest',
      ...layout(kind || 'chest', rows),
      title: titleOf(rest),
      line,
      structure,
      slots: new Map(),
      warnings: []
    }
    if (rows !== undefined && (rows < 1 || rows > 6)) gui.warnings.push(`Line ${line}: ${rows} rows is invalid; chests have 1-6 rows.`)
    guis.set(key.toLowerCase(), gui)
    order.push(gui)
    lastGui = gui
  }

  const assign = (gui: Gui | undefined, slotText: string, itemText: string, line: number, loops: number[][], target: string) => {
    gui ??= guis.get(target.toLowerCase())
    if (!gui) {
      // Açık envantere yazılıyor ama oluşturması bu yapıda değil
      gui = { key: target, kind: 'unknown', rows: 6, columns: 9, line, structure, slots: new Map(), warnings: ['Created elsewhere; size unknown (6 rows shown).'] }
      guis.set(target.toLowerCase(), gui)
      order.push(gui)
      lastGui = gui
    }
    const { slots, unknown } = parseSlots(slotText, loops)
    if (unknown.length) gui.warnings.push(`Line ${line}: could not resolve slot ${unknown.map((u) => JSON.stringify(u)).join(', ')} statically.`)
    const item = parseItem(itemText, line)
    const size = gui.rows * gui.columns
    for (const slot of slots) {
      if (slot < 0 || slot >= size) {
        gui.warnings.push(`Line ${line}: slot ${slot} is outside this ${gui.rows}-row inventory (0-${size - 1}).`)
        continue
      }
      const previous = gui.slots.get(slot)
      if (previous && previous.line !== line) gui.warnings.push(`Line ${line}: slot ${slot} overrides what line ${previous.line} put there.`)
      gui.slots.set(slot, item)
    }
  }

  const visit = (nodes: readonly BodyNode[], loops: number[][]) => {
    for (const node of nodes) {
      const line = node.range.start.line + 1
      if (node.type === 'section') {
        const values = loopValues(node.header)
        const header = node.header.trim().replace(/:$/, '')
        const created = CREATE.exec(maskNested(header))
        const make = MAKE_GUI_SLOT.exec(header)
        if (created && !created[1]) create('gui', created[2], header.slice(header.length - created[3].length), line)
        else if (make) assign(lastGui, make[1], make[2], line, loops, 'gui')
        visit(node.children, values ? [...loops, values] : loops)
        continue
      }
      if (node.type === 'entry') {
        if (node.children) visit(node.children, loops)
        continue
      }
      const text = node.text.trim()
      const masked = maskNested(text)
      const created = CREATE.exec(masked)
      if (created) {
        const key = created[1] ? text.slice(4, 4 + created[1].length).trim() : 'gui'
        const restStart = masked.length - created[3].length
        create(key, created[2], text.slice(restStart), line)
        continue
      }
      const opened = OPEN_DIRECT.exec(masked)
      if (opened) {
        const restStart = masked.indexOf(opened[2], masked.toLowerCase().indexOf('inventory'))
        create("player's open inventory", opened[1], text.slice(restStart, restStart + opened[2].length), line)
        continue
      }
      const set = SET_SLOT.exec(masked)
      if (set) {
        const slotStart = masked.indexOf(set[1])
        const slotText = text.slice(slotStart, slotStart + set[1].length)
        const targetStart = slotStart + set[1].length + masked.slice(slotStart + set[1].length).indexOf(set[2])
        const target = normalizeTarget(text.slice(targetStart, targetStart + set[2].length))
        const itemText = text.slice(masked.length - set[3].length)
        const gui = guis.get(target.toLowerCase()) ?? (target === "player's open inventory" ? lastGui : undefined)
        assign(gui, slotText, itemText, line, loops, target)
        continue
      }
      const make = MAKE_GUI_SLOT.exec(masked)
      if (make) {
        const slotStart = masked.indexOf(make[1])
        assign(lastGui, text.slice(slotStart, slotStart + make[1].length), text.slice(masked.lastIndexOf(make[2]), masked.lastIndexOf(make[2]) + make[2].length), line, loops, 'gui')
      }
    }
  }
  visit(structure.children, [])
  return order
}

function render(gui: Gui, path: string): string {
  const title = gui.title !== undefined ? `, title "${gui.title}" → shown ${JSON.stringify(previewText(gui.title).plain)}` : ''
  const lines = [`${gui.key} — ${gui.kind}, ${gui.rows}×${gui.columns}${title} (${path}:${gui.line}, ${structureLabel(gui.structure)})`]
  const legend = new Map<string, { symbol: string; item: SlotItem; slots: number[] }>()
  const symbolFor = (item: SlotItem, slot: number) => {
    const key = `${item.item}|${item.name ?? ''}|${item.lore.join('|')}`
    let entry = legend.get(key)
    if (!entry) {
      entry = { symbol: SYMBOLS[legend.size] ?? '?', item, slots: [] }
      legend.set(key, entry)
    }
    entry.slots.push(slot)
    return entry.symbol
  }
  const header = Array.from({ length: gui.columns }, (_, i) => String(i)).join(' ')
  lines.push(`      ${header}`)
  for (let row = 0; row < gui.rows; row++) {
    const cells: string[] = []
    for (let column = 0; column < gui.columns; column++) {
      const slot = row * gui.columns + column
      const item = gui.slots.get(slot)
      cells.push(item ? symbolFor(item, slot) : '·')
    }
    lines.push(`  ${String(row * gui.columns).padStart(2)}  ${cells.join(' ')}`)
  }
  for (const { symbol, item, slots } of legend.values()) {
    const name = item.name !== undefined ? ` named ${JSON.stringify(previewText(item.name).plain)}` : ''
    const lore = item.lore.length ? `; lore: ${item.lore.map((l) => JSON.stringify(previewText(l).plain)).join(' / ')}` : ''
    lines.push(`  ${symbol}: ${clip(item.item, 60)}${name}${lore} — slot${slots.length === 1 ? '' : 's'} ${compactSlots(slots)}`)
  }
  if (gui.slots.size === 0) lines.push('  (no slots set)')
  lines.push(...gui.warnings.map((warning) => `  ! ${warning}`))
  return lines.join('\n')
}

function compactSlots(slots: readonly number[]): string {
  const sorted = [...new Set(slots)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

interface PreviewGuiInput {
  path: string
  line?: number
}

export const previewGuiTool = defineTool<PreviewGuiInput>({
  name: 'preview_gui',
  description:
    'Draw the inventory GUIs a .sk file builds as a slot grid with a legend: which item (and its visible name and ' +
    'lore) ends up in each slot. It follows "set {_gui} to chest inventory with N rows named ...", "set slot(s) ... of ' +
    '{_gui}/player\'s current inventory to ...", skript-gui "create a gui ..." / "make gui slot ...", ranges such as ' +
    '"integers between 0 and 8" and simple loops. Warns about slots outside the inventory, slots overwritten later ' +
    'and slots it cannot resolve statically. Use it to check a menu layout before or after editing it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root.' },
      line: { type: 'integer', description: '1-based line inside the trigger or function that builds the GUI; default: every GUI in the file.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    const { scripts } = await readProjectScripts(ctx, input.path)
    const script = scripts[0]
    if (!script) throw new ToolError(`Could not read ${input.path}.`)
    let structures = script.doc.structures
    if (input.line !== undefined) {
      const structure = structureAt(script.doc, input.line - 1)
      if (!structure) throw new ToolError(`Line ${input.line} of ${input.path} is not inside a trigger or function.`)
      structures = [structure]
    }
    const guis = structures.flatMap(scanStructure)
    if (guis.length === 0) return `No inventory GUI found in ${script.path}${input.line ? ` around line ${input.line}` : ''}.`
    return guis.map((gui) => render(gui, script.path)).join('\n\n')
  }
})
