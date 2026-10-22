import { readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  defineTool,
  ToolError,
  type AgentLanguageService,
  type FileChange,
  type JsonSchema,
  type ToolContext,
  type ToolLocation,
  type ToolPosition,
  type ToolRange,
  type ToolSymbol
} from '../../tool'
import { displayPath, isInside, resolveInProject } from '../core/paths'
import { scriptFeedback } from './edit-feedback'
import { fileUri, isScript, requireLanguageService, syncWorkspace } from './shared'

const MAX_LOCATIONS = 200
const MAX_OUTLINE_FILES = 100
const MAX_LINE_LENGTH = 200
const LINE_BREAK = /\r\n|\n|\r/

interface SymbolInput {
  path: string
  symbol: string
  line?: number
}

const SYMBOL_PROPERTIES = {
  path: { type: 'string', description: 'The .sk file where the symbol appears, relative to the project root.' },
  symbol: {
    type: 'string',
    description: 'The name as written in the file: a function name ("give_kit"), a variable ("{_target}", "{coins::%player%}") or an option ("{@prefix}").'
  },
  line: { type: 'integer', description: '1-based line where the symbol appears; default: its first appearance in the file.' }
} satisfies Record<string, JsonSchema>

/** Bir `.sk` dosyasını çözer ve tüm projeyi dil servisine verir; başka dosyalardaki tanımlar da bilinsin. */
async function prepareScript(ctx: ToolContext, path: string) {
  const service = requireLanguageService(ctx)
  if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
  const root = await realpath(ctx.projectRoot)
  const file = await resolveInProject(ctx, path)
  if (!isScript(file)) throw new ToolError(`${path} is not a .sk file.`)
  await syncWorkspace(service, root)
  return { service, root, file }
}

/** Sembolün dosyadaki konumu: adın ilk karakteri (`{`, `{@` atlanır), dil servisinin beklediği biçimde. */
function findSymbol(text: string, { path, symbol, line }: SymbolInput): ToolPosition {
  const needle = symbol.trim().replace(/\(.*$/s, '').toLowerCase()
  if (needle === '') throw new ToolError('symbol must not be empty.')
  const lines = text.split(LINE_BREAK)
  const skip = needle.startsWith('{@') ? 2 : needle.startsWith('{') ? 1 : 0
  const at = (index: number): ToolPosition | null => {
    const column = lines[index]?.toLowerCase().indexOf(needle) ?? -1
    return column === -1 ? null : { line: index, character: column + skip }
  }

  if (line !== undefined) {
    if (!Number.isInteger(line) || line < 1) throw new ToolError('line must be a positive integer (1-based).')
    const found = at(line - 1)
    if (!found) throw new ToolError(`"${symbol}" does not appear on line ${line} of ${path}.`)
    return found
  }
  for (let index = 0; index < lines.length; index++) {
    const found = at(index)
    if (found) return found
  }
  throw new ToolError(`"${symbol}" does not appear in ${path}.`)
}

/** Konumları `path:line:column: satır` biçiminde yazar; dosyalar bir kez okunur. */
async function formatLocations(root: string, locations: readonly ToolLocation[]): Promise<string[]> {
  const texts = new Map<string, string[]>()
  const out: string[] = []
  for (const { uri, range } of locations.slice(0, MAX_LOCATIONS)) {
    const file = fileURLToPath(uri)
    if (!texts.has(file)) texts.set(file, await readFile(file, 'utf8').then((t) => t.split(LINE_BREAK), () => []))
    const source = texts.get(file)![range.start.line]?.trim().slice(0, MAX_LINE_LENGTH) ?? ''
    out.push(`${displayPath(root, file)}:${range.start.line + 1}:${range.start.character + 1}: ${source}`)
  }
  if (locations.length > MAX_LOCATIONS) out.push(`(… ${locations.length - MAX_LOCATIONS} more)`)
  return out
}

function outlineLines(symbols: readonly ToolSymbol[], depth: number, nested: boolean): string[] {
  return symbols.flatMap((symbol) => {
    const { start, end } = symbol.range
    const lines = start.line === end.line ? `${start.line + 1}` : `${start.line + 1}-${end.line + 1}`
    const detail = symbol.detail ? ` (${symbol.detail})` : ''
    const head = `${'  '.repeat(depth)}${lines}: ${symbol.name.trim()}${detail}`
    return nested && symbol.children?.length ? [head, ...outlineLines(symbol.children, depth + 1, nested)] : [head]
  })
}

export const getOutlineTool = defineTool<{ path?: string }>({
  name: 'get_outline',
  description:
    'Show the structure of Skript files: events, commands, functions (with signatures), options and variables blocks, ' +
    'each with its line range. With path, also lists what is inside each block. Without path, lists the top-level ' +
    'structures of every .sk file in the project, which is a quick way to see where things are defined. ' +
    'Use it before reading a large script.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root. Omit for every .sk file.' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path }, ctx) {
    if (path !== undefined) {
      const { service, root, file } = await prepareScript(ctx, path)
      const symbols = await service.getDocumentSymbols(fileUri(file))
      const shown = displayPath(root, file)
      return symbols.length === 0 ? `${shown}: no structures.` : [`${shown}:`, ...outlineLines(symbols, 1, true)].join('\n')
    }

    const service = requireLanguageService(ctx)
    if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
    const scripts = await syncWorkspace(service, await realpath(ctx.projectRoot))
    if (scripts.length === 0) return 'No .sk files in the project.'
    const out: string[] = []
    for (const script of scripts.slice(0, MAX_OUTLINE_FILES)) {
      ctx.signal.throwIfAborted()
      const symbols = await service.getDocumentSymbols(fileUri(script.file))
      out.push(symbols.length === 0 ? `${script.path}: no structures.` : `${script.path}:`, ...outlineLines(symbols, 1, false))
    }
    if (scripts.length > MAX_OUTLINE_FILES) out.push(`(… ${scripts.length - MAX_OUTLINE_FILES} more files; pass path to see one)`)
    return out.join('\n')
  }
})

