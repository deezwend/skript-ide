import {
  loadAddonDatabase,
  loadSyntaxDatabase,
  resolveAddonDatabase,
  SYNTAX_KINDS,
  SyntaxIndex,
  type AddonSyntaxInfo,
  type SyntaxDatabase,
  type SyntaxEntry,
  type SyntaxKind
} from '@skript-ide/syntax-db'
import { defineTool, ToolError, type AgentLanguageService, type AgentTool } from '../../tool'
import { requireLanguageService } from './shared'

/**
 * Veritabanı yükleyicileri. Varsayılanlar paketleyiciyle (Vite/electron-vite) çalışır;
 * paketlenmemiş Node'da (testler) `@skript-ide/syntax-db/node` okuyucuları verilir.
 */
export interface SyntaxLoaders {
  loadDatabase(skriptVersion: string): Promise<SyntaxDatabase>
  loadAddonDatabase(info: Pick<AddonSyntaxInfo, 'addon' | 'addonVersion' | 'skriptVersion'>): Promise<SyntaxDatabase>
}

const DEFAULT_LIMIT = 15
const MAX_LIMIT = 50
const PATTERNS_IN_RESULT = 3

interface ProjectSyntax {
  index: SyntaxIndex
  /** Seçili olup syntax verisi olmayan addon'lar. */
  missing: string[]
}

/** Projenin Skript sürümü ve addon'ları için birleşik arama dizinleri; anahtar sürüm + addon'lar. */
function createSyntaxSource(loaders: SyntaxLoaders) {
  const cache = new Map<string, Promise<ProjectSyntax>>()

  async function build(service: AgentLanguageService): Promise<ProjectSyntax> {
    const version = service.skriptVersion
    const core = await loaders.loadDatabase(version)
    const entries: SyntaxEntry[] = [...core.entries]
    const missing: string[] = []
    for (const addon of service.selectedAddons) {
      const info = resolveAddonDatabase(addon.name, addon.version, version)
      if (!info) {
        missing.push(`${addon.name} ${addon.version}`)
        continue
      }
      const db = await loaders.loadAddonDatabase(info)
      for (const entry of db.entries) entries.push({ ...entry, addon: entry.addon ?? info.addon })
    }
    return { index: new SyntaxIndex({ ...core, entries }), missing }
  }

  return (service: AgentLanguageService): Promise<ProjectSyntax> => {
    const key = [service.skriptVersion, ...service.selectedAddons.map((addon) => `${addon.name}@${addon.version}`)].join(',')
    let pending = cache.get(key)
    if (!pending) {
      pending = build(service)
      pending.catch(() => cache.delete(key))
      cache.set(key, pending)
    }
    return pending
  }
}

function origin(entry: SyntaxEntry): string {
  return entry.addon ?? 'Skript'
}

function summary(entry: SyntaxEntry): string {
  const head = `[${entry.kind}] ${entry.name} (id: ${entry.id}, ${origin(entry)}${entry.deprecated ? ', deprecated' : ''})`
  const patterns = entry.patterns.slice(0, PATTERNS_IN_RESULT).map((pattern) => `    ${pattern}`)
  if (entry.patterns.length > PATTERNS_IN_RESULT) patterns.push(`    (… ${entry.patterns.length - PATTERNS_IN_RESULT} more patterns)`)
  return [head, ...patterns].join('\n')
}

function refs(list: readonly { name: string }[]): string {
  return list.map((ref) => ref.name).join(', ')
}

