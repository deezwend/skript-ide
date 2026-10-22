import { readFile, realpath, stat } from 'node:fs/promises'
import { defineTool, ToolError } from '../../tool'
import { displayPath, escapeRegExp, globToRegExp, resolveInProject, walkFiles } from './paths'

const MAX_RESULTS = 200
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LINE_LENGTH = 300
const MAX_CONTEXT = 10

interface SearchInput {
  query: string
  regex?: boolean
  case_sensitive?: boolean
  path?: string
  /** Yalnızca bu uzantılar, örn. `[".sk"]`. */
  extensions?: string[]
  /** Yalnızca köke göre yolu bu glob'la eşleşen dosyalar. */
  glob?: string
  /** Her eşleşmenin öncesinde ve sonrasında gösterilecek satır sayısı. */
  context_lines?: number
  /** `files`: yalnızca eşleşen dosyaların yolları ve eşleşme sayıları. */
  output?: 'content' | 'files'
}

export const searchFilesTool = defineTool<SearchInput>({
  name: 'search_files',
  description:
    'Search file contents in the project. Returns "path:line: text" matches (case-insensitive unless case_sensitive is true). ' +
    'With context_lines, surrounding lines are shown as "path-line- text" (indentation kept) and separate blocks are divided by "--". ' +
    'With output "files", returns only the matching file paths and how many lines matched in each. ' +
    `At most ${MAX_RESULTS} matches (or files) are returned.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for (a JavaScript regex if regex is true).' },
      regex: { type: 'boolean' },
      case_sensitive: { type: 'boolean', description: 'Match letter case exactly (default: false).' },
      path: { type: 'string', description: 'Directory to search in, relative to the project root (default: root).' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Only files with these extensions, e.g. [".sk"].' },
      glob: {
        type: 'string',
        description: 'Only files whose project-relative path matches this glob, e.g. "scripts/**/*.sk" or "*shop*".'
      },
      context_lines: { type: 'integer', description: `Lines of context before and after each match (0-${MAX_CONTEXT}).` },
      output: { type: 'string', enum: ['content', 'files'], description: 'content (default): matching lines; files: only file paths.' }
    },
    required: ['query'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ query, regex = false, case_sensitive = false, path = '.', extensions, glob, context_lines = 0, output = 'content' }, ctx) {
    let pattern: RegExp
    try {
      pattern = new RegExp(regex ? query : escapeRegExp(query), case_sensitive ? '' : 'i')
    } catch (error) {
      throw new ToolError(`Invalid regex: ${(error as Error).message}`)
    }
    const root = await realpath(ctx.projectRoot!)
    const start = await resolveInProject(ctx, path)
    const wanted = extensions?.map((ext) => ext.toLowerCase())
    const include = glob ? globToRegExp(glob) : undefined
    const context = Math.max(0, Math.min(MAX_CONTEXT, Math.floor(context_lines)))

    const results: string[] = []
    let matchCount = 0
    for await (const file of walkFiles(start, ctx)) {
      const shown = displayPath(root, file)
      if (wanted && !wanted.some((ext) => file.toLowerCase().endsWith(ext))) continue
      if (include && !include.test(shown)) continue
      if ((await stat(file)).size > MAX_FILE_BYTES) continue
      const lines = (await readFile(file, 'utf8')).split(/\r\n|\n|\r/)
      const hits = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []))
      if (hits.length === 0) continue

      if (output === 'files') {
        results.push(`${shown} (${hits.length})`)
        if (results.length >= MAX_RESULTS) return `${results.join('\n')}\n(result limit reached)`
        continue
      }
      if (context === 0) {
        for (const index of hits) {
          results.push(`${shown}:${index + 1}: ${lines[index].trim().slice(0, MAX_LINE_LENGTH)}`)
          if (++matchCount >= MAX_RESULTS) return `${results.join('\n')}\n(result limit reached)`
        }
        continue
      }

      // Bağlamlı çıktı: üst üste binen pencereler birleşir, ayrık bloklar `--` ile ayrılır
      const isHit = new Set(hits)
      let last = -1
      for (const index of hits) {
        const from = Math.max(index - context, last + 1)
        const to = Math.min(lines.length - 1, index + context)
        if (from > to) continue
        if (results.length > 0 && (last === -1 || from > last + 1)) results.push('--')
        for (let i = from; i <= to; i++) {
          const text = lines[i].trimEnd().slice(0, MAX_LINE_LENGTH)
          results.push(isHit.has(i) ? `${shown}:${i + 1}: ${text}` : `${shown}-${i + 1}- ${text}`)
          if (isHit.has(i) && ++matchCount >= MAX_RESULTS) return `${results.join('\n')}\n(result limit reached)`
        }
        last = Math.max(last, to)
      }
    }
    return results.length === 0 ? 'No matches.' : results.join('\n')
  }
})