export const findDefinitionTool = defineTool<SymbolInput>({
  name: 'find_definition',
  description:
    'Find where a Skript function, variable or option used in a .sk file is defined, across all project scripts. ' +
    'For variables, every place that sets the variable is returned. Returns "path:line:column: source line" lines.',
  inputSchema: { type: 'object', properties: SYMBOL_PROPERTIES, required: ['path', 'symbol'], additionalProperties: false },
  permission: 'read',
  async execute(input, ctx) {
    const { service, root, file } = await prepareScript(ctx, input.path)
    const position = findSymbol(await readFile(file, 'utf8'), input)
    const locations = await service.getDefinition(fileUri(file), position)
    if (locations.length === 0) return `No definition found for "${input.symbol}".`
    return (await formatLocations(root, locations)).join('\n')
  }
})

export const findReferencesTool = defineTool<SymbolInput>({
  name: 'find_references',
  description:
    'Find every use of a Skript function, variable or option across all project scripts, including its definition. ' +
    'More reliable than a text search: it ignores other things with similar names and respects local functions and variables. ' +
    'Returns "path:line:column: source line" lines.',
  inputSchema: { type: 'object', properties: SYMBOL_PROPERTIES, required: ['path', 'symbol'], additionalProperties: false },
  permission: 'read',
  async execute(input, ctx) {
    const { service, root, file } = await prepareScript(ctx, input.path)
    const position = findSymbol(await readFile(file, 'utf8'), input)
    const locations = await service.getReferences(fileUri(file), position, true)
    if (locations.length === 0) return `No references found for "${input.symbol}".`
    const count = `${locations.length} ${locations.length === 1 ? 'reference' : 'references'}:`
    return [count, ...(await formatLocations(root, locations))].join('\n')
  }
})

// --- Yeniden adlandırma ---

interface RenameInput extends SymbolInput {
  new_name: string
}

type RangeEdits = Map<string, { range: ToolRange; newText: string }[]>

const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function offsetAt(text: string, lineStarts: readonly number[], position: ToolPosition): number {
  return Math.min(text.length, (lineStarts[position.line] ?? text.length) + position.character)
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (const match of text.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length)
  return starts
}

