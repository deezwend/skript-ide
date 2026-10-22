import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool, ToolError, type ToolMigrationItem, type ToolMigrationReport } from '../../tool'
import { requireLanguageService, syncWorkspace } from './shared'

const MAX_ITEMS = 40

interface MigrationInput {
  from: string
  to?: string
  path?: string
}

function filePath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

function displayFile(uri: string, root: string | null): string {
  const file = filePath(uri)
  if (!file) return uri
  if (root) {
    const rel = relative(root, file)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  }
  return file.split(sep).join('/')
}

function sameFile(uri: string, wanted: string, root: string | null): boolean {
  const file = filePath(uri)
  if (!file) return uri === wanted
  if (isAbsolute(wanted)) return resolve(wanted) === resolve(file)
  const relativePath = wanted.replace(/\\/g, '/').replace(/^\.\//, '')
  const display = displayFile(uri, root)
  return display === relativePath || display.endsWith(`/${relativePath}`)
}

function statusText(item: ToolMigrationItem, to: string): string {
  const name = item.entry ? `"${item.entry.name}"` : 'This line'
  if (item.status === 'removed') return `${name} was removed in Skript ${to}`
  if (item.status === 'changed') {
    const now = item.target?.patterns[0]
    return `${name} changed in Skript ${to}${now ? `; it no longer matches (now: ${now})` : ''}`
  }
  return `${name} is only valid in Skript ${to}`
}

function formatReport(report: ToolMigrationReport, root: string | null, wanted?: string): string {
  const counts = `removed: ${report.counts.removed}, changed: ${report.counts.changed}, new: ${report.counts.new}`
  const title = `Skript ${report.from} → ${report.to} migration: ${counts} in ${report.files} files (${report.checkedLines} lines checked).`
  const scope = wanted ? ` Only ${wanted}.` : ''
  const shown = report.items.slice(0, MAX_ITEMS)
  if (shown.length === 0) {
    return `${title}${scope} No removed, changed or new syntax in these files.`
  }
  const lines = shown.map((item) => {
    const text = item.text.trim().replace(/\s+/g, ' ').slice(0, 160)
    return `- ${displayFile(item.uri, root)}:${item.line + 1}: ${statusText(item, report.to)} — ${text}`
  })
  const more = report.items.length > shown.length ? `\n(… ${report.items.length - shown.length} more)` : ''
  const fixable = shown.filter((item) => item.fix).length
  const hint = fixable
    ? `\n${fixable} of these lines have a suggested fix; the editor offers it as a quick fix.`
    : ''
  return `${title}${scope}\n${lines.join('\n')}${more}${hint}`
}

export const getMigrationNotesTool = defineTool<MigrationInput>({
  name: 'get_migration_notes',
  description:
    'List the syntax that was removed, changed or newly added between two Skript versions, checked line by line ' +
    'against the .sk files of the current project (read from disk). Use it before or during a Skript version upgrade ' +
    'to find code that no longer works instead of guessing. `to` defaults to the project version; pass `path` to ' +
    'limit the report to one file.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source Skript version, e.g. "2.12.2".' },
      to: { type: 'string', description: 'Target Skript version; defaults to the project version.' },
      path: { type: 'string', description: 'Only report this .sk file, relative to the project root.' }
    },
    required: ['from'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ from, to, path }, ctx) {
    const service = requireLanguageService(ctx)
    const target = (to ?? service.skriptVersion).trim()
    const source = from.trim()
    if (!source || !target) throw new ToolError('from and to must not be empty.')
    if (ctx.projectRoot) await syncWorkspace(service, await realpath(ctx.projectRoot))
    let report: ToolMigrationReport
    try {
      report = await service.getMigrationReport(source, target)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    const root = ctx.projectRoot ? await realpath(ctx.projectRoot) : null
    const items = path === undefined ? report.items : report.items.filter((item) => sameFile(item.uri, path, root))
    return formatReport({ ...report, items }, root, path)
  }
})
