import { readFile, rm, stat } from 'node:fs/promises'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { resolveInProject } from './paths'

const MAX_BYTES = 1024 * 1024

/** Silinecek dosya ve içeriği; geri alma ve önizleme bu içerikle yapılır, bu yüzden yalnızca metin dosyaları silinir. */
async function computeDelete(path: string, ctx: ToolContext) {
  const file = await resolveInProject(ctx, path)
  const info = await stat(file)
  if (info.isDirectory()) throw new ToolError(`${path} is a directory; only files can be deleted.`)
  if (info.size > MAX_BYTES) throw new ToolError(`${path} is too large to delete with this tool (${info.size} bytes).`)
  return { file, before: await readFile(file, 'utf8') }
}

export const deleteFileTool = defineTool<{ path: string }>({
  name: 'delete_file',
  description:
    'Delete a file from the project. Only files can be deleted, not folders. ' +
    'Before deleting a .sk file, make sure nothing else uses its functions (find_references or search_files).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  permission: 'write',
  async preview({ path }, ctx) {
    const { before } = await computeDelete(path, ctx)
    return { summary: `Delete ${path}`, changes: [{ path, before, after: '', deleted: true }] }
  },
  async execute({ path }, ctx) {
    const { file, before } = await computeDelete(path, ctx)
    await rm(file)
    ctx.onFilesChanged?.([{ path, before, after: '', deleted: true }])
    return `Deleted ${path}.`
  }
})
