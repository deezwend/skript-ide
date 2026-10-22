import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver'
import { createService } from './helpers'

function labels(items: { label: string }[]): string[] {
  return items.map((item) => item.label)
}

test('üst düzeyde olay ve yapı tamamlamaları', async () => {
  const service = createService()
  const uri = 'file:///test/top.sk'
  service.openDocument(uri, '', 1)

  const items = await service.getCompletions(uri, { line: 0, character: 0 })
  const kinds = new Set(items.map((item) => item.kind))
  assert.ok(kinds.has(CompletionItemKind.Event), labels(items).join(' | '))
  assert.ok(kinds.has(CompletionItemKind.Module), labels(items).join(' | '))
  assert.ok(items.some((item) => item.label === 'join'))
  assert.ok(items.some((item) => item.label.startsWith('command')))
})

test('gövdede efekt/koşul/bölüm; olaylar listelenmez', async () => {
  const service = createService()
  const uri = 'file:///test/body.sk'
  const text = ['on join:', '    o'].join('\n')
  service.openDocument(uri, text, 1)

  const items = await service.getCompletions(uri, { line: 1, character: 5 })
  assert.ok(items.some((item) => item.kind === CompletionItemKind.Keyword && item.label.startsWith('send')))
  assert.ok(items.some((item) => item.label.startsWith('loop')))
  assert.ok(!items.some((item) => item.label === 'join'))
})

test('ifade bağlamında expression ve fonksiyonlar', async () => {
  const service = createService()
  const uri = 'file:///test/expr.sk'
  const text = ['on join:', '    send '].join('\n')
  service.openDocument(uri, text, 1)

  const items = await service.getCompletions(uri, { line: 1, character: 9 })
  const found = labels(items)
  assert.ok(found.includes('player'), found.join(' | '))
  const floor = items.find((item) => item.kind === CompletionItemKind.Function && item.label.startsWith('floor'))
  assert.ok(floor, found.join(' | '))
  assert.equal(floor?.label, 'floor(n: number)')
  assert.ok(floor?.textEdit && 'newText' in floor.textEdit)
  assert.equal(floor.textEdit.newText, 'floor(${1:n})')
})

test('çalışma alanı fonksiyonu imzasıyla tamamlanır', async () => {
  const service = createService()
  service.openDocument(
    'file:///test/lib.sk',
    ['function benimFonksiyonum(a: number) :: text:', '    return "x"'].join('\n'),
    1
  )
  const uri = 'file:///test/kullan.sk'
  service.openDocument(uri, ['on join:', '    set x to '].join('\n'), 1)

  const items = await service.getCompletions(uri, { line: 1, character: 13 })
  const item = items.find((candidate) => candidate.label.startsWith('benimFonksiyonum('))
  assert.ok(item, labels(items).join(' | '))
  assert.equal(item?.insertTextFormat, InsertTextFormat.Snippet)
  const edit = item?.textEdit
  assert.ok(edit && 'newText' in edit)
  assert.match(edit.newText, /\$\{1:a\}/)
})

test('süslü parantezde değişken tamamlaması', async () => {
  const service = createService()
  const uri = 'file:///test/vars.sh'
  const text = ['on join:', '    set {sayac} to 1', '    send {'].join('\n')
  service.openDocument(uri, text, 1)

  const items = await service.getCompletions(uri, { line: 2, character: 10 })
  const item = items.find((candidate) => candidate.label === '{sayac}')
  assert.ok(item, labels(items).join(' | '))
  assert.equal(item?.kind, CompletionItemKind.Variable)
  const edit = item?.textEdit
  assert.ok(edit && 'newText' in edit)
  assert.equal(edit.newText, 'sayac')
})

test('{@ yazınca option tamamlaması', async () => {
  const service = createService()
  const uri = 'file:///test/options.sk'
  const text = ['options:', '    isim: Merhaba', '', 'on join:', '    send "{@'].join('\n')
  service.openDocument(uri, text, 1)

  const items = await service.getCompletions(uri, { line: 4, character: 12 })
  const item = items.find((candidate) => candidate.label === '{@isim}')
  assert.ok(item, labels(items).join(' | '))
  assert.equal(item?.kind, CompletionItemKind.Constant)
})

test('komut gövdesinde komut girişleri tamamlanır', async () => {
  const service = createService()
  const uri = 'file:///test/command.sk'
  const text = ['command /heal:', '    per'].join('\n')
  service.openDocument(uri, text, 1)

  const items = await service.getCompletions(uri, { line: 1, character: 7 })
  const found = labels(items)
  assert.ok(found.includes('permission:'), found.join(' | '))
  assert.ok(found.includes('trigger:'), found.join(' | '))
})

test('options, variables ve aliases gövdelerinde effect/koşul önerilmez', async () => {
  const service = createService()
  const cases: { uri: string; text: string; line: number; character: number }[] = [
    {
      uri: 'file:///test/c-options.sk',
      text: ['options:', '    prefix: Merhaba', '    '].join('\n'),
      line: 2,
      character: 4
    },
    {
      uri: 'file:///test/c-variables.sk',
      text: ['variables:', '    {x} = 1', '    '].join('\n'),
      line: 2,
      character: 4
    },
    {
      uri: 'file:///test/c-aliases.sk',
      text: ['aliases:', '    kisa = /kisa', '    '].join('\n'),
      line: 2,
      character: 4
    }
  ]

  for (const item of cases) {
    service.openDocument(item.uri, item.text, 1)
    const items = await service.getCompletions(item.uri, {
      line: item.line,
      character: item.character
    })
    assert.deepEqual(labels(items), [], `${item.uri}: ${labels(items).join(' | ')}`)
  }
})

test('komut girdisi değerinde ve trigger başlığında gövde önerilmez', async () => {
  const service = createService()
  const uri = 'file:///test/c-command-value.sk'
  const text = ['command /heal:', '    permission: ', '    trigger:', '        '].join('\n')
  service.openDocument(uri, text, 1)

  const permissionValue = await service.getCompletions(uri, { line: 1, character: 16 })
  assert.deepEqual(labels(permissionValue), [], labels(permissionValue).join(' | '))

  const triggerHeader = await service.getCompletions(uri, { line: 2, character: 13 })
  assert.deepEqual(labels(triggerHeader), [], labels(triggerHeader).join(' | '))

  const triggerBody = await service.getCompletions(uri, { line: 3, character: 8 })
  assert.ok(
    triggerBody.some((item) => item.label.startsWith('send')),
    labels(triggerBody).join(' | ')
  )
})

test('tamamlamalar snippet biçimindedir', async () => {
  const service = createService()
  const uri = 'file:///test/snippet.sk'
  service.openDocument(uri, 'on join:\n    se', 1)

  const items = await service.getCompletions(uri, { line: 1, character: 6 })
  const send = items.find((item) => item.label.startsWith('send'))
  assert.ok(send)
  assert.equal(send?.insertTextFormat, InsertTextFormat.Snippet)
  assert.ok(send?.textEdit && 'newText' in send.textEdit && send.textEdit.newText.includes('${1:'))
})
