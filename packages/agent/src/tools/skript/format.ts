import { readFile, realpath, writeFile } from 'node:fs/promises'
import { parseDocument } from '@skript-ide/parser'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { scriptFeedback } from './edit-feedback'
import { isScript } from './shared'

type IndentStyle = 'tab' | '2' | '4'

interface FormatInput {
  path: string
  indent?: IndentStyle
  tab_width?: number
}

export interface FormatResult {
  text: string
  reindented: number
  /** 1 tabanlı satırlar. */
  colonsAdded: number[]
  ambiguous: number[]
  unit: string
}

/** Altında blok açabilen satırlar; yalnızca bunlara eksik `:` eklenir. */
const SECTION_START =
  /^(?:else\s+if|if|else|loop|while|on|every|at|command|function|local\s+function|options|variables|aliases|trigger|chance\s+of|parse\s+if|do\s+if)\b/i

function width(indent: string, tabWidth: number): number {
  let total = 0
  for (const ch of indent) total += ch === '\t' ? tabWidth : 1
  return total
}

/** Dosyada ağırlıkla kullanılan girinti birimi: ilk seviye girintilerin çoğu tab ise tab, değilse en küçük boşluk sayısı. */
function detectUnit(indents: readonly string[]): string {
  let tabs = 0
  let spaces = 0
  let smallest = Infinity
  for (const indent of indents) {
    if (indent === '') continue
    if (indent.includes('\t')) tabs++
    else {
      spaces++
      smallest = Math.min(smallest, indent.length)
    }
  }
  if (tabs === 0 && spaces === 0) return '\t'
  if (tabs >= spaces) return '\t'
  return ' '.repeat(smallest >= 4 ? 4 : smallest === 3 ? 4 : 2)
}

/**
 * Girintiyi seviyelere göre yeniden yazar: karışık tab/boşluk, tutarsız genişlikler ve sondaki boşluklar
 * düzelir; altında daha derin satır olan ama `:` ile bitmeyen başlıklara `:` eklenir. Yorum satırları
 * kendilerinden sonraki kod satırının seviyesine alınır. Satırların içeriğine dokunulmaz.
 */
export function formatScript(source: string, options: { indent?: IndentStyle; tabWidth?: number } = {}): FormatResult {
  const tabWidth = options.tabWidth ?? 4
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const text = source.slice(bom.length)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const rawLines = text.split(/\r\n|\n|\r/)
  const doc = parseDocument(text)
  const info = doc.lines

  const unit =
    options.indent === 'tab' ? '\t' : options.indent === '2' ? '  ' : options.indent === '4' ? '    ' : detectUnit(info.map((l) => l.indent))

  // Kod satırlarının derinliği
  const depth = new Map<number, number>()
  const colonsAdded: number[] = []
  const ambiguous: number[] = []
  const stack = [0]
  let previous: number | null = null
  for (const line of info) {
    if (line.blank) continue
    const w = width(line.indent, tabWidth)
    const top = stack[stack.length - 1]
    if (w > top) {
      const header = previous === null ? '' : info[previous].text
      if (previous === null || header.endsWith(':')) {
        stack.push(w)
      } else if (SECTION_START.test(header)) {
        colonsAdded.push(previous)
        stack.push(w)
      } else {
        // Başlık olmayan satırın altında fazla girinti: aynı seviyeye alınır
        ambiguous.push(line.line + 1)
      }
    } else if (w < top) {
      let popped = top
      while (stack.length > 1 && stack[stack.length - 1] > w) popped = stack.pop()!
      const below = stack[stack.length - 1]
      if (below !== w) {
        ambiguous.push(line.line + 1)
        // Arada kalan genişlik: daha yakın olan seviyeye yerleştir
        if (popped - w <= w - below) stack.push(w)
      }
    }
    depth.set(line.line, stack.length - 1)
    previous = line.line
  }

  const out: string[] = []
  let reindented = 0
  let nextCodeDepth = 0
  // Yorum satırları sonraki kod satırının seviyesini alır; bu yüzden sondan başa gidilir
  const resolved: string[] = new Array(rawLines.length)
  for (let index = rawLines.length - 1; index >= 0; index--) {
    const raw = rawLines[index]
    const line = info[index]
    if (!line) {
      resolved[index] = raw
      continue
    }
    const content = raw.slice(line.indent.length).trimEnd()
    if (content === '') {
      resolved[index] = ''
    } else if (line.blank) {
      // Yalnızca yorum (ya da blok yorum içi) satır
      resolved[index] = line.commentStart !== undefined ? unit.repeat(nextCodeDepth) + content : raw.trimEnd()
    } else {
      const d = depth.get(index) ?? 0
      nextCodeDepth = d
      let body = content
      if (colonsAdded.includes(index)) {
        const codeEnd = line.start - line.indent.length + line.text.length
        body = `${content.slice(0, codeEnd)}:${content.slice(codeEnd)}`
      }
      resolved[index] = unit.repeat(d) + body
    }
  }
  for (let index = 0; index < rawLines.length; index++) {
    if (resolved[index] !== rawLines[index]) reindented++
    out.push(resolved[index])
  }

  return {
    text: bom + out.join(eol),
    reindented,
    colonsAdded: colonsAdded.map((line) => line + 1),
    ambiguous,
    unit: unit === '\t' ? 'tabs' : `${unit.length} spaces`
  }
}

