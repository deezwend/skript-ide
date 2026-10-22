/** Agent'ın çağırabileceği tool'ların sözleşmesi. Temel ve Skript tool'ları aynı arayüzü uygular. */

import type { SkriptServer } from '@skript-ide/runtime-validator'

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

/** LSP biçiminde tanı; satır/sütun 0 tabanlı, `severity` 1 hata, 2 uyarı, 3 bilgi, 4 ipucu. */
export interface ToolDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  /** LSP 3.18'de mesaj Markdown (`MarkupContent`) da olabilir. */
  message: string | { value: string }
  code?: number | string
}

/**
 * Skript tool'larının kullandığı dil servisi; `@skript-ide/language-server`'daki `SkriptLanguageService`
 * bunu yapısal olarak karşılar. Agent paketi language-server'a bağımlı olmasın diye burada tanımlıdır.
 */
export interface AgentLanguageService {
  /** Geçerli Skript sürümü (veritabanı yüklenemediyse dönülen yedek sürüm). */
  readonly skriptVersion: string
  readonly versionWarning: { message: string } | null
  readonly selectedAddons: readonly { name: string; version: string }[]
  addonDataStatus(): readonly {
    name: string
    version: string
    data: 'exact' | 'nearest' | 'missing'
    skriptVersion?: string
  }[]
  setWorkspaceFiles(files: readonly { uri: string; text: string }[], complete: boolean): void
  getDiagnostics(uri: string): Promise<readonly ToolDiagnostic[]>
}

export interface ToolContext {
  /** Açık proje klasörü; dosya erişimi bunun dışına çıkamaz. `null`: proje açık değil. */
  projectRoot: string | null
  signal: AbortSignal
  /** `write`/`exec` tool'ları için kullanıcı onayı; reddedilirse tool çalışmaz. */
  requestApproval(request: ApprovalRequest): Promise<boolean>
  /** Projenin sürümüne ve addon'larına ayarlı dil servisi; yoksa Skript tool'ları hata döndürür. */
  languageService?: AgentLanguageService
  /** Gerçek Paper + Skript doğrulama sunucusu; yoksa `validate_on_server` hata döndürür. */
  server?: Pick<SkriptServer, 'currentStatus' | 'isEulaAccepted' | 'validate'>
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
