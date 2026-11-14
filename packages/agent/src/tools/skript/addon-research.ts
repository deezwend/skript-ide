/**
 * Skript ekosistemi için web araştırma tool'ları: SkriptHub syntax listesi, Modrinth/Hangar/Spigot eklenti araması ve
 * GitHub depo/issue/kod araması. Hepsi salt okunurdur; sonuçlar güvenilmez veridir.
 */
import { defineTool, ToolError, type AgentTool } from '../../tool'
import type { EnvReader } from '../web'
import { clip, defaultNetDeps, requestJson, type NetDeps } from '../web-net'

export const ADDON_RESEARCH_TOOL_NAMES: readonly string[] = ['search_addon_syntax', 'search_plugins', 'github_search']

// --- SkriptHub ---

const SKRIPTHUB_LIST_URL = 'https://skripthub.net/api/v1/addonsyntaxlist/'
const SKRIPTHUB_TTL_MS = 6 * 60 * 60_000
const SKRIPTHUB_MAX_BYTES = 40 * 1024 * 1024
/** Liste ~8 MB; yavaş bağlantıda varsayılan 30 sn yetmez. */
const SKRIPTHUB_TIMEOUT_MS = 120_000
const SYNTAX_TYPES = ['event', 'condition', 'effect', 'expression', 'type', 'section', 'structure', 'function'] as const

export interface SkriptHubEntry {
  id: number
  title: string
  description?: string | null
  syntax_pattern?: string | null
  syntax_type?: string | null
  compatible_addon_version?: string | null
  compatible_minecraft_version?: string | null
  return_type?: string | null
  event_values?: string | null
  keywords?: string | null
  required_plugins?: { name?: string }[] | null
  addon?: { name?: string; link_to_addon?: string | null } | null
  mark_as_removed?: boolean | null
  removed_since?: string | null
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9%]+/).filter((word) => word.length > 1)
}

/** Sorgu kelimelerinin başlık, pattern, anahtar kelime ve açıklamada geçmesine göre puan; hiç geçmiyorsa 0. */
export function scoreEntry(entry: SkriptHubEntry, terms: readonly string[], phrase: string): number {
  const title = entry.title.toLowerCase()
  const pattern = (entry.syntax_pattern ?? '').toLowerCase()
  const keywords = (entry.keywords ?? '').toLowerCase()
  const description = (entry.description ?? '').toLowerCase()
  let score = 0
  let matched = 0
  for (const term of terms) {
    let hit = 0
    if (title.includes(term)) hit += 4
    if (pattern.includes(term)) hit += 3
    if (keywords.includes(term)) hit += 2
    if (description.includes(term)) hit += 1
    if (hit > 0) matched++
    score += hit
  }
  if (matched === 0) return 0
  // Tüm kelimeleri içeren kayıtlar öne geçer; tam ifade başlıkta ya da pattern'de geçiyorsa ek puan
  score *= matched / terms.length
  if (matched === terms.length) score += 5
  if (phrase && (title.includes(phrase) || pattern.includes(phrase))) score += 8
  return score
}

export function formatSkriptHubEntry(entry: SkriptHubEntry): string {
  const addon = entry.addon?.name ?? 'unknown addon'
  const lines = [`${entry.title} — ${entry.syntax_type ?? 'syntax'} from ${addon}${entry.compatible_addon_version ? ` (since ${addon} ${entry.compatible_addon_version})` : ''}`]
  const pattern = (entry.syntax_pattern ?? '').trim()
  if (pattern) lines.push(...pattern.split(/\r?\n/).slice(0, 6).map((line) => `   ${line.trim()}`))
  const details: string[] = []
  if (entry.return_type) details.push(`returns ${entry.return_type}`)
  if (entry.event_values) details.push(`event values: ${clip(entry.event_values, 160)}`)
  if (entry.compatible_minecraft_version) details.push(`Minecraft ${entry.compatible_minecraft_version}`)
  const plugins = (entry.required_plugins ?? []).map((plugin) => plugin.name).filter(Boolean)
  if (plugins.length) details.push(`requires ${plugins.join(', ')}`)
  if (details.length) lines.push(`   ${details.join(' · ')}`)
  if (entry.description) lines.push(`   ${clip(entry.description, 300)}`)
  lines.push(`   https://skripthub.net/docs/?id=${entry.id}`)
  return lines.join('\n')
}

