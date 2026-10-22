import { defineTool } from '../../tool'
import { requireServer } from './server-shared'

interface GetServerLogInput {
  lines?: number
  filter?: string
}

export const getServerLogTool = defineTool<GetServerLogInput>({
  name: 'get_server_log',
  description:
    'Read the most recent console lines of the local headless Paper + Skript test server, optionally filtered by text. ' +
    'Use it to inspect what happened at runtime, for example why a command failed or what a script logged, when the ' +
    'output was not captured by run_server_command or test_script. It does not start the server.',
  inputSchema: {
    type: 'object',
    properties: {
      lines: { type: 'integer', description: 'How many lines to return (default 80, at most 400).' },
      filter: { type: 'string', description: 'Only return lines containing this text (case-insensitive).' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ lines, filter }, ctx) {
    const server = requireServer(ctx)
    const count = Math.min(400, Math.max(1, Math.floor(lines ?? 80)))
    const status = server.currentStatus
    const all = server.readLog(2000)
    if (all.length === 0) {
      return status.state === 'stopped'
        ? 'The local test server is not running and has produced no console output yet. It starts when a script is validated or a command is run.'
        : `The local test server has produced no console output yet (state: ${status.state}).`
    }
    const needle = filter?.trim()
    const selected = (needle ? all.filter((line) => line.toLowerCase().includes(needle.toLowerCase())) : all).slice(-count)
    if (selected.length === 0) return `No console lines on the local test server match ${JSON.stringify(needle)}.`
    const header =
      `Last ${selected.length} console line${selected.length === 1 ? '' : 's'} from the local test server ` +
      `(state: ${status.state})${needle ? ` matching ${JSON.stringify(needle)}` : ''}:`
    return [header, ...selected].join('\n')
  }
})
