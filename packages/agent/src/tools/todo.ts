/**
 * `update_todos`: agent'ın çok adımlı işlerde tuttuğu plan. Dosyaya yazmadığı için `read` izniyle
 * çalışır; liste arayüze `ToolContext.onTodosChanged` üzerinden iletilir.
 */
import { toolCalls, type Message } from '../messages'
import { defineTool, ToolError, type Todo, type TodoStatus } from '../tool'

export const MAX_TODOS = 20

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

export const todoTool = defineTool<{ todos: Todo[] }>({
  name: 'update_todos',
  description:
    'Replace the task list for the current work. Use it for multi-step tasks (3 or more steps, or changes across several files): ' +
    'put the whole plan in one call, mark a step in_progress before starting it and completed as soon as it is done. ' +
    'Do not use it for simple single-step requests.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list, in order. It replaces the previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short description of the step.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['content', 'status'],
          additionalProperties: false
        }
      }
    },
    required: ['todos'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ todos }, ctx) {
    if (!Array.isArray(todos)) throw new ToolError('todos must be an array.')
    if (todos.length > MAX_TODOS) throw new ToolError(`At most ${MAX_TODOS} todos are allowed.`)
    let inProgress = 0
    const list = todos.map((todo, index): Todo => {
      const status = todo?.status
      if (!STATUSES.includes(status)) throw new ToolError(`todos[${index}].status must be one of: ${STATUSES.join(', ')}.`)
      if (typeof todo.content !== 'string' || !todo.content.trim()) throw new ToolError(`todos[${index}].content is empty.`)
      if (status === 'in_progress') inProgress++
      return { content: todo.content.trim(), status }
    })
    if (inProgress > 1) throw new ToolError('At most one todo can be in_progress.')

    ctx.onTodosChanged?.(list)
    const remaining = list.filter((todo) => todo.status !== 'completed').length
    return `Todo list updated: ${list.length} item(s), ${remaining} remaining.`
  }
})

/** Geçmişteki son `update_todos` çağrısının listesi; yoksa boş. Arayüz yeniden açılınca listeyi bundan kurar. */
export function latestTodos(messages: readonly Message[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = toolCalls(messages[i]).filter((call) => call.name === 'update_todos')
    for (let j = calls.length - 1; j >= 0; j--) {
      const parsed = parseTodos(calls[j].input)
      if (parsed) return parsed
    }
  }
  return []
}

/** Tool girdisini doğrular; bozuk kayıtta `null`. */
function parseTodos(input: unknown): Todo[] | null {
  const raw = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(raw) || raw.length > MAX_TODOS) return null
  const todos: Todo[] = []
  for (const item of raw) {
    const entry = item as { content?: unknown; status?: unknown } | null
    if (typeof entry?.content !== 'string' || !entry.content.trim()) return null
    if (!STATUSES.includes(entry.status as TodoStatus)) return null
    todos.push({ content: entry.content, status: entry.status as TodoStatus })
  }
  return todos
}
