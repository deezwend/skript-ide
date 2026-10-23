/** Agent'ın çağırabileceği tool'ların sözleşmesi. Temel ve Skript tool'ları aynı arayüzü uygular. */

import type { SkriptServer } from '@skript-ide/runtime-validator'
import type { Message } from './messages'

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

/**
 * Bir `write` tool'unun tek dosyada yapacağı değişiklik; arayüz diff gösterir, geri alma bununla yapılır.
 * - `created`: dosya henüz yok; `before` boştur ve onaylanırsa oluşturulur.
 * - `deleted`: dosya silinir; `after` boştur.
 * - `movedFrom`: dosya bu yoldan taşınır; eski yol ayrıca `deleted` değişikliği olarak listelenir.
 */
export interface FileChange {
  path: string
  before: string
  after: string
  created?: boolean
  deleted?: boolean
  movedFrom?: string
}

export interface ApprovalRequest {
  tool: string
  input: unknown
  /** Kullanıcıya gösterilecek tek satırlık özet. */
  summary: string
  /** `write` tool'larında arayüzün diff gösterebilmesi için dosya başına önce/sonra içeriği. */
  changes?: FileChange[]
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
  getDocumentSymbols(uri: string): Promise<readonly ToolSymbol[]>
  getDefinition(uri: string, position: ToolPosition): Promise<readonly ToolLocation[]>
  getReferences(uri: string, position: ToolPosition, includeDeclaration: boolean): Promise<readonly ToolLocation[]>
  /** Yalnızca değişkenleri yeniden adlandırır; geçersiz ad için hata fırlatır. */
  rename(uri: string, position: ToolPosition, newName: string): Promise<ToolWorkspaceEdit | null>
  /** Verilen metnin tanıları; açık belgeyi ve çalışma alanını değiştirmez (düzenleme öncesi/sonrası karşılaştırması için). */
  getDiagnosticsForText(uri: string, text: string): Promise<readonly ToolDiagnostic[]>
  getHover(uri: string, position: ToolPosition): Promise<ToolHover | null>
  getCompletions(uri: string, position: ToolPosition): Promise<readonly ToolCompletionItem[]>
  getCodeActions(uri: string, range: ToolRange): Promise<readonly ToolCodeAction[]>
  /** Konumun içinde bulunduğu yapı/olay, o noktada geçerli yerel değişkenler ve options. */
  getScopeInfo(uri: string, position: ToolPosition): Promise<ToolScopeInfo | null>
  /** Satırın (0 tabanlı) hangi syntax kaydına uyduğunu, uymadıysa nedenini açıklar. */
  explainLine(uri: string, line: number): Promise<ToolLineExplanation | null>
  /** Henüz dosyada olmayan bir satırı, isteğe bağlı bir başlığın altında açıklar. */
  explainCode(code: string, context?: string): Promise<ToolLineExplanation>
  /** Çalışma alanındaki satırları `from` sürümünden `to` sürümüne göre karşılaştırır. */
  getMigrationReport(from: string, to: string): Promise<ToolMigrationReport>
}

/** LSP konumu; satır ve sütun 0 tabanlı. */
export interface ToolPosition {
  line: number
  character: number
}

export interface ToolRange {
  start: ToolPosition
  end: ToolPosition
}

export interface ToolLocation {
  uri: string
  range: ToolRange
}

export interface ToolSymbol {
  name: string
  detail?: string
  range: ToolRange
  children?: readonly ToolSymbol[]
}

export interface ToolWorkspaceEdit {
  changes?: Record<string, readonly { range: ToolRange; newText: string }[]>
}

/** `getHover` sonucu: Markdown içerik (LSP `MarkupContent`/`MarkedString` ile yapısal olarak uyumlu). */
export interface ToolHover {
  contents: string | { value: string } | readonly (string | { value: string })[]
  range?: ToolRange
}

