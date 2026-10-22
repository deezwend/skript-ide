import { readFile, writeFile } from 'node:fs/promises'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { resolveInProject } from './paths'

interface EditInput {
  path: string
  old_text: string
  new_text: string
  line?: number
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

/** Değişikliği hesaplar; hem önizleme hem uygulama aynı sonucu kullanır. */
async function computeEdit({ path, old_text, new_text, line }: EditInput, ctx: ToolContext) {
  if (old_text === '') throw new ToolError('old_text must not be empty.')
  const file = await resolveInProject(ctx, path)
  const before = await readFile(file, 'utf8')

  const flatBefore = flatten(before)
  const flatOld = flatten(old_text)
  const starts = occurrences(flatBefore, flatOld)
  if (starts.length === 0) {
    throw new ToolError(
      `old_text was not found in ${path}. Read the file again and copy the text exactly, including indentation.`
    )
  }

  const start = chooseMatch(starts, lineNumbers(flatBefore, starts), line, path)
  const begin = originalOffset(before, start)
  const end = originalOffset(before, start + flatOld.length)
  const eol = detectEol(before)
  const after = before.slice(0, begin) + new_text.replace(EOL, eol) + before.slice(end)
  return { file, before, after }
}

export const editFileTool = defineTool<EditInput>({
  name: 'edit_file',
  description:
    'Replace one exact occurrence of old_text with new_text in an existing project file. ' +
    'Copy old_text exactly from read_file output (without the line-number prefix), including indentation. ' +
    'Line endings (LF/CRLF) are matched automatically and new_text keeps the file\'s line ending style. ' +
    'If old_text appears more than once, pass line (the 1-based line where it starts) to pick one.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      line: {
        type: 'integer',
        description: '1-based line where old_text starts; picks one occurrence when old_text appears more than once.'
      }
    },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before, after } = await computeEdit(input, ctx)
    return { summary: `Edit ${input.path}`, change: { path: input.path, before, after } }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosya değişmiş olabilir; yeniden hesapla
    const { file, after } = await computeEdit(input, ctx)
    await writeFile(file, after, 'utf8')
    return `Edited ${input.path}.`
  }
})
