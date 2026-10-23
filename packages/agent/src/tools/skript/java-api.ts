import { DEFAULT_VERSIONS } from '@skript-ide/runtime-validator'
import { htmlToText } from '@skript-ide/syntax-db'
import { defineTool, ToolError, type AgentTool, type ToolContext } from '../../tool'

const JAVADOC_BASE = 'https://jd.papermc.io/paper/'
const FETCH_TIMEOUT_MS = 30_000
const DEFAULT_LIMIT = 25
const MAX_MEMBERS = 150

/** Ağ erişimi; testlerde sahtesi verilir. */
export type TextFetcher = (url: string, signal: AbortSignal) => Promise<string>

export const defaultFetcher: TextFetcher = async (url, signal) => {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

interface TypeRef {
  p: string
  l: string
}

interface MemberRef {
  p: string
  c: string
  l: string
}

interface JavadocIndex {
  types: TypeRef[]
  members: MemberRef[]
}

/** `typeSearchIndex = [...];updateSearchResults();` biçimindeki javadoc arama dosyasından dizi. */
export function parseSearchIndex<T>(script: string): T[] {
  const start = script.indexOf('[')
  const end = script.lastIndexOf(']')
  if (start === -1 || end <= start) throw new Error('unexpected search index format')
  return JSON.parse(script.slice(start, end + 1)) as T[]
}

function minecraftVersion(ctx: ToolContext, requested?: string): string {
  const version = requested?.trim() || ctx.server?.currentStatus.versions.minecraft || DEFAULT_VERSIONS.minecraft
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) throw new ToolError(`"${version}" is not a Minecraft version such as 1.21.11 or 26.3.`)
  return version
}

export interface ClassMember {
  section: string
  signature: string
  description: string
}

export interface ClassPage {
  signature: string
  description: string
  members: ClassMember[]
  inherited: string[]
}

const SECTIONS: readonly [id: string, label: string][] = [
  ['enum-constant-summary', 'enum constant'],
  ['field-summary', 'field'],
  ['constructor-summary', 'constructor'],
  ['method-summary', 'method']
]

/** `htmlToText` `<wbr>` gibi boş etiketleri tanımıyor. */
function cellText(html: string): string {
  return htmlToText(html.replace(/<wbr\s*\/?>/gi, '')).replace(/\s+/g, ' ').trim()
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/s.exec(text)
  return (match ? match[1] : text).replace(/\s+/g, ' ').trim()
}

/** Javadoc sınıf sayfasından imza, açıklama, üye özetleri ve kalıtılan türler. */
export function parseClassPage(html: string): ClassPage {
  const signatureAt = html.indexOf('class="type-signature"')
  const signature = signatureAt === -1 ? '' : htmlToText(html.slice(html.indexOf('>', signatureAt) + 1, html.indexOf('</div>', signatureAt))).replace(/\s+/g, ' ').trim()
  const descriptionAt = html.indexOf('class="class-description"')
  const blockAt = descriptionAt === -1 ? -1 : html.indexOf('<div class="block">', descriptionAt)
  const description = blockAt === -1 ? '' : firstSentence(htmlToText(html.slice(blockAt, html.indexOf('</div>', blockAt))))

  const members: ClassMember[] = []
  for (const [id, label] of SECTIONS) {
    const start = html.indexOf(`id="${id}"`)
    if (start === -1) continue
    const end = html.indexOf('</section>', start)
    const section = html.slice(start, end === -1 ? undefined : end)
    const cells = [...section.matchAll(/<div class="(col-[a-z-]+)[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="col-|<\/div>)/g)]
    let row: string[] = []
    for (const [, kind, content] of cells) {
      if (kind === 'col-last') {
        const signatureText = row.map(cellText).filter(Boolean).join(' ')
        const block = /<div class="block">([\s\S]*)/.exec(content)
        const deprecated = /deprecated-label|Deprecated/.test(content)
        const text = block ? firstSentence(htmlToText(block[1])) : ''
        if (signatureText) members.push({ section: label, signature: signatureText, description: `${deprecated ? '[deprecated] ' : ''}${text}`.trim() })
        row = []
      } else {
        row.push(content)
      }
    }
  }
  const inherited = [...html.matchAll(/<h3 id="(?:methods|fields)-inherited-from-(?:class|interface)-([\w.$]+)"/g)].map((match) => match[1])
  return { signature, description, members, inherited: [...new Set(inherited)] }
}

interface SearchInput {
  query: string
  version?: string
  limit?: number
}

interface ClassInput {
  class_name: string
  filter?: string
  version?: string
}

/** Üye ve sınıf eşleşmesinin toplamı; biri eşleşmezse -1. */
function combinedScore(member: number, owner: number): number {
  return member < 0 || owner < 0 ? -1 : member * 3 + owner
}

function score(name: string, query: string): number {
  const n = name.toLowerCase()
  const q = query.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  if (n.includes(q)) return 2
  return -1
}

