import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExampleIndex } from '@skript-ide/corpus'
import { buildExampleIndexFromSamples, DEFAULT_SAMPLES_DIR, readExampleIndex } from '@skript-ide/corpus/node'
import { ToolError, type AgentLanguageService } from '../src/tool'
import { createExampleTools, type ExampleLoader } from '../src/tools/skript/examples'
import { makeContext } from './helpers'

const tools = new Map(createExampleTools(loaderFor(makeIndex())).map((tool) => [tool.name, tool]))
const tool = tools.get('search_examples')!

function makeIndex(): ExampleIndex {
  const file = (source: string, addons: string[], extra: Partial<ExampleIndex['files'][string]> = {}) => ({
    license: 'MIT',
    source,
    sourceUrl: `https://github.com/${source}`,
    sourcePath: 'main.sk',
    addons,
    lines: 10,
    errors: 0,
    warnings: 0,
    ...extra
  })
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    chunks: [
      { path: 'a.sk', title: 'on join:', start: 1, end: 3, text: 'on join:\n\tsend "welcome" to player' },
      { path: 'b.sk', title: 'on player click:', start: 1, end: 2, text: 'on player click:\n\tset {_gui} to "inventory"' },
      {
        path: 'c.sk',
        title: 'command /gui:',
        start: 10,
        end: 14,
        text: 'command /gui:\n\ttrigger:\n\t\topen chest inventory named "gui" to player',
        truncated: true
      },
      {
        path: 'd.sk',
        title: 'function gui():',
        start: 20,
        end: 22,
        text: 'function gui():\n\tset {_x} to gui\n\tsend {_x} to player'
      }
    ],
    files: {
      'a.sk': file('vanilla/one', []),
      'b.sk': file('vanilla/two', []),
      'c.sk': file('skbee/code', ['SkBee'], { errors: 2, groundTruth: '2.17.1' }),
      'd.sk': file('skquery/code', ['SkQuery'])
    }
  }
}

function loaderFor(index: ExampleIndex): ExampleLoader {
  return { loadExamples: async () => index }
}

test('search_examples başlık eşleşmesini gövdeden önce sıralar, limiti uygular ve meta bilgiyi yazar', async () => {
  const result = await tool.execute({ query: 'gui', limit: 3 }, makeContext())
  assert.match(result, /^3 examples for "gui":/)
  const positions = ['command /gui:', 'function gui():', 'on player click:'].map((title) => result.indexOf(title))
  assert.ok(positions.every((position) => position > 0), result)
  assert.ok(positions[0] < positions[2], result)
  assert.match(result, /^c\.sk:10-14 \(skbee\/code, MIT, requires: SkBee\)/m)
  assert.match(result, /2 lines in this file fail on Skript 2\.17\.1/)
  assert.match(result, /\(… block truncated; it continues to line 14\)/)
})

test('search_examples addon filtresi, seçili olmayan addon işareti ve sıralaması', async () => {
  const filtered = await tool.execute({ query: 'gui', addon: 'SkQuery' }, makeContext())
  assert.match(filtered, /requires SkQuery/)
  assert.doesNotMatch(filtered, /requires SkBee\)/)

  const selected = {
    ...makeContext(),
    languageService: { selectedAddons: [{ name: 'SkBee', version: '3.26.0' }] } as unknown as AgentLanguageService
  }
  const result = await tool.execute({ query: 'gui', limit: 10 }, selected)
  assert.match(result, /Snippets marked "not installed" need an addon this project does not use/)
  assert.match(result, /d\.sk:20-22[^\n]*requires: SkQuery \(not installed\)/)
  // SkQuery bloğu başlıkta "gui" geçse de seçili olmadığı için gövde eşleşmesinden sonra gelir
  assert.ok(result.indexOf('d.sk') > result.indexOf('b.sk'), result)

  const none = {
    ...makeContext(),
    languageService: { selectedAddons: [] } as unknown as AgentLanguageService
  }
  const demo = await tool.execute({ query: 'gui', limit: 10 }, none)
  assert.match(demo, /requires: SkBee \(not installed\)/)
  assert.match(demo, /not installed/)
})

test('search_examples boş sorguyu ve yorumlayıcısız durumu reddeder/çözer', async () => {
  await assert.rejects(tool.execute({ query: '   ' }, makeContext()), ToolError)
  const noService = await tool.execute({ query: 'gui' }, makeContext())
  assert.doesNotMatch(noService, /not installed/)
  assert.match(noService, /Snippets are real code/)
  assert.match(await tool.execute({ query: 'zzzz' }, makeContext()), /No examples match "zzzz"/)
})

test('gerçek corpus indeksi üretilebilir ve data/examples.json günceldir', async () => {
  const built = await buildExampleIndexFromSamples({ samplesDir: DEFAULT_SAMPLES_DIR })
  assert.ok(built.chunks.length > 300, `chunks: ${built.chunks.length}`)
  assert.equal(Object.keys(built.files).length, 79)
  assert.ok(built.chunks.every((chunk) => chunk.text.split('\n').length <= 60))
  assert.ok(built.chunks.every((chunk) => chunk.start >= 1 && chunk.end >= chunk.start))
  assert.ok(Object.values(built.files).some((file) => file.addons.length > 0))

  // Ground truth'ta hata veren satır indekse alınmamalı (ör. -fools2016.sk satır 49).
  const broken = 'vanilla/Gamealition--Survival-Skripts/-fools2016.sk'
  assert.ok(built.files[broken].errors > 0)
  assert.ok(!built.chunks.some((chunk) => chunk.path === broken && chunk.start <= 49 && chunk.end >= 49))

  const data = await readExampleIndex()
  assert.equal(data.chunks.length, built.chunks.length)
  assert.equal(Object.keys(data.files).length, Object.keys(built.files).length)
})

test('gerçek indeksle search_examples Skript kodu döndürür', async () => {
  const built = await buildExampleIndexFromSamples({ samplesDir: DEFAULT_SAMPLES_DIR })
  const realTools = new Map(createExampleTools(loaderFor(built)).map((entry) => [entry.name, entry]))
  const result = await realTools.get('search_examples')!.execute({ query: 'on join', limit: 2 }, makeContext())
  assert.match(result, /2 examples for "on join":/)
  assert.match(result, /```skript\n/)
  assert.match(result, /requires: /)
})
