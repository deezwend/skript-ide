import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MODES,
  coreTools,
  createSkriptTools,
  geometryTools,
  isAgentMode,
  modeInstructions,
  todoTool,
  toolAllowedInMode
} from '../src/index'

const allTools = [...coreTools, ...createSkriptTools(), ...geometryTools, todoTool].map((tool) => tool.name)

test('quick mode hides server, test, example and todo tools', () => {
  const quick = allTools.filter((name) => toolAllowedInMode('quick', name))
  for (const hidden of ['validate_on_server', 'test_script', 'run_server_command', 'get_server_log', 'search_examples', 'update_todos']) {
    assert.ok(allTools.includes(hidden), `${hidden} should exist`)
    assert.ok(!quick.includes(hidden), `${hidden} should be hidden in quick mode`)
  }
  assert.ok(quick.includes('edit_file'))
  assert.ok(quick.includes('get_diagnostics'))
})

test('standard and thorough modes keep every tool', () => {
  for (const mode of ['standard', 'thorough'] as const) {
    assert.deepEqual(allTools.filter((name) => toolAllowedInMode(mode, name)), allTools)
  }
})

test('every mode has its own instructions', () => {
  const texts = AGENT_MODES.map(modeInstructions)
  assert.equal(new Set(texts).size, AGENT_MODES.length)
  assert.ok(isAgentMode('quick'))
  assert.ok(!isAgentMode('pro'))
})