function documentation(entry: SyntaxEntry): string {
  const lines = [`# [${entry.kind}] ${entry.name}`, `id: ${entry.id}`, `from: ${origin(entry)}`]
  if (entry.deprecated) lines.push('deprecated: yes')
  if (entry.since.length) lines.push(`since: ${entry.since.join(', ')}`)
  if (entry.requirements?.length) lines.push(`requirements: ${entry.requirements.join(', ')}`)
  if (entry.returnType) lines.push(`returns: ${entry.returnType.name}`)
  if (entry.eventValues?.length) lines.push(`event values: ${refs(entry.eventValues)}`)
  if (entry.cancellable !== undefined) lines.push(`cancellable: ${entry.cancellable ? 'yes' : 'no'}`)
  if (entry.events?.length) lines.push(`only in events: ${refs(entry.events)}`)
  lines.push('', 'Patterns:', ...entry.patterns.map((pattern) => `  ${pattern}`))
  if (entry.description) lines.push('', entry.description)
  if (entry.examples.length) lines.push('', 'Examples:', ...entry.examples.map((example) => `\`\`\`\n${example}\n\`\`\``))
  return lines.join('\n')
}

function missingNote(syntax: ProjectSyntax): string {
  return syntax.missing.length ? `\nNo syntax data for: ${syntax.missing.join(', ')}; their syntax cannot be looked up.` : ''
}

interface SearchInput {
  query: string
  kinds?: SyntaxKind[]
  limit?: number
}

interface DocsInput {
  kind: SyntaxKind
  id: string
}

export function createSyntaxTools(loaders: SyntaxLoaders): AgentTool[] {
  const projectSyntax = createSyntaxSource(loaders)

  const searchSyntaxTool = defineTool<SearchInput>({
    name: 'search_syntax',
    description:
      "Search the Skript syntax documentation for the project's Skript version and addons. " +
      'Returns matching events, conditions, effects, expressions, sections, structures, types and functions ' +
      'with their raw Skript patterns. Use it before writing syntax you are not sure exists, then get_syntax_docs ' +
      'for full details and examples.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for, e.g. "send action bar" or "player health".' },
        kinds: { type: 'array', items: { type: 'string', enum: SYNTAX_KINDS }, description: 'Only these kinds.' },
        limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` }
      },
      required: ['query'],
      additionalProperties: false
    },
    permission: 'read',
    async execute({ query, kinds, limit = DEFAULT_LIMIT }, ctx) {
      if (!query.trim()) throw new ToolError('query must not be empty.')
      const service = requireLanguageService(ctx)
      const syntax = await projectSyntax(service)
      const count = Math.min(MAX_LIMIT, Math.max(1, limit))
      const results = syntax.index.search(query, { kinds, limit: count })
      const scope = `Skript ${service.skriptVersion}${service.selectedAddons.length ? ` + ${service.selectedAddons.map((addon) => addon.name).join(', ')}` : ''}`
      if (results.length === 0) return `No syntax matches "${query}" in ${scope}.${missingNote(syntax)}`
      return `${results.length} results in ${scope}:\n${results.map(summary).join('\n')}${missingNote(syntax)}`
    }
  })

  const getSyntaxDocsTool = defineTool<DocsInput>({
    name: 'get_syntax_docs',
    description:
      'Get the full documentation of one Skript syntax entry (all patterns, description, examples, since, ' +
      'event values, return type) by its kind and id, as returned by search_syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: SYNTAX_KINDS },
        id: { type: 'string', description: 'The id from search_syntax, e.g. "EffActionBar".' }
      },
      required: ['kind', 'id'],
      additionalProperties: false
    },
    permission: 'read',
    async execute({ kind, id }, ctx) {
      const service = requireLanguageService(ctx)
      const syntax = await projectSyntax(service)
      const wanted = id.trim().toLowerCase()
      // Kimlik yalnızca Skript içinde benzersiz; aynı kimlikli addon kaydı da varsa hepsi gösterilir
      const entries = syntax.index.database.entries.filter((entry) => entry.kind === kind && entry.id.toLowerCase() === wanted)
      if (entries.length === 0) {
        throw new ToolError(`No ${kind} with id "${id}" in Skript ${service.skriptVersion}; use search_syntax to find it.`)
      }
      return entries.map(documentation).join('\n\n')
    }
  })

  return [searchSyntaxTool, getSyntaxDocsTool]
}

export const defaultSyntaxLoaders: SyntaxLoaders = { loadDatabase: loadSyntaxDatabase, loadAddonDatabase }
