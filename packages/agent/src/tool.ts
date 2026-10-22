/** Agent'ın çağırabileceği tool'ların sözleşmesi. Temel ve Skript tool'ları aynı arayüzü uygular. */

/** LLM'e gönderilen girdi şeması; tüm büyük sağlayıcıların kabul ettiği JSON Schema alt kümesi. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: readonly (string | number)[]
  additionalProperties?: boolean
}

/**
 * - `read`: dosya okuma, arama gibi yan etkisiz işler; onaysız çalışır.
 * - `write`: kullanıcının dosyalarını değiştirir; önizlemeyle onay ister.
 * - `exec`: sunucu komutu gibi geri alınamayabilecek işler; her seferinde onay ister.
 */
export type ToolPermission = 'read' | 'write' | 'exec'

export interface ApprovalRequest {
  tool: string
  input: unknown
  /** Kullanıcıya gösterilecek tek satırlık özet. */
  summary: string
  /** `write` tool'larında arayüzün diff gösterebilmesi için önce/sonra içeriği. */
  change?: { path: string; before: string; after: string }
}

export interface ToolContext {
  /** Açık proje klasörü; dosya erişimi bunun dışına çıkamaz. `null`: proje açık değil. */
  projectRoot: string | null
  signal: AbortSignal
  /** `write`/`exec` tool'ları için kullanıcı onayı; reddedilirse tool çalışmaz. */
  requestApproval(request: ApprovalRequest): Promise<boolean>
}

export interface AgentTool<I = any> {
  name: string
  /** LLM'in tool'u ne zaman kullanacağına karar verdiği açıklama. */
  description: string
  inputSchema: JsonSchema
  permission: ToolPermission
  /** Onay penceresinde gösterilecek özet/değişiklik; verilmezse genel bir özet kullanılır. */
  preview?(input: I, ctx: ToolContext): Promise<Omit<ApprovalRequest, 'tool' | 'input'>>
  /** Dönen metin LLM'e tool sonucu olarak gider. Hata fırlatmak `isError` sonucu üretir. */
  execute(input: I, ctx: ToolContext): Promise<string>
}

/** Tool'un LLM'e beklenen bir hatayı (dosya yok, eşleşme yok…) bildirmek için fırlattığı hata. */
export class ToolError extends Error {}

export function defineTool<I>(tool: AgentTool<I>): AgentTool<I> {
  return tool
}
