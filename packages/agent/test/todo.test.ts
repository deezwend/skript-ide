import test from 'node:test'
import assert from 'node:assert/strict'
import { latestTodos, MAX_TODOS, todoTool, type Message, type Todo } from '../src/index'
import { makeContext } from './helpers'

test('update_todos listeyi değiştirir, callback çağrılır ve kalan sayıyı döndürür', async () => {
  let received: readonly Todo[] | undefined
  const context = { ...makeContext(), onTodosChanged: (todos: readonly Todo[]) => (received = todos) }
  const todos: Todo[] = [
    { content: 'Read the scripts', status: 'completed' },
    { content: 'Fix the parser', status: 'in_progress' },
    { content: 'Run diagnostics', status: 'pending' }
  ]
  const result = await todoTool.execute({ todos }, context)
  assert.deepEqual(received, todos)
  assert.match(result, /3 item/)
  assert.match(result, /2 remaining/)
  assert.equal(todoTool.permission, 'read')
})

test('en fazla bir madde in_progress olabilir', async () => {
  await assert.rejects(
    todoTool.execute(
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' }
        ]
      },
      makeContext()
    ),
    /at most one todo can be in_progress/i
  )
})

test('en fazla 20 madde kabul edilir', async () => {
  const todos = Array.from({ length: MAX_TODOS + 1 }, (_, i) => ({ content: `step ${i}`, status: 'pending' as const }))
  await assert.rejects(todoTool.execute({ todos }, makeContext()), /at most 20/i)
})

test('boş içerik ve geçersiz durum reddedilir', async () => {
  await assert.rejects(todoTool.execute({ todos: [{ content: ' ', status: 'pending' }] }, makeContext()), /empty/)
  await assert.rejects(
    todoTool.execute({ todos: [{ content: 'x', status: 'done' as never }] }, makeContext()),
    /status must be one of/
  )
})

test('boş liste planı temizler', async () => {
  let received: readonly Todo[] | undefined
  const context = { ...makeContext(), onTodosChanged: (todos: readonly Todo[]) => (received = todos) }
  const result = await todoTool.execute({ todos: [] }, context)
  assert.deepEqual(received, [])
  assert.match(result, /0 remaining/)
})

test('konuşma geçmişindeki son update_todos çağrısından liste yeniden kurulur', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'update_todos', input: { todos: [{ content: 'old', status: 'pending' }] } }] },
    { role: 'user', content: [{ type: 'tool_result', callId: 'a', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'b', name: 'update_todos', input: { todos: [{ content: 'new', status: 'completed' }] } }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'read_file', input: { path: 'a.sk' } }] }
  ]
  assert.deepEqual(latestTodos(messages), [{ content: 'new', status: 'completed' }])
  assert.deepEqual(latestTodos([]), [])
})

test('bozuk update_todos girdisi geçmişten listeye alınmaz', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'update_todos', input: { todos: [{ content: 'x', status: 'nope' }] } }] }
  ]
  assert.deepEqual(latestTodos(messages), [])
})
