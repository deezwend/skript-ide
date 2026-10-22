import { realpath } from 'node:fs/promises'
import { defineTool, ToolError, type ToolDiagnostic } from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { fileUri, isScript, requireLanguageService, syncWorkspace } from './shared'

const MAX_DIAGNOSTICS = 200
const SEVERITIES: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/** `path:line:column: severity: message [code]`; düzenleme geri bildirimi de aynı biçimi kullanır. */
export function formatDiagnostic(path: string, diagnostic: ToolDiagnostic): string {
  const { line, character } = diagnostic.range.start
  const severity = SEVERITIES[diagnostic.severity ?? 1] ?? 'error'
  const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`
  const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value
  return `${path}:${line + 1}:${character + 1}: ${severity}: ${message.replace(/\s*\n\s*/g, ' ')}${code}`
}

export const getDiagnosticsTool = defineTool<{ path?: string }>({
  name: 'get_diagnostics',
  description:
    "Check Skript files with the IDE's static analyzer (the same errors and warnings shown in the Problems panel), " +
    "using the project's Skript version and addons. Returns \"path:line:column: severity: message [code]\" lines. " +
    'Edits of .sk files already report the problems they introduce; use this for a full check of one file or the whole project. ' +
    'It reads files from disk, so unsaved editor changes are not included. ' +
    'It does not run the script; use validate_on_server for that.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root. Omit to check every .sk file.' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path }, ctx) {
    const service = requireLanguageService(ctx)
    if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
    const root = await realpath(ctx.projectRoot)

    let targets: { path: string; file: string }[]
    if (path !== undefined) {
      const file = await resolveInProject(ctx, path)
      if (!isScript(file)) throw new ToolError(`${path} is not a .sk file.`)
      await syncWorkspace(service, root)
      targets = [{ path: displayPath(root, file), file }]
    } else {
      targets = await syncWorkspace(service, root)
      if (targets.length === 0) return 'No .sk files in the project.'
    }

    const lines: string[] = []
    let errors = 0
    let warnings = 0
    for (const target of targets) {
      if (ctx.signal.aborted) throw new ToolError('Cancelled.')
      for (const diagnostic of await service.getDiagnostics(fileUri(target.file))) {
        if ((diagnostic.severity ?? 1) === 1) errors++
        else if (diagnostic.severity === 2) warnings++
        lines.push(formatDiagnostic(target.path, diagnostic))
      }
    }

    const scope = targets.length === 1 ? targets[0].path : `${targets.length} files`
    const header = `Skript ${service.skriptVersion}: ${errors} errors, ${warnings} warnings in ${scope}.`
    const warning = service.versionWarning ? `\n${service.versionWarning.message}` : ''
    if (lines.length === 0) return `${header}${warning}`
    const shown = lines.slice(0, MAX_DIAGNOSTICS).join('\n')
    const more = lines.length > MAX_DIAGNOSTICS ? `\n(… ${lines.length - MAX_DIAGNOSTICS} more)` : ''
    return `${header}${warning}\n${shown}${more}`
  }
})