export interface ToolCompletionItem {
  label: string
  /** LSP `CompletionItemKind` sayısı (3 fonksiyon, 6 değişken, 14 anahtar kelime…). */
  kind?: number
  detail?: string
}

export interface ToolCodeAction {
  title: string
  kind?: string
}

/** Bir syntax kaydına kısa referans. */
export interface ToolSyntaxRef {
  kind: string
  id: string
  name: string
  addon?: string
}

export interface ToolScopeInfo {
  structure?: { kind: string; header: string; name?: string }
  /** Yapı bir olay gövdesiyse: olay başlığının eşleştiği kayıtlar ve kullanılabilir olay değerleri. */
  event?: {
    header: string
    matches: readonly ToolSyntaxRef[]
    values: readonly { name: string; description?: string }[]
  }
  variables: readonly { name: string; local: boolean; list: boolean; access: string }[]
  options: readonly { name: string; value: string }[]
}

export interface ToolExplainedPlaceholder {
  /** Yer tutucunun eşleştiği alt metin (boş olabilir). */
  text: string
  types: readonly string[]
  nullable: boolean
  literalOnly: boolean
  changeable: boolean
  plural: boolean
  time?: number
  /** Alt metnin ifade olarak çözümü (iç içe, sınırlı derinlikte). */
  expression?: readonly ToolExplainedMatch[]
}

export interface ToolExplainedMatch {
  kind: string
  id: string
  name: string
  addon?: string
  pattern: string
  patternIndex: number
  /** `exact`: tüm yer tutucular tanındı; `structural`: yapı uydu ama içerik doğrulanamadı. */
  confidence: string
  placeholders: readonly ToolExplainedPlaceholder[]
}

/** Eşleşmeyen satırda en yakın pattern ve tutmama nedeni. */
export interface ToolCandidatePattern {
  kind: string
  id: string
  name: string
  addon?: string
  pattern: string
  /** Satırda bulunmayan zorunlu kelimeler. */
  missing: readonly string[]
  /** Kelime yakınlığı ipuçları dahil, okunur neden. */
  reason: string
}

export interface ToolLineExplanation {
  /** 1 tabanlı satır numarası; `code` girdisinde 1. */
  line: number
  text: string
  /** Satırın bağlamı: event, condition, section, statement; eşleştirilmeyecekse null. */
  context: string | null
  matches: readonly ToolExplainedMatch[]
  candidates: readonly ToolCandidatePattern[]
  /** Satır beklenen türde değil de başka bir türde eşleştiyse. */
  otherKinds: readonly ToolSyntaxRef[]
}

/** `update_todos` ile verilen plan maddesinin durumu. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** Agent'ın çok adımlı işlerde tuttuğu plan maddesi; arayüzde canlı liste olarak gösterilir. */
export interface Todo {
  content: string
  status: TodoStatus
}

export interface ToolContext {
  /** Açık proje klasörü; dosya erişimi bunun dışına çıkamaz. `null`: proje açık değil. */
  projectRoot: string | null
  signal: AbortSignal
  /** `write`/`exec` tool'ları için kullanıcı onayı; reddedilirse tool çalışmaz. */
  requestApproval(request: ApprovalRequest): Promise<boolean>
  /**
   * `write` tool'ları dosyaları değiştirdikten sonra (onay modundan bağımsız) çağırır; arayüz sekmeleri
   * yeniler ve turu geri alabilmek için önceki içerikleri saklar.
   */
  onFilesChanged?(changes: readonly FileChange[]): void
  /** Projenin sürümüne ve addon'larına ayarlı dil servisi; yoksa Skript tool'ları hata döndürür. */
  languageService?: AgentLanguageService
  /** Gerçek Paper + Skript doğrulama sunucusu; yoksa `validate_on_server` hata döndürür. */
  server?: Pick<SkriptServer, 'currentStatus' | 'isEulaAccepted' | 'validate' | 'runCommands' | 'readLog'>
  /** `update_todos` listeyi değiştirdiğinde çağrılır; arayüz plan listesini bundan çizer. */
  onTodosChanged?(todos: readonly Todo[]): void
  /** Kullanıcı hafızasının (tüm projeler) mutlak yolu; yoksa `remember`/`forget` yalnızca proje kapsamında çalışır. */
  userMemoryFile?: string | null
  /** Kayıtlı geçmiş konuşmalar; yoksa `search_conversations`/`read_conversation` hata döndürür. */
  conversations?: ConversationArchive
  /** Alt agent çalıştırıcısı; yoksa `run_subagent`/`list_models` hata döndürür. */
  subagents?: SubagentRunner
  /** Döngünün o an çalıştırdığı tool çağrısının kimliği; arayüz alt agent'ı çağrının satırına bağlar. */
  callId?: string
}

