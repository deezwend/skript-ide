/**
 * `@skript-ide/language-server` çekirdeği: LSP taşımasından bağımsız dil servisi.
 *
 * - `@skript-ide/language-server/browser` → Web Worker girişi
 * - `@skript-ide/language-server/node` → stdio girişi
 */
export {
  SkriptLanguageService,
  type AddonDataStatus,
  type AddonDatabaseRef,
  type AddonSelectionInput,
  type LanguageServiceOptions,
  DIAGNOSTIC_SOURCE
} from './service'
export {
  DiagnosticCodes,
  VersionChecker,
  type VersionWarning
} from './diagnostics'
export { SEMANTIC_TOKENS_LEGEND } from './semantic-tokens'
export type {
  MigrationEntryRef,
  MigrationFix,
  MigrationItem,
  MigrationReport,
  MigrationStatus
} from './migration'
export { VariableCodes } from './variables'
export { startServer, parseAddonsSetting, COMPLETION_TRIGGER_CHARACTERS } from './server'
export type {
  MatcherAdapter,
  ParserAdapter,
  PatternCompilerAdapter,
  Position,
  Range,
  SkriptDocument,
  SyntaxMatchLike
} from './contracts'
