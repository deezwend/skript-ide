import { realpath, stat } from 'node:fs/promises'
import { defineTool, ToolError } from '../../tool'
import { displayPath, globToRegExp, resolveInProject, walkFiles } from './paths'

const MAX_RESULTS = 500

export const findFilesTool = defineTool<{ pattern: string; path?: string }>({
  name: 'find_files',
  description:
    'Find project files by name with a glob pattern (case-insensitive). Returns matching paths relative to the project root, sorted. ' +
    'A pattern without "/" matches file names at any depth ("*.sk", "shop*"); with "/" it matches the whole path ("scripts/**/*.sk"). ' +
    '"**" crosses folders, "*" and "?" do not; "{a,b}" and "[abc]" are supported. ' +
    `At most ${MAX_RESULTS} paths are returned.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "*.sk", "**/shop*.sk", "lib/*.{sk,yml}".' },
      path: { type: 'string', description: 'Only search inside this directory, relative to the project root (default: root).' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ pattern, path = '.' }, ctx) {
    if (pattern.trim() === '') throw new ToolError('pattern must not be empty.')
    const root = await realpath(ctx.projectRoot!)
    const start = await resolveInProject(ctx, path)
    if (!(await stat(start)).isDirectory()) throw new ToolError(`${path} is not a directory.`)
    const matcher = globToRegExp(pattern)
    // Desen `path`e göre değil köke göre yazılabilir; ikisinden biri eşleşmesi yeter
    const prefix = displayPath(root, start)

    const found: string[] = []
    for await (const file of walkFiles(start, ctx)) {
      const shown = displayPath(root, file)
      const inside = prefix === '.' ? shown : shown.slice(prefix.length + 1)
      if (matcher.test(inside) || matcher.test(shown)) found.push(shown)
    }
    if (found.length === 0) return 'No files found.'
    found.sort((a, b) => a.localeCompare(b))
    const shown = found.slice(0, MAX_RESULTS).join('\n')
    return found.length > MAX_RESULTS ? `${shown}\n(… ${found.length - MAX_RESULTS} more)` : shown
  }
})
