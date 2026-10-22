import { readFile, realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { isScript } from './shared'

/** İptal edilince bekleme bırakılır; sunucudaki doğrulama kendi zaman aşımıyla biter. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolError('Cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolError('Cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function requireServer(ctx: ToolContext): NonNullable<ToolContext['server']> {
  if (!ctx.server) throw new ToolError('The validation server is not available.')
  return ctx.server
}

export const validateOnServerTool = defineTool<{ path: string }>({
  name: 'validate_on_server',
  description:
    'Load a .sk file on the local headless Paper + Skript test server (the project\'s Skript version and addons) ' +
    'with `sk reload` and return the errors and warnings Skript itself reports. This is the most reliable check, ' +
    'but slower than get_diagnostics (the server may need to start first). It reads the file from disk.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'A .sk file relative to the project root.' } },
    required: ['path'],
    additionalProperties: false
  },
  permission: 'exec',
  async preview({ path }, ctx) {
    const version = ctx.server?.currentStatus.versions.skript
    return { summary: `Load ${path} on the local Skript${version ? ` ${version}` : ''} test server` }
  },
  async execute({ path }, ctx) {
    const server = requireServer(ctx)
    const file = await resolveInProject(ctx, path)
    if (!isScript(file)) throw new ToolError(`${path} is not a .sk file.`)
    if (!(await server.isEulaAccepted())) {
      throw new ToolError('The Minecraft EULA has not been accepted, so the test server cannot start. Ask the user to accept it in the Server panel.')
    }
    const content = await readFile(file, 'utf8')
    let result
    try {
      result = await untilAborted(server.validate(file, basename(file), content), ctx.signal)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Validation failed: ${(error as Error).message}`)
    }

    const shown = displayPath(await realpath(ctx.projectRoot!), file)
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    const warnings = result.diagnostics.length - errors
    const status = server.currentStatus
    const header =
      `${result.ok ? 'Loaded' : 'Failed to load'} ${shown} on Skript ${status.versions.skript} ` +
      `(Minecraft ${status.versions.minecraft}): ${errors} errors, ${warnings} warnings, ${(result.durationMs / 1000).toFixed(1)}s.`
    const lines = result.diagnostics.map((diagnostic) => {
      const code = diagnostic.code ? `\n    ${diagnostic.code.trim()}` : ''
      return `${shown}:${diagnostic.line}: ${diagnostic.severity}: ${diagnostic.message}${code}`
    })
    // Yüklenemeyen addon'un syntax'ı sunucuda da tanınmaz; hatanın nedeni bu olabilir
    for (const addon of status.addons ?? []) {
      if (addon.state === 'failed' || addon.state === 'skipped') {
        lines.push(`Note: addon ${addon.name} ${addon.version} is ${addon.state} on the server${addon.message ? ` (${addon.message})` : ''}.`)
      }
    }
    return [header, ...lines].join('\n')
  }
})
