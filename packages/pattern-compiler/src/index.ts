/**
 * `@skript-ide/pattern-compiler`
 *
 * Skript pattern'lerini derler, eşleştirir ve syntax veritabanı kayıtları üzerinde
 * `SyntaxMatcher` ile satır/olay/ifade araması yapar. Tarayıcı worker'ında çalışabilir:
 * Node API'si kullanmaz.
 */

export { PatternSyntaxError, compilePattern } from './compiler'
export type { CompiledPattern, CompileOptions } from './compiler'

export type {
  PatternNode,
  PlaceholderInfo,
  SequenceNode,
  LiteralNode,
  OptionalNode,
  GroupNode,
  ChoiceNode,
  PlaceholderNode,
  RegexNode,
  ParseTagNode
} from './ast'

export { matchPattern, matchWithBudget, createMatchBudget } from './matcher'
export type {
  MatchOptions,
  MatchBudget,
  PlaceholderMatch,
  PatternMatch
} from './matcher'

export { patternToSnippet, patternToLabel } from './format'

export { SyntaxMatcher } from './syntax-matcher'
export type {
  MatchConfidence,
  SyntaxMatch,
  SyntaxMatchResult,
  SyntaxMatcherOptions,
  PatternCompileError
} from './syntax-matcher'