// --- Eklenti arama ---

interface PluginHit {
  source: string
  name: string
  author?: string
  description: string
  url: string
  downloads?: number
  updated?: string
  versions?: string
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Minecraft sürüm listesini `1.8.8 – 26.3 (27 versions)` biçiminde özetler. */
export function versionRange(versions: readonly string[]): string | undefined {
  const valid = [...new Set(versions.filter((version) => /^\d+(?:\.\d+)*$/.test(version)))].sort(compareVersions)
  if (valid.length === 0) return undefined
  if (valid.length === 1) return valid[0]
  return `${valid[0]} – ${valid[valid.length - 1]} (${valid.length} versions)`
}

function date(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10)
}

async function searchModrinth(query: string, minecraft: string | undefined, limit: number, signal: AbortSignal, deps: NetDeps): Promise<PluginHit[]> {
  const facets = [['project_type:plugin'], ...(minecraft ? [[`versions:${minecraft}`]] : [])]
  const url = `https://api.modrinth.com/v2/search?${new URLSearchParams({ query, limit: String(limit), facets: JSON.stringify(facets) })}`
  const data = await requestJson<{
    hits?: { slug: string; title: string; author?: string; description?: string; downloads?: number; date_modified?: string; versions?: string[] }[]
  }>(url, { signal }, deps)
  return (data.hits ?? []).map((hit) => ({
    source: 'Modrinth',
    name: hit.title,
    author: hit.author,
    description: hit.description ?? '',
    url: `https://modrinth.com/plugin/${hit.slug}`,
    downloads: hit.downloads,
    updated: date(hit.date_modified),
    versions: versionRange(hit.versions ?? [])
  }))
}

async function searchHangar(query: string, minecraft: string | undefined, limit: number, signal: AbortSignal, deps: NetDeps): Promise<PluginHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  if (minecraft) {
    params.set('platform', 'PAPER')
    params.set('version', minecraft)
  }
  const data = await requestJson<{
    result?: {
      name: string
      namespace?: { owner?: string; slug?: string }
      description?: string
      stats?: { downloads?: number }
      lastUpdated?: string
      supportedPlatforms?: Record<string, string[]>
    }[]
  }>(`https://hangar.papermc.io/api/v1/projects?${params}`, { signal }, deps)
  return (data.result ?? []).map((project) => ({
    source: 'Hangar',
    name: project.name,
    author: project.namespace?.owner,
    description: project.description ?? '',
    url: `https://hangar.papermc.io/${project.namespace?.owner ?? ''}/${project.namespace?.slug ?? project.name}`,
    downloads: project.stats?.downloads,
    updated: date(project.lastUpdated),
    versions: versionRange(Object.values(project.supportedPlatforms ?? {}).flat())
  }))
}

async function searchSpigot(query: string, minecraft: string | undefined, limit: number, signal: AbortSignal, deps: NetDeps): Promise<PluginHit[]> {
  const params = new URLSearchParams({ size: String(minecraft ? limit * 3 : limit), sort: '-downloads', fields: 'id,name,tag,downloads,updateDate,testedVersions,premium' })
  const data = await requestJson<{ id: number; name: string; tag?: string; downloads?: number; updateDate?: number; testedVersions?: string[]; premium?: boolean }[]>(
    `https://api.spiget.org/v2/search/resources/${encodeURIComponent(query)}?${params}`,
    { signal },
    deps
  )
  // Spigot yalnızca ana sürüm listesi verir (1.20, 1.21); süzme bu düzeyde yapılır
  const major = minecraft?.split('.').slice(0, 2).join('.')
  return (Array.isArray(data) ? data : [])
    .filter((resource) => !major || (resource.testedVersions ?? []).some((version) => version === major || major.startsWith(`${version}.`)))
    .slice(0, limit)
    .map((resource) => ({
      source: 'Spigot',
      name: resource.name + (resource.premium ? ' (premium)' : ''),
      description: resource.tag ?? '',
      url: `https://www.spigotmc.org/resources/${resource.id}/`,
      downloads: resource.downloads,
      updated: date(resource.updateDate),
      versions: versionRange(resource.testedVersions ?? [])
    }))
}

