import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DocumentSymbol,
  ResponseError,
  TextEdit,
  type CompletionItem,
  type Hover,
  type Location,
  type Position,
  type Range,
  type SemanticTokens,
  type WorkspaceEdit
} from 'vscode-languageserver'
import {
  listAddonDatabases,
  listSyntaxVersions,
  loadAddonDatabase as loadBundledAddonDatabase,
  resolveAddonDatabase,
  type AddonSyntaxInfo,
  type SyntaxDatabase,
  type SyntaxEntry
} from '@skript-ide/syntax-db'
import type {
  MatcherAdapter,
  ParserAdapter,
  PatternCompilerAdapter,
  SkriptDocument
} from './contracts'
import { computeCompletions, type VisibleFunction, type VisibleVariable } from './completion'
import {
  collectDiagnostics,
  DIAGNOSTIC_SOURCE,
  VersionChecker,
  type AddonCandidate,
  type VersionWarning
} from './diagnostics'
import { loadDefaultAdapters } from './defaults'
import { analyzeDocument, type DocumentAnalysis } from './document'
import { computeHover, type HoverFunction } from './hover'
import {
  computeDefinition,
  computeReferences,
  type NavigationFile,
  type WorkspaceFunction
} from './navigation'
import { computeSemanticTokens } from './semantic-tokens'
import { computeDocumentSymbols } from './symbols'
import { rangesIntersect, uriKey } from './util'
import { buildMigrationReport, type MigrationEntryRef, type MigrationReport } from './migration'
import {
  analyzeVariables,
  collectVariableDiagnostics,
  occurrenceAt,
  sameVariable,
  stemRange,
  VariableCodes,
  type VariableOccurrence
} from './variables'

import { l } from '@skript-ide/i18n'
export { DIAGNOSTIC_SOURCE }

export interface LanguageServiceOptions {
  /** Sürümün syntax veritabanını yükler (tarayıcıda loadSyntaxDatabase, Node'da readSyntaxDatabase). */
  loadDatabase: (skriptVersion: string) => Promise<SyntaxDatabase>
  /** Başlangıç sürümü; verilmezse katalogdaki en yeni sürüm. */
  skriptVersion?: string
  /** Testlerde ya da farklı bir taşımada gerçek parser yerine kullanılabilir. */
  parser?: ParserAdapter
  /** Testlerde ya da farklı bir taşımada gerçek pattern-compiler yerine kullanılabilir. */
  patternCompiler?: PatternCompilerAdapter
  /** Addon veritabanı yükleyicisi; verilmezse paketlenmiş katalogdaki (`loadAddonDatabase`) kullanılır. */
  loadAddonDatabase?: (info: AddonDatabaseRef) => Promise<SyntaxDatabase>
  /** Başlangıçta seçili addon'lar (`skript-project.json` → `addons`). */
  addons?: readonly AddonSelectionInput[]
}

export type AddonDatabaseRef = Pick<AddonSyntaxInfo, 'addon' | 'addonVersion' | 'skriptVersion'>

export interface AddonSelectionInput {
  name: string
  version: string
}

/** Seçili bir addon'un, seçili Skript sürümü için hangi veriyle tanındığı. */
export interface AddonDataStatus {
  name: string
  version: string
  /** `exact`: bu Skript sürümünde üretilmiş veri; `nearest`: en yakın Skript sürümünün verisi; `missing`: veri yok. */
  data: 'exact' | 'nearest' | 'missing'
  /** Kullanılan verinin üretildiği Skript sürümü. */
  skriptVersion?: string
}

interface AddonSet {
  databases: SyntaxDatabase[]
  /** Verisi olmayan seçili addon var mı? (varsa tanımsız fonksiyon denetimi kapatılır) */
  missing: boolean
}

interface ParsedDocument {
  doc: SkriptDocument
  analysis: DocumentAnalysis
  /** Değişken kullanımları; ilk istendiğinde hesaplanır. */
  variables?: VariableOccurrence[]
}

interface VariableFile {
  uri: string
  key: string
  occurrences: VariableOccurrence[]
}

interface OpenDocument {
  uri: string
  text: string
  version: number
  parsed?: ParsedDocument
}

interface WorkspaceFile {
  uri: string
  text: string
}

interface StoredFile {
  uri: string
  key: string
  text: string
  doc: SkriptDocument
  analysis: DocumentAnalysis
  parsed: ParsedDocument
}

interface FunctionIndex {
  all: WorkspaceFunction[]
  /** Bir dosya skript-reflect ile kendi syntax'ını (`effect …:`, `expression …:`) tanımlıyor mu? */
  customSyntax: boolean
}

