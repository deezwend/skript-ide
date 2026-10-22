import { defineTool, ToolError } from '../../tool'
import { escapeRegExp } from '../core/paths'
import { formatCapturedOutput, prepareCommands, requireEula, requireServer, throwIfAborted, untilAborted } from './server-shared'

interface RunServerCommandInput {
  commands: string[]
  wait_for?: string
  timeout_seconds?: number
}

export const runServerCommandTool = defineTool<RunServerCommandInput>({
  name: 'run_server_command',
  description:
    'Run console commands on the local headless Paper + Skript test server and return the console output produced while ' +
    'they run. Commands are written without the leading slash and run in order. Use it to exercise commands defined by ' +
    'a loaded script (load one first with validate_on_server or test_script), to run Skript subcommands such as ' +
    '"sk reload", and to see what a script prints or changes at runtime. The console is not a player: ' +
    'player-only events (on join, on break, ...) do not fire, and Skript effect commands starting with "!" work only for ' +
    'players, so they are unavailable here. To trigger logic from the console, the script should define a command ' +
    'executable by the console or do its work on load. Commands that stop or restart the server, Bukkit\'s reload ' +
    'command, operator status, the whitelist or bans are rejected (Skript\'s own "sk reload" is allowed). Set wait_for ' +
    'to stop as soon as a console line contains that text.',
  inputSchema: {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: '1-20 console commands, without the leading slash.'
      },
      wait_for: { type: 'string', description: 'Stop waiting as soon as a console line contains this text (case-insensitive).' },
      timeout_seconds: { type: 'number', description: 'Maximum wait in seconds (default 15, at most 60).' }
    },
    required: ['commands'],
    additionalProperties: false
  },
  permission: 'exec',
  async preview({ commands }, ctx) {
    const shown = (Array.isArray(commands) ? commands : [])
      .map((command) => `/${String(command).replace(/^\/+/, '').trim()}`)
      .join(', ')
    const summary = `Run on the local test server: ${shown.length > 200 ? `${shown.slice(0, 197)}...` : shown}`
    const version = ctx.server?.currentStatus.versions.skript
    return { summary: version ? `${summary} (Skript ${version})` : summary }
  },
  async execute(input, ctx) {
    const server = requireServer(ctx)
    await requireEula(server)
    const commands = prepareCommands(input.commands)
    const waitFor = input.wait_for?.trim()
    const until = waitFor ? new RegExp(escapeRegExp(waitFor), 'i') : undefined
    const timeoutMs =
      typeof input.timeout_seconds === 'number' ? Math.min(60, Math.max(1, input.timeout_seconds)) * 1000 : undefined

    let result
    try {
      throwIfAborted(ctx.signal)
      result = await untilAborted(server.runCommands(commands, { until, timeoutMs, signal: ctx.signal }), ctx.signal)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Could not run the commands: ${(error as Error).message}`)
    }

    const status = server.currentStatus
    const seconds = (result.durationMs / 1000).toFixed(1)
    const header =
      `Ran ${commands.length} command${commands.length === 1 ? '' : 's'} on the local test server ` +
      `(Skript ${status.versions.skript}, Minecraft ${status.versions.minecraft}) in ${seconds}s.`
    const notes: string[] = []
    if (result.timedOut) {
      notes.push('The wait timed out; what is shown below may be incomplete and the commands may still be running.')
    } else if (!result.acknowledged) {
      notes.push('The server did not confirm that the commands finished; what is shown below may be incomplete.')
    }
    if (waitFor && !result.matchedUntil) notes.push(`The output never contained ${JSON.stringify(waitFor)}.`)
    return [header, ...notes, '', 'Output:', formatCapturedOutput(result.output)].join('\n')
  }
})