const PLUGIN_SOURCES = {
  modrinth: { name: 'Modrinth', search: searchModrinth },
  hangar: { name: 'Hangar', search: searchHangar },
  spigot: { name: 'Spigot', search: searchSpigot }
} as const

function formatPlugin(hit: PluginHit): string {
  const meta = [hit.author && `by ${hit.author}`, hit.versions && `MC ${hit.versions}`, hit.updated && `updated ${hit.updated}`, hit.downloads !== undefined && `${hit.downloads.toLocaleString('en-US')} downloads`]
    .filter(Boolean)
    .join(' · ')
  return `${hit.name} [${hit.source}]${meta ? ` — ${meta}` : ''}\n   ${hit.url}${hit.description ? `\n   ${clip(hit.description, 200)}` : ''}`
}

// --- GitHub ---

interface GithubRepo {
  full_name: string
  html_url: string
  description?: string | null
  stargazers_count?: number
  pushed_at?: string
  archived?: boolean
  language?: string | null
}

interface GithubIssue {
  title: string
  html_url: string
  state: string
  comments?: number
  updated_at?: string
  repository_url?: string
  pull_request?: unknown
  body?: string | null
}

interface GithubCode {
  path: string
  html_url: string
  repository?: { full_name?: string }
}

export interface AddonResearchOptions {
  deps?: NetDeps
  env?: EnvReader
  now?: () => number
}

