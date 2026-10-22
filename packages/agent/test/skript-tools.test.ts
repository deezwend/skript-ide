import test from 'node:test'
import assert from 'node:assert/strict'
import { SkriptLanguageService } from '@skript-ide/language-server'
import { readAddonDatabase, readSyntaxDatabase } from '@skript-ide/syntax-db/node'
import type { SkriptServer, ValidationResult } from '@skript-ide/runtime-validator'
import { createSkriptTools, ToolError, type AgentTool, type ToolContext } from '../src/index'
import { makeContext, makeProject } from './helpers'

const tools = new Map(createSkriptTools({ loadDatabase: readSyntaxDatabase, loadAddonDatabase: readAddonDatabase }).map((tool) => [tool.name, tool]))
const tool = (name: string): AgentTool => tools.get(name)!

function makeService(addons: { name: string; version: string }[] = []): SkriptLanguageService {
  return new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: '2.17.1', addons })
}

type FakeServer = NonNullable<ToolContext['server']> & { calls: { source: string; fileName: string; content: string }[] }

function makeServer(result: Partial<ValidationResult>, eula = true): FakeServer {
  const calls: FakeServer['calls'] = []
  const status = {
    state: 'ready',
    message: 'Ready',
    versions: { skript: '2.17.1', minecraft: '1.21.10' },
    eulaUrl: '',
    addons: [{ name: 'SkBee', version: '3.26.0', state: 'failed', message: 'boom' }]
  } as unknown as SkriptServer['currentStatus']
  return {
    calls,
    currentStatus: status,
    isEulaAccepted: async () => eula,
    validate: async (source, fileName, content) => {
      calls.push({ source, fileName, content })
      return { source, stagedName: fileName, diagnostics: [], ok: true, durationMs: 1200, ...result }
    }
  }
}

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeProject(files)
  try {
    await run(root)
  } finally {
    await cleanup()
  }
}

test('get_diagnostics hatasız betikte sıfır hata, başka dosyadaki fonksiyonu tanır', () =>
  withProject(
    {
      'main.sk': 'on join:\n\tsend "hi" to player\n\tgreet(player)\n',
      'lib/greet.sk': 'function greet(p: player):\n\tsend "hello" to {_p}\n'
    },
    async (root) => {
      const ctx = { ...makeContext({ projectRoot: root }), languageService: makeService() }
      const result = await tool('get_diagnostics').execute({ path: 'main.sk' }, ctx)
      assert.match(result, /^Skript 2\.17\.1: 0 errors, \d+ warnings in main\.sk\./)
      assert.doesNotMatch(result, /greet/)
    }
  ))

test('get_diagnostics anlaşılamayan satırı satır numarasıyla bildirir; yol verilmezse tüm dosyalar', () =>
  withProject(
    { 'a.sk': 'on join:\n\tsend "hi" to player\n', 'b.sk': 'on join:\n\tbroadcst "hi"\n' },
    async (root) => {
      const ctx = { ...makeContext({ projectRoot: root }), languageService: makeService() }
      const result = await tool('get_diagnostics').execute({}, ctx)
      assert.match(result, /1 errors, \d+ warnings in 2 files\./)
      assert.match(result, /^b\.sk:2:\d+: error: /m)
      assert.doesNotMatch(result, /^a\.sk:/m)
    }
  ))

test('get_diagnostics .sk olmayan dosyayı ve dil servisi yokluğunu reddeder', () =>
  withProject({ 'notes.txt': 'x' }, async (root) => {
    await assert.rejects(
      tool('get_diagnostics').execute({ path: 'notes.txt' }, { ...makeContext({ projectRoot: root }), languageService: makeService() }),
      ToolError
    )
    await assert.rejects(tool('get_diagnostics').execute({}, makeContext({ projectRoot: root })), /language service/)
  }))

