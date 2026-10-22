import type { ContentBlock } from '../../src/messages'
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/provider'

/** Senaryo adımı: sabit yanıt ya da gelen isteğe göre yanıt üreten fonksiyon. */
export type ScriptStep = ModelResponse | ((request: ModelRequest) => ModelResponse)

/**
 * Önceden yazılmış yanıtları sırayla döndüren sahte LLM. Gelen istekleri kaydeder;
 * testler modele ne gönderildiğini (tool sonuçları, tool tanımları) buradan doğrular.
 */
export class FakeProvider implements ModelProvider {
  readonly requests: ModelRequest[] = []
  private readonly steps: ScriptStep[]

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Döngü diziyi sonradan değiştirdiği için anlık kopyasını sakla
    this.requests.push({ ...request, messages: structuredClone([...request.messages]) })
    const step = this.steps.shift()
    if (!step) throw new Error('FakeProvider: senaryoda yanıt kalmadı')
    return typeof step === 'function' ? step(request) : step
  }
}

export function reply(text: string): ModelResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end' }
}

let nextId = 0

export function callTool(name: string, input: unknown, text?: string): ModelResponse {
  const content: ContentBlock[] = text ? [{ type: 'text', text }] : []
  content.push({ type: 'tool_call', id: `call_${++nextId}`, name, input })
  return { content, stopReason: 'tool_use' }
}
