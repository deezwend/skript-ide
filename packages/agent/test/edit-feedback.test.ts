import test from 'node:test'
import assert from 'node:assert/strict'
import { editFileTool, multiEditTool, writeFileTool } from '../src/index'
import type { ToolDiagnostic } from '../src/index'
import { makeContext, makeProject } from './helpers'
import { fakeLanguageService, type FakeLanguageServiceOptions } from './fakes/language-service'

/** Metindeki işaretli satırlardan tanı üretir: `BROKEN` hata, `WARN` uyarı sayılır. */
function diagnosticsFrom(text: string): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = []
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (line.includes('BROKEN')) {
      out.push({
        range: { start: { line: index, character: 1 }, end: { line: index, character: 8 } },
        severity: 1,
        message: "Skript can't understand this line",
        code: 'unknown-syntax'
      })
    }
    if (line.includes('WARN')) {
      out.push({
        range: { start: { line: index, character: 1 }, end: { line: index, character: 5 } },
        severity: 2,
        message: 'Function "warn" is not defined',
        code: 'undefined-function'
      })
    }
  })
  return out
}

function contextWith(root: string, options: FakeLanguageServiceOptions = {}) {
  return {
    ...makeContext({ projectRoot: root }),
    languageService: fakeLanguageService({ diagnostics: (_uri, text) => diagnosticsFrom(text), ...options })
  }
}

test('edit_file yeni sorunları düzenlemenin sonucuna ekler', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tsend "hi" to player\n' })
  try {
    const result = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tsend "hi" to player', new_text: '\tBROKEN thing' },
      contextWith(root)
    )
    assert.equal(
      result,
      'Edited main.sk.\n' +
        'Diagnostics for main.sk: 1 new error, 0 new warnings.\n' +
        "main.sk:2:2: error: Skript can't understand this line [unknown-syntax]"
    )
  } finally {
    await cleanup()
  }
})

test('edit_file düzelttiği hataları bildirir, dil servisi yoksa sonuç değişmez', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tBROKEN thing\n' })
  try {
    const result = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tBROKEN thing', new_text: '\tsend "ok" to player' },
      contextWith(root)
    )
    assert.equal(result, 'Edited main.sk.\nNo new problems in main.sk (1 error fixed).')

    const plain = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tsend "ok" to player', new_text: '\tsend "hey" to player' },
      makeContext({ projectRoot: root })
    )
    assert.equal(plain, 'Edited main.sk.')
  } finally {
    await cleanup()
  }
})

test('satır numarası kayan eski tanı yeni sorun sayılmaz; sayımlar doğru', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tWARN old\n' })
  try {
    const shifted = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tWARN old', new_text: '\tsend "ok" to player\n\tWARN old' },
      contextWith(root)
    )
    assert.equal(shifted, 'Edited main.sk.\nNo new problems in main.sk (0 existing errors, 1 existing warning remain).')

    const mixed = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tsend "ok" to player', new_text: '\tBROKEN thing' },
      contextWith(root)
    )
    assert.match(mixed, /Diagnostics for main\.sk: 1 new error, 0 new warnings\.\nmain\.sk:2:2: error: Skript can't understand this line \[unknown-syntax\]$/)
  } finally {
    await cleanup()
  }
})

test('yeni uyarı ve hata sayıları ayrı ayrı verilir', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tBROKEN a\n\tWARN b\n\tsend "x"\n' })
  try {
    const result = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tsend "x"', new_text: '\tWARN c\n\tBROKEN d' },
      contextWith(root)
    )
    const [summary, header, ...lines] = result.split('\n')
    assert.equal(summary, 'Edited main.sk.')
    assert.equal(header, 'Diagnostics for main.sk: 1 new error, 1 new warning.')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /^main\.sk:4:\d+: warning: Function "warn" is not defined \[undefined-function\]$/)
    assert.match(lines[1]!, /^main\.sk:5:\d+: error: Skript can't understand this line \[unknown-syntax\]$/)
  } finally {
    await cleanup()
  }
})

test('multi_edit ve write_file da geri bildirim ekler; .sk olmayan dosya sessizdir', async () => {
  const { root, cleanup } = await makeProject({
    'main.sk': 'on join:\n\tsend "x" to player\n',
    'notes.txt': 'hello\n'
  })
  try {
    const ctx = contextWith(root)
    const multi = await multiEditTool.execute(
      {
        path: 'main.sk',
        edits: [
          { old_text: '\tsend "x" to player', new_text: '\tBROKEN one' },
          { old_text: '\tBROKEN one', new_text: '\tWARN two' }
        ]
      },
      ctx
    )
    assert.match(multi, /^Edited main\.sk \(2 replacements\)\.\nDiagnostics for main\.sk: 0 new errors, 1 new warning\./)

    const written = await writeFileTool.execute({ path: 'lib/new.sk', content: 'on join:\n\tBROKEN x\n' }, ctx)
    assert.match(written, /^Created lib\/new\.sk \(3 lines\)\.\nDiagnostics for lib\/new\.sk: 1 new error, 0 new warnings\./)

    assert.equal(await editFileTool.execute({ path: 'notes.txt', old_text: 'hello', new_text: 'bye' }, ctx), 'Edited notes.txt.')
  } finally {
    await cleanup()
  }
})

test('dil servisi hata verirse düzenleme sonucu bozulmaz', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tsend "x" to player\n' })
  try {
    const ctx = contextWith(root, { failDiagnostics: true })
    assert.equal(
      await editFileTool.execute({ path: 'main.sk', old_text: '\tsend "x" to player', new_text: '\tsend "y" to player' }, ctx),
      'Edited main.sk.'
    )
  } finally {
    await cleanup()
  }
})

test('hızlı düzeltme varsa tanı satırına fix ipucu eklenir', async () => {
  const { root, cleanup } = await makeProject({ 'main.sk': 'on join:\n\tsend "x" to player\n' })
  try {
    const result = await editFileTool.execute(
      { path: 'main.sk', old_text: '\tsend "x" to player', new_text: '\tBROKEN x' },
      contextWith(root, { actions: [{ title: 'Change to "say"' }] })
    )
    assert.match(result, / \[unknown-syntax\] \(fix: Change to "say"\)$/)
  } finally {
    await cleanup()
  }
})
