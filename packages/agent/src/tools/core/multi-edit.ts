import { readFile, writeFile } from 'node:fs/promises'
import { defineTool, ToolError, type ToolContext } from '../../tool'
import { scriptFeedback } from '../skript/edit-feedback'
import { applyTextEdit, EDIT_PROPERTIES, type TextEdit } from './edit-file'
import { resolveInProject } from './paths'

const MAX_EDITS = 50

interface MultiEditInput {
  path: string
  edits: TextEdit[]
}

/** Düzenlemeleri sırayla uygular; biri bile başarısız olursa hiçbiri yazılmaz. */
async function computeMultiEdit({ path, edits }: MultiEditInput, ctx: ToolContext) {
  if (edits.length === 0) throw new ToolError('edits must not be empty.')
  if (edits.length > MAX_EDITS) throw new ToolError(`At most ${MAX_EDITS} edits can be applied at once.`)
  const file = await resolveInProject(ctx, path)
  const before = await readFile(file, 'utf8')
  let after = before
  let count = 0
  for (const [index, edit] of edits.entries()) {
    // Boş old_text yalnızca boş dosyanın ilk düzenlemesi olabilir
    if (edit.old_text === '' && index > 0) throw new ToolError(`edits[${index}]: old_text must not be empty.`)
    try {
      const result = applyTextEdit(after, edit, path)
      after = result.text
      count += result.count
    } catch (error) {
      if (error instanceof ToolError) {
        throw new ToolError(`edits[${index}]: ${error.message} No edits were applied.`)
      }
      throw error
    }
  }
  return { file, before, after, count }
}

export const multiEditTool = defineTool<MultiEditInput>({
  name: 'multi_edit',
  description:
    'Make several edits to one existing file in a single step (the user approves them together). ' +
    'Edits are applied in order, each to the result of the previous ones, so later old_text must match the text after earlier edits. ' +
    'Each edit works like edit_file (exact old_text, optional line or replace_all). ' +
    'If any edit fails, none are applied. Prefer this over several edit_file calls on the same file. ' +
    'For .sk files the result also lists the errors and warnings these edits introduced, with quick fixes when available.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root.' },
      edits: {
        type: 'array',
        description: `1-${MAX_EDITS} edits, applied in order.`,
        items: {
          type: 'object',
          properties: EDIT_PROPERTIES,
          required: ['old_text', 'new_text'],
          additionalProperties: false
        }
      }
    },
    required: ['path', 'edits'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { before, after } = await computeMultiEdit(input, ctx)
    return {
      summary: `Edit ${input.path} (${input.edits.length} ${input.edits.length === 1 ? 'edit' : 'edits'})`,
      changes: [{ path: input.path, before, after }]
    }
  },
  async execute(input, ctx) {
    // Onay beklenirken dosya değişmiş olabilir; yeniden hesapla
    const { file, before, after, count } = await computeMultiEdit(input, ctx)
    await writeFile(file, after, 'utf8')
    ctx.onFilesChanged?.([{ path: input.path, before, after }])
    const summary = `Edited ${input.path} (${count} ${count === 1 ? 'replacement' : 'replacements'}).`
    return `${summary}${await scriptFeedback(ctx, [{ path: input.path, file, before, after }])}`
  }
})
