import { readFile, realpath } from 'node:fs/promises'
import {
  defineTool,
  ToolError,
  type ToolExplainedMatch,
  type ToolExplainedPlaceholder,
  type ToolLineExplanation
} from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { fileUri, isScript, requireLanguageService, syncWorkspace } from './shared'

interface ExplainInput {
  path?: string
  line?: number
  code?: string
  context?: string
}

const MAX_MATCHES = 3
const MAX_PLACEHOLDERS = 12
const MAX_NESTED = 2

export const explainLineTool = defineTool<ExplainInput>({
  name: 'explain_line',
  description:
    'Explain how one Skript line is parsed before you change it: which syntax entry it matches (kind, name, id, addon), ' +
    'the matched pattern, and what each %placeholder% resolved to (including nested expressions). ' +
    'When the line matches nothing, lists the closest patterns and what is missing or misspelled. ' +
    'Pass path and line for a line in a .sk file, or code (with an optional context such as "on join:") for a line ' +
    'that is not in a file yet. Use it instead of guessing syntax and retrying after errors.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root. Use together with line.' },
      line: { type: 'integer', description: '1-based line number in path.' },
      code: { type: 'string', description: 'A single line of Skript to explain instead of reading a file.' },
      context: {
        type: 'string',
        description: 'Header the code would sit under, e.g. "on join:" or "if player is op:". Only for code.'
      }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    const service = requireLanguageService(ctx)
    if (input.path === undefined && input.code === undefined) throw new ToolError('Pass either path and line, or code.')
    if (input.path !== undefined && input.code !== undefined) throw new ToolError('Pass either path and line, or code, not both.')

    if (input.code !== undefined) {
      if (!input.code.trim()) throw new ToolError('code must not be empty.')
      const explanation = await service.explainCode(input.code, input.context)
      const header = `Code${input.context ? ` (context "${input.context.trim()}")` : ''}: ${explanation.text.trim()}`
      return formatExplanation(header, explanation, service.skriptVersion)
    }

    if (input.line === undefined) throw new ToolError('line is required when path is given.')
    if (!Number.isInteger(input.line) || input.line < 1) throw new ToolError('line must be a positive integer (1-based).')
    if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
    const line = input.line
    const root = await realpath(ctx.projectRoot)
    const file = await resolveInProject(ctx, input.path!)
    if (!isScript(file)) throw new ToolError(`${input.path} is not a .sk file.`)
    const text = await readFile(file, 'utf8')
    if (line > text.split(/\r\n|\r|\n/).length) throw new ToolError(`${input.path} has fewer than ${line} lines.`)

    await syncWorkspace(service, root)
    const explanation = await service.explainLine(fileUri(file), line - 1)
    if (!explanation) throw new ToolError(`Could not explain line ${line} of ${input.path}.`)
    return formatExplanation(`${displayPath(root, file)}:${line}`, explanation, service.skriptVersion)
  }
})

function formatExplanation(header: string, explanation: ToolLineExplanation, version: string): string {
  if (explanation.context === null) return `${header}\nNothing to match: the line is blank or a comment.`
  if (explanation.matches.length === 0) {
    const lines = [`${header}\nNo syntax matches this ${explanation.context} in Skript ${version}.`]
    if (explanation.candidates.length > 0) {
      lines.push('Closest patterns:')
      for (const candidate of explanation.candidates) {
        const origin = candidate.addon ? `, ${candidate.addon}` : ''
        lines.push(`  [${candidate.kind}] ${candidate.name} (id: ${candidate.id}${origin}) — ${candidate.reason}`)
        lines.push(`    pattern: ${candidate.pattern}`)
      }
    } else {
      lines.push('No close patterns found.')
    }
    if (explanation.otherKinds.length > 0) {
      const refs = explanation.otherKinds.map((ref) => `[${ref.kind}] ${ref.name} (id: ${ref.id})`).join(', ')
      lines.push(`Note: the line matches ${refs} instead, so it is in the wrong place.`)
    }
    return lines.join('\n')
  }

  const lines = [`${header}\nMatches (${explanation.matches.length}):`]
  for (const match of explanation.matches.slice(0, MAX_MATCHES)) {
    lines.push(matchHead(match))
    lines.push(`    pattern: ${match.pattern}`)
    for (const placeholder of match.placeholders.slice(0, MAX_PLACEHOLDERS)) {
      lines.push(placeholderLine(placeholder))
    }
    if (match.placeholders.length > MAX_PLACEHOLDERS) {
      lines.push(`    (… ${match.placeholders.length - MAX_PLACEHOLDERS} more placeholders)`)
    }
  }
  if (explanation.matches.length > MAX_MATCHES) {
    lines.push(`(… ${explanation.matches.length - MAX_MATCHES} other matches)`)
  }
  return lines.join('\n')
}

function matchHead(match: ToolExplainedMatch): string {
  const origin = match.addon ? `, ${match.addon}` : ''
  return `  [${match.kind}] ${match.name} (id: ${match.id}${origin}) — ${match.confidence}`
}

function placeholderLine(placeholder: ToolExplainedPlaceholder): string {
  const value = placeholder.text.trim() === '' ? '(empty)' : placeholder.text.trim()
  const flags = [
    placeholder.types.length > 0 ? placeholder.types.join('/') : '',
    placeholder.nullable ? 'optional' : '',
    placeholder.literalOnly ? 'literal only' : '',
    placeholder.changeable ? 'changeable' : '',
    placeholder.plural ? 'plural' : ''
  ].filter(Boolean)
  const details = flags.length > 0 ? ` (${flags.join(', ')})` : ''
  const nested = placeholder.expression?.slice(0, MAX_NESTED).map((item) => {
    const origin = item.addon ? `, ${item.addon}` : ''
    return `[${item.kind}] ${item.name} (id: ${item.id}${origin})`
  })
  const resolved = nested && nested.length > 0 ? ` → ${nested.join(' | ')}` : ''
  return `    ${value}${details}${resolved}`
}
