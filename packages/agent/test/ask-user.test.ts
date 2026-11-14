import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UserQuestion } from '../src/tool'
import { askUserQuestionTool } from '../src/tools/ask-user'
import { makeContext } from './helpers'

const QUESTION: UserQuestion = {
  question: 'Which storage?',
  header: 'Storage',
  options: [{ label: 'YAML', description: 'simple' }, { label: 'MySQL' }]
}

test('ask_user_question returns the answers per question', async () => {
  let asked: readonly UserQuestion[] = []
  const context = {
    ...makeContext(),
    askUser: async (questions: readonly UserQuestion[]) => {
      asked = questions
      return [['YAML']]
    }
  }
  const result = await askUserQuestionTool.execute({ questions: [QUESTION] }, context)
  assert.equal(result, 'Q: Which storage?\nA: YAML')
  assert.equal(asked[0].multiSelect, false)
  assert.equal(askUserQuestionTool.permission, 'read')
})

test('ask_user_question reports a dismissed question', async () => {
  const context = { ...makeContext(), askUser: async () => null }
  assert.match(await askUserQuestionTool.execute({ questions: [QUESTION] }, context), /dismissed/)
})

test('ask_user_question rejects bad input and unavailable UI', async () => {
  const context = { ...makeContext(), askUser: async () => [[]] }
  await assert.rejects(askUserQuestionTool.execute({ questions: [] }, context), /non-empty/)
  await assert.rejects(
    askUserQuestionTool.execute({ questions: [{ ...QUESTION, options: [{ label: 'only' }] }] }, context),
    /options must have/
  )
  await assert.rejects(
    askUserQuestionTool.execute({ questions: [{ ...QUESTION, options: [{ label: 'a' }, { label: 'a' }] }] }, context),
    /twice/
  )
  await assert.rejects(askUserQuestionTool.execute({ questions: [QUESTION] }, makeContext()), /not available/)
})
