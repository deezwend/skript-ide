import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { scriptFeedback } from '../skript/edit-feedback'
import { resolveTargetInProject } from './paths'

interface WriteInput {
  path: string
  content: string
}

/** Hedefin şu anki içeriği; dosya yoksa `null`. Klasörün üzerine yazılmaz. */
async function currentContent(file: string, path: string): Promise<string | null> {
  try {
    if ((await stat(file)).isDirectory()) throw new ToolError(`${path} is a directory.`)
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function computeWrite({ path }: WriteInput, ctx: ToolContext) {
  const file = await resolveTargetInProject(ctx, path)
  const before = await currentContent(file, path)
  return { file, before }
}

export const writeFileTool = defineTool<WriteInput>({
  name: 'write_file',
  description:
    'Create a new file in the project, or replace the whole content of an existing one. ' +
    'Missing parent folders are created. To change part of an existing file, use edit_file instead: ' +
    'only use write_file on an existing file when you are rewriting most of it, and read it first. ' +
    'For .sk files the result also lists the errors and warnings in the new content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      content: { type: 'string', description: 'The complete file content.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before } = await computeWrite(input, ctx)
    return {
      summary: before === null ? `Create ${input.path}` : `Overwrite ${input.path}`,
      changes: [{ path: input.path, before: before ?? '', after: input.content, created: before === null }]
    }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosya oluşmuş ya da silinmiş olabilir; yeniden bak
    const { file, before } = await computeWrite(input, ctx)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, input.content, 'utf8')
    ctx.onFilesChanged?.([{ path: input.path, before: before ?? '', after: input.content, created: before === null }])
    const lines = input.content === '' ? 0 : input.content.split(/\r\n|\r|\n/).length
    const summary = `${before === null ? 'Created' : 'Overwrote'} ${input.path} (${lines} lines).`
    return `${summary}${await scriptFeedback(ctx, [{ path: input.path, file, before: before ?? '', after: input.content }])}`
  }
})
