import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolError, type SubagentModel, type SubagentRequest } from '../src/tool'
import { listModelsTool, resolveSubagentEffort, resolveSubagentModel, runSubagentTool } from '../src/tools/subagent'
import { makeContext } from './helpers'

const MODELS: SubagentModel[] = [
  { id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5', effortLevels: ['low', 'medium', 'high'], current: true },
  { id: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', effortLevels: [], current: false },
  { id: 'openrouter/claude-haiku-5-5', name: 'Claude Haiku 5.5 (OR)', effortLevels: [], current: false }
]

function contextWith(runs: SubagentRequest[]) {
  return {
    ...makeContext(),
    subagents: {
      models: async () => MODELS,
      run: async (request: SubagentRequest) => {
        runs.push(request)
        return `done: ${request.description}`
      }
    }
  }
}

test('resolveSubagentModel matches full id, bare id and name', () => {
  assert.equal(resolveSubagentModel(MODELS, 'Anthropic/Claude-Opus-5-5').id, 'anthropic/claude-opus-5-5')
  assert.equal(resolveSubagentModel(MODELS, 'claude-opus-5-5').id, 'anthropic/claude-opus-5-5')
  assert.equal(resolveSubagentModel(MODELS, 'claude opus 5.5').id, 'anthropic/claude-opus-5-5')
  assert.throws(() => resolveSubagentModel(MODELS, 'claude-haiku-5-5'), /ambiguous/)
  assert.throws(() => resolveSubagentModel(MODELS, 'gpt-9'), /list_models/)
})

test('resolveSubagentEffort validates against the model', () => {
  assert.equal(resolveSubagentEffort(MODELS[0], 'HIGH'), 'high')
  assert.equal(resolveSubagentEffort(MODELS[0], 'default'), undefined)
  assert.equal(resolveSubagentEffort(MODELS[0], undefined), undefined)
  assert.throws(() => resolveSubagentEffort(MODELS[0], 'max'), /low, medium, high/)
  assert.throws(() => resolveSubagentEffort(MODELS[1], 'low'), /no effort/)
})

test('run_subagent passes the resolved model and effort to the runner', async () => {
  const runs: SubagentRequest[] = []
  const ctx = contextWith(runs)
  const result = await runSubagentTool.execute({ description: ' Find usages ', prompt: 'Look', model: 'anthropic/claude-haiku-5-5' }, ctx)
  assert.equal(result, 'done: Find usages')
  assert.deepEqual(runs[0], { description: 'Find usages', prompt: 'Look', modelId: 'anthropic/claude-haiku-5-5', effort: undefined })

  await runSubagentTool.execute({ description: 'x', prompt: 'y' }, ctx)
  assert.equal(runs[1].modelId, undefined)

  // Yalnızca effort: mevcut modelle
  await runSubagentTool.execute({ description: 'x', prompt: 'y', effort: 'low' }, ctx)
  assert.deepEqual([runs[2].modelId, runs[2].effort], ['anthropic/claude-opus-5-5', 'low'])
})

test('run_subagent and list_models fail without a runner', async () => {
  await assert.rejects(runSubagentTool.execute({ description: 'x', prompt: 'y' }, makeContext()), ToolError)
  await assert.rejects(listModelsTool.execute({}, makeContext()), ToolError)
})

test('list_models filters by words and marks the current model', async () => {
  const ctx = contextWith([])
  const all = await listModelsTool.execute({}, ctx)
  assert.match(all, /3 model\(s\)/)
  assert.match(all, /claude-opus-5-5 .*effort: low, medium, high · \(current model\)/)
  const filtered = await listModelsTool.execute({ query: 'haiku openrouter' }, ctx)
  assert.match(filtered, /1 model\(s\)/)
  assert.match(await listModelsTool.execute({ query: 'gpt' }, ctx), /No model matches/)
})
