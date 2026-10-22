import { readFile, realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { STAGING_FOLDER, type SkriptDiagnostic } from '@skript-ide/runtime-validator'
import { defineTool, ToolError } from '../../tool'
import { displayPath, resolveInProject } from '../core/paths'
import { formatCapturedOutput, isRuntimeError, prepareCommands, requireEula, requireServer, throwIfAborted, untilAborted } from './server-shared'

interface TestScriptInput {
  path: string
  commands: string[]
  expect?: string[]
  forbid?: string[]
  timeout_seconds?: number
}

function diagnosticLine(shown: string, diagnostic: SkriptDiagnostic): string {
  const code = diagnostic.code ? `\n    ${diagnostic.code.trim()}` : ''
  return `${shown}:${diagnostic.line}: ${diagnostic.severity}: ${diagnostic.message}${code}`
}

export const testScriptTool = defineTool<TestScriptInput>({
  name: 'test_script',
  description:
    'Load a .sk file on the local headless Paper + Skript test server, run console commands, and compare the console ' +
    'output with expectations: every text in expect must appear, no text in forbid may appear. Use it to prove how a ' +
    'script actually behaves at runtime, for example that a command it defines prints the right message or changes ' +
    'state. The script is unloaded afterwards, so each call is self-contained. If the script fails to load, its ' +
    'diagnostics are returned and no commands are run. Skript runtime errors (exceptions, load/parse errors) make the ' +
    'test FAIL even when expect matches. The console is not a player, so ' +
    'player-only events such as on join cannot be tested; give the script a console-executable command instead.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A .sk file relative to the project root.' },
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: '1-20 console commands to run after the script loads, without the leading slash.'
      },
      expect: {
        type: 'array',
        items: { type: 'string' },
        description: 'Texts that must all appear in the console output (case-insensitive).'
      },
      forbid: {
        type: 'array',
        items: { type: 'string' },
        description: 'Texts that must not appear in the console output (case-insensitive), e.g. "error".'
      },
      timeout_seconds: { type: 'number', description: 'Maximum wait in seconds (default 15, at most 60).' }
    },
    required: ['path', 'commands'],
    additionalProperties: false
  },
  permission: 'exec',
  async preview({ path, commands }, ctx) {
    const count = Array.isArray(commands) ? commands.length : 0
    const version = ctx.server?.currentStatus.versions.skript
    return { summary: `Load ${path} on the local Skript${version ? ` ${version}` : ''} test server, run ${count} command${count === 1 ? '' : 's'} and check the output` }
  },
  async execute(input, ctx) {
    const server = requireServer(ctx)
    const file = await resolveInProject(ctx, input.path)
    if (!file.toLowerCase().endsWith('.sk')) throw new ToolError(`${input.path} is not a .sk file.`)
    await requireEula(server)
    const commands = prepareCommands(input.commands)
    const expectations = (input.expect ?? []).filter((text) => typeof text === 'string' && text.trim() !== '')
    const forbidden = (input.forbid ?? []).filter((text) => typeof text === 'string' && text.trim() !== '')
    const timeoutMs =
      typeof input.timeout_seconds === 'number' ? Math.min(60, Math.max(1, input.timeout_seconds)) * 1000 : undefined
    const content = await readFile(file, 'utf8')

    let validation
    try {
      throwIfAborted(ctx.signal)
      validation = await untilAborted(server.validate(file, basename(file), content), ctx.signal)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Validation failed: ${(error as Error).message}`)
    }

    const shown = displayPath(await realpath(ctx.projectRoot!), file)
    const status = server.currentStatus
    const version = `Skript ${status.versions.skript} (Minecraft ${status.versions.minecraft})`
    const loadErrors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (!validation.ok || loadErrors.length > 0) {
      const lines = validation.diagnostics.map((diagnostic) => diagnosticLine(shown, diagnostic))
      if (lines.length === 0) lines.push('Skript did not confirm a successful reload and reported no diagnostics.')
      return [`FAIL ${shown} on ${version}: the script did not load, so no commands were run.`, ...lines].join('\n')
    }

    let result
    try {
      throwIfAborted(ctx.signal)
      result = await untilAborted(server.runCommands(commands, { timeoutMs, signal: ctx.signal }), ctx.signal)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Could not run the commands: ${(error as Error).message}`)
    } finally {
      // Sonraki testler aynı komutu yeniden kaydetmesin diye betiği bırak
      void server.runCommands([`sk disable ${STAGING_FOLDER}/${validation.stagedName}`], { settleMs: 300, timeoutMs: 5000 }).catch(() => {})
    }

    const text = result.output.join('\n').toLowerCase()
    const missing = expectations.filter((needle) => !text.includes(needle.toLowerCase()))
    const found = forbidden.filter((needle) => text.includes(needle.toLowerCase()))
    const runtimeErrors = result.output.filter(isRuntimeError)
    const pass = missing.length === 0 && found.length === 0 && runtimeErrors.length === 0 && !result.timedOut

    const seconds = (result.durationMs / 1000).toFixed(1)
    const header =
      `${pass ? 'PASS' : 'FAIL'} ${shown} on ${version}: loaded and ran ${commands.length} ` +
      `command${commands.length === 1 ? '' : 's'} in ${seconds}s.`
    const sections: string[] = []
    if (result.timedOut) sections.push('The wait timed out; the output below may be incomplete and the commands may still be running.')
    if (missing.length > 0) {
      sections.push(['Unmet expectations:', ...missing.map((needle) => `- ${JSON.stringify(needle)} was not found in the output`)].join('\n'))
    }
    if (found.length > 0) {
      sections.push(['Forbidden text found:', ...found.map((needle) => `- ${JSON.stringify(needle)}`)].join('\n'))
    }
    if (runtimeErrors.length > 0) {
      sections.push(['Skript runtime errors:', ...runtimeErrors.slice(0, 20).map((line) => `- ${line}`)].join('\n'))
    }
    if (pass && expectations.length === 0 && forbidden.length === 0) {
      sections.push('No expect/forbid checks were given; PASS only means no runtime errors were seen.')
    }
    return [header, ...sections, '', 'Output:', formatCapturedOutput(result.output)].join('\n')
  }
})
