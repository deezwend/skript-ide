import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolLineExplanation } from '../src/tool'
import { explainLineTool } from '../src/tools/skript/explain-line'
import { makeContext, makeProject } from './helpers'
import { fakeLanguageService } from './fakes/language-service'

const MATCHED: ToolLineExplanation = {
  line: 1,
  text: 'send "hi" to player',
  context: 'statement',
  matches: [
    {
      kind: 'effect',
      id: 'EffMessage',
      name: 'Message',
      addon: 'Skript',
      pattern: '(message|send [message[s]]) %objects% [to %audiences%]',
      patternIndex: 0,
      confidence: 'exact',
      placeholders: [
        {
          text: '"hi"',
          types: ['objects'],
          nullable: false,
          literalOnly: false,
          changeable: false,
          plural: true,
          expression: [
            {
              kind: 'expression',
              id: 'literal:string',
              name: 'Text',
              pattern: '',
              patternIndex: 0,
              confidence: 'exact',
              placeholders: []
            }
          ]
        },
        {
          text: 'player',
          types: ['audiences'],
          nullable: false,
          literalOnly: false,
          changeable: false,
          plural: true
        }
      ]
    }
  ],
  candidates: [],
  otherKinds: []
}

function contextFor(explanation: ToolLineExplanation | null) {
  return { ...makeContext(), languageService: fakeLanguageService({ explanation }) }
}

test('explain_line kod girdisinde kaydı, pattern\'i ve yer tutucuları yazar', async () => {
  const result = await explainLineTool.execute({ code: 'send "hi" to player', context: 'on join:' }, contextFor(MATCHED))
  assert.equal(
    result,
    [
      'Code (context "on join:"): send "hi" to player',
      'Matches (1):',
      '  [effect] Message (id: EffMessage, Skript) — exact',
      '    pattern: (message|send [message[s]]) %objects% [to %audiences%]',
      '    "hi" (objects, plural) → [expression] Text (id: literal:string)',
      '    player (audiences, plural)'
    ].join('\n')
  )
})

test('explain_line eşleşmeyen satırda adayları ve nedenini yazar', async () => {
  const missing: ToolLineExplanation = {
    line: 1,
    text: 'brodcast "hi"',
    context: 'statement',
    matches: [],
    candidates: [
      {
        kind: 'effect',
        id: 'EffBroadcast',
        name: 'Broadcast',
        addon: 'Skript',
        pattern: 'broadcast %objects% [(to|in) %worlds%]',
        missing: ['broadcast'],
        reason: 'missing "broadcast" (close to "brodcast")'
      }
    ],
    otherKinds: [{ kind: 'condition', id: 'CondIsOp', name: 'Is Op' }]
  }
  const result = await explainLineTool.execute({ code: 'brodcast "hi"' }, contextFor(missing))
  assert.match(result, /^Code: brodcast "hi"\nNo syntax matches this statement in Skript 2\.17\.1\.\nClosest patterns:\n/)
  assert.match(result, /\[effect\] Broadcast \(id: EffBroadcast, Skript\) — missing "broadcast" \(close to "brodcast"\)/)
  assert.match(result, /pattern: broadcast %objects% \[\(to\|in\) %worlds%\]/)
  assert.match(result, /Note: the line matches \[condition\] Is Op \(id: CondIsOp\) instead/)
})

test('explain_line boş satırı ve dosyadan satırı okur', async () => {
  const blank: ToolLineExplanation = { line: 3, text: '', context: null, matches: [], candidates: [], otherKinds: [] }
  await assert.rejects(explainLineTool.execute({ code: '   ' }, contextFor(blank)), /code must not be empty/)

  const { root, cleanup } = await makeProject({ 'a.sk': 'on join:\n\tsend "x" to player\n' })
  try {
    const ctx = {
      ...makeContext({ projectRoot: root }),
      languageService: fakeLanguageService({ explanation: { ...MATCHED, line: 2, text: '\tsend "x" to player' } })
    }
    const result = await explainLineTool.execute({ path: 'a.sk', line: 2 }, ctx)
    assert.match(result, /^a\.sk:2\nMatches \(1\):\n  \[effect\] Message/)
  } finally {
    await cleanup()
  }
})

test('explain_line girdi doğrulaması yapar', async () => {
  const ctx = contextFor(MATCHED)
  await assert.rejects(explainLineTool.execute({}, ctx), /Pass either path and line, or code/)
  await assert.rejects(explainLineTool.execute({ path: 'a.sk', line: 1, code: 'x' }, ctx), /not both/)
  await assert.rejects(explainLineTool.execute({ path: 'a.sk' }, ctx), /line is required/)
  await assert.rejects(explainLineTool.execute({ path: 'a.sk', line: 0 }, ctx), /positive integer/)
  await assert.rejects(explainLineTool.execute({ code: 'x' }, makeContext()), /language service is not available/)

  const { root, cleanup } = await makeProject({ 'a.sk': 'on join:\n', 'notes.txt': 'x\n' })
  try {
    const projectCtx = {
      ...makeContext({ projectRoot: root }),
      languageService: fakeLanguageService({ explanation: MATCHED })
    }
    await assert.rejects(explainLineTool.execute({ path: 'a.sk', line: 9 }, projectCtx), /fewer than 9 lines/)
    await assert.rejects(explainLineTool.execute({ path: 'notes.txt', line: 1 }, projectCtx), /not a \.sk file/)
  } finally {
    await cleanup()
  }
})
