import { loadExampleIndex, type ExampleChunk, type ExampleIndex } from '@skript-ide/corpus'
import { defineTool, ToolError, type AgentTool, type ToolContext } from '../../tool'

/** Örnek indeksi yükleyicisi; varsayılan paketlenmiş JSON'u okur, testler Node okuyucusunu verir. */
export interface ExampleLoader {
  loadExamples(): Promise<ExampleIndex>
}

export const defaultExampleLoader: ExampleLoader = { loadExamples: loadExampleIndex }

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

interface SearchExamplesInput {
  query: string
  limit?: number
  addon?: string
}

interface ExampleHit {
  chunk: ExampleChunk
  score: number
  /** Projede seçili olmayan, örneğin gerektirdiği addon'lar. */
  missing: string[]
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_'-]+/)
    .filter((word) => word.length > 0)
}

function addonNames(chunk: ExampleChunk, index: ExampleIndex): string[] {
  return index.files[chunk.path]?.addons ?? []
}

/** Projede seçili addon adları (küçük harf); dil servisi yoksa `null` (addon bilgisi bilinmiyor). */
function selectedAddons(ctx: ToolContext): Set<string> | null {
  if (!ctx.languageService) return null
  return new Set(ctx.languageService.selectedAddons.map((addon) => addon.name.toLowerCase()))
}

function rank(index: ExampleIndex, query: string, addon: string | undefined, selected: Set<string> | null): ExampleHit[] {
  const phrase = query.trim().toLowerCase()
  const words = tokenize(query)
  if (words.length === 0) return []
  const wanted = addon?.trim().toLowerCase()
  const hits: ExampleHit[] = []
  for (const chunk of index.chunks) {
    const addons = addonNames(chunk, index)
    if (wanted && !addons.some((name) => name.toLowerCase() === wanted)) continue
    const title = chunk.title.toLowerCase()
    const body = chunk.text.toLowerCase()
    const path = chunk.path.toLowerCase()
    let score = 0
    let matched = true
    for (const word of words) {
      const inTitle = title.includes(word)
      const inPath = path.includes(word)
      if (!inTitle && !inPath && !body.includes(word)) {
        matched = false
        break
      }
      if (inTitle) score += 10
      if (inPath) score += 2
      const occurrences = body.split(word).length - 1
      score += Math.min(3, occurrences)
    }
    if (!matched) continue
    if (title.includes(phrase)) score += 15
    else if (body.includes(phrase)) score += 5
    const missing = selected ? addons.filter((name) => !selected.has(name.toLowerCase())) : []
    hits.push({ chunk, score, missing })
  }
  hits.sort((a, b) => Number(a.missing.length > 0) - Number(b.missing.length > 0) || b.score - a.score)
  return hits
}

function formatHit(hit: ExampleHit, index: ExampleIndex): string {
  const file = index.files[hit.chunk.path]
  const requires = file?.addons.length ? file.addons.join(', ') : 'Skript only'
  const installed = hit.missing.length === 0 ? requires : `${requires} (not installed)`
  const source = file ? `${file.source}, ${file.license}` : 'unknown source'
  const trouble = file?.groundTruth && file.errors > 0 ? `; ${file.errors} lines in this file fail on Skript ${file.groundTruth}` : ''
  const truncated = hit.chunk.truncated ? `\n(… block truncated; it continues to line ${hit.chunk.end})` : ''
  return `${hit.chunk.path}:${hit.chunk.start}-${hit.chunk.end} (${source}, requires: ${installed})${trouble}\n\`\`\`skript\n${hit.chunk.text}\n\`\`\`${truncated}`
}

export function createExampleTools(loader: ExampleLoader = defaultExampleLoader): AgentTool[] {
  const searchExamplesTool = defineTool<SearchExamplesInput>({
    name: 'search_examples',
    description:
      'Search real-world Skript code (vanilla and addon-based, from permissively licensed repositories) for idioms ' +
      'and structure. Returns whole top-level blocks (events, commands, functions, options) with file path, line ' +
      'range, source repository, license and required addons. Snippets may target another Skript version or addons ' +
      'that are not installed; verify anything you copy with search_syntax and get_diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for, e.g. "gui inventory click" or "on join first join".'
        },
        limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
        addon: { type: 'string', description: 'Only snippets that require this addon, e.g. "SkBee".' }
      },
      required: ['query'],
      additionalProperties: false
    },
    permission: 'read',
    async execute({ query, limit = DEFAULT_LIMIT, addon }, ctx) {
      if (!query.trim()) throw new ToolError('query must not be empty.')
      const index = await loader.loadExamples()
      const count = Math.min(MAX_LIMIT, Math.max(1, limit))
      const selected = selectedAddons(ctx)
      const hits = rank(index, query, addon, selected).slice(0, count)
      if (hits.length === 0) {
        return `No examples match "${query}"${addon ? ` that require ${addon}` : ''}.`
      }
      const header = `${hits.length} ${hits.length === 1 ? 'example' : 'examples'} for "${query}"${addon ? ` (requires ${addon})` : ''}:`
      const missing = hits.filter((hit) => hit.missing.length > 0)
      const note = missing.length
        ? '\nSnippets marked "not installed" need an addon this project does not use; suggest installing it instead of copying that syntax.'
        : ''
      const footer =
        '\nSnippets are real code, not API documentation: check patterns with search_syntax and the result with get_diagnostics before relying on them.'
      return `${header}\n${hits.map((hit) => formatHit(hit, index)).join('\n\n')}${note}${footer}`
    }
  })

  return [searchExamplesTool]
}
