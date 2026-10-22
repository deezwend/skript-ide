import { readFile, writeFile } from 'node:fs/promises'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { resolveInProject } from './paths'

interface EditInput {
  path: string
  old_text: string
  new_text: string
}

/** Değişikliği hesaplar; hem önizleme hem uygulama aynı sonucu kullanır. */
async function computeEdit({ path, old_text, new_text }: EditInput, ctx: ToolContext) {
  if (old_text === '') throw new ToolError('old_text must not be empty.')
  const file = await resolveInProject(ctx, path)
  const before = await readFile(file, 'utf8')

  const first = before.indexOf(old_text)
  if (first === -1) throw new ToolError(`old_text was not found in ${path}.`)
  if (before.indexOf(old_text, first + 1) !== -1) {
    throw new ToolError(`old_text appears more than once in ${path}; include more surrounding lines.`)
  }
  const after = before.slice(0, first) + new_text + before.slice(first + old_text.length)
  return { file, before, after }
}

export const editFileTool = defineTool<EditInput>({
  name: 'edit_file',
  description:
    'Replace one exact, unique occurrence of old_text with new_text in an existing project file. ' +
    'Copy old_text exactly from read_file output (without the line-number prefix), including indentation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      old_text: { type: 'string' },
      new_text: { type: 'string' }
    },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before, after } = await computeEdit(input, ctx)
    return { summary: `Edit ${input.path}`, change: { path: input.path, before, after } }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosya değişmiş olabilir; yeniden hesapla
    const { file, after } = await computeEdit(input, ctx)
    await writeFile(file, after, 'utf8')
    return `Edited ${input.path}.`
  }
})
