import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { listProjectFiles } from '../../attachments'
import { defineTool, ToolError, type FileChange, type ToolContext } from '../../tool'
import { isInside } from '../core/paths'
import { isScript } from './shared'

const MAX_CHECKPOINTS = 20
const MAX_FILE_BYTES = 1024 * 1024
const NAME = /^[\w .-]{1,40}$/

interface Checkpoint {
  name: string
  createdAt: number
  /** Köke göre yol → içerik. */
  files: Map<string, string>
}

/** Proje kökü → adına göre checkpoint'ler; yalnızca bu oturum boyunca bellekte tutulur. */
const store = new Map<string, Map<string, Checkpoint>>()

async function projectCheckpoints(ctx: ToolContext): Promise<{ root: string; checkpoints: Map<string, Checkpoint> }> {
  if (!ctx.projectRoot) throw new ToolError('No project folder is open.')
  const root = await realpath(ctx.projectRoot)
  if (!store.has(root)) store.set(root, new Map())
  return { root, checkpoints: store.get(root)! }
}

async function snapshot(root: string, all: boolean): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const path of await listProjectFiles(root)) {
    if (!all && !isScript(path)) continue
    const file = resolve(root, path)
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue
      files.set(path, await readFile(file, 'utf8'))
    } catch {
      // Listelendikten sonra silinmiş olabilir
    }
  }
  return files
}

function age(createdAt: number): string {
  const seconds = Math.round((Date.now() - createdAt) / 1000)
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`
}

interface CreateInput {
  name: string
  all_files?: boolean
}

export const createCheckpointTool = defineTool<CreateInput>({
  name: 'create_checkpoint',
  description:
    'Save a named snapshot of the project\'s .sk files (or all text files with all_files) before a risky change, ' +
    'such as a large refactor or a migration. restore_checkpoint brings the files back to this state. Snapshots live ' +
    'in memory for this session only and are not written to the project. Reusing a name replaces that checkpoint; ' +
    'list_checkpoints shows the saved ones.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, e.g. "before-refactor".' },
      all_files: { type: 'boolean', description: 'Include every project file under 1 MB, not only .sk files.' }
    },
    required: ['name'],
    additionalProperties: false
  },
  permission: 'read',
  async execute(input, ctx) {
    const name = input.name.trim()
    if (!NAME.test(name)) throw new ToolError('name may only contain letters, digits, spaces, ".", "-" and "_" (at most 40).')
    const { root, checkpoints } = await projectCheckpoints(ctx)
    const files = await snapshot(root, input.all_files ?? false)
    checkpoints.delete(name)
    checkpoints.set(name, { name, createdAt: Date.now(), files })
    while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!)
    return `Checkpoint "${name}" saved: ${files.size} file${files.size === 1 ? '' : 's'}.`
  }
})

export const listCheckpointsTool = defineTool<Record<string, never>>({
  name: 'list_checkpoints',
  description: 'List the checkpoints saved in this session with create_checkpoint, and how many files differ from each now.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'read',
  async execute(_input, ctx) {
    const { root, checkpoints } = await projectCheckpoints(ctx)
    if (checkpoints.size === 0) return 'No checkpoints in this session.'
    const out: string[] = []
    for (const checkpoint of checkpoints.values()) {
      const changes = await restoreChanges(root, checkpoint)
      out.push(`- "${checkpoint.name}" (${age(checkpoint.createdAt)}): ${checkpoint.files.size} files; ${changes.length === 0 ? 'unchanged since' : `${changes.length} differ now`}`)
    }
    return out.join('\n')
  }
})

/** Checkpoint'e dönmek için gereken değişiklikler; sonradan oluşturulan dosyalara dokunulmaz. */
async function restoreChanges(root: string, checkpoint: Checkpoint): Promise<FileChange[]> {
  const changes: FileChange[] = []
  for (const [path, content] of checkpoint.files) {
    const file = resolve(root, path)
    if (!isInside(root, file)) continue
    let current: string | null = null
    try {
      current = await readFile(file, 'utf8')
    } catch {
      current = null
    }
    if (current === content) continue
    changes.push(current === null ? { path, before: '', after: content, created: true } : { path, before: current, after: content })
  }
  return changes
}

async function newFiles(root: string, checkpoint: Checkpoint, all: boolean): Promise<string[]> {
  return (await listProjectFiles(root)).filter((path) => (all || isScript(path)) && !checkpoint.files.has(path))
}

async function computeRestore(name: string, ctx: ToolContext) {
  const { root, checkpoints } = await projectCheckpoints(ctx)
  const checkpoint = checkpoints.get(name.trim())
  if (!checkpoint) {
    const names = [...checkpoints.keys()]
    throw new ToolError(`No checkpoint named "${name}".${names.length ? ` Existing: ${names.map((n) => `"${n}"`).join(', ')}.` : ''}`)
  }
  const changes = await restoreChanges(root, checkpoint)
  const all = [...checkpoint.files.keys()].some((path) => !isScript(path))
  return { root, checkpoint, changes, added: await newFiles(root, checkpoint, all) }
}

export const restoreCheckpointTool = defineTool<{ name: string }>({
  name: 'restore_checkpoint',
  description:
    'Restore the files saved by create_checkpoint: changed files get their saved content back and deleted ones are ' +
    'recreated (the user approves the diff). Files created after the checkpoint are left alone and listed, so you can ' +
    'delete them with delete_file if needed.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The checkpoint name.' } },
    required: ['name'],
    additionalProperties: false
  },
  permission: 'write',
  async preview({ name }, ctx) {
    const { changes } = await computeRestore(name, ctx)
    if (changes.length === 0) throw new ToolError(`The files already match checkpoint "${name}".`)
    return { summary: `Restore checkpoint "${name}" (${changes.length} file${changes.length === 1 ? '' : 's'})`, changes }
  },
  async execute({ name }, ctx) {
    const { root, changes, added } = await computeRestore(name, ctx)
    for (const change of changes) {
      const file = resolve(root, change.path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, change.after, 'utf8')
    }
    ctx.onFilesChanged?.(changes)
    const lines = [changes.length ? `Restored ${changes.length} file${changes.length === 1 ? '' : 's'}: ${changes.map((c) => c.path).join(', ')}.` : 'Nothing to restore.']
    if (added.length) lines.push(`Created after the checkpoint (left as is): ${added.join(', ')}`)
    return lines.join('\n')
  }
})

export const checkpointTools = [createCheckpointTool, listCheckpointsTool, restoreCheckpointTool]
