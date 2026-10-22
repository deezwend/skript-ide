import test from 'node:test'
import assert from 'node:assert/strict'
import { editorContextText, isEditorContext, parseEditorContextInput } from '../src/index'

test('editör bağlamı dosya, imleç ve seçimi blok olarak yazar', () => {
  const text = editorContextText({
    path: 'scripts/main.sk',
    dirty: true,
    line: 3,
    column: 5,
    selection: { startLine: 2, endLine: 3, text: 'on join:\n\tsend "hi"' }
  })
  assert.equal(
    text,
    '<editor_context>\nActive file: scripts/main.sk (has unsaved changes; the file on disk is older)\n' +
      'Cursor: line 3, column 5\nSelection (lines 2-3):\n```\non join:\n\tsend "hi"\n```\n</editor_context>'
  )
  assert.ok(isEditorContext(text))
  assert.ok(!isEditorContext('fix this'))
})

test('uzun seçim kesilir', () => {
  const text = editorContextText({ path: 'a.sk', line: 1, column: 1, selection: { startLine: 1, endLine: 1, text: 'x'.repeat(9000) } })
  assert.ok(text.includes('… (selection truncated)'))
  assert.ok(text.length < 8300)
})

test('IPC girdisi doğrulanır', () => {
  assert.equal(parseEditorContextInput(null), null)
  assert.equal(parseEditorContextInput({ path: 'a.sk', line: 0, column: 1 }), null)
  assert.equal(parseEditorContextInput({ path: '', line: 1, column: 1 }), null)
  assert.deepEqual(parseEditorContextInput({ path: 'a.sk', line: 2, column: 1, untitled: 'yes', selection: { startLine: 'x', endLine: 2, text: 'a' } }), {
    path: 'a.sk',
    line: 2,
    column: 1,
    untitled: false,
    dirty: false
  })
})
