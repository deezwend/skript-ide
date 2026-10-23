/**
 * `remember` / `forget`: agent'ın konuşmalar arası hafızası. Notlar kullanıcının kodu değil, agent'ın
 * kendi kayıtlarıdır; `update_todos` gibi `read` izniyle onaysız çalışır, arayüz tool satırında gösterir.
 * Dosya biçimi ve modele nasıl gittiği `../memory.ts`'de.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { memoryEntries, normalizeMemoryEntry, PROJECT_MEMORY_FILE, type MemoryScope } from '../memory'
import { defineTool, ToolError, type ToolContext } from '../tool'

const HEADER = '# Skript IDE agent memory\n\nOne note per line. You can edit or delete notes here.\n\n'

const scopeSchema = {
  type: 'string' as const,
  enum: ['user', 'project'],
  description: '"user": about the person, applies to every project. "project": about this project only.'
}

function memoryFile(ctx: ToolContext, scope: MemoryScope): string {
  if (scope === 'project') {
    if (!ctx.projectRoot) throw new ToolError('No project folder is open; use scope "user".')
    return join(ctx.projectRoot, ...PROJECT_MEMORY_FILE.split('/'))
  }
  if (!ctx.userMemoryFile) throw new ToolError('User memory is not available here.')
  return ctx.userMemoryFile
}

async function readMemoryFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Notun satırını bulur; `match` tam not ya da notun içinde geçen benzersiz bir parçadır. */
function findEntryLine(lines: string[], match: string): number {
  const wanted = match.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!wanted) throw new ToolError('match is empty.')
  const entries = lines.map((line) => memoryEntries(line)[0]?.toLowerCase())
  const exact = entries.indexOf(wanted)
  if (exact >= 0) return exact
  const candidates = entries.flatMap((entry, index) => (entry?.includes(wanted) ? [index] : []))
  if (candidates.length === 0) throw new ToolError(`No note matches "${match}".`)
  if (candidates.length > 1) {
    const listed = candidates.map((index) => `- ${memoryEntries(lines[index])[0]}`).join('\n')
    throw new ToolError(`"${match}" matches ${candidates.length} notes; give a longer part of the one you mean:\n${listed}`)
  }
  return candidates[0]
}

async function save(file: string, lines: string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const text = lines.join('\n').replace(/\n*$/, '\n')
  await writeFile(file, text, 'utf8')
}

export const rememberTool = defineTool<{ text: string; scope: MemoryScope; replaces?: string }>({
  name: 'remember',
  description:
    'Save a short note to your long-term memory so you still know it in future conversations. ' +
    'Pass replaces with (part of) an existing note to update it instead of adding a new one.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The note: one short, self-contained sentence.' },
      scope: scopeSchema,
      replaces: { type: 'string', description: 'An existing note (or a unique part of it) that this note replaces.' }
    },
    required: ['text', 'scope'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ text, scope, replaces }, ctx) {
    const normalized = normalizeMemoryEntry(text)
    if ('error' in normalized) throw new ToolError(normalized.error)
    const file = memoryFile(ctx, scope)
    const current = await readMemoryFile(file)
    const lines = current ? current.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : HEADER.trimEnd().split('\n')
    const line = `- ${normalized.entry}`
    if (replaces !== undefined) {
      lines[findEntryLine(lines, replaces)] = line
    } else {
      if (memoryEntries(lines.join('\n')).some((entry) => entry.toLowerCase() === normalized.entry.toLowerCase())) {
        return 'This note is already in memory.'
      }
      lines.push(line)
    }
    await save(file, lines)
    return `${replaces !== undefined ? 'Updated' : 'Saved'} in ${scope} memory: ${normalized.entry}`
  }
})

export const forgetTool = defineTool<{ match: string; scope: MemoryScope }>({
  name: 'forget',
  description: 'Remove a note from your long-term memory.',
  inputSchema: {
    type: 'object',
    properties: {
      match: { type: 'string', description: 'The note to remove, or a unique part of it.' },
      scope: scopeSchema
    },
    required: ['match', 'scope'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ match, scope }, ctx) {
    const file = memoryFile(ctx, scope)
    const lines = (await readMemoryFile(file)).replace(/\r\n/g, '\n').split('\n')
    const index = findEntryLine(lines, match)
    const [removed] = memoryEntries(lines[index])
    lines.splice(index, 1)
    await save(file, lines)
    return `Removed from ${scope} memory: ${removed}`
  }
})

export const memoryTools = [rememberTool, forgetTool]
