import { STAGING_FOLDER } from '@skript-ide/runtime-validator'
import type { SyntaxEntry } from '@skript-ide/syntax-db'
import { defineTool, ToolError, type AgentLanguageService, type AgentTool } from '../../tool'
import { requireEula, requireServer, throwIfAborted, untilAborted } from './server-shared'
import { requireLanguageService } from './shared'
import type { ProjectSyntax } from './syntax'

const DEFAULT_LIMIT = 80
const MAX_LIMIT = 400
const DUMP_PREFIX = 'SKRIPT_IDE_VALUES:'
const DUMP_END = 'SKRIPT_IDE_VALUES_END'
const DUMP_COMMAND = 'skriptide-values'
const TYPE_PHRASE = /^[a-z][a-z ]{1,40}$/i

/** Bilinen kısa adlar → Skript tür kimliği. */
const TYPE_ALIASES: Record<string, string[]> = {
  item: ['itemtype'],
  items: ['itemtype'],
  block: ['itemtype', 'blockdata'],
  blocks: ['itemtype', 'blockdata'],
  material: ['itemtype'],
  entity: ['entitydata'],
  entities: ['entitydata'],
  mob: ['entitydata'],
  mobs: ['entitydata'],
  potion: ['potioneffecttype'],
  potions: ['potioneffecttype'],
  effect: ['potioneffecttype'],
  enchant: ['enchantment'],
  enchants: ['enchantment'],
  sound: ['sound'],
  sounds: ['sound'],
  particles: ['particle']
}

/** Sunucudan alınan listeler: `skript sürümü|tür ifadesi` → değerler. */
const serverValues = new Map<string, string[]>()

