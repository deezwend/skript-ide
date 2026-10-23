/**
 * `list_models` / `run_subagent`: ana agent bir işi kendi bağlamı olan bir alt agent'a verir.
 * Alt agent'ı çalıştırmak masaüstü uygulamasının işidir (`ToolContext.subagents`); burada yalnızca
 * girdinin doğrulanması ve model/effort seçiminin çözülmesi var.
 */
import { defineTool, ToolError, type SubagentModel, type SubagentRunner, type ToolContext } from '../tool'

/** Alt agent'a verilmeyen tool'lar: iç içe alt agent açılmaz. */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ['list_models', 'run_subagent']

const DEFAULT_LIST_LIMIT = 40
const MAX_LIST_LIMIT = 200

function runnerOf(ctx: ToolContext): SubagentRunner {
  if (!ctx.subagents) throw new ToolError('Subagents are not available here.')
  return ctx.subagents
}

/**
 * Modeli `sağlayıcı/model` kimliğiyle, yalnızca model kimliğiyle ya da adıyla bulur (büyük/küçük harf
 * duyarsız). Birden çok sağlayıcıda aynı kimlik varsa tam kimlik istenir.
 */
export function resolveSubagentModel(models: readonly SubagentModel[], query: string): SubagentModel {
  const wanted = query.trim().toLowerCase()
  if (!wanted) throw new ToolError('model is empty.')
  const exact = models.find((model) => model.id.toLowerCase() === wanted)
  if (exact) return exact
  const byModelId = models.filter((model) => model.id.slice(model.id.indexOf('/') + 1).toLowerCase() === wanted)
  const candidates = byModelId.length ? byModelId : models.filter((model) => model.name.toLowerCase() === wanted)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new ToolError(`"${query}" is ambiguous; use one of: ${candidates.map((model) => model.id).join(', ')}`)
  }
  throw new ToolError(`Unknown model "${query}". Call list_models to see the models you can use.`)
}

/** Effort seviyesini modelin desteklediklerine göre doğrular; boşsa sağlayıcının varsayılanı. */
export function resolveSubagentEffort(model: SubagentModel, effort: string | undefined): string | undefined {
  const wanted = effort?.trim().toLowerCase()
  if (!wanted || wanted === 'default') return undefined
  if (model.effortLevels.length === 0) throw new ToolError(`${model.id} has no effort setting; omit effort.`)
  const level = model.effortLevels.find((candidate) => candidate.toLowerCase() === wanted)
  if (!level) throw new ToolError(`${model.id} supports effort: ${model.effortLevels.join(', ')}.`)
  return level
}

function modelLine(model: SubagentModel): string {
  const parts = [model.id]
  if (model.name !== model.id) parts.push(model.name)
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k context`)
  if (model.cost) parts.push(`$${model.cost.input}/$${model.cost.output} per 1M in/out`)
  parts.push(model.effortLevels.length ? `effort: ${model.effortLevels.join(', ')}` : 'no effort setting')
  if (model.current) parts.push('(current model)')
  return `- ${parts.join(' · ')}`
}

export const listModelsTool = defineTool<{ query?: string; limit?: number }>({
  name: 'list_models',
  description:
    'List the models (and their effort levels) the user has set up, which run_subagent can use. ' +
    'Filter by words in the id or name, e.g. "claude" or "gpt mini".',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words that must appear in the model id or name (case-insensitive). Empty lists all.' },
      limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).` }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ query = '', limit = DEFAULT_LIST_LIMIT }, ctx) {
    const models = await runnerOf(ctx).models()
    if (models.length === 0) return 'No models are set up.'
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = models.filter((model) => words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)))
    if (matches.length === 0) return `No model matches "${query.trim()}".`
    const max = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)))
    const more = matches.length > max ? `\n… ${matches.length - max} more; refine the query or raise limit.` : ''
    return `${matches.length} model(s):\n${matches.slice(0, max).map(modelLine).join('\n')}${more}`
  }
})

export const runSubagentTool = defineTool<{ description: string; prompt: string; model?: string; effort?: string }>({
  name: 'run_subagent',
  description:
    'Hand a self-contained task to a subagent: a fresh agent with the same tools (except subagents) and its own context, ' +
    'which works until done and returns its final message to you. Use it for independent research or changes that would ' +
    'flood your context, or to run several tasks in parallel (call it several times in one response). The subagent does ' +
    'not see this conversation, so the prompt must contain everything it needs: goal, relevant files, constraints and what ' +
    'to report back. Optionally pick a model and effort level from list_models (e.g. a cheaper model for simple searches); ' +
    'by default it uses your model and effort. Its file changes ask the user for approval like yours do.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-6 word) title for the task, shown to the user.' },
      prompt: { type: 'string', description: 'The complete task for the subagent.' },
      model: { type: 'string', description: 'Model id from list_models ("provider/model"). Omit to use the current model.' },
      effort: { type: 'string', description: 'Effort level the model supports (see list_models), or "default".' }
    },
    required: ['description', 'prompt'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ description, prompt, model, effort }, ctx) {
    const runner = runnerOf(ctx)
    if (!description.trim()) throw new ToolError('description is empty.')
    if (!prompt.trim()) throw new ToolError('prompt is empty.')
    let modelId: string | undefined
    let level: string | undefined
    if (model?.trim()) {
      const picked = resolveSubagentModel(await runner.models(), model)
      modelId = picked.id
      level = resolveSubagentEffort(picked, effort)
    } else if (effort?.trim()) {
      const current = (await runner.models()).find((candidate) => candidate.current)
      if (!current) throw new ToolError('The current model is unknown; pass model together with effort.')
      modelId = current.id
      level = resolveSubagentEffort(current, effort)
    }
    return runner.run({ description: description.trim(), prompt: prompt.trim(), modelId, effort: level }, ctx)
  }
})

export const subagentTools = [listModelsTool, runSubagentTool]