export function createAddonResearchTools(options: AddonResearchOptions = {}): AgentTool[] {
  const deps = options.deps ?? defaultNetDeps
  const env = options.env ?? ((name) => process.env[name])
  const now = options.now ?? Date.now
  let syntaxList: { at: number; entries: SkriptHubEntry[] } | null = null
  let syntaxLoading: Promise<SkriptHubEntry[]> | null = null

  /** Liste ~8 MB; bir kez indirilir, eşzamanlı çağrılar aynı indirmeyi bekler. */
  async function loadSyntaxList(signal: AbortSignal): Promise<SkriptHubEntry[]> {
    if (syntaxList && now() - syntaxList.at < SKRIPTHUB_TTL_MS) return syntaxList.entries
    // İndirme tek bir turun iptaline bağlı olmasın: başka çağrılar da bekliyor olabilir
    syntaxLoading ??= requestJson<SkriptHubEntry[]>(SKRIPTHUB_LIST_URL, { signal: new AbortController().signal, maxBytes: SKRIPTHUB_MAX_BYTES, timeoutMs: SKRIPTHUB_TIMEOUT_MS }, deps)
      .then((entries) => {
        if (!Array.isArray(entries)) throw new ToolError('SkriptHub returned an unexpected syntax list.')
        const usable = entries.filter((entry) => entry && typeof entry.title === 'string' && !entry.mark_as_removed)
        syntaxList = { at: now(), entries: usable }
        return usable
      })
      .finally(() => (syntaxLoading = null))
    const loading = syntaxLoading
    return new Promise<SkriptHubEntry[]>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('aborted'))
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      loading.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  const searchAddonSyntaxTool = defineTool<{ query: string; addon?: string; type?: string; limit?: number }>({
    name: 'search_addon_syntax',
    description:
      'Search SkriptHub\'s online syntax list (Skript and ~175 addons, including addons the project does not have) by keywords. ' +
      'Returns title, addon, type, patterns, version and a SkriptHub link. Use search_syntax first for the project\'s own Skript version ' +
      'and addons; use this to find which addon provides something, or for addons without local data. The first call downloads the list (a few seconds).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "nbt compound", "scoreboard team", "world border".' },
        addon: { type: 'string', description: 'Only this addon, e.g. "SkBee", "skript-reflect", "Skript".' },
        type: { type: 'string', enum: SYNTAX_TYPES, description: 'Only this syntax type.' },
        limit: { type: 'integer', description: 'Results, 1-30. Default 10.' }
      },
      required: ['query']
    },
    permission: 'read',
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim()
      const terms = [...new Set(words(query))]
      if (terms.length === 0) throw new ToolError('query needs at least one keyword.')
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 10), 1), 30)
      const addon = input.addon?.trim().toLowerCase()
      const type = input.type?.trim().toLowerCase()
      if (type && !(SYNTAX_TYPES as readonly string[]).includes(type)) throw new ToolError(`type must be one of ${SYNTAX_TYPES.join(', ')}.`)
      const entries = await loadSyntaxList(ctx.signal)
      const scoped = entries.filter(
        (entry) => (!addon || (entry.addon?.name ?? '').toLowerCase() === addon) && (!type || entry.syntax_type === type)
      )
      if (addon && scoped.length === 0 && !entries.some((entry) => (entry.addon?.name ?? '').toLowerCase() === addon)) {
        const names = [...new Set(entries.map((entry) => entry.addon?.name).filter((name): name is string => !!name))]
        const close = names.filter((name) => name.toLowerCase().includes(addon) || addon.includes(name.toLowerCase())).slice(0, 8)
        throw new ToolError(`SkriptHub has no addon named "${input.addon}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`)
      }
      const phrase = query.toLowerCase()
      const ranked = scoped
        .map((entry) => ({ entry, score: scoreEntry(entry, terms, terms.length > 1 ? phrase : '') }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
      if (ranked.length === 0) return `No SkriptHub syntax matches "${query}"${addon ? ` in ${input.addon}` : ''}${type ? ` (${type})` : ''}. Try other keywords.`
      const shown = ranked.slice(0, limit).map((item) => formatSkriptHubEntry(item.entry))
      return `SkriptHub: ${ranked.length} match${ranked.length === 1 ? '' : 'es'} for "${query}"${ranked.length > limit ? `, showing ${limit}` : ''}:\n\n${shown.join('\n\n')}`
    }
  })

  const searchPluginsTool = defineTool<{ query: string; source?: string; minecraft_version?: string; limit?: number }>({
    name: 'search_plugins',
    description:
      'Search Minecraft server plugins and Skript addons on Modrinth, Hangar (PaperMC) and SpigotMC. Returns name, supported ' +
      'Minecraft versions, last update, downloads and the page URL. Use it to check whether an addon exists, is maintained, or supports a Minecraft version.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Plugin or addon name or keywords, e.g. "SkBee", "skript gui".' },
        source: { type: 'string', enum: ['all', 'modrinth', 'hangar', 'spigot'], description: 'Where to search. Default all.' },
        minecraft_version: { type: 'string', description: 'Only plugins that list this Minecraft version, e.g. 1.21.4.' },
        limit: { type: 'integer', description: 'Results per source, 1-10. Default 5.' }
      },
      required: ['query']
    },
    permission: 'read',
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim()
      if (!query) throw new ToolError('query is empty.')
      const source = input.source?.trim().toLowerCase() || 'all'
      if (source !== 'all' && !Object.hasOwn(PLUGIN_SOURCES, source)) throw new ToolError('source must be all, modrinth, hangar or spigot.')
      const minecraft = input.minecraft_version?.trim() || undefined
      if (minecraft && !/^\d+(?:\.\d+){1,2}$/.test(minecraft)) throw new ToolError(`"${minecraft}" is not a Minecraft version such as 1.21.4.`)
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 5), 1), 10)
      const selected = source === 'all' ? Object.values(PLUGIN_SOURCES) : [PLUGIN_SOURCES[source as keyof typeof PLUGIN_SOURCES]]
      const settled = await Promise.allSettled(selected.map((item) => item.search(clip(query, 100), minecraft, limit, ctx.signal, deps)))
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted')
      const sections: string[] = []
      const failures: string[] = []
      settled.forEach((result, index) => {
        const name = selected[index].name
        if (result.status === 'rejected') {
          failures.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        } else if (result.value.length === 0) {
          sections.push(`${name}: no results.`)
        } else {
          sections.push(result.value.map(formatPlugin).join('\n\n'))
        }
      })
      if (failures.length === selected.length) throw new ToolError(`Plugin search failed.\n${failures.join('\n')}`)
      const header = `Plugins matching "${query}"${minecraft ? ` for Minecraft ${minecraft}` : ''}:`
      return [header, ...sections, ...(failures.length ? [`Unavailable sources: ${failures.join('; ')}`] : [])].join('\n\n')
    }
  })

  const githubSearchTool = defineTool<{ query: string; kind?: string; repo?: string; limit?: number }>({
    name: 'github_search',
    description:
      'Search GitHub repositories, issues/pull requests or code. Use it for Skript and addon source code, bug reports, ' +
      'changelogs and examples, e.g. kind "issues" with repo "SkriptLang/Skript". Code search needs a GITHUB_TOKEN environment ' +
      'variable; without a token GitHub allows about 10 searches a minute. Read a result with web_fetch.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GitHub search query; qualifiers such as is:open, label:bug, language:java, filename:plugin.yml are allowed.' },
        kind: { type: 'string', enum: ['repositories', 'issues', 'code'], description: 'What to search. Default repositories.' },
        repo: { type: 'string', description: 'Limit to one repository, owner/name (issues and code).' },
        limit: { type: 'integer', description: 'Results, 1-20. Default 8.' }
      },
      required: ['query']
    },
    permission: 'read',
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim()
      if (!query) throw new ToolError('query is empty.')
      const kind = input.kind?.trim().toLowerCase() || 'repositories'
      if (!['repositories', 'issues', 'code'].includes(kind)) throw new ToolError('kind must be repositories, issues or code.')
      const repo = input.repo?.trim()
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ToolError('repo must look like owner/name.')
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 8), 1), 20)
      const token = (env('GITHUB_TOKEN') ?? env('GH_TOKEN'))?.trim()
      if (kind === 'code' && !token) {
        throw new ToolError('GitHub code search requires a token. Set the GITHUB_TOKEN environment variable, or search issues/repositories, or use web_search with domains ["github.com"].')
      }
      const q = clip(`${query}${repo ? ` repo:${repo}` : ''}`, 256)
      const url = `https://api.github.com/search/${kind}?${new URLSearchParams({ q, per_page: String(limit) })}`
      const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
      if (token) headers.authorization = `Bearer ${token}`
      const data = await requestJson<{ total_count?: number; items?: unknown[] }>(url, { headers, signal: ctx.signal }, deps)
      const items = data.items ?? []
      if (items.length === 0) return `GitHub ${kind}: no results for "${q}".`
      let lines: string[]
      if (kind === 'repositories') {
        lines = (items as GithubRepo[]).map(
          (item) =>
            `${item.full_name}${item.archived ? ' (archived)' : ''} — ★${item.stargazers_count ?? 0}${item.language ? ` · ${item.language}` : ''}${item.pushed_at ? ` · last push ${item.pushed_at.slice(0, 10)}` : ''}\n   ${item.html_url}${item.description ? `\n   ${clip(item.description, 200)}` : ''}`
        )
      } else if (kind === 'issues') {
        lines = (items as GithubIssue[]).map((item) => {
          const repository = item.repository_url?.replace('https://api.github.com/repos/', '') ?? ''
          const type = item.pull_request ? 'PR' : 'issue'
          return `${item.title} — ${type} ${item.state} in ${repository}${item.comments ? ` · ${item.comments} comments` : ''}${item.updated_at ? ` · updated ${item.updated_at.slice(0, 10)}` : ''}\n   ${item.html_url}${item.body ? `\n   ${clip(item.body, 200)}` : ''}`
        })
      } else {
        lines = (items as GithubCode[]).map((item) => `${item.repository?.full_name ?? ''}/${item.path}\n   ${item.html_url}`)
      }
      return `GitHub ${kind} for "${q}" (${data.total_count ?? items.length} total):\n\n${lines.join('\n\n')}`
    }
  })

  return [searchAddonSyntaxTool, searchPluginsTool, githubSearchTool]
}