export function createJavaApiTools(fetchText: TextFetcher = defaultFetcher): AgentTool[] {
  const indexes = new Map<string, Promise<JavadocIndex>>()
  const pages = new Map<string, Promise<ClassPage>>()

  const loadIndex = (version: string, signal: AbortSignal): Promise<JavadocIndex> => {
    let pending = indexes.get(version)
    if (!pending) {
      const base = `${JAVADOC_BASE}${version}/`
      pending = Promise.all([fetchText(`${base}type-search-index.js`, signal), fetchText(`${base}member-search-index.js`, signal)]).then(
        ([types, members]) => ({ types: parseSearchIndex<TypeRef>(types), members: parseSearchIndex<MemberRef>(members) })
      )
      pending.catch(() => indexes.delete(version))
      indexes.set(version, pending)
    }
    return pending.catch((error: Error) => {
      throw new ToolError(`Could not load the Paper ${version} javadoc index from ${JAVADOC_BASE}: ${error.message}`)
    })
  }

  const search = defineTool<SearchInput>({
    name: 'search_java_api',
    description:
      'Search the Paper/Bukkit Java API (javadoc for the project\'s Minecraft version, from jd.papermc.io) for classes ' +
      'and methods. Use it when writing skript-reflect code or when you need the exact Java name of an event, enum ' +
      'constant or method. Query a class ("PlayerInteractEvent"), a member ("getHealth") or both ("Player.getHealth"). ' +
      'Use get_java_class for a class\'s full member list.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A class name, member name, or Class.member.' },
        version: { type: 'string', description: 'Minecraft version of the javadoc; default: the test server\'s version.' },
        limit: { type: 'integer', description: `Maximum results per group (default ${DEFAULT_LIMIT}).` }
      },
      required: ['query'],
      additionalProperties: false
    },
    permission: 'read',
    async execute(input, ctx) {
      const version = minecraftVersion(ctx, input.version)
      const index = await loadIndex(version, ctx.signal)
      const limit = Math.min(100, Math.max(1, input.limit ?? DEFAULT_LIMIT))
      // Paket öneki atılır: `org.bukkit.entity.Player.getHealth` → `Player.getHealth`
      const query = input.query.trim().replace(/\(.*\)$/, '').replace(/^(?:[a-z_]\w*\.)+(?=[A-Z])/, '')
      if (!query) throw new ToolError('query must not be empty.')
      const [classPart, memberPart] = /[.#]/.test(query) ? query.split(/[.#](?=[^.#]*$)/) : [query, query]

      const types = index.types
        .map((type) => ({ type, rank: score(type.l, classPart) }))
        .filter(({ rank }) => rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.type.l.length - b.type.l.length)
        .slice(0, limit)
      const members = index.members
        .map((member) => ({
          member,
          rank: combinedScore(score(member.l.replace(/\(.*$/, ''), memberPart), classPart !== memberPart ? score(member.c, classPart) : 0)
        }))
        .filter(({ rank }) => rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.member.c.localeCompare(b.member.c))
        .slice(0, limit)

      const out = [`Paper ${version} javadoc:`]
      if (types.length && classPart === memberPart) out.push('Classes:', ...types.map(({ type }) => `- ${type.p}.${type.l}`))
      if (members.length) out.push('Members:', ...members.map(({ member }) => `- ${member.p}.${member.c}#${member.l}`))
      if (out.length === 1) return `Nothing in the Paper ${version} javadoc matches ${JSON.stringify(query)}.`
      return out.join('\n')
    }
  })

  const getClass = defineTool<ClassInput>({
    name: 'get_java_class',
    description:
      'Show a Paper/Bukkit Java class from the javadoc: its declaration, a one-line description, and its enum ' +
      'constants, fields, constructors and methods with signatures and short descriptions, plus the types it inherits ' +
      'members from. Pass a simple name ("Player") or a full name ("org.bukkit.entity.Player"); filter narrows the members.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'e.g. "Player", "org.bukkit.Material", "PlayerInteractEvent".' },
        filter: { type: 'string', description: 'Only members whose signature contains this text, e.g. "health".' },
        version: { type: 'string', description: 'Minecraft version of the javadoc; default: the test server\'s version.' }
      },
      required: ['class_name'],
      additionalProperties: false
    },
    permission: 'read',
    async execute(input, ctx) {
      const version = minecraftVersion(ctx, input.version)
      const index = await loadIndex(version, ctx.signal)
      const wanted = input.class_name.trim()
      const matches = index.types.filter((type) => `${type.p}.${type.l}`.toLowerCase() === wanted.toLowerCase() || type.l.toLowerCase() === wanted.toLowerCase())
      if (matches.length === 0) throw new ToolError(`No class named ${wanted} in the Paper ${version} javadoc; try search_java_api.`)
      const type = matches.find((match) => match.p.startsWith('org.bukkit') || match.p.startsWith('io.papermc')) ?? matches[0]
      const url = `${JAVADOC_BASE}${version}/${type.p.replace(/\./g, '/')}/${type.l}.html`
      let pending = pages.get(url)
      if (!pending) {
        pending = fetchText(url, ctx.signal).then(parseClassPage)
        pending.catch(() => pages.delete(url))
        pages.set(url, pending)
      }
      let page: ClassPage
      try {
        page = await pending
      } catch (error) {
        throw new ToolError(`Could not load ${url}: ${(error as Error).message}`)
      }
      const filter = input.filter?.trim().toLowerCase()
      const members = filter ? page.members.filter((member) => member.signature.toLowerCase().includes(filter)) : page.members
      const out = [`${type.p}.${type.l} (Paper ${version})`, page.signature]
      if (page.description) out.push(page.description)
      if (matches.length > 1) out.push(`Other classes with this name: ${matches.filter((m) => m !== type).map((m) => `${m.p}.${m.l}`).join(', ')}`)
      let section = ''
      for (const member of members.slice(0, MAX_MEMBERS)) {
        if (member.section !== section) {
          section = member.section
          out.push('', `${section[0].toUpperCase()}${section.slice(1)}s:`)
        }
        out.push(`- ${member.signature}${member.description ? ` — ${member.description}` : ''}`)
      }
      if (members.length > MAX_MEMBERS) out.push(`(… ${members.length - MAX_MEMBERS} more; narrow with filter)`)
      if (filter && members.length === 0) out.push('', `No member contains ${JSON.stringify(input.filter)}.`)
      if (page.inherited.length) out.push('', `Also inherits members from: ${page.inherited.join(', ')}`)
      out.push('', url)
      return out.join('\n')
    }
  })

  return [search, getClass]
}
