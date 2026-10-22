import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { displayPath, IGNORED_DIRS, resolveInProject } from './paths'

const MAX_RESULTS = 200
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LINE_LENGTH = 300

interface SearchInput {
  query: string
  regex?: boolean
  path?: string
  /** Yalnızca bu uzantılar, örn. `[".sk"]`. */
  extensions?: string[]
}

export const searchFilesTool = defineTool<SearchInput>({
  name: 'search_files',
  description:
    'Search file contents in the project. Returns "path:line: text" matches (case-insensitive). ' +
    `At most ${MAX_RESULTS} matches are returned.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for (a JavaScript regex if regex is true).' },
      regex: { type: 'boolean' },
      path: { type: 'string', description: 'Directory to search in, relative to the project root (default: root).' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Only files with these extensions, e.g. [".sk"].' }
    },
    required: ['query'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ query, regex = false, path = '.', extensions }, ctx) {
    let pattern: RegExp
    try {
      pattern = new RegExp(regex ? query : escapeRegExp(query), 'i')
    } catch (error) {
      throw new ToolError(`Invalid regex: ${(error as Error).message}`)
    }
    const root = await realpath(ctx.projectRoot!)
    const start = await resolveInProject(ctx, path)
    const wanted = extensions?.map((ext) => ext.toLowerCase())

    const matches: string[] = []
    for await (const file of walk(start, ctx)) {
      if (wanted && !wanted.some((ext) => file.toLowerCase().endsWith(ext))) continue
      if ((await stat(file)).size > MAX_FILE_BYTES) continue
      const lines = (await readFile(file, 'utf8')).split(/\r\n|\n|\r/)
      for (const [index, line] of lines.entries()) {
        if (!pattern.test(line)) continue
        matches.push(`${displayPath(root, file)}:${index + 1}: ${line.trim().slice(0, MAX_LINE_LENGTH)}`)
        if (matches.length >= MAX_RESULTS) return `${matches.join('\n')}\n(result limit reached)`
      }
    }
    return matches.length === 0 ? 'No matches.' : matches.join('\n')
  }
})

async function* walk(dir: string, ctx: ToolContext): AsyncGenerator<string> {
  ctx.signal.throwIfAborted()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Sembolik bağlar izlenmez: proje dışına çıkabilirler
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(full, ctx)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
