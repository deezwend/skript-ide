import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAddonResearchTools, versionRange, type SkriptHubEntry } from '../src/tools/skript/addon-research'
import type { NetDeps } from '../src/tools/web-net'
import { makeContext } from './helpers'

function fakeDeps(handler: (url: string, init: RequestInit) => Response | Promise<Response>): NetDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url, init) => (calls.push(url), handler(url, init)),
    lookup: async () => ['93.184.215.14']
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function tool(name: string, deps: NetDeps, env: Record<string, string> = {}) {
  const found = createAddonResearchTools({ deps, env: (key) => env[key] }).find((item) => item.name === name)
  assert.ok(found)
  return found
}

const entries: SkriptHubEntry[] = [
  { id: 1, title: 'NBT Compound', syntax_pattern: 'nbt compound of %object%', syntax_type: 'expression', addon: { name: 'SkBee' }, compatible_addon_version: '1.0', return_type: 'NBT Compound', description: 'Get the NBT compound of an item.' },
  { id: 2, title: 'Send Message', syntax_pattern: 'send %texts% [to %players%]', syntax_type: 'effect', addon: { name: 'Skript' } },
  { id: 3, title: 'Old NBT', syntax_pattern: 'old nbt of %item%', syntax_type: 'expression', addon: { name: 'SkBee' }, mark_as_removed: true },
  { id: 4, title: 'Compound Tag', syntax_pattern: 'tag %string% of %nbt compound%', syntax_type: 'expression', addon: { name: 'SkNBeeT' }, keywords: 'nbt' }
]

test('search_addon_syntax ranks matches, skips removed entries, filters and downloads the list once', async () => {
  const deps = fakeDeps(() => json(entries))
  const search = tool('search_addon_syntax', deps)
  const output = await search.execute({ query: 'nbt compound' }, makeContext())
  assert.match(output, /^SkriptHub: 2 matches for "nbt compound":\n\nNBT Compound — expression from SkBee \(since SkBee 1\.0\)\n {3}nbt compound of %object%\n {3}returns NBT Compound/)
  assert.match(output, /https:\/\/skripthub\.net\/docs\/\?id=1/)
  assert.doesNotMatch(output, /Old NBT/)
  const filtered = await search.execute({ query: 'nbt', addon: 'sknbeet' }, makeContext())
  assert.match(filtered, /1 match/)
  assert.match(filtered, /Compound Tag/)
  await assert.rejects(search.execute({ query: 'nbt', addon: 'Bee' }, makeContext()), /no addon named "Bee".*SkBee/)
  assert.equal(deps.calls.length, 1)
})

test('search_addon_syntax shares one download between concurrent calls', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps = fakeDeps(async () => (await gate, json(entries)))
  const search = tool('search_addon_syntax', deps)
  const both = Promise.all([search.execute({ query: 'send' }, makeContext()), search.execute({ query: 'nbt' }, makeContext())])
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  const [send, nbt] = await both
  assert.match(send, /Send Message/)
  assert.match(nbt, /NBT Compound/)
  assert.equal(deps.calls.length, 1)
})

test('search_plugins merges sources and reports a failing one', async () => {
  const deps = fakeDeps((url) => {
    if (url.startsWith('https://api.modrinth.com')) {
      return json({ hits: [{ slug: 'skbee', title: 'SkBee', author: 'ShaneBee', description: 'Addon', downloads: 1200, date_modified: '2026-09-26T16:52:37Z', versions: ['1.21.10', '1.8.8', '1.21.4'] }] })
    }
    if (url.startsWith('https://hangar.papermc.io')) return json({ error: 'down' }, 500)
    return json([{ id: 75000, name: 'SkBee', tag: 'Skript addon', downloads: 50, updateDate: 1700000000, testedVersions: ['1.20', '1.21'] }])
  })
  const output = await tool('search_plugins', deps).execute({ query: 'SkBee', minecraft_version: '1.21.4' }, makeContext())
  assert.match(output, /SkBee \[Modrinth\] — by ShaneBee · MC 1\.8\.8 – 1\.21\.10 \(3 versions\) · updated 2026-09-26 · 1,200 downloads\n {3}https:\/\/modrinth\.com\/plugin\/skbee/)
  assert.match(output, /SkBee \[Spigot\].*https:\/\/www\.spigotmc\.org\/resources\/75000\//s)
  assert.match(output, /Unavailable sources: Hangar: hangar\.papermc\.io answered HTTP 500\./)
  const modrinth = new URL(deps.calls.find((url) => url.includes('modrinth'))!)
  assert.deepEqual(JSON.parse(modrinth.searchParams.get('facets')!), [['project_type:plugin'], ['versions:1.21.4']])
})

test('github_search formats issues, scopes to a repo and needs a token for code', async () => {
  const deps = fakeDeps(() =>
    json({ total_count: 1, items: [{ title: 'NBT crash', html_url: 'https://github.com/ShaneBee/SkBee/issues/1', state: 'open', comments: 3, updated_at: '2026-10-01T00:00:00Z', repository_url: 'https://api.github.com/repos/ShaneBee/SkBee' }] })
  )
  const search = tool('github_search', deps)
  const output = await search.execute({ query: 'nbt crash', kind: 'issues', repo: 'ShaneBee/SkBee' }, makeContext())
  assert.match(output, /NBT crash — issue open in ShaneBee\/SkBee · 3 comments · updated 2026-10-01/)
  assert.equal(new URL(deps.calls[0]).searchParams.get('q'), 'nbt crash repo:ShaneBee/SkBee')
  await assert.rejects(search.execute({ query: 'x', kind: 'code' }, makeContext()), /GITHUB_TOKEN/)

  const limited = fakeDeps(() => json({ message: 'rate limit' }, 403))
  await assert.rejects(tool('github_search', limited).execute({ query: 'x' }, makeContext()), /rate limit/)
})

test('versionRange sorts numerically and ignores non-release versions', () => {
  assert.equal(versionRange(['1.21.10', '1.9', '26.1', '1.21.2', '24w10a']), '1.9 – 26.1 (4 versions)')
  assert.equal(versionRange([]), undefined)
})
