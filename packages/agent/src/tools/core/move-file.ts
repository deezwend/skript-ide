import { mkdir, readFile, realpath, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool, ToolError, type FileChange, type ToolContext } from '../../tool'
import { resolveInProject, resolveTargetInProject } from './paths'

const MAX_BYTES = 1024 * 1024

interface MoveInput {
  from: string
  to: string
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function computeMove({ from, to }: MoveInput, ctx: ToolContext) {
  const source = await resolveInProject(ctx, from)
  const info = await stat(source)
  if (info.isDirectory()) throw new ToolError(`${from} is a directory; only files can be moved.`)
  if (info.size > MAX_BYTES) throw new ToolError(`${from} is too large to move with this tool (${info.size} bytes).`)
  const target = await resolveTargetInProject(ctx, to)
  // Harf büyüklüğü duyarsız dosya sistemlerinde yalnızca büyüklüğü değiştiren taşımada hedef kaynağın kendisidir
  if ((await exists(target)) && (await realpath(target)) !== source) {
    throw new ToolError(`${to} already exists; delete it first or pick another name.`)
  }
  return { source, target, content: await readFile(source, 'utf8') }
}

/** Taşıma, eski yolun silinmesi ve yeni yolun oluşturulması olarak bildirilir; geri alma ikisini de geri çevirir. */
function moveChanges({ from, to }: MoveInput, content: string): FileChange[] {
  return [
    { path: from, before: content, after: '', deleted: true },
    { path: to, before: '', after: content, created: true, movedFrom: from }
  ]
}

export const moveFileTool = defineTool<MoveInput>({
  name: 'move_file',
  description:
    'Move or rename a file inside the project. Missing parent folders are created. Fails if the target already exists. ' +
    'Only files can be moved, not folders. Skript loads scripts by file name, so tell the user when a rename changes which scripts load ' +
    '(for example names starting with "-" are disabled).',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Current path relative to the project root.' },
      to: { type: 'string', description: 'New path relative to the project root.' }
    },
    required: ['from', 'to'],
    additionalProperties: false
  },
  permission: 'write',
  async preview(input, ctx) {
    const { content } = await computeMove(input, ctx)
    return { summary: `Move ${input.from} → ${input.to}`, changes: moveChanges(input, content) }
  },
  async execute(input, ctx) {
    const { source, target, content } = await computeMove(input, ctx)
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    ctx.onFilesChanged?.(moveChanges(input, content))
    return `Moved ${input.from} → ${input.to}.`
  }
})
