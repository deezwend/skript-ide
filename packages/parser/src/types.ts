/** Konumlar 0 tabanlı satır/karakter, karakterler UTF-16 kod birimi. */
export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export type Severity = 'error' | 'warning' | 'information' | 'hint'

export interface ParseDiagnostic {
  range: Range
  severity: Severity
  /** Kararlı tanılama kodu, ör. 'indent-mixed', 'unclosed-string'. */
  code: string
  /** Kullanıcıya gösterilecek kısa Türkçe mesaj. */
  message: string
}

export interface LineInfo {
  line: number
  /** Ham girinti metni (tab/boşluk). */
  indent: string
  /** Yorum ve sondaki boşluklar çıkarılmış içerik (girintisiz). */
  text: string
  /** `text`in satırdaki başlangıç karakteri. */
  start: number
  /** Varsa yorumun başladığı karakter. */
  commentStart?: number
  /** Boş ya da yalnızca yorum. */
  blank: boolean
}

export type StructureKind =
  | 'event'
  | 'command'
  | 'function'
  | 'options'
  | 'variables'
  | 'aliases'
  | 'unknown'

export interface NodeBase {
  /** Düğümün kapladığı aralık; başlık/anahtar başlangıcından son içerik sonuna kadar. */
  range: Range
}

export interface StatementNode extends NodeBase {
  type: 'statement'
  /** Girintisiz, yorumsuz satır içeriği. */
  text: string
  textRange: Range
}

export interface SectionNode extends NodeBase {
  type: 'section'
  /** Sondaki ':' hariç. */
  header: string
  headerRange: Range
  children: BodyNode[]
}

/** `permission: x`, option tanımı, `trigger:` gibi girdiler. */
export interface EntryNode extends NodeBase {
  type: 'entry'
  key: string
  keyRange: Range
  /** Section ise ''. */
  value: string
  valueRange: Range
  /** `trigger:` gibi alt blok taşıyan girdi. */
  children?: BodyNode[]
}

export type BodyNode = StatementNode | SectionNode | EntryNode

export interface StructureNode extends NodeBase {
  type: 'structure'
  kind: StructureKind
  /** ':' hariç, ör. 'on join', 'command /heal [<player>]'. */
  header: string
  headerRange: Range
  children: BodyNode[]
  /** event: olay metni ('on' dahil); command: '/heal'; function: ad. */
  name?: string
  nameRange?: Range
}

export interface FunctionParameter {
  name: string
  type: string
  defaultValue?: string
  range: Range
}

export interface FunctionDefinition {
  name: string
  nameRange: Range
  parameters: FunctionParameter[]
  returnType?: string
  local: boolean
  structure: StructureNode
}

export interface FunctionCall {
  name: string
  nameRange: Range
  /** Çağrının tamamı (ad ve argümanlar). */
  range: Range
}

export interface OptionDefinition {
  name: string
  value: string
  nameRange: Range
  range: Range
}

export interface OptionReference {
  name: string
  /** Süslü parantezler dahil. */
  range: Range
}

export interface VariableReference {
  /** Süslü parantez içi ham ad, ör. 'home::%player%', '_x', 'list::*'. */
  name: string
  /** Süslü parantezler dahil. */
  range: Range
  /** '_' ile başlıyor. */
  local: boolean
  /** '::*' ile bitiyor. */
  list: boolean
}

export interface CommandDefinition {
  name: string
  nameRange: Range
  structure: StructureNode
}

export interface SkriptDocument {
  lines: LineInfo[]
  structures: StructureNode[]
  diagnostics: ParseDiagnostic[]
  functions: FunctionDefinition[]
  functionCalls: FunctionCall[]
  options: OptionDefinition[]
  optionReferences: OptionReference[]
  variables: VariableReference[]
  commands: CommandDefinition[]
}