function serverKey(skriptVersion: string, phrase: string): string {
  return `${skriptVersion}|${phrase.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Tür belgesindeki kullanım metninden tek tek değerler; liste değilse (açıklama metni) `null`. */
export function typeValues(entry: SyntaxEntry): string[] | null {
  const values: string[] = []
  for (const pattern of entry.patterns) {
    let depth = 0
    let from = 0
    for (let i = 0; i <= pattern.length; i++) {
      const ch = pattern[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (i === pattern.length || (ch === ',' && depth === 0)) {
        const value = pattern.slice(from, i).trim()
        if (value) values.push(value)
        from = i + 1
      }
    }
  }
  const unique = [...new Set(values)]
  if (unique.length < 3) return null
  if (unique.some((value) => /[<>]|\[.*\]/.test(value))) return null
  const average = unique.reduce((sum, value) => sum + value.length, 0) / unique.length
  return average > 40 ? null : unique
}

function typeEntries(syntax: ProjectSyntax): SyntaxEntry[] {
  return syntax.index.database.entries.filter((entry) => entry.kind === 'type')
}

function findTypes(entries: readonly SyntaxEntry[], query: string): SyntaxEntry[] {
  const key = normalize(query)
  const aliases = TYPE_ALIASES[query.toLowerCase().trim()] ?? []
  const exact = entries.filter((entry) => aliases.includes(entry.id.toLowerCase()) || normalize(entry.id) === key || normalize(entry.name) === key)
  if (exact.length) return exact
  return entries.filter((entry) => normalize(entry.id).includes(key) || normalize(entry.name).includes(key))
}

function matches(value: string, query: string): boolean {
  const q = query.toLowerCase()
  return value.toLowerCase().includes(q) || normalize(value).includes(normalize(q))
}

interface LookupInput {
  type?: string
  query?: string
  limit?: number
}

function listing(title: string, values: readonly string[], query: string | undefined, limit: number): string {
  const hits = query ? values.filter((value) => matches(value, query)) : values
  const head = query ? `${title}: ${hits.length} of ${values.length} values contain ${JSON.stringify(query)}` : `${title}: ${values.length} values`
  const shown = hits.slice(0, limit)
  const more = hits.length > limit ? `\n(… ${hits.length - limit} more; narrow with query or raise limit)` : ''
  return `${head}\n${shown.join(', ')}${more}`
}

export function createMinecraftDataTools(projectSyntax: (service: AgentLanguageService) => Promise<ProjectSyntax>): AgentTool[] {
  const lookup = defineTool<LookupInput>({
    name: 'lookup_minecraft_data',
    description:
      'Look up the exact names Skript accepts for Minecraft values in the project\'s Skript version: particles, ' +
      'enchantments, potion effect types, biomes, damage causes, spawn reasons, inventory types, colors, game rules, ' +
      'attribute types, sound categories, villager professions, and every other Skript type that has a fixed list of ' +
      'values. Use it instead of guessing a name. Without type and query it lists the types that have value lists. ' +
      'With query but no type it searches all of them. Items, blocks, entity types and sounds have no list in the ' +
      'documentation: fetch them once with dump_type_values (results are then searchable here too).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'A Skript type, e.g. "particle", "enchantment", "potion effect type", "biome", "damage cause".' },
        query: { type: 'string', description: 'Only values containing this text, e.g. "flame" or "sharp".' },
        limit: { type: 'integer', description: `Maximum number of values (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` }
      },
      additionalProperties: false
    },
    permission: 'read',
    async execute(input, ctx) {
      const service = requireLanguageService(ctx)
      const syntax = await projectSyntax(service)
      const entries = typeEntries(syntax)
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT))
      const query = input.query?.trim() || undefined
      const dumped = [...serverValues.entries()]
        .filter(([key]) => key.startsWith(`${service.skriptVersion}|`))
        .map(([key, values]) => ({ phrase: key.slice(key.indexOf('|') + 1), values }))

      if (!input.type?.trim()) {
        const enumerable = entries
          .map((entry) => ({ entry, values: typeValues(entry) }))
          .filter((item): item is { entry: SyntaxEntry; values: string[] } => item.values !== null)
        if (!query) {
          const lines = enumerable.map(({ entry, values }) => `- ${entry.name} (${entry.id}${entry.addon ? `, ${entry.addon}` : ''}): ${values.length} values`)
          for (const { phrase, values } of dumped) lines.push(`- all ${phrase} (from the test server): ${values.length} values`)
          return [`Types with value lists in Skript ${service.skriptVersion}:`, ...lines].join('\n')
        }
        const out: string[] = []
        let total = 0
        for (const { entry, values } of [...enumerable.map(({ entry, values }) => ({ entry, values })), ...dumped.map(({ phrase, values }) => ({ entry: { name: `all ${phrase}`, id: 'server' } as SyntaxEntry, values }))]) {
          const hits = values.filter((value) => matches(value, query))
          if (hits.length === 0) continue
          total += hits.length
          out.push(`${entry.name} (${entry.id}): ${hits.slice(0, 20).join(', ')}${hits.length > 20 ? ` (… ${hits.length - 20} more)` : ''}`)
        }
        if (out.length === 0) {
          return `No value of any documented type contains ${JSON.stringify(query)}. For items, blocks, entity types or sounds, use dump_type_values first.`
        }
        return [`${total} values contain ${JSON.stringify(query)}:`, ...out].join('\n')
      }

      const typeQuery = input.type.trim()
      const fromServer = dumped.find(({ phrase }) => normalize(phrase).includes(normalize(typeQuery)) || normalize(typeQuery).includes(normalize(phrase)))
      const found = findTypes(entries, typeQuery)
      if (found.length === 0 && !fromServer) {
        throw new ToolError(`No Skript type matches ${JSON.stringify(typeQuery)}. Call lookup_minecraft_data without arguments to list the types.`)
      }
      const out: string[] = []
      for (const entry of found.slice(0, 3)) {
        const values = typeValues(entry)
        const title = `${entry.name} (${entry.id}${entry.addon ? `, ${entry.addon}` : ''})`
        if (values) out.push(listing(title, values, query, limit))
        else if (!fromServer) {
          const usage = entry.patterns.join('\n  ')
          out.push(
            `${title} has no value list in the documentation.${usage ? `\nUsage:\n  ${usage}` : ''}\n` +
              `To get the real list from the test server, call dump_type_values with the type in plural form (e.g. "item types", "entity types").`
          )
        }
      }
      if (fromServer) out.push(listing(`all ${fromServer.phrase} (from the test server)`, fromServer.values, query, limit))
      if (found.length > 3) out.push(`Other matching types: ${found.slice(3).map((entry) => entry.id).join(', ')}`)
      return out.join('\n\n')
    }
  })

  return [lookup, dumpTypeValuesTool]
}

interface DumpInput {
  type: string
  query?: string
}

export function dumpScript(phrase: string): string {
  return [
    `command /${DUMP_COMMAND}:`,
    '\texecutable by: console',
    '\ttrigger:',
    `\t\tloop all ${phrase}:`,
    '\t\t\tadd "%loop-value%" to {_values::*}',
    '\t\t\tif size of {_values::*} >= 50:',
    `\t\t\t\tsend "${DUMP_PREFIX}%join {_values::*} with "|"%" to sender`,
    '\t\t\t\tdelete {_values::*}',
    '\t\tif {_values::*} is set:',
    `\t\t\tsend "${DUMP_PREFIX}%join {_values::*} with "|"%" to sender`,
    `\t\tsend "${DUMP_END}" to sender`,
    ''
  ].join('\n')
}

export const dumpTypeValuesTool = defineTool<DumpInput>({
  name: 'dump_type_values',
  description:
    'Ask the local test server for every value of a Skript type, by running "loop all <type>" there. This gives the ' +
    'exact names the project\'s Skript and Minecraft version accept for types that have no list in the documentation: ' +
    'items ("item types"), entity types ("entity types"), and any other type that supports "all <type>". The result is ' +
    'cached for the session and becomes searchable with lookup_minecraft_data. If the type cannot be looped, the ' +
    'Skript error is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'The type in plural as written after "all", e.g. "item types", "entity types", "biomes".' },
      query: { type: 'string', description: 'Only return values containing this text (all values are still cached).' }
    },
    required: ['type'],
    additionalProperties: false
  },
  permission: 'exec',
  async preview({ type }) {
    return { summary: `List all ${type} on the local test server` }
  },
  async execute(input, ctx) {
    const phrase = input.type.trim().replace(/^all\s+/i, '').replace(/\s+/g, ' ')
    if (!TYPE_PHRASE.test(phrase)) throw new ToolError('type must be a plain type name such as "item types" or "entity types".')
    const server = requireServer(ctx)
    const version = server.currentStatus.versions.skript
    const key = serverKey(version, phrase)
    let values = serverValues.get(key)
    if (!values) {
      await requireEula(server)
      let validation
      try {
        throwIfAborted(ctx.signal)
        validation = await untilAborted(server.validate('skriptide-values', 'skriptide-values.sk', dumpScript(phrase)), ctx.signal)
      } catch (error) {
        if (error instanceof ToolError) throw error
        throw new ToolError(`Could not load the helper script: ${(error as Error).message}`)
      }
      const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      try {
        if (!validation.ok || errors.length) {
          const detail = errors.map((diagnostic) => diagnostic.message).join('; ') || 'no details'
          throw new ToolError(`Skript cannot loop "all ${phrase}" (${detail}). Try another spelling, e.g. the plural from the type's documentation.`)
        }
        throwIfAborted(ctx.signal)
        const result = await untilAborted(server.runCommands([DUMP_COMMAND], { until: DUMP_END, timeoutMs: 30_000, signal: ctx.signal }), ctx.signal)
        if (!result.matchedUntil) throw new ToolError('The server did not finish listing the values in time.')
        values = []
        for (const line of result.output) {
          const at = line.indexOf(DUMP_PREFIX)
          if (at !== -1) values.push(...line.slice(at + DUMP_PREFIX.length).split('|').map((value) => value.trim()).filter(Boolean))
        }
        values = [...new Set(values)].sort((a, b) => a.localeCompare(b))
        serverValues.set(key, values)
      } finally {
        void server.runCommands([`sk disable ${STAGING_FOLDER}/${validation.stagedName}`], { settleMs: 300, timeoutMs: 5000 }).catch(() => {})
      }
    }
    const query = input.query?.trim()
    const hits = query ? values.filter((value) => matches(value, query)) : values
    const head = `all ${phrase} on Skript ${version}: ${values.length} values${query ? `, ${hits.length} contain ${JSON.stringify(query)}` : ''}.`
    const shown = hits.slice(0, MAX_LIMIT)
    const more = hits.length > shown.length ? `\n(… ${hits.length - shown.length} more; search with lookup_minecraft_data)` : ''
    return `${head}\n${shown.join(', ')}${more}`
  }
})