/** skript-reflect özel syntax yapıları; bunlar tanımlıysa satırların neye uyduğu bilinemez. */
const CUSTOM_SYNTAX_HEADER = /^(?:local\s+)?(?:(?:plural|non-single)\s+)?(?:effect|condition|expression|event|section|.+\s+property)(?:\s|$)/i

interface Adapters {
  parser: ParserAdapter
  patternCompiler: PatternCompilerAdapter
}

const unknownVersionMessage = (version: string, fallback: string) =>
  l(
    `Skript ${version} için syntax veritabanı yüklenemedi; ${fallback} sürümüne dönüldü.`,
    `Could not load the syntax database for Skript ${version}; fell back to ${fallback}.`
  )

/**
 * `implicit:<…>` Skript dokümanlarında yalnızca dahili bir işarettir; gerçek bir kullanıcı
 * satırıyla eşleşmemelidir (aksi halde her satır `SecConditional` ile eşleşirdi).
 */
function matcherEntries(entries: readonly SyntaxEntry[]): SyntaxEntry[] {
  const result: SyntaxEntry[] = []
  for (const entry of entries) {
    const patterns = entry.patterns.filter((pattern) => !/^\s*implicit\s*:/i.test(pattern))
    if (patterns.length === entry.patterns.length) result.push(entry)
    else if (patterns.length > 0) result.push({ ...entry, patterns })
  }
  return result
}

export class SkriptLanguageService {
  private readonly openDocuments = new Map<string, OpenDocument>()
  private readonly workspaceFiles = new Map<string, WorkspaceFile>()
  private readonly workspaceCache = new Map<string, ParsedDocument>()
  private readonly databaseCache = new Map<string, Promise<SyntaxDatabase>>()
  private readonly matcherCache = new Map<string, Promise<MatcherAdapter | null>>()
  private readonly entriesCache = new Map<string, Promise<SyntaxEntry[]>>()
  private readonly builtinFunctionCache = new Map<string, ReadonlySet<string>>()
  private readonly versionCheckers = new Map<string, VersionChecker>()
  private readonly addonSetCache = new Map<string, Promise<AddonSet>>()
  private readonly addonMatcherCache = new Map<string, Promise<MatcherAdapter | null>>()
  private readonly defaultVersion: string
  private addons: AddonSelectionInput[] = []
  private addonKey = ''

  private currentVersion: string
  private versionRequest = 0
  private fallback: VersionWarning | null = null
  private workspaceDeclared = false
  private workspaceComplete = false
  private generation = 0
  private functionIndex: { generation: number; promise: Promise<FunctionIndex> } | undefined
  private variableIndex: { generation: number; promise: Promise<VariableFile[]> } | undefined
  /** Son yayımlanan tanılar (hızlı düzeltmeler bunlardan üretilir; istemci `data` alanını geri göndermeyebilir). */
  private readonly lastDiagnostics = new Map<string, Diagnostic[]>()
  /** Son geçiş raporu; satırları hâlâ aynıysa hızlı düzeltmeleri kod eylemi olarak sunulur. */
  private lastMigration: MigrationReport | undefined
  private adaptersPending: Promise<Adapters> | undefined

  constructor(private readonly options: LanguageServiceOptions) {
    const latest = listSyntaxVersions()[0]?.skriptVersion ?? '2.17.1'
    this.defaultVersion = latest
    this.currentVersion = options.skriptVersion?.trim() || latest
    if (options.addons) this.setAddons(options.addons)
  }

  get selectedAddons(): readonly AddonSelectionInput[] {
    return this.addons
  }