/** Değişkenler için dil servisinin yeniden adlandırması; fonksiyon ve seçenekler için referansların değiştirilmesi. */
async function renameEdits(service: AgentLanguageService, uri: string, position: ToolPosition, input: RenameInput): Promise<RangeEdits> {
  const edits: RangeEdits = new Map()
  let variable
  try {
    variable = await service.rename(uri, position, input.new_name)
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : String(error))
  }
  if (variable) {
    for (const [target, list] of Object.entries(variable.changes ?? {})) edits.set(target, [...list])
    return edits
  }

  const references = await service.getReferences(uri, position, true)
  if (references.length === 0) {
    throw new ToolError(`"${input.symbol}" is not a function, variable or option that can be renamed.`)
  }
  const name = input.new_name.trim().replace(/^\{@?|\}$/g, '')
  if (!FUNCTION_NAME.test(name)) {
    throw new ToolError('Function and option names may only contain letters, digits and _, and cannot start with a digit.')
  }
  for (const { uri: target, range } of references) {
    if (!edits.has(target)) edits.set(target, [])
    edits.get(target)!.push({ range, newText: name })
  }
  return edits
}

async function computeRename(input: RenameInput, ctx: ToolContext) {
  const { service, root, file } = await prepareScript(ctx, input.path)
  const position = findSymbol(await readFile(file, 'utf8'), input)
  const edits = await renameEdits(service, fileUri(file), position, input)

  const files: { file: string; change: FileChange }[] = []
  for (const [uri, list] of edits) {
    const target = fileURLToPath(uri)
    if (!isInside(root, target)) throw new ToolError(`Refusing to edit a file outside the project: ${target}`)
    const before = await readFile(target, 'utf8')
    const starts = lineStartsOf(before)
    const ranges = list
      .map(({ range, newText }) => {
        const from = offsetAt(before, starts, range.start)
        const to = offsetAt(before, starts, range.end)
        // Seçenek başvurusunun aralığı `{@ad}` olabilir; süslü parantezler korunur
        const old = before.slice(from, to)
        const text = old.startsWith('{@') && old.endsWith('}') ? `{@${newText}}` : newText
        return { from, to, text }
      })
      .sort((a, b) => b.from - a.from)
    let after = before
    for (const { from, to, text } of ranges) after = after.slice(0, from) + text + after.slice(to)
    if (after !== before) files.push({ file: target, change: { path: displayPath(root, target), before, after } })
  }
  if (files.length === 0) throw new ToolError(`Renaming "${input.symbol}" would not change anything.`)
  return files
}

export const renameSymbolTool = defineTool<RenameInput>({
  name: 'rename_symbol',
  description:
    'Rename a Skript function, variable or option everywhere it is used, across all project scripts, in one step ' +
    '(the user approves all files together). Local functions and variables are only renamed where they are visible. ' +
    'For a variable, new_name is the name without braces (e.g. "_target" or "coins::%player%"); ' +
    'for a function or option, just the new name. The result lists new errors in the changed .sk files, if any.',
  inputSchema: {
    type: 'object',
    properties: { ...SYMBOL_PROPERTIES, new_name: { type: 'string', description: 'The new name.' } },
    required: ['path', 'symbol', 'new_name'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const files = await computeRename(input, ctx)
    const scope = files.length === 1 ? files[0].change.path : `${files.length} files`
    return { summary: `Rename ${input.symbol} → ${input.new_name} in ${scope}`, changes: files.map((f) => f.change) }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosyalar değişmiş olabilir; yeniden hesapla
    const files = await computeRename(input, ctx)
    for (const { file, change } of files) await writeFile(file, change.after, 'utf8')
    ctx.onFilesChanged?.(files.map((f) => f.change))
    const paths = files.map((f) => f.change.path).join(', ')
    const summary = `Renamed ${input.symbol} → ${input.new_name} in ${paths}.`
    const feedback = await scriptFeedback(
      ctx,
      files.map(({ file, change }) => ({ path: change.path, file, before: change.before, after: change.after }))
    )
    return `${summary}${feedback}`
  }
})

export const navigationTools = [getOutlineTool, findDefinitionTool, findReferencesTool, renameSymbolTool]
