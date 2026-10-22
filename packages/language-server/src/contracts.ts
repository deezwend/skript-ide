/**
 * Parser ve pattern-compiler paketlerinin sözleşmedeki (faz4-sozlesme.md) yapısal tipleri.
 *
 * Bu paket, o iki paketi yalnızca *yapısal* olarak tanır: gerçek uygulamalar `ParserAdapter` ve
 * `PatternCompilerAdapter` üzerinden enjekte edilir. Böylece language-server, parser/matcher
 * hazır olmadan da sahte uygulamalarla test edilebilir ve iki paket arasında derleme zamanı
 * sıkı bir bağımlılık oluşmaz.
 */

import type { SyntaxEntry, SyntaxKind } from '@skript-ide/syntax-db'

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
  code: string
  message: string
}

export interface LineInfo {
  line: number
  indent: string
  text: string
  start: number
  commentStart?: number
  blank: boolean
}

export type StructureKind = 'event' | 'command' | 'function' | 'options' | 'variables' | 'aliases' | 'unknown'

interface NodeBase {
  range: Range
}

export interface StatementNode extends NodeBase {
  type: 'statement'
  text: string
  textRange: Range
}

export interface SectionNode extends NodeBase {
  type: 'section'
  header: string
  headerRange: Range
  children: BodyNode[]
}

export interface EntryNode extends NodeBase {
  type: 'entry'
  key: string
  keyRange: Range
  value: string
  valueRange: Range
  children?: BodyNode[]
}

export type BodyNode = StatementNode | SectionNode | EntryNode

export interface StructureNode extends NodeBase {
  type: 'structure'
  kind: StructureKind
  header: string
  headerRange: Range
  children: BodyNode[]
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
  range: Range
}

export interface VariableReference {
  name: string
  range: Range
  local: boolean
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

/** Parser paketinin bu sunucunun ihtiyaç duyduğu yüzü. */
export interface ParserAdapter {
  parseDocument(text: string): SkriptDocument
}

export interface PatternMatchLike {
  mark: number
  tags: readonly string[]
  placeholders: readonly unknown[]
  regexes: readonly unknown[]
}

export type MatchConfidence = 'exact' | 'structural'

export interface SyntaxMatchLike {
  entry: SyntaxEntry
  patternIndex: number
  match: PatternMatchLike
  confidence: MatchConfidence
}

/** SyntaxMatcher'ın bu sunucunun ihtiyaç duyduğu yüzü. */
export interface MatcherAdapter {
  match(text: string, kinds: readonly SyntaxKind[]): readonly SyntaxMatchLike[]
  matchEvent(header: string): readonly SyntaxMatchLike[]
  matchExpression(text: string): readonly SyntaxMatchLike[]
  /**
   * `match` / `matchEvent` gibi; `complete: false` adım bütçesinin tükendiğini bildirir. İkisi de
   * yoksa "hiçbir syntax'a uymuyor" (`unknown-syntax`) denetimi yapılmaz.
   */
  matchWithStatus?(text: string, kinds: readonly SyntaxKind[]): MatchStatusLike
  matchEventWithStatus?(header: string): MatchStatusLike
}

export interface MatchStatusLike {
  matches: readonly SyntaxMatchLike[]
  complete: boolean
}

export interface PatternCompilerAdapter {
  createMatcher(entries: readonly SyntaxEntry[]): MatcherAdapter
  /** Ham Skript pattern'inden LSP snippet'i üretir. Derlenemeyen pattern'de fırlatabilir. */
  toSnippet(pattern: string): string
  /** Tamamlama listesinde gösterilecek kısa etiket. */
  toLabel(pattern: string): string
}
