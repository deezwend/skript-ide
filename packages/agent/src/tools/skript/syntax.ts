import {
  ADDON_SYNTAX_DBS,
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

interface AddonSyntax {
  index: SyntaxIndex
  /** Addon adı (küçük harf) → verinin üretildiği addon sürümü. */
  versions: Map<string, string>
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number(part) || 0)
}

function versionNewer(a: string, b: string): boolean {
  const [pa, pb] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Katalogda bu Skript sürümü için tam verisi olan addon'lar (addon başına en yeni sürüm). */
function catalogAddons(skriptVersion: string): AddonSyntaxInfo[] {
  const byAddon = new Map<string, AddonSyntaxInfo>()
  for (const info of ADDON_SYNTAX_DBS) {
    if (info.skriptVersion !== skriptVersion) continue
    const key = info.addon.toLowerCase()
    const current = byAddon.get(key)
    if (!current || versionNewer(info.addonVersion, current.addonVersion)) byAddon.set(key, info)
  }
  return [...byAddon.values()]
}

/**
 * Projenin Skript sürümü için verisi olan tüm addon'ların birleşik dizini. Seçili addon'lar da
 * içindedir; çağıran taraf seçili olanları eler. Yalnızca gerektiğinde, sürüm başına bir kez yüklenir.
 */
function createAddonSource(loaders: SyntaxLoaders) {
  const cache = new Map<string, Promise<AddonSyntax>>()

  async function build(skriptVersion: string): Promise<AddonSyntax> {
    const core = await loaders.loadDatabase(skriptVersion)
    const entries: SyntaxEntry[] = []
    const versions = new Map<string, string>()
    for (const info of catalogAddons(skriptVersion)) {
      const db = await loaders.loadAddonDatabase(info)
      versions.set(info.addon.toLowerCase(), info.addonVersion)
      for (const entry of db.entries) entries.push({ ...entry, addon: entry.addon ?? info.addon })
    }
    return { index: new SyntaxIndex({ ...core, entries }), versions }
  }

  return (skriptVersion: string): Promise<AddonSyntax> => {
    let pending = cache.get(skriptVersion)
    if (!pending) {
      pending = build(skriptVersion)
      pending.catch(() => cache.delete(skriptVersion))
      cache.set(skriptVersion, pending)
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

/** Seçili olmayan addon kaydının başlığı; addon sürümü de yazılır. */
function addonLabel(entry: SyntaxEntry, addons: AddonSyntax): string {
  const name = origin(entry)
  const version = addons.versions.get(name.toLowerCase())
  return version ? `${name} ${version}` : name
}

function unavailableSummary(entry: SyntaxEntry, addons: AddonSyntax): string {
  const head = `[${entry.kind}] ${entry.name} (id: ${entry.id}, ${addonLabel(entry, addons)}, not installed${entry.deprecated ? ', deprecated' : ''})`
  const patterns = entry.patterns.slice(0, PATTERNS_IN_RESULT).map((pattern) => `    ${pattern}`)
  if (entry.patterns.length > PATTERNS_IN_RESULT) patterns.push(`    (… ${entry.patterns.length - PATTERNS_IN_RESULT} more patterns)`)
  return [head, ...patterns].join('\n')
}

interface SearchInput {
  query: string
  kinds?: SyntaxKind[]
  limit?: number
  include_unselected_addons?: boolean
}

interface DocsInput {
  kind: SyntaxKind
  id: string
}

export function createSyntaxTools(loaders: SyntaxLoaders): AgentTool[] {
  const projectSyntax = createSyntaxSource(loaders)
  const addonSyntax = createAddonSource(loaders)

  const searchSyntaxTool = defineTool<SearchInput>({
    name: 'search_syntax',
    description:
      "Search the Skript syntax documentation for the project's Skript version and addons. " +
      'Returns matching events, conditions, effects, expressions, sections, structures, types and functions ' +
      'with their raw Skript patterns. Use it before writing syntax you are not sure exists, then get_syntax_docs ' +
      'for full details and examples. If nothing matches, it also reports syntax from addons this project does ' +
      'not use, clearly marked as not installed, so you can suggest installing the addon instead of inventing syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for, e.g. "send action bar" or "player health".' },
        kinds: { type: 'array', items: { type: 'string', enum: SYNTAX_KINDS }, description: 'Only these kinds.' },
        limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
        include_unselected_addons: {
          type: 'boolean',
          description: 'Also search addons that are not selected in this project; those results are marked as not installed.'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    permission: 'read',
    async execute({ query, kinds, limit = DEFAULT_LIMIT, include_unselected_addons = false }, ctx) {
      if (!query.trim()) throw new ToolError('query must not be empty.')
      const service = requireLanguageService(ctx)
      const syntax = await projectSyntax(service)
      const count = Math.min(MAX_LIMIT, Math.max(1, limit))
      const results = syntax.index.search(query, { kinds, limit: count })
      const scope = `Skript ${service.skriptVersion}${service.selectedAddons.length ? ` + ${service.selectedAddons.map((addon) => addon.name).join(', ')}` : ''}`
      let otherPart = ''
      if (include_unselected_addons || results.length === 0) {
        const addons = await addonSyntax(service.skriptVersion)
        const selected = new Set(service.selectedAddons.map((addon) => addon.name.toLowerCase()))
        const seen = new Set(results.map((entry) => SyntaxIndex.key(entry)))
        const extra = addons.index
          .search(query, { kinds, limit: count * 3 })
          .filter((entry) => !selected.has((entry.addon ?? '').toLowerCase()))
          .filter((entry) => !seen.has(SyntaxIndex.key(entry)))
          .slice(0, count)
        if (extra.length > 0) {
          otherPart = [
            '',
            'Not available in this project (addon not installed):',
            ...extra.map((entry) => unavailableSummary(entry, addons)),
            'These syntaxes need an addon this project does not use. Do not use them here; suggest installing the addon instead.'
          ].join('\n')
        }
      }
      const projectPart =
        results.length > 0
          ? `${results.length} results in ${scope}:\n${results.map(summary).join('\n')}`
          : `No syntax matches "${query}" in ${scope}.`
      return `${projectPart}${missingNote(syntax)}${otherPart}`
    }
  })

  const getSyntaxDocsTool = defineTool<DocsInput>({
    name: 'get_syntax_docs',
    description:
      'Get the full documentation of one Skript syntax entry (all patterns, description, examples, since, ' +
      'event values, return type) by its kind and id, as returned by search_syntax. Entries from addons this ' +
      'project does not have are still shown, marked as not installed, so you can tell the user which addon to add.',
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
      const matching = (entry: SyntaxEntry) => entry.kind === kind && entry.id.toLowerCase() === wanted
      // Kimlik yalnızca Skript içinde benzersiz; aynı kimlikli addon kaydı da varsa hepsi gösterilir
      let entries = syntax.index.database.entries.filter(matching)
      let addons: AddonSyntax | undefined
      if (entries.length === 0) {
        addons = await addonSyntax(service.skriptVersion)
        const selected = new Set(service.selectedAddons.map((addon) => addon.name.toLowerCase()))
        entries = addons.index.database.entries.filter(
          (entry) => matching(entry) && !selected.has((entry.addon ?? '').toLowerCase())
        )
      }
      if (entries.length === 0) {
        throw new ToolError(`No ${kind} with id "${id}" in Skript ${service.skriptVersion}; use search_syntax to find it.`)
      }
      if (!addons) return entries.map(documentation).join('\n\n')
      const source = addons
      return entries
        .map((entry) => `not installed in this project: ${addonLabel(entry, source)} (add this addon to use it)\n\n${documentation(entry)}`)
        .join('\n\n')
    }
  })

  return [searchSyntaxTool, getSyntaxDocsTool]
}

export const defaultSyntaxLoaders: SyntaxLoaders = { loadDatabase: loadSyntaxDatabase, loadAddonDatabase }