async function computeFormat(input: FormatInput, ctx: ToolContext) {
  const file = await resolveInProject(ctx, input.path)
  if (!isScript(file)) throw new ToolError(`${input.path} is not a .sk file.`)
  const tabWidth = input.tab_width ?? 4
  if (!Number.isInteger(tabWidth) || tabWidth < 1 || tabWidth > 8) throw new ToolError('tab_width must be an integer from 1 to 8.')
  const before = await readFile(file, 'utf8')
  const result = formatScript(before, { indent: input.indent, tabWidth })
  if (result.text === before) throw new ToolError(`${input.path} is already formatted (indentation: ${result.unit}).`)
  return { file, before, result }
}

export const formatScriptTool = defineTool<FormatInput>({
  name: 'format_script',
  description:
    'Normalize the indentation of a .sk file: mixed tabs and spaces, inconsistent widths and trailing whitespace ' +
    'are fixed by re-indenting every line by its block level, and a header that has an indented block under it but ' +
    'no trailing ":" gets one. Comment lines take the level of the next code line. Line contents are not changed. ' +
    'Use it when diagnostics report indentation errors (mixed indentation, "unexpected indentation") instead of ' +
    'fixing indents by hand. Lines whose indent does not fit a block (between two levels, or deeper than a line that ' +
    'cannot open a block) are reported; check them afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root.' },
      indent: {
        type: 'string',
        enum: ['tab', '2', '4'],
        description: 'Indent unit: tab, 2 or 4 spaces. Default: the unit the file mostly uses.'
      },
      tab_width: { type: 'integer', description: 'How many spaces a tab counts as when comparing mixed indents (default 4).' }
    },
    required: ['path'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before, result } = await computeFormat(input, ctx)
    return { summary: `Format ${input.path} (${result.unit})`, changes: [{ path: input.path, before, after: result.text }] }
  },
  async execute(input, ctx) {
    const { file, before, result } = await computeFormat(input, ctx)
    await writeFile(file, result.text, 'utf8')
    const shown = displayPath(await realpath(ctx.projectRoot!), file)
    ctx.onFilesChanged?.([{ path: shown, before, after: result.text }])
    const lines = [`Formatted ${shown}: ${result.reindented} line${result.reindented === 1 ? '' : 's'} changed, indentation: ${result.unit}.`]
    if (result.colonsAdded.length) lines.push(`Added a missing ":" on line${result.colonsAdded.length === 1 ? '' : 's'} ${result.colonsAdded.join(', ')}.`)
    if (result.ambiguous.length) {
      lines.push(`Indent did not fit a block on line${result.ambiguous.length === 1 ? '' : 's'} ${result.ambiguous.join(', ')}; check that these lines are in the intended block.`)
    }
    return lines.join('\n') + (await scriptFeedback(ctx, [{ path: shown, file, before, after: result.text }]))
  }
})