  /** Seçili addon'ları değiştirir; değişiklik olduysa `true` (diagnostics yenilenmeli). */
  setAddons(selections: readonly AddonSelectionInput[]): boolean {
    const seen = new Set<string>()
    const normalized: AddonSelectionInput[] = []
    for (const selection of selections) {
      const name = selection.name.trim()
      const version = selection.version.trim()
      if (!name || !version || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      normalized.push({ name, version })
    }
    normalized.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    const key = normalized.map((selection) => `${selection.name.toLowerCase()}@${selection.version}`).join(',')
    if (key === this.addonKey) return false
    this.addons = normalized
    this.addonKey = key
    return true
  }

  /** Seçili addon'ların seçili Skript sürümü için veri durumu. */
  addonDataStatus(): AddonDataStatus[] {
    return this.addons.map((selection): AddonDataStatus => {
      const info = resolveAddonDatabase(selection.name, selection.version, this.currentVersion)
      if (!info) return { name: selection.name, version: selection.version, data: 'missing' }
      return {
        name: info.addon,
        version: selection.version,
        data: info.exact ? 'exact' : 'nearest',
        skriptVersion: info.skriptVersion
      }
    })
  }

  get skriptVersion(): string {
    return this.currentVersion
  }

  get versionWarning(): VersionWarning | null {
    return this.fallback
  }

  /** Açık belgelerin (uri, sürüm) listesi; sunucu diagnostics yenilerken kullanır. */
  listOpenDocuments(): { uri: string; version: number }[] {
    return [...this.openDocuments.values()].map((document) => ({
      uri: document.uri,
      version: document.version
    }))
  }

  isOpen(uri: string): boolean {
    return this.openDocuments.has(uriKey(uri))
  }

  async setSkriptVersion(version: string): Promise<void> {
    const requested = version.trim()
    if (!requested) return
    const requestId = ++this.versionRequest
    this.fallback = null

    if (requested === this.currentVersion) {
      try {
        await this.loadDatabaseCached(requested)
      } catch {
        if (this.versionRequest === requestId) await this.fallbackToDefault(requested, requestId)
      }
      return
    }

    try {
      await this.loadDatabaseCached(requested)
      if (this.versionRequest !== requestId) return
      this.currentVersion = requested
    } catch {
      if (this.versionRequest === requestId) await this.fallbackToDefault(requested, requestId)
    }
  }

  private async fallbackToDefault(requested: string, requestId: number): Promise<void> {
    const fallback = this.defaultVersion
    try {
      await this.loadDatabaseCached(fallback)
    } catch {
      // Varsayılan da yoksa yapılandırma yine de değişir; diagnostics sürüm uyarısı üretmez.
    }
    // Daha yeni bir sürüm isteği bu arada tamamlandıysa eski isteğin sonucu yazılmaz.
    if (this.versionRequest !== requestId) return
    this.currentVersion = fallback
    this.fallback = {
      message: unknownVersionMessage(requested, fallback),
      foundVersion: requested,
      since: fallback
    }
  }

  openDocument(uri: string, text: string, version: number): void {
    const key = uriKey(uri)
    this.openDocuments.set(key, { uri, text, version })
    this.touch()
  }

  updateDocument(uri: string, text: string, version: number): void {
    const key = uriKey(uri)
    const existing = this.openDocuments.get(key)
    if (!existing) {
      this.openDocument(uri, text, version)
      return
    }
    if (existing.text === text) {
      existing.version = version
      return
    }
    existing.text = text
    existing.version = version
    existing.parsed = undefined
    this.touch()
  }

  closeDocument(uri: string): void {
    const key = uriKey(uri)
    if (!this.openDocuments.delete(key)) return
    this.touch()
  }

  /** Açık olmayan çalışma alanı dosyaları. `complete=true` ise liste çalışma alanının tamamıdır. */
  setWorkspaceFiles(files: readonly { uri: string; text: string }[], complete: boolean): void {
    this.workspaceFiles.clear()
    this.workspaceCache.clear()
    for (const file of files) {
      this.workspaceFiles.set(uriKey(file.uri), { uri: file.uri, text: file.text })
    }
    this.workspaceDeclared = true
    this.workspaceComplete = complete
    this.touch()
  }

  /** Tek bir çalışma alanı dosyasını ekler/günceller; `null` siler. */
  updateWorkspaceFile(uri: string, text: string | null): void {
    const key = uriKey(uri)
    if (text === null) {
      this.workspaceFiles.delete(key)
      this.workspaceCache.delete(key)
    } else {
      this.workspaceFiles.set(key, { uri, text })
      this.workspaceCache.delete(key)
    }
    this.workspaceDeclared = true
    this.touch()
  }

  async getDiagnostics(uri: string): Promise<Diagnostic[]> {
    const key = uriKey(uri)
    const expectedVersion = this.openDocuments.get(key)?.version
    const file = await this.lookupFile(uri)
    if (!file) return []
    await this.ensureVersion()
    const version = this.currentVersion
    const [builtins, definedFunctions, addonSet] = await Promise.all([
      this.getBuiltinFunctions(version),
      this.definedFunctionNames(file.key),
      this.getAddonSet(version)
    ])
    // Hesaplama sürerken belge güncellendiyse kalan satırları taramayı bırak; sunucu eski
    // sonucu zaten yayınlamaz, burada yalnızca boşa iş yapılmaması sağlanır.
    const isCurrent =
      expectedVersion === undefined
        ? undefined
        : (): boolean => this.openDocuments.get(key)?.version === expectedVersion
    const variableDiagnostics = collectVariableDiagnostics(this.fileVariables(file), {
      source: DIAGNOSTIC_SOURCE,
      // Genel değişkenler yalnızca tüm çalışma alanı biliniyorsa denetlenir (başka dosya yazıyor olabilir).
      globalOccurrences:
        !this.workspaceDeclared || this.workspaceComplete
          ? (await this.getVariableIndex()).flatMap((entry) => entry.occurrences.filter((o) => o.scope === 'global'))
          : undefined
    })
    // Matcher yoksa (veritabanı eksik) yalnızca parser hataları ve fonksiyon/option denetimleri yapılır.
    const diagnostics = await collectDiagnostics(file.doc, {
      additional: variableDiagnostics,
      currentVersion: version,
      versionChecker: this.getVersionChecker(version),
      builtinFunctions: builtins,
      definedFunctions,
      // Verisi olmayan bir addon seçiliyse onun fonksiyonları bilinemez; yanlış uyarı üretilmez.
      checkUndefinedFunctions: (!this.workspaceDeclared || this.workspaceComplete) && !addonSet.missing,
      // Aynı nedenle o addon'un syntax'ı da bilinemez; "anlaşılamayan satır" hatası verilmez.
      // skript-reflect ile tanımlanan özel syntax da veritabanında yoktur.
      checkUnknownSyntax: !addonSet.missing && !(await this.getFunctionIndex()).customSyntax,
      isCurrent
    })
    this.lastDiagnostics.set(key, diagnostics)
    return diagnostics
  }

  /** Hızlı düzeltmeler: değişken adı yazım hatası önerisi (ve geçiş asistanının satır düzeltmeleri). */
  async getCodeActions(uri: string, range: Range): Promise<CodeAction[]> {
    const key = uriKey(uri)
    const file = await this.lookupFile(uri)
    if (!file) return []
    const actions: CodeAction[] = []
    for (const diagnostic of this.lastDiagnostics.get(key) ?? []) {
      if (!rangesIntersect(diagnostic.range, range) && !sameStart(diagnostic.range, range)) continue
      const data = diagnostic.data as { replacement?: unknown } | undefined
      if (diagnostic.code === VariableCodes.typo && typeof data?.replacement === 'string') {
        actions.push({
          title: l(`${data.replacement} olarak düzelt`, `Change to ${data.replacement}`),
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: { changes: { [file.uri]: [TextEdit.replace(diagnostic.range, data.replacement)] } }
        })
      }
    }
    for (const item of this.lastMigration?.items ?? []) {
      if (!item.fix || uriKey(item.uri) !== key) continue
      if (!rangesIntersect(item.range, range) && !sameStart(item.range, range)) continue
      // Rapordan sonra satır değiştiyse düzeltme bayattır.
      if (file.analysis.lines.get(item.line)?.text !== item.text) continue
      actions.push({
        title: l(`Skript ${this.lastMigration!.to} geçişi: ${item.fix.title}`, `Skript ${this.lastMigration!.to} migration: ${item.fix.title}`),
        kind: CodeActionKind.QuickFix,
        edit: { changes: { [file.uri]: [TextEdit.replace(item.fix.range, item.fix.newText)] } }
      })
    }
    return actions
  }

  /**
   * Geçiş asistanı: çalışma alanındaki (ya da açık) tüm dosyaların `from` → `to` sürüm farkı.
   * Seçili addon'lar iki tarafta da matcher'a dahildir; addon satırları yanlışlıkla "kaldırıldı" görünmez.
   */
  async getMigrationReport(from: string, to: string): Promise<MigrationReport> {
    const known = new Set(listSyntaxVersions().map((info) => info.skriptVersion))
    for (const version of [from, to]) {
      if (!known.has(version)) throw new ResponseError(0, l(`Skript ${version} için syntax verisi yok.`, `No syntax data for Skript ${version}.`))
    }
    const [fromMatcher, toMatcher, toList, files] = await Promise.all([
      this.getMatcher(from),
      this.getMatcher(to),
      this.getEntries(to),
      this.collectFiles()
    ])
    if (!fromMatcher || !toMatcher) throw new ResponseError(0, l('Syntax eşleştiricisi yüklenemedi.', 'Could not load the syntax matcher.'))
    const toEntries = new Map<string, MigrationEntryRef>()
    for (const entry of toList) {
      toEntries.set(entry.id, { id: entry.id, name: entry.name, kind: entry.kind, patterns: entry.patterns })
    }
    const report = await buildMigrationReport(
      files.map((file) => ({ uri: file.uri, doc: file.doc, analysis: file.analysis })),
      { from, to, fromMatcher, toMatcher, toEntries, yieldEvery: () => new Promise((resolve) => setTimeout(resolve, 0)) }
    )
    this.lastMigration = report
    return report
  }

  /** Yeniden adlandırılabilir değişken kökünün aralığı; değişken değilse `null`. */
  async prepareRename(uri: string, position: Position): Promise<{ range: Range; placeholder: string } | null> {
    const file = await this.lookupFile(uri)
    if (!file) return null
    const occurrence = occurrenceAt(this.fileVariables(file), position)
    if (!occurrence) return null
    const range = stemRange(occurrence)
    if (!range || occurrence.stem === null) {
      throw new ResponseError(0, l('Dinamik adlı değişken yeniden adlandırılamaz.', 'A variable with a dynamic name cannot be renamed.'))
    }
    return { range, placeholder: occurrence.parameter ? occurrence.stem.slice(1) : occurrence.stem }
  }

  async rename(uri: string, position: Position, newName: string): Promise<WorkspaceEdit | null> {
    const file = await this.lookupFile(uri)
    if (!file) return null
    const target = occurrenceAt(this.fileVariables(file), position)
    if (!target || target.stem === null) return null
    let name = newName.trim()
    // Parametrenin üzerinde `_` olmadan yazılmış ad, gövdedeki `{_ad}` için `_` alır.
    if (target.parameter && !name.startsWith('_')) name = `_${name}`
    if (!name || /[{}%*\s]/.test(name) || name.includes('::')) {
      throw new ResponseError(0, l('Değişken adı boşluk, süslü parantez, % , * ya da :: içeremez.', 'Variable names cannot contain spaces, curly braces, %, * or ::.'))
    }
    if (name.startsWith('_') !== target.ref.local) {
      throw new ResponseError(0, target.ref.local
        ? l('Yerel değişkenin adı _ ile başlamalı.', 'Local variable names must start with _.')
        : l("Genel değişkenin adı _ ile başlayamaz (yerel değişkene dönüşür).", "Global variable names cannot start with _ (that makes them local)."))
    }
    const changes: Record<string, TextEdit[]> = {}
    for (const entry of await this.relatedVariables(file, target)) {
      for (const occurrence of entry.occurrences) {
        const range = stemRange(occurrence)
        if (!range) continue
        const text = occurrence.parameter ? name.slice(1) : name
        ;(changes[entry.uri] ??= []).push(TextEdit.replace(range, text))
      }
    }
    return { changes }
  }

  async getCompletions(uri: string, position: Position): Promise<CompletionItem[]> {
    const file = await this.lookupFile(uri)
    if (!file) return []
    await this.ensureVersion()
    const [entries, adapters, functions, variables] = await Promise.all([
      this.getEntries(this.currentVersion),
      this.getAdapters(),
      this.visibleFunctions(file.key),
      this.visibleVariables(file.key)
    ])
    return computeCompletions({
      uri: file.uri,
      doc: file.doc,
      analysis: file.analysis,
      text: file.text,
      position,
      entries,
      compiler: adapters.patternCompiler,
      functions,
      variables
    })
  }

  async getHover(uri: string, position: Position): Promise<Hover | null> {
    const file = await this.lookupFile(uri)
    if (!file) return null
    await this.ensureVersion()
    const [matcher, entries, functions] = await Promise.all([
      this.getMatcher(this.currentVersion),
      this.getEntries(this.currentVersion),
      this.visibleFunctions(file.key)
    ])
    return computeHover({
      uri: file.uri,
      doc: file.doc,
      analysis: file.analysis,
      position,
      matcher,
      entries,
      functions: functions as readonly HoverFunction[]
    })
  }

  async getDefinition(uri: string, position: Position): Promise<Location[]> {
    const file = await this.lookupFile(uri)
    if (!file) return []
    const variable = occurrenceAt(this.fileVariables(file), position)
    if (variable && variable.stem !== null) {
      const related = await this.relatedVariables(file, variable)
      const all = related.flatMap((entry) => entry.occurrences.map((occurrence) => ({ uri: entry.uri, occurrence })))
      const writes = all.filter(({ occurrence }) => occurrence.access !== 'read')
      // Yazılmıyorsa tanım olarak ilk kullanım gösterilir.
      return (writes.length > 0 ? writes : all.slice(0, 1)).map(({ uri: target, occurrence }) => ({
        uri: target,
        range: occurrence.ref.range
      }))
    }
    const index = await this.getFunctionIndex()
    return computeDefinition({
      uri: file.uri,
      key: file.key,
      doc: file.doc,
      text: file.text,
      position,
      files: await this.navigationFiles(),
      functions: index.all
    })
  }

  async getReferences(
    uri: string,
    position: Position,
    includeDeclaration: boolean
  ): Promise<Location[]> {
    const file = await this.lookupFile(uri)
    if (!file) return []
    const variable = occurrenceAt(this.fileVariables(file), position)
    if (variable && variable.stem !== null) {
      return (await this.relatedVariables(file, variable)).flatMap((entry) =>
        entry.occurrences.map((occurrence) => ({ uri: entry.uri, range: occurrence.ref.range }))
      )
    }
    const index = await this.getFunctionIndex()
    return computeReferences(
      {
        uri: file.uri,
        key: file.key,
        doc: file.doc,
        text: file.text,
        position,
        files: await this.navigationFiles(),
        functions: index.all
      },
      includeDeclaration
    )
  }

  async getDocumentSymbols(uri: string): Promise<DocumentSymbol[]> {
    const file = await this.lookupFile(uri)
    if (!file) return []
    return computeDocumentSymbols(file.doc)
  }

  async getSemanticTokens(uri: string): Promise<SemanticTokens> {
    const file = await this.lookupFile(uri)
    if (!file) return { data: [] }
    return computeSemanticTokens(file.doc)
  }

  private touch(): void {
    this.generation += 1
    this.functionIndex = undefined
    this.variableIndex = undefined
  }

  private fileVariables(file: StoredFile): VariableOccurrence[] {
    file.parsed.variables ??= analyzeVariables(file.doc)
    return file.parsed.variables
  }

  private getVariableIndex(): Promise<VariableFile[]> {
    if (this.variableIndex?.generation === this.generation) return this.variableIndex.promise
    const generation = this.generation
    const promise = (async () =>
      (await this.collectFiles()).map((file) => ({ uri: file.uri, key: file.key, occurrences: this.fileVariables(file) })))()
    this.variableIndex = { generation, promise }
    promise.catch(() => {
      if (this.variableIndex?.generation === generation) this.variableIndex = undefined
    })
    return promise
  }

  /** Aynı değişkenin (aynı kök ad) kullanımları: yerelse aynı tetikleyicide, genelse tüm çalışma alanında. */
  private async relatedVariables(file: StoredFile, target: VariableOccurrence): Promise<VariableFile[]> {
    if (target.ref.local) {
      const occurrences = this.fileVariables(file).filter(
        (occurrence) => occurrence.scope === target.scope && sameVariable(occurrence, target)
      )
      return [{ uri: file.uri, key: file.key, occurrences }]
    }
    const result: VariableFile[] = []
    for (const entry of await this.getVariableIndex()) {
      const occurrences = entry.occurrences.filter((occurrence) => sameVariable(occurrence, target))
      if (occurrences.length > 0) result.push({ ...entry, occurrences })
    }
    return result
  }

  private async getAdapters(): Promise<Adapters> {
    if (!this.adaptersPending) {
      const pending = (async () => {
        const defaults =
          this.options.parser && this.options.patternCompiler ? null : loadDefaultAdapters()
        const parser = this.options.parser ?? defaults?.parser
        const patternCompiler = this.options.patternCompiler ?? defaults?.patternCompiler
        if (!parser || !patternCompiler) {
          throw new Error(
            l('@skript-ide/parser ve @skript-ide/pattern-compiler paketleri yüklenemedi; dil sunucusu çalışamaz.', 'Could not load the @skript-ide/parser and @skript-ide/pattern-compiler packages; the language server cannot run.')
          )
        }
        return { parser, patternCompiler }
      })()
      pending.catch(() => {
        if (this.adaptersPending === pending) this.adaptersPending = undefined
      })
      this.adaptersPending = pending
    }
    return this.adaptersPending
  }

  private loadDatabaseCached(version: string): Promise<SyntaxDatabase> {
    let pending = this.databaseCache.get(version)
    if (!pending) {
      pending = this.options.loadDatabase(version)
      pending.catch(() => this.databaseCache.delete(version))
      this.databaseCache.set(version, pending)
    }
    return pending
  }

  private async ensureVersion(): Promise<void> {
    try {
      await this.loadDatabaseCached(this.currentVersion)
      return
    } catch {
      if (this.currentVersion === this.defaultVersion) return
    }
    const requested = this.currentVersion
    try {
      await this.loadDatabaseCached(this.defaultVersion)
    } catch {
      return
    }
    this.currentVersion = this.defaultVersion
    this.fallback = {
      message: unknownVersionMessage(requested, this.defaultVersion),
      foundVersion: requested,
      since: this.defaultVersion
    }
  }

  /** Önbellek anahtarı: Skript sürümü + seçili addon'lar (addon değişince yeni matcher/kayıt listesi). */
  private cacheKey(version: string): string {
    return `${version}|${this.addonKey}`
  }

  private loadAddon(info: AddonDatabaseRef): Promise<SyntaxDatabase> {
    return (this.options.loadAddonDatabase ?? loadBundledAddonDatabase)(info)
  }

  /** Seçili addon'ların bu Skript sürümü için veritabanları (yüklenemeyenler atlanır). */
  private getAddonSet(version: string): Promise<AddonSet> {
    const key = this.cacheKey(version)
    let pending = this.addonSetCache.get(key)
    if (!pending) {
      const selections = this.addons
      pending = (async () => {
        const databases: SyntaxDatabase[] = []
        let missing = false
        for (const selection of selections) {
          const info = resolveAddonDatabase(selection.name, selection.version, version)
          if (!info) {
            missing = true
            continue
          }
          try {
            databases.push(await this.loadAddon(info))
          } catch {
            missing = true
          }
        }
        return { databases, missing }
      })()
      this.addonSetCache.set(key, pending)
    }
    return pending
  }

  /** Skript sürümünün ve seçili addon'ların tüm kayıtları; addon kayıtları `addon` alanını taşır. */
  private async loadAllEntries(version: string): Promise<SyntaxEntry[]> {
    const [database, addonSet] = await Promise.all([this.loadDatabaseCached(version), this.getAddonSet(version)])
    if (addonSet.databases.length === 0) return database.entries
    return [...database.entries, ...addonSet.databases.flatMap((addon) => addon.entries)]
  }

  private getMatcher(version: string): Promise<MatcherAdapter | null> {
    const key = this.cacheKey(version)
    let pending = this.matcherCache.get(key)
    if (!pending) {
      const load = (async () => {
        try {
          const entries = await this.loadAllEntries(version)
          const adapters = await this.getAdapters()
          return adapters.patternCompiler.createMatcher(matcherEntries(entries))
        } catch {
          return null
        }
      })()
      // Geçici bir yükleme hatası oturum boyunca önbelleğe yazılmamalı; yalnızca başarı önbelleklenir.
      load.then((matcher) => {
        if (matcher === null && this.matcherCache.get(key) === load) {
          this.matcherCache.delete(key)
        }
      })
      this.matcherCache.set(key, load)
      pending = load
    }
    return pending
  }

  private getEntries(version: string): Promise<SyntaxEntry[]> {
    const key = this.cacheKey(version)
    let pending = this.entriesCache.get(key)
    if (!pending) {
      const load = this.loadAllEntries(version)
      // Başarısız yükleme [] olarak önbelleğe yazılmaz; sonraki istek yeniden dener.
      load.catch(() => {
        if (this.entriesCache.get(key) === load) this.entriesCache.delete(key)
      })
      this.entriesCache.set(key, load)
      pending = load
    }
    return pending.catch(() => [])
  }

  private async getBuiltinFunctions(version: string): Promise<ReadonlySet<string> | null> {
    const key = this.cacheKey(version)
    const cached = this.builtinFunctionCache.get(key)
    if (cached) return cached
    let entries: SyntaxEntry[]
    try {
      entries = await this.loadAllEntries(version)
    } catch {
      return null
    }
    const names = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'function') continue
      names.add(entry.name.toLowerCase())
      const patternName = /^[A-Za-z_][\w-]*/.exec(entry.patterns[0] ?? '')
      if (patternName) names.add(patternName[0].toLowerCase())
    }
    this.builtinFunctionCache.set(key, names)
    return names
  }

  private getVersionChecker(version: string): VersionChecker {
    const key = this.cacheKey(version)
    let checker = this.versionCheckers.get(key)
    if (!checker) {
      const others = listSyntaxVersions()
        .map((info) => info.skriptVersion)
        .filter((candidate) => candidate !== version)
      checker = new VersionChecker(
        version,
        others,
        (candidate) => this.getMatcher(candidate),
        async () => this.addonCandidates(version)
      )
      this.versionCheckers.set(key, checker)
    }
    return checker
  }

  /**
   * Seçili sürümde eşleşmeyen satırlar için denenecek addon veritabanları: önce seçili addon'ların
   * başka sürümleri, sonra seçili olmayan addon'lar; her addon sürümünün en yakın Skript sürümündeki verisi.
   */
  private addonCandidates(version: string): AddonCandidate[] {
    const selected = new Map(this.addons.map((selection) => [selection.name.toLowerCase(), selection.version]))
    const variants = new Map<string, { addon: string; addonVersion: string }>()
    for (const info of listAddonDatabases()) {
      variants.set(`${info.addon.toLowerCase()}@${info.addonVersion}`, { addon: info.addon, addonVersion: info.addonVersion })
    }
    const candidates: (AddonCandidate & { rank: number })[] = []
    for (const variant of variants.values()) {
      const selectedVersion = selected.get(variant.addon.toLowerCase())
      if (selectedVersion === variant.addonVersion) continue
      const info = resolveAddonDatabase(variant.addon, variant.addonVersion, version)
      if (!info) continue
      const matcherKey = `${info.addon.toLowerCase()}@${info.addonVersion}@${info.skriptVersion}`
      candidates.push({
        addon: info.addon,
        addonVersion: info.addonVersion,
        selectedVersion,
        rank: selectedVersion ? 0 : 1,
        getMatcher: () => this.getAddonOnlyMatcher(matcherKey, info)
      })
    }
    // Katalog addon adına ve sürüme (yeniden eskiye) göre sıralı; sıralama kararlı olduğundan bu sıra korunur.
    return candidates.sort((a, b) => a.rank - b.rank)
  }

  private getAddonOnlyMatcher(key: string, info: AddonDatabaseRef): Promise<MatcherAdapter | null> {
    let pending = this.addonMatcherCache.get(key)
    if (!pending) {
      pending = (async () => {
        try {
          const database = await this.loadAddon(info)
          const adapters = await this.getAdapters()
          return adapters.patternCompiler.createMatcher(matcherEntries(database.entries))
        } catch {
          return null
        }
      })()
      this.addonMatcherCache.set(key, pending)
    }
    return pending
  }

  private async parseText(text: string): Promise<ParsedDocument> {
    const adapters = await this.getAdapters()
    const doc = adapters.parser.parseDocument(text)
    return { doc, analysis: analyzeDocument(doc) }
  }

  private async openFileState(document: OpenDocument): Promise<StoredFile> {
    document.parsed ??= await this.parseText(document.text)
    return {
      uri: document.uri,
      key: uriKey(document.uri),
      text: document.text,
      doc: document.parsed.doc,
      analysis: document.parsed.analysis,
      parsed: document.parsed
    }
  }

  private async workspaceFileState(key: string, file: WorkspaceFile): Promise<StoredFile> {
    let parsed = this.workspaceCache.get(key)
    if (!parsed) {
      parsed = await this.parseText(file.text)
      this.workspaceCache.set(key, parsed)
    }
    return { uri: file.uri, key, text: file.text, doc: parsed.doc, analysis: parsed.analysis, parsed }
  }

  private async lookupFile(uri: string): Promise<StoredFile | null> {
    const key = uriKey(uri)
    const open = this.openDocuments.get(key)
    if (open) return this.openFileState(open)
    const workspace = this.workspaceFiles.get(key)
    if (workspace) return this.workspaceFileState(key, workspace)
    return null
  }

  private async collectFiles(): Promise<StoredFile[]> {
    const files: StoredFile[] = []
    for (const open of this.openDocuments.values()) files.push(await this.openFileState(open))
    for (const [key, workspace] of this.workspaceFiles) {
      if (this.openDocuments.has(key)) continue
      files.push(await this.workspaceFileState(key, workspace))
    }
    return files
  }

  private async navigationFiles(): Promise<NavigationFile[]> {
    return (await this.collectFiles()).map((file) => ({
      uri: file.uri,
      key: file.key,
      doc: file.doc
    }))
  }

  private getFunctionIndex(): Promise<FunctionIndex> {
    if (this.functionIndex?.generation === this.generation) return this.functionIndex.promise
    const generation = this.generation
    const promise = (async () => {
      const all: WorkspaceFunction[] = []
      let customSyntax = false
      for (const file of await this.collectFiles()) {
        for (const definition of file.doc.functions) {
          all.push({ uri: file.uri, fileKey: file.key, definition })
        }
        customSyntax ||= file.doc.structures.some(
          (structure) => structure.kind === 'unknown' && CUSTOM_SYNTAX_HEADER.test(structure.header.trim())
        )
      }
      return { all, customSyntax }
    })()
    this.functionIndex = { generation, promise }
    promise.catch(() => {
      if (this.functionIndex?.generation === generation) this.functionIndex = undefined
    })
    return promise
  }

  private async definedFunctionNames(fileKey: string): Promise<ReadonlySet<string>> {
    const index = await this.getFunctionIndex()
    const names = new Set<string>()
    for (const candidate of index.all) {
      if (candidate.definition.local && candidate.fileKey !== fileKey) continue
      names.add(candidate.definition.name.toLowerCase())
    }
    return names
  }

  private async visibleFunctions(fileKey: string): Promise<VisibleFunction[]> {
    const index = await this.getFunctionIndex()
    return index.all
      .filter((candidate) => !candidate.definition.local || candidate.fileKey === fileKey)
      .map((candidate) => ({ definition: candidate.definition, uri: candidate.uri }))
  }

  private async visibleVariables(fileKey: string): Promise<VisibleVariable[]> {
    const files = await this.collectFiles()
    const variables: VisibleVariable[] = []
    for (const file of files) {
      for (const variable of file.doc.variables) {
        if (variable.local && file.key !== fileKey) continue
        variables.push({ name: variable.name, local: variable.local, list: variable.list })
      }
    }
    return variables
  }
}

function sameStart(a: Range, b: Range): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character
}

export { collectDiagnostics, VersionChecker }
