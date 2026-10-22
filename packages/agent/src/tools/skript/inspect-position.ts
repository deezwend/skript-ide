import { readFile, realpath } from 'node:fs/promises'
import {
  defineTool,
  ToolError,
  type ToolCompletionItem,
  type ToolHover,
  type ToolPosition,
  type ToolScopeInfo
} from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { fileUri, isScript, requireLanguageService, syncWorkspace } from './shared'

interface InspectInput {
  path: string
  line: number
  column?: number
}

const MAX_COMPLETIONS = 30
const MAX_HOVER_CHARS = 700
const MAX_VARIABLES = 25

/** LSP `CompletionItemKind` adları; yalnızca gösterim için. */
const COMPLETION_KINDS: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'constructor',
  5: 'field',
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'module',
  10: 'property',
  11: 'unit',
  12: 'value',
  13: 'enum',
  14: 'keyword',
  15: 'snippet',
  16: 'color',
  17: 'file',
  18: 'reference',
  19: 'folder',
  20: 'enum member',
  21: 'constant',
  22: 'struct',
  23: 'event',
  24: 'operator',
  25: 'type parameter'
}

export const inspectPositionTool = defineTool<InspectInput>({
  name: 'inspect_position',
  description:
    'Show what is valid at one position of a .sk file in a single call: hover documentation, the enclosing event/structure, ' +
    'the event values available there, local variables and options in scope, and a short completion list. ' +
    'Use it to answer questions like "does this event have a victim?" or "what does this expression return?" ' +
    'before writing code, instead of guessing and retrying.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root.' },
      line: { type: 'integer', description: '1-based line number.' },
      column: {
        type: 'integer',
        description: '1-based column; defaults to the first non-space character of the line.'
      }
    },
    required: ['path', 'line'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path, line, column }, ctx) {
    const service = requireLanguageService(ctx)
    if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
    if (!Number.isInteger(line) || line < 1) throw new ToolError('line must be a positive integer (1-based).')
    if (column !== undefined && (!Number.isInteger(column) || column < 1)) {
      throw new ToolError('column must be a positive integer (1-based).')
    }

    const root = await realpath(ctx.projectRoot)
    const file = await resolveInProject(ctx, path)
    if (!isScript(file)) throw new ToolError(`${path} is not a .sk file.`)
    const text = await readFile(file, 'utf8')
    const lines = text.split(/\r\n|\r|\n/)
    const source = lines[line - 1]
    if (source === undefined) throw new ToolError(`${path} has fewer than ${line} lines.`)
    const firstChar = source.search(/\S/)
    const character = Math.min((column ?? (firstChar === -1 ? 1 : firstChar + 1)) - 1, source.length)
    const position: ToolPosition = { line: line - 1, character }

    await syncWorkspace(service, root)
    const uri = fileUri(file)
    const [hover, scope, completions] = await Promise.all([
      service.getHover(uri, position),
      service.getScopeInfo(uri, position),
      service.getCompletions(uri, position)
    ])

    return format(displayPath(root, file), line, position.character + 1, source, hover, scope, completions)
  }
})

function format(
  shown: string,
  line: number,
  column: number,
  source: string,
  hover: ToolHover | null,
  scope: ToolScopeInfo | null,
  completions: readonly ToolCompletionItem[]
): string {
  const out = [`${shown}:${line}:${column}: ${source.trim().slice(0, 200)}`]

  const hoverText = hover ? plainText(hover) : ''
  out.push(`Hover: ${hoverText || '(none)'}`)

  if (scope?.structure) {
    out.push(`Inside: ${scope.structure.kind} "${scope.structure.header.trim()}"`)
  }
  if (scope?.event) {
    const refs = scope.event.matches.map((ref) => {
      const origin = ref.addon ? `, ${ref.addon}` : ''
      return `[${ref.kind}] ${ref.name} (id: ${ref.id}${origin})`
    })
    if (refs.length > 0) out.push(`Matched event: ${refs.join(' | ')}`)
    const values = scope.event.values.map((value) => value.name)
    if (values.length > 0) {
      const extra = values.length > 20 ? `, … (${values.length} total)` : ''
      out.push(`Event values: ${values.slice(0, 20).join(', ')}${extra}`)
    }
  }
  if (scope) {
    const variables = scope.variables
      .slice(0, MAX_VARIABLES)
      .map((variable) => `{${variable.name}}${variable.access === 'read' ? '' : ` (${variable.access})`}`)
    out.push(`Local variables: ${variables.length > 0 ? variables.join(', ') : 'none'}`)
    if (scope.variables.length > MAX_VARIABLES) out.push(`(… ${scope.variables.length - MAX_VARIABLES} more variables)`)
    if (scope.options.length > 0) {
      const options = scope.options.slice(0, 15).map((option) => `{@${option.name}} = ${option.value || '(empty)'}`)
      out.push(`Options: ${options.join(', ')}`)
    }
  }

  if (completions.length === 0) {
    out.push('Completions: none at this position.')
    return out.join('\n')
  }
  out.push(`Completions (showing ${Math.min(completions.length, MAX_COMPLETIONS)} of ${completions.length}):`)
  for (const item of completions.slice(0, MAX_COMPLETIONS)) {
    const kind = item.kind === undefined ? '' : ` [${COMPLETION_KINDS[item.kind] ?? item.kind}]`
    const detail = item.detail ? ` — ${item.detail.replace(/\s+/g, ' ').trim()}` : ''
    out.push(`  ${item.label.slice(0, 120)}${kind}${detail}`)
  }
  return out.join('\n')
}

/** Hover Markdown'ını modele gidecek sade metne indirger. */
function plainText(hover: ToolHover): string {
  const contents = hover.contents
  const parts = Array.isArray(contents) ? contents : [contents]
  const text = parts.map((part) => (typeof part === 'string' ? part : part.value)).join('\n')
  return text
    .replace(/```[\w-]*\n?/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/ {2}\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_HOVER_CHARS)
}
