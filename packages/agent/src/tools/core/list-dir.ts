import { readdir, realpath, stat } from 'node:fs/promises'
import { defineTool, ToolError } from '../../tool'
import { displayPath, IGNORED_DIRS, resolveInProject } from './paths'

export const listDirTool = defineTool<{ path?: string }>({
  name: 'list_dir',
  description: 'List the entries of a project directory. Directories end with "/".',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the project root (default: the root).' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ path = '.' }, ctx) {
    const dir = await resolveInProject(ctx, path)
    if (!(await stat(dir)).isDirectory()) throw new ToolError(`${path} is not a directory.`)
    const root = await realpath(ctx.projectRoot!)

    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))

    const header = `${displayPath(root, dir)}/`
    return entries.length === 0 ? `${header} (empty)` : [header, ...entries.map((e) => `  ${e}`)].join('\n')
  }
})
