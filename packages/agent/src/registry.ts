import type { AgentTool, JsonSchema } from './tool'

/** Provider'a gönderilen tool tanımı. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>()

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: AgentTool): void {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Geçersiz tool adı: ${tool.name}`)
    if (this.tools.has(tool.name)) throw new Error(`Tool zaten kayıtlı: ${tool.name}`)
    if (tool.inputSchema.type !== 'object') throw new Error(`${tool.name}: girdi şeması bir nesne olmalı`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  list(): AgentTool[] {
    return [...this.tools.values()]
  }

  definitions(): ToolDefinition[] {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }
}

/**
 * Girdiyi şemaya karşı denetler; ilk sorunu döndürür, geçerliyse `null`.
 * LLM'ler bazen alan unutur ya da yanlış tür gönderir; hata LLM'e geri döner ve düzeltmesi beklenir.
 */
export function validateInput(schema: JsonSchema, value: unknown, path = 'input'): string | null {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} bir nesne olmalı`
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return `${path}.${key} zorunlu`
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = schema.properties?.[key]
        if (!childSchema) {
          if (schema.additionalProperties === false) return `${path}.${key} beklenmeyen alan`
          continue
        }
        if (child === undefined) continue
        const problem = validateInput(childSchema, child, `${path}.${key}`)
        if (problem) return problem
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} bir dizi olmalı`
      if (schema.items) {
        for (const [index, item] of value.entries()) {
          const problem = validateInput(schema.items, item, `${path}[${index}]`)
          if (problem) return problem
        }
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') return `${path} bir metin olmalı`
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} bir sayı olmalı`
      break
    case 'integer':
      if (!Number.isInteger(value)) return `${path} bir tam sayı olmalı`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${path} true/false olmalı`
      break
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${path} şunlardan biri olmalı: ${schema.enum.join(', ')}`
  }
  return null
}
