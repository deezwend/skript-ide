import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createService } from './helpers'
import { SEMANTIC_TOKENS_LEGEND } from '../src/semantic-tokens'

interface DecodedToken {
  line: number
  character: number
  length: number
  type: string
  declaration: boolean
}

function decode(data: number[]): DecodedToken[] {
  const tokens: DecodedToken[] = []
  let line = 0
  let character = 0
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index]
    const deltaCharacter = data[index + 1]
    if (deltaLine === 0) character += deltaCharacter
    else {
      line += deltaLine
      character = deltaCharacter
    }
    tokens.push({
      line,
      character,
      length: data[index + 2],
      type: SEMANTIC_TOKENS_LEGEND.tokenTypes[data[index + 3]] ?? '?',
      declaration: (data[index + 4] & 1) === 1
    })
  }
  return tokens
}

test('semantic tokens: fonksiyon, parametre, değişken ve option', async () => {
  const service = createService()
  const uri = 'file:///test/semantic.sk'
  const text = [
    'options:',
    '    isim: Merhaba',
    '',
    'function benim(a: number) :: text:',
    '    return "x"',
    '',
    'on join:',
    '    set {sayac} to benim(1)',
    '    send "{@isim}" to player'
  ].join('\n')
  service.openDocument(uri, text, 1)

  const result = await service.getSemanticTokens(uri)
  assert.equal(result.data.length % 5, 0)
  const tokens = decode(result.data)

  const functionDeclaration = tokens.find(
    (token) => token.type === 'function' && token.declaration && token.line === 3
  )
  assert.ok(functionDeclaration)
  assert.equal(functionDeclaration?.character, 9)
  assert.equal(functionDeclaration?.length, 5)

  const parameter = tokens.find((token) => token.type === 'parameter' && token.declaration)
  assert.ok(parameter)
  assert.equal(parameter?.line, 3)

  const call = tokens.find(
    (token) => token.type === 'function' && !token.declaration && token.line === 7
  )
  assert.ok(call)
  assert.equal(call?.character, 19)

  const variable = tokens.find((token) => token.type === 'variable' && token.line === 7)
  assert.ok(variable)
  assert.equal(variable?.character, 8)

  const optionReference = tokens.find((token) => token.type === 'macro' && token.line === 8)
  assert.ok(optionReference)
  assert.equal(optionReference?.character, 10)
})

test('bilinmeyen dosyada boş semantic tokens', async () => {
  const service = createService()
  const result = await service.getSemanticTokens('file:///test/yok.sk')
  assert.deepEqual([...result.data], [])
})