/** Alt agent'ın kullanabileceği bir model. */
export interface SubagentModel {
  /** `sağlayıcı/model`. */
  id: string
  name: string
  /** Desteklenen effort seviyeleri; boşsa effort ayarı yok. */
  effortLevels: readonly string[]
  contextWindow?: number
  /** 1M token başına USD. */
  cost?: { input: number; output: number }
  /** Ana agent'ın şu an kullandığı model. */
  current: boolean
}

export interface SubagentRequest {
  /** Kullanıcıya gösterilen kısa başlık. */
  description: string
  prompt: string
  /** `sağlayıcı/model`; yoksa ana agent'ın modeli ve effort'u. */
  modelId?: string
  /** Doğrulanmış effort seviyesi; yoksa sağlayıcının varsayılanı (model verildiyse). */
  effort?: string
}

/** Alt agent'ları çalıştıran taraf (masaüstü uygulaması). */
export interface SubagentRunner {
  models(): Promise<readonly SubagentModel[]>
  /** Alt agent'ı bitene kadar çalıştırır; son mesajını döndürür. İptal `ctx.signal` ile yapılır. */
  run(request: SubagentRequest, ctx: ToolContext): Promise<string>
}

/** Kayıtlı bir konuşmanın özeti (mesajlar olmadan). */
export interface ConversationInfo {
  id: string
  title: string
  /** Epoch ms. */
  updatedAt: number
  projectRoot: string | null
  /** Kullanıcının gönderdiği mesaj sayısı. */
  turns: number
}

/** Geçmiş konuşmalara salt okunur erişim; açık konuşma listede yer almaz. */
export interface ConversationArchive {
  /** Yeniden eskiye. */
  list(): Promise<readonly ConversationInfo[]>
  read(id: string): Promise<{ info: ConversationInfo; messages: readonly Message[] } | null>
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

/** Geçiş raporundaki syntax kaydı; `@skript-ide/language-server`'daki `MigrationEntryRef` ile uyumlu. */
export interface ToolMigrationEntryRef {
  id: string
  name: string
  kind: string
  patterns: readonly string[]
}

export type ToolMigrationStatus = 'removed' | 'changed' | 'new'

/** Sürüm karşılaştırmasında tek bir satır; `MigrationItem` ile yapısal olarak uyumlu. */
export interface ToolMigrationItem {
  uri: string
  /** 0 tabanlı satır. */
  line: number
  text: string
  status: ToolMigrationStatus
  message: string
  entry?: ToolMigrationEntryRef
  target?: ToolMigrationEntryRef
  /** Düzenleyicinin önerdiği hızlı düzeltme; varsa başlığı gösterilir. */
  fix?: { title: string; newText: string }
}

/** `getMigrationReport` sonucu; `MigrationReport` ile yapısal olarak uyumlu. */
export interface ToolMigrationReport {
  from: string
  to: string
  files: number
  checkedLines: number
  counts: Record<ToolMigrationStatus, number>
  items: readonly ToolMigrationItem[]
}