test('search_syntax projenin sürümünde arar, addon kayıtlarını işaretler; get_syntax_docs ayrıntı verir', async () => {
  const ctx = { ...makeContext(), languageService: makeService([{ name: 'SkBee', version: '3.26.0' }]) }
  const result = await tool('search_syntax').execute({ query: 'action bar', kinds: ['effect'] }, ctx)
  assert.match(result, /in Skript 2\.17\.1 \+ SkBee:/)
  const match = /\[effect\] [^\n]*\(id: (\w+), Skript\)/.exec(result)
  assert.ok(match, result)

  const docs = await tool('get_syntax_docs').execute({ kind: 'effect', id: match[1] }, ctx)
  assert.match(docs, /^# \[effect\] /)
  assert.match(docs, /\nPatterns:\n/)

  const nbt = await tool('search_syntax').execute({ query: 'nbt', limit: 5 }, ctx)
  assert.match(nbt, /SkBee\)/)
})

test("search_syntax verisi olmayan addon'u söyler; bilinmeyen kimlik hata verir", async () => {
  const ctx = { ...makeContext(), languageService: makeService([{ name: 'Skungee', version: '1.0.0' }]) }
  assert.match(await tool('search_syntax').execute({ query: 'broadcast' }, ctx), /No syntax data for: Skungee 1\.0\.0/)
  await assert.rejects(tool('get_syntax_docs').execute({ kind: 'effect', id: 'NoSuchThing' }, ctx), ToolError)
})

test('validate_on_server dosyayı sunucuya gönderir, sonucu ve yüklenemeyen addonu bildirir', () =>
  withProject({ 'scripts/main.sk': 'on join:\n\tsend "x" to playr\n' }, async (root) => {
    const server = makeServer({
      ok: false,
      diagnostics: [{ file: 'ide\\main.sk', line: 2, severity: 'error', message: "Can't understand this expression", code: 'send "x" to playr' }]
    })
    const ctx = { ...makeContext({ projectRoot: root }), server }
    const result = await tool('validate_on_server').execute({ path: 'scripts/main.sk' }, ctx)
    assert.equal(server.calls.length, 1)
    assert.equal(server.calls[0].fileName, 'main.sk')
    assert.equal(server.calls[0].content, 'on join:\n\tsend "x" to playr\n')
    assert.match(result, /^Failed to load scripts\/main\.sk on Skript 2\.17\.1 \(Minecraft 1\.21\.10\): 1 errors, 0 warnings, 1\.2s\./)
    assert.match(result, /scripts\/main\.sk:2: error: Can't understand this expression\n {4}send "x" to playr/)
    assert.match(result, /addon SkBee 3\.26\.0 is failed on the server \(boom\)/)
    assert.equal(tool('validate_on_server').permission, 'exec')
  }))

test('validate_on_server EULA onaylanmadıysa sunucuya gitmez', () =>
  withProject({ 'main.sk': 'on join:\n' }, async (root) => {
    const server = makeServer({}, false)
    await assert.rejects(tool('validate_on_server').execute({ path: 'main.sk' }, { ...makeContext({ projectRoot: root }), server }), /EULA/)
    assert.equal(server.calls.length, 0)
  }))

test('get_project_info proje dosyasını, addon sorunlarını ve sunucu durumunu özetler', () =>
  withProject(
    { 'skript-project.json': JSON.stringify({ skriptVersion: '2.17.1', addons: { SkBee: '3.26.0', Skungee: '1.0.0' } }) },
    async (root) => {
      const ctx = {
        ...makeContext({ projectRoot: root }),
        languageService: makeService([{ name: 'SkBee', version: '3.26.0' }, { name: 'Skungee', version: '1.0.0' }]),
        server: makeServer({})
      }
      const result = await tool('get_project_info').execute({}, ctx)
      assert.match(result, /skript-project\.json: found/)
      assert.match(result, /^Skript version: 2\.17\.1$/m)
      assert.match(result, /^- SkBee 3\.26\.0 — syntax data available, server: failed: boom$/m)
      assert.match(result, /^- Skungee 1\.0\.0 — no syntax data$/m)
      assert.match(result, /^Problems:\n- .*Skungee/m)
      assert.match(result, /^Validation server: ready \(Ready\)$/m)
    }
  ))

test('get_project_info proje dosyası yoksa varsayılanları söyler', () =>
  withProject({}, async (root) => {
    const result = await tool('get_project_info').execute({}, makeContext({ projectRoot: root }))
    assert.match(result, /skript-project\.json: not found/)
    assert.match(result, /Addons: none/)
  }))
