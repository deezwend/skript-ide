import { readFile, stat } from 'node:fs/promises'
import { defineTool, ToolError } from '../../tool'
import { resolveInProject } from './paths'

const MAX_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 2000

export const readFileTool = defineTool<{ path: string; offset?: number; limit?: number }>({
  name: 'read_file',
  description:
    'Read a text file from the project. Returns lines prefixed with their 1-based line number and a tab. ' +
    `Use offset/limit to read part of a large file (default: first ${DEFAULT_LIMIT} lines).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      offset: { type: 'integer', description: '1-based line to start from.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path, offset = 1, limit = DEFAULT_LIMIT }, ctx) {
    const file = await resolveInProject(ctx, path)
    const info = await stat(file)
    if (info.isDirectory()) throw new ToolError(`${path} is a directory; use list_dir.`)
    if (info.size > MAX_BYTES) throw new ToolError(`${path} is too large (${info.size} bytes).`)

    const lines = (await readFile(file, 'utf8')).split(/\r\n|\n|\r/)
    const start = Math.max(1, offset)
    const end = Math.min(lines.length, start - 1 + Math.max(1, limit))
    if (start > lines.length) return `(file has ${lines.length} lines)`

    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}\t${line}`)
      .join('\n')
    return end < lines.length ? `${body}\n(… ${lines.length - end} more lines)` : body
  }
})
