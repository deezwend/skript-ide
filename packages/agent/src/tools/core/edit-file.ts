import { readFile, writeFile } from 'node:fs/promises'
import { defineTool, ToolError, type JsonSchema, type ToolContext } from '../../tool'
import { scriptFeedback } from '../skript/edit-feedback'
import { resolveInProject } from './paths'

interface EditInput extends TextEdit {
  path: string
}

const EOL = /\r\n|\r|\n/g
const MAX_LINES_IN_ERROR = 8

/** `read_file` satırları LF ile verir; eşleştirme satır sonu biçiminden bağımsız olsun diye hepsi tek `\n` sayılır. */
function flatten(text: string): string {
  return text.replace(EOL, '\n')
}

/** `flatten` sonrası konumu özgün metindeki konuma çevirir (`\r\n` iki karakterden bire indiği için gerekir). */
function originalOffset(text: string, flatOffset: number): number {
  let flat = 0
  for (let i = 0; i < text.length; i++) {
    if (flat === flatOffset) return i
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i++
    flat++
  }
  return text.length
}

/** Eşleşme başlangıçlarının 1 tabanlı satır numaraları; `offsets` artan sırada olmalı. */
function lineNumbers(flat: string, offsets: readonly number[]): number[] {
  const lines: number[] = []
  let line = 1
  let cursor = 0
  for (const offset of offsets) {
    for (; cursor < offset; cursor++) if (flat.charCodeAt(cursor) === 10) line++
    lines.push(line)
  }
  return lines
}

function occurrences(haystack: string, needle: string): number[] {
  const starts: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) starts.push(at)
  return starts
}

/** Dosyanın baskın satır sonu; yeni metin dosyanın biçimini korusun diye. Hiç satır sonu yoksa LF. */
function detectEol(text: string): string {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else {
        cr++
      }
    } else if (code === 10) {
      lf++
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return '\n'
  if (crlf >= lf && crlf >= cr) return '\r\n'
  return lf >= cr ? '\n' : '\r'
}

function summarizeLines(lines: readonly number[]): string {
  const shown = lines.slice(0, MAX_LINES_IN_ERROR).join(', ')
  return lines.length > MAX_LINES_IN_ERROR ? `${shown}, … (${lines.length} matches)` : shown
}

/** Birden çok eşleşmede `line` ile seçim yapar; seçim yapılamıyorsa aday satırları söyleyerek reddeder. */
function chooseMatch(starts: readonly number[], lines: readonly number[], line: number | undefined, path: string): number {
  if (line === undefined) {
    if (starts.length > 1) {
      throw new ToolError(
        `old_text appears ${starts.length} times in ${path} (lines ${summarizeLines(lines)}); ` +
          'pass line to pick one or include more surrounding lines.'
      )
    }
    return starts[0]
  }
  if (!Number.isInteger(line) || line < 1) throw new ToolError('line must be a positive integer (1-based).')
  const atLine = starts.filter((_, index) => lines[index] === line)
  if (atLine.length === 0) {
    throw new ToolError(
      `old_text does not start at line ${line} in ${path}; it appears at line ${summarizeLines(lines)}.`
    )
  }
  if (atLine.length > 1) {
    throw new ToolError(`old_text appears ${atLine.length} times on line ${line} of ${path}; include more surrounding text.`)
  }
  return atLine[0]
}

/** Tek bir değiştirme; `edit_file` girdisi ve `multi_edit` adımları bu biçimdedir. */
export interface TextEdit {
  old_text: string
  new_text: string
  line?: number
  replace_all?: boolean
}

/**
 * Değiştirmeyi metne uygular; eşleşme yoksa ya da belirsizse `ToolError` fırlatır.
 * Dönen `count`: değiştirilen yer sayısı.
 */
export function applyTextEdit(text: string, { old_text, new_text, line, replace_all = false }: TextEdit, path: string): { text: string; count: number } {
  // Boş dosyada eşleşecek metin yok; boş old_text dosyayı doldurur
  if (old_text === '') {
    if (text.trim() !== '') throw new ToolError('old_text must not be empty unless the file is empty.')
    return { text: new_text, count: 1 }
  }

  const flatText = flatten(text)
  const flatOld = flatten(old_text)
  const starts = occurrences(flatText, flatOld)
  if (starts.length === 0) {
    throw new ToolError(
      `old_text was not found in ${path}. Read the file again and copy the text exactly, including indentation.`
    )
  }

  let chosen: number[]
  if (replace_all) {
    if (line !== undefined) throw new ToolError('Pass either line or replace_all, not both.')
    // Üst üste binen eşleşmelerden yalnızca ilki değişir
    chosen = []
    for (const start of starts) if (chosen.length === 0 || start >= chosen.at(-1)! + flatOld.length) chosen.push(start)
  } else {
    chosen = [chooseMatch(starts, lineNumbers(flatText, starts), line, path)]
  }

  const replacement = new_text.replace(EOL, detectEol(text))
  let result = text
  // Sondan başa: öndeki konumlar kaymasın
  for (const start of [...chosen].reverse()) {
    const begin = originalOffset(text, start)
    const end = originalOffset(text, start + flatOld.length)
    result = result.slice(0, begin) + replacement + result.slice(end)
  }
  return { text: result, count: chosen.length }
}

/** Değişikliği hesaplar; hem önizleme hem uygulama aynı sonucu kullanır. */
async function computeEdit({ path, ...edit }: EditInput, ctx: ToolContext) {
  const file = await resolveInProject(ctx, path)
  const before = await readFile(file, 'utf8')
  const { text: after, count } = applyTextEdit(before, edit, path)
  return { file, before, after, count }
}

/** `edit_file` ve `multi_edit` adımlarının ortak şeması. */
export const EDIT_PROPERTIES = {
  old_text: { type: 'string' },
  new_text: { type: 'string' },
  line: {
    type: 'integer',
    description: '1-based line where old_text starts; picks one occurrence when old_text appears more than once.'
  },
  replace_all: { type: 'boolean', description: 'Replace every occurrence of old_text (default: false).' }
} satisfies Record<string, JsonSchema>

export const editFileTool = defineTool<EditInput>({
  name: 'edit_file',
  description:
    'Replace one exact occurrence of old_text with new_text in an existing project file. ' +
    'Copy old_text exactly from read_file output (without the line-number prefix), including indentation. ' +
    'Line endings (LF/CRLF) are matched automatically and new_text keeps the file\'s line ending style. ' +
    'If old_text appears more than once, pass line (the 1-based line where it starts) to pick one, ' +
    'or replace_all to change every occurrence (for example to rename something within the file). ' +
    'If the file is empty, pass an empty old_text to fill it with new_text. ' +
    'For several changes in the same file, use multi_edit instead. ' +
    'For .sk files the result also lists the errors and warnings this edit introduced, with quick fixes when available.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      ...EDIT_PROPERTIES
    },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before, after } = await computeEdit(input, ctx)
    return { summary: `Edit ${input.path}`, changes: [{ path: input.path, before, after }] }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosya değişmiş olabilir; yeniden hesapla
    const { file, before, after, count } = await computeEdit(input, ctx)
    await writeFile(file, after, 'utf8')
    ctx.onFilesChanged?.([{ path: input.path, before, after }])
    const summary = count > 1 ? `Edited ${input.path} (${count} replacements).` : `Edited ${input.path}.`
    return `${summary}${await scriptFeedback(ctx, [{ path: input.path, file, before, after }])}`
  }
})
