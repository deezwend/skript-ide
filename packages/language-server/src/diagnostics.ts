import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import type {
  FunctionCall,
  FunctionDefinition,
  LineInfo,
  MatchStatusLike,
  MatcherAdapter,
  SkriptDocument,
  SyntaxMatchLike
} from './contracts'
import { analyzeDocument, type DocumentAnalysis, type LineContext } from './document'
import { compareVersions, versionDistance } from './util'
import { l } from '@skript-ide/i18n'
export const DIAGNOSTIC_SOURCE = 'skript-ls'

/** Kararlı diagnostic kodları. README'de belgelenmiştir. */
export const DiagnosticCodes = {
  /** Parser'ın kodu `parse/<parser-kodu>` biçiminde eklenir. */
  parse: 'parse',
  undefinedFunction: 'undefined-function',
  /** Çağrıdaki argüman sayısı fonksiyonun imzasına uymuyor. */
  functionArguments: 'function-arguments',
  /** Bir argüman sabiti parametrenin türüne açıkça uymuyor (ör. sayı bekleyen yere metin). */
  functionArgumentType: 'function-argument-type',
  /** Fonksiyon yalnızca Skript'in yüklemediği (`-` ile başlayan) bir dosyada tanımlı. */
  functionDisabledFile: 'function-disabled-file',
  /** Fonksiyon başka bir dosyada tanımlı; oyunda bu dosya tek başına yüklenirse o dosya da yüklü olmalı. */
  functionOtherFile: 'function-other-file',
  undefinedOption: 'undefined-option',
  versionSyntax: 'version-syntax',
  /** Satır seçili olmayan bir addon'un (ya da seçili addon'un başka sürümünün) syntax'ı. */
  addonSyntax: 'addon-syntax',
  /** Satır ne seçili sürümde ne başka bir sürümde ne de bilinen bir addon'da hiçbir syntax'a uyuyor. */
  unknownSyntax: 'unknown-syntax'
} as const

const SEVERITY: Record<string, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint
}

export type LineGroup = Exclude<LineContext['kind'], 'skip'>

export interface VersionWarning {
  message: string
  foundVersion: string
  since?: string
  /** Uyarı bir addon syntax'ı için ise: bulunduğu addon ve sürümü. */
  addon?: { name: string; version: string; selectedVersion?: string }
  /** Satır hiçbir yerde bir syntax'a uymuyor (Skript'in "Can't understand this ..." hatası). */
  unknown?: boolean
}

/** Seçili sürümde eşleşmeyen satırların denendiği addon veritabanı. */
export interface AddonCandidate {
  addon: string
  addonVersion: string
  /** Addon projede seçiliyse seçili sürüm; seçili değilse yok. */
  selectedVersion?: string
  getMatcher: () => Promise<MatcherAdapter | null>
}

/** Satır sonucu önbelleğinin üst sınırı; büyük (10k+ satırlı) dosyaların tamamını tutabilmeli. */
const VERSION_CACHE_LIMIT = 50_000

/** Farklı sürümlerin veritabanlarını yalnızca gerektiğinde yükleyen sürüm uyarısı çözücüsü. */
export class VersionChecker {
  private readonly cache = new Map<string, VersionWarning | null>()

  constructor(
    private readonly currentVersion: string,
    private readonly otherVersions: readonly string[],
    private readonly getMatcher: (version: string) => Promise<MatcherAdapter | null>,
    private readonly addonCandidates: () => Promise<readonly AddonCandidate[]> = async () => []
  ) {}

  async check(group: LineGroup, text: string): Promise<VersionWarning | null> {
    const key = `${this.currentVersion}|${group}|${text.toLowerCase()}`
    if (this.cache.has(key)) {
      const cached = this.cache.get(key) ?? null
      // LRU: kullanılan kayıt sona taşınır, böylece silinecekler en uzun süredir kullanılmayanlar olur.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }

    const selected = await this.getMatcher(this.currentVersion)
    if (!selected) return this.remember(key, null)
    if (matchLine(selected, group, text, true).length > 0) return this.remember(key, null)

    const ordered = [...this.otherVersions].sort(
      (left, right) => versionDistance(this.currentVersion, left) - versionDistance(this.currentVersion, right)
    )
    for (const version of ordered) {
      if (version === this.currentVersion) continue
      const matcher = await this.getMatcher(version)
      if (!matcher) continue
      const exact = matchLine(matcher, group, text).find((match) => match.confidence === 'exact')
      if (!exact) continue
      const warning: VersionWarning = {
        message: buildMessage(this.currentVersion, version, exact),
        foundVersion: version,
        since: exact.entry.since?.[0]
      }
      return this.remember(key, warning)
    }
    for (const candidate of await this.addonCandidates()) {
      const matcher = await candidate.getMatcher()
      if (!matcher) continue
      const exact = matchLine(matcher, group, text).find((match) => match.confidence === 'exact')
      if (!exact) continue
      const message = candidate.selectedVersion
        ? l(`Bu syntax ${candidate.addon} ${candidate.addonVersion} sürümünde var; projede ${candidate.addon} ${candidate.selectedVersion} seçili.`, `This syntax exists in ${candidate.addon} ${candidate.addonVersion}; the project uses ${candidate.addon} ${candidate.selectedVersion}.`)
        : l(`Bu syntax ${candidate.addon} addon'una ait (${exact.entry.name}); projede ${candidate.addon} seçili değil.`, `This syntax belongs to the ${candidate.addon} addon (${exact.entry.name}); ${candidate.addon} is not selected in the project.`)
      return this.remember(key, {
        message,
        foundVersion: this.currentVersion,
        addon: { name: candidate.addon, version: candidate.addonVersion, selectedVersion: candidate.selectedVersion }
      })
    }
    return this.remember(key, unknownSyntax(selected, group, text, this.currentVersion))
  }

  private remember(key: string, value: VersionWarning | null): VersionWarning | null {
    // Önbellek tamamen temizlenmez: binlerce farklı satırı olan dosyalarda her turda baştan
    // eşleştirmeye (düzenleme başına saniyeler) yol açıyordu. Yalnızca en eski kayıtlar atılır.
    this.cache.set(key, value)
    while (this.cache.size > VERSION_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return value
  }
}

const STATEMENT_KINDS = ['effect', 'condition', 'section'] as const

/**
 * `retryKinds`, türlerin paylaştığı adım bütçesi tükenmiş olabileceğinde her türü kendi
 * bütçesiyle yeniden dener. Yalnızca seçili sürüm için gerekir: diğer sürümlerde kaçırılan
 * eşleşme uyarı üretmemekle sonuçlanır (yanlış pozitif değil).
 */
export function matchLine(
  matcher: MatcherAdapter,
  group: LineGroup,
  text: string,
  retryKinds = false
): readonly SyntaxMatchLike[] {
  switch (group) {
    case 'event':
      return matcher.matchEvent(text)
    case 'condition':
      return matcher.match(text, ['condition'])
    case 'section':
      return matcher.match(text, ['section'])
    case 'statement': {
      const matches = matcher.match(text, STATEMENT_KINDS)
      if (matches.length > 0 || !retryKinds) return matches
      return STATEMENT_KINDS.flatMap((kind) => matcher.match(text, [kind]))
    }
  }
}

/**
 * `unknown-syntax` için denenecek türler. Bölüm başlığı bir koşul da olabilir (Skript'in örtük
 * `if`'i, `SecConditional`'ın `implicit:<.+>` pattern'i) ya da bölümlü bir efekt.
 */
const UNKNOWN_KINDS = {
  condition: ['condition'],
  section: ['section', 'condition', 'effect'],
  statement: STATEMENT_KINDS
} as const

/** Satırın tamamı bir fonksiyon çağrısıysa Skript bunu efekt olarak çalıştırır (veritabanında kaydı yok). */
const BARE_FUNCTION_CALL = /^[\p{L}_][\p{L}\p{N}_]*\(.*\)$/su

/** `if any:` / `if all:` çok satırlı koşul başlığı; koşullar alt satırlardadır. */
const MULTILINE_CONDITION = /^(?:any|all|at\s+least\s+one(?:\s+of)?)$/i

/** `display scale: vector(…)` gibi addon bölümlerinin `anahtar: değer` girişleri. */
const ENTRY_LINE = /^[\p{L}][\p{L}\p{N} _-]*:\s*\S/u

/** skript-reflect Java çağrısı (`{_list}.add(…)`, `Files.move(…)`); string içleri sayılmaz. */
const JAVA_CALL = /[\p{L}\p{N}_)\]}]\.[\p{L}_][\p{L}\p{N}_]*\s*\(/u

/** Yanlış pozitif riski yüksek, Skript çekirdeğinin dışındaki biçimler. */
function looksLikeAddonLine(group: LineGroup, text: string): boolean {
  const trimmed = text.trim()
  if (group === 'condition') return MULTILINE_CONDITION.test(trimmed)
  if (group === 'event') return false
  if (group === 'statement' && BARE_FUNCTION_CALL.test(trimmed)) return true
  if (ENTRY_LINE.test(trimmed)) return true
  return JAVA_CALL.test(trimmed.replace(/"(?:[^"]|"")*"/g, '""'))
}

const unknownLabel = (group: LineGroup): string =>
  ({
    event: l('olay', 'event'),
    condition: l('koşul', 'condition'),
    section: l('bölüm ya da koşul', 'section or condition'),
    statement: l('efekt ya da koşul', 'effect or condition')
  })[group]

/**
 * Seçili sürümde satır hiçbir kayda (structural dahil) uymuyorsa ve arama bütçe tükenmeden
 * bittiyse uyarı üretir. Bütçe tükendiyse ya da eşleştirici durumu bildirmiyorsa sessiz kalır.
 */
function unknownSyntax(
  matcher: MatcherAdapter,
  group: LineGroup,
  text: string,
  currentVersion: string
): VersionWarning | null {
  if (looksLikeAddonLine(group, text)) return null
  const status = matchLineStatus(matcher, group, text)
  if (!status || !status.complete || status.matches.length > 0) return null
  return {
    message:
      l(
        `Skript bu satırı anlayamaz: Skript ${currentVersion} sürümünde bu satıra uyan bir ${unknownLabel(group)} yok. ` +
          `Satır bir addon'a aitse addon'u skript-project.json dosyasındaki "addons" listesine ekleyin.`,
        `Skript can't understand this line: no ${unknownLabel(group)} in Skript ${currentVersion} matches it. ` +
          `If the line belongs to an addon, add the addon to the "addons" list in skript-project.json.`
      ),
    foundVersion: currentVersion,
    unknown: true
  }
}

function matchLineStatus(matcher: MatcherAdapter, group: LineGroup, text: string): MatchStatusLike | null {
  if (group === 'event') return matcher.matchEventWithStatus?.(text) ?? null
  if (!matcher.matchWithStatus) return null
  const kinds = UNKNOWN_KINDS[group]
  const combined = matcher.matchWithStatus(text, kinds)
  if (combined.complete || combined.matches.length > 0) return combined
  // Paylaşılan bütçe tükendiyse her tür kendi bütçesiyle denenir.
  const matches: SyntaxMatchLike[] = []
  let complete = true
  for (const kind of kinds) {
    const result = matcher.matchWithStatus(text, [kind])
    matches.push(...result.matches)
    complete &&= result.complete
  }
  return { matches, complete }
}

function buildMessage(currentVersion: string, foundVersion: string, match: SyntaxMatchLike): string {
  const entry = match.entry
  if (compareVersions(foundVersion, currentVersion) > 0) {
    const since = entry.since?.find((value) => compareVersions(value, currentVersion) > 0) ?? entry.since?.[0]
    const label = since && compareVersions(since, currentVersion) > 0 ? since : foundVersion
    return l(`Bu syntax Skript ${label} sürümünde eklendi; seçili sürüm ${currentVersion}.`, `This syntax was added in Skript ${label}; the selected version is ${currentVersion}.`)
  }
  return l(`Bu syntax Skript ${currentVersion} sürümünde yok ya da kaldırılmış (Skript ${foundVersion} sürümünde vardı).`, `This syntax does not exist or was removed in Skript ${currentVersion} (it existed in Skript ${foundVersion}).`)
}

export interface FunctionSite {
  definition: FunctionDefinition
  /** Tanımın bulunduğu dosya, betik klasörüne göre (ör. `kaydirak/kaydirak-cizim.sk`). */
  path: string
  /** Tanım, tanıları hesaplanan dosyanın kendisinde mi? */
  sameFile: boolean
  /** Skript bu dosyayı yüklemez: kendisi ya da bir üst klasörü `-` ile başlıyor. */
  disabled: boolean
}

export interface DiagnosticsOptions {
  currentVersion: string
  versionChecker: VersionChecker
  /** Seçili sürümün yerleşik fonksiyon adları (küçük harf). Veritabanı yoksa null. */
  builtinFunctions: ReadonlySet<string> | null
  /** Çalışma alanındaki tanımlı fonksiyon adları (küçük harf); local olanlar yalnızca aynı dosyadan. */
  definedFunctions: ReadonlySet<string>
  /** Tanımsız fonksiyon denetimi yapılmalı mı? (çalışma alanı listesi tam ya da hiç bildirilmemiş) */
  checkUndefinedFunctions: boolean
  /**
   * Çalışma alanındaki fonksiyon tanımları (küçük harfli ad → tanımlar, başka dosyalardaki local olanlar dahil).
   * Verilirse imza (argüman sayısı/türü) ve dosya bağımlılığı denetimleri de yapılır.
   */
  workspaceFunctions?: ReadonlyMap<string, readonly FunctionSite[]>
  /** Hiçbir syntax'a uymayan satırlar raporlansın mı? (verisi olmayan addon seçiliyse hayır) */
  checkUnknownSyntax?: boolean
  /** Daha yeni bir belge sürümü geldiyse hesaplamayı bırakmak için (isteğe bağlı). */
  isCurrent?: () => boolean
  /** Başka analizlerin (değişken analizi) hazır tanıları; sonuçla birlikte sıralanır. */
  additional?: readonly Diagnostic[]
}

/** Sürüm denetimi uzun belgelerde worker'ı kilitlemesin diye olay döngüsüne dönülür. */
const VERSION_YIELD_LINES = 50
const VERSION_YIELD_MS = 10

/**
 * `setTimeout(0)` kullanılmaz: Windows'ta ~15 ms'ye, worker'da iç içe çağrılarda 4 ms'ye yuvarlanıyor;
 * 8000 satırlık dosyada düzenleme başına ~3 s boş beklemeye yol açıyordu. `setImmediate` (Node) ve
 * `MessageChannel` (worker) beklemeden döner ama bekleyen mesajların (tamamlama/hover) araya girmesine izin verir.
 */
let yieldChannel: MessageChannel | undefined
const yieldResolvers: (() => void)[] = []

function yieldToEventLoop(): Promise<void> {
  if (typeof setImmediate === 'function') return new Promise((resolve) => setImmediate(resolve))
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  if (!yieldChannel) {
    yieldChannel = new MessageChannel()
    yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.()
  }
  const channel = yieldChannel
  return new Promise((resolve) => {
    yieldResolvers.push(resolve)
    channel.port2.postMessage(null)
  })
}

export function collectDiagnostics(
  doc: SkriptDocument,
  options: DiagnosticsOptions
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const parserErrorLines = new Set<number>()

  for (const parseDiagnostic of doc.diagnostics) {
    diagnostics.push({
      range: parseDiagnostic.range,
      severity: SEVERITY[parseDiagnostic.severity] ?? DiagnosticSeverity.Warning,
      code: `${DiagnosticCodes.parse}/${parseDiagnostic.code}`,
      source: DIAGNOSTIC_SOURCE,
      message: parseDiagnostic.message
    })
    if (parseDiagnostic.severity === 'error') parserErrorLines.add(parseDiagnostic.range.start.line)
  }

  const analysis = analyzeDocument(doc)

  if (options.additional) diagnostics.push(...options.additional)
  addUndefinedFunctions(doc, options, diagnostics)
  addFunctionCallChecks(doc, options, diagnostics)
  addUndefinedOptions(doc, analysis, diagnostics)
  if (options.checkUnknownSyntax !== false) addMisplacedStructures(doc, diagnostics, parserErrorLines)

  return addVersionWarnings(doc, analysis, options, diagnostics, parserErrorLines).then(() =>
    sortDiagnostics(diagnostics)
  )
}

function addUndefinedFunctions(
  doc: SkriptDocument,
  options: DiagnosticsOptions,
  diagnostics: Diagnostic[]
): void {
  if (!options.checkUndefinedFunctions) return
  const builtins = options.builtinFunctions
  // Yerleşik fonksiyon listesi bilinmiyorsa yanlış pozitif üretmemek için denetim yapılmaz.
  if (!builtins) return
  const seen = new Set<string>()
  for (const call of doc.functionCalls) {
    // `x.method()` Skript fonksiyonu değil, skript-reflect üzerinden Java metodu çağrısıdır.
    const lineText = doc.lines[call.nameRange.start.line]
    if (lineText && isMethodCall(lineText, call.nameRange.start.character)) continue
    const key = call.name.toLowerCase()
    if (options.definedFunctions.has(key) || builtins.has(key)) continue
    const identity = `${call.nameRange.start.line}:${call.nameRange.start.character}:${key}`
    if (seen.has(identity)) continue
    seen.add(identity)
    diagnostics.push({
      range: call.nameRange,
      severity: DiagnosticSeverity.Warning,
      code: DiagnosticCodes.undefinedFunction,
      source: DIAGNOSTIC_SOURCE,
      message: l(`"${call.name}" fonksiyonu tanımlı değil. Çalışma alanında ya da Skript ${options.currentVersion} yerleşik fonksiyonlarında bulunamadı.`, `Function "${call.name}" is not defined. It was not found in the workspace or among the built-in functions of Skript ${options.currentVersion}.`),
      data: { skriptVersion: options.currentVersion }
    })
  }
}

/*
 * Oyunda "The function x(object, number) does not exist" hatası şu durumlarda çıkar:
 *  - argüman sayısı imzaya uymaz ya da bir argüman parametre türüne dönüştürülemez,
 *  - fonksiyon Skript'in yüklemediği bir dosyadadır (`-` ile başlayan dosya/klasör),
 *  - fonksiyon başka bir dosyadadır ve o dosya sunucuda (henüz) yüklü değildir; örneğin yeni oluşturulmuş
 *    ve yalnızca bu dosya `sk reload` ile yüklenmiştir.
 * Son durum statik olarak kesin bilinemez; bilgi düzeyinde hatırlatılır.
 */
function addFunctionCallChecks(
  doc: SkriptDocument,
  options: DiagnosticsOptions,
  diagnostics: Diagnostic[]
): void {
  const functions = options.workspaceFunctions
  if (!functions) return
  const remindedOtherFile = new Set<string>()
  for (const call of doc.functionCalls) {
    const line = doc.lines[call.nameRange.start.line]
    if (!line || isMethodCall(line, call.nameRange.start.character)) continue
    const key = call.name.toLowerCase()
    const visible = (functions.get(key) ?? []).filter((site) => site.sameFile || !site.definition.local)
    if (visible.length === 0) continue
    const loaded = visible.filter((site) => site.sameFile || !site.disabled)
    if (loaded.length === 0) {
      diagnostics.push({
        range: call.nameRange,
        severity: DiagnosticSeverity.Error,
        code: DiagnosticCodes.functionDisabledFile,
        source: DIAGNOSTIC_SOURCE,
        message: l(
          `"${call.name}" yalnızca ${visible[0].path} dosyasında tanımlı; Skript adı "-" ile başlayan dosya ve klasörleri yüklemez. Oyunda "The function ${call.name}(…) does not exist" hatası verir.`,
          `"${call.name}" is only defined in ${visible[0].path}; Skript does not load files or folders whose name starts with "-". In game this fails with "The function ${call.name}(…) does not exist".`
        )
      })
      continue
    }
    const site = loaded.find((candidate) => candidate.sameFile) ?? loaded[0]
    checkArguments(call, line, site.definition, diagnostics)
    if (!site.sameFile && !remindedOtherFile.has(key)) {
      remindedOtherFile.add(key)
      diagnostics.push({
        range: call.nameRange,
        severity: DiagnosticSeverity.Information,
        code: DiagnosticCodes.functionOtherFile,
        source: DIAGNOSTIC_SOURCE,
        message: l(
          `"${call.name}" ${site.path} dosyasında tanımlı. Bu dosyayı oyunda tek başına yüklüyorsan önce o dosya yüklü olmalı (/sk reload ${site.path}); yoksa "The function ${call.name}(…) does not exist" hatası alırsın.`,
          `"${call.name}" is defined in ${site.path}. If you reload only this file in game, that file must be loaded first (/sk reload ${site.path}); otherwise you get "The function ${call.name}(…) does not exist".`
        ),
        data: { path: site.path }
      })
    }
  }
}

/** Metin sabiti bu türlere hiçbir zaman dönüştürülmez. */
const NON_TEXT_TYPES = new Set([
  'number', 'numbers', 'integer', 'integers', 'boolean', 'booleans', 'location', 'locations',
  'vector', 'vectors', 'entity', 'entities', 'player', 'players'
])
const TEXT_LITERAL = /^"(?:[^"]|"")*"$/
const LIST_JOINER = /\s(?:and|or|nor)\s/i

function checkArguments(call: FunctionCall, line: LineInfo, definition: FunctionDefinition, diagnostics: Diagnostic[]): void {
  const open = line.text.indexOf('(', call.nameRange.end.character - line.start)
  if (open < 0) return
  const inner = splitArguments(line.text.slice(open + 1))
  // Kapanmayan parantez: `rest` boş değilse çağrı satırda bitmiyor, denetlenmez
  if (inner.rest === null) return
  const args = inner.args
  const parameters = definition.parameters
  const max = parameters.length
  const min = parameters.filter((parameter) => parameter.defaultValue === undefined).length
  const signature = `${definition.name}(${parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(', ')})`

  // Tek parametreli fonksiyonda Skript bütün argümanları tek bir liste olarak verir; virgüller sayılmaz.
  // "a and b" de birden çok argüman sayılabildiğinden virgül sayısı alt sınırdır: "az argüman" yalnızca
  // böyle bir liste yoksa söylenir.
  const tooMany = max !== 1 && args.length > max
  const tooFew = args.length < min && !args.some((arg) => LIST_JOINER.test(arg))
  if (tooMany || tooFew) {
    const expected = min === max ? `${max}` : `${min}–${max}`
    diagnostics.push({
      range: call.range,
      severity: DiagnosticSeverity.Error,
      code: DiagnosticCodes.functionArguments,
      source: DIAGNOSTIC_SOURCE,
      message: l(
        `"${definition.name}" ${expected} argüman alıyor ama ${args.length} verildi (${signature}). Oyunda "The function ${definition.name}(…) does not exist" hatası verir.`,
        `"${definition.name}" takes ${expected} arguments but ${args.length} were given (${signature}). In game this fails with "The function ${definition.name}(…) does not exist".`
      )
    })
    return
  }

  if (max === 1 && args.length > 1) return
  args.forEach((arg, index) => {
    const parameter = parameters[index]
    if (!parameter || !TEXT_LITERAL.test(arg)) return
    if (!NON_TEXT_TYPES.has(parameter.type.trim().toLowerCase())) return
    diagnostics.push({
      range: call.range,
      severity: DiagnosticSeverity.Error,
      code: DiagnosticCodes.functionArgumentType,
      source: DIAGNOSTIC_SOURCE,
      message: l(
        `"${definition.name}" fonksiyonunun ${index + 1}. argümanı (${parameter.name}) ${parameter.type} olmalı ama metin verildi: ${arg}. Oyunda "The function ${definition.name}(…) does not exist" hatası verir.`,
        `Argument ${index + 1} of "${definition.name}" (${parameter.name}) must be ${parameter.type}, but text was given: ${arg}. In game this fails with "The function ${definition.name}(…) does not exist".`
      )
    })
  })
}

/**
 * Açılış parantezinden sonraki metni, çağrıyı kapatan `)` işaretine kadar parantez, köşeli/süslü parantez
 * ve tırnak dışındaki virgüllerden böler. `rest`: kapanıştan sonraki metin; çağrı kapanmıyorsa null.
 */
export function splitArguments(text: string): { args: string[]; rest: string | null } {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    if (char === '"') {
      // Skript metninde "" kaçışlı bir tırnaktır
      if (inString && text.charAt(i + 1) === '"') i++
      else inString = !inString
      continue
    }
    if (inString) continue
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' && depth === 0) {
      const last = text.slice(start, i).trim()
      if (parts.length > 0 || last !== '') parts.push(last)
      return { args: parts, rest: text.slice(i + 1) }
    } else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  return { args: parts, rest: null }
}

function isMethodCall(line: LineInfo, character: number): boolean {
  const before = line.text.slice(0, Math.max(0, character - line.start)).trimEnd()
  return before.endsWith('.')
}

function addUndefinedOptions(
  doc: SkriptDocument,
  analysis: DocumentAnalysis,
  diagnostics: Diagnostic[]
): void {
  if (doc.optionReferences.length === 0) return
  // Skript 2.17 (StructOptions): options yapısı yoksa {@x} yerine konmaz, düz metin kalır.
  // Bu yüzden yapı hiç yokken tanımsız option uyarısı üretilmez; boş `options:` yapısı yeterlidir.
  if (!doc.structures.some((structure) => structure.kind === 'options')) return
  const definitions = analysis.options
  for (const reference of doc.optionReferences) {
    if (definitions.has(reference.name.toLowerCase())) continue
    diagnostics.push({
      range: reference.range,
      severity: DiagnosticSeverity.Warning,
      code: DiagnosticCodes.undefinedOption,
      source: DIAGNOSTIC_SOURCE,
      message: l(`"{@${reference.name}}" seçeneği bu dosyanın options bölümünde tanımlı değil.`, `Option "{@${reference.name}}" is not defined in the options section of this file.`)
    })
  }
}

/** Üst düzeyde yalnızca gövdede geçerli olabilecek başlıklar (`if …:`, `loop …:`, `trigger:`). */
const BODY_ONLY_HEADER = /^(?:(?:else\s+)?(?:parse\s+)?if\s+.+|else|(?:do\s+)?while\s+.+|loop\s+.+|trigger)$/i

function addMisplacedStructures(
  doc: SkriptDocument,
  diagnostics: Diagnostic[],
  parserErrorLines: ReadonlySet<number>
): void {
  for (const structure of doc.structures) {
    if (structure.kind !== 'unknown') continue
    if (parserErrorLines.has(structure.headerRange.start.line)) continue
    if (!BODY_ONLY_HEADER.test(structure.header.trim())) continue
    diagnostics.push({
      range: structure.headerRange,
      severity: DiagnosticSeverity.Error,
      code: DiagnosticCodes.unknownSyntax,
      source: DIAGNOSTIC_SOURCE,
      message: l(`Skript bu yapıyı anlayamaz: "${structure.header.trim()}" yalnızca bir olay, komut ya da fonksiyon gövdesinde kullanılabilir.`, `Skript can't understand this structure: "${structure.header.trim()}" can only be used inside an event, command or function body.`)
    })
  }
}

async function addVersionWarnings(
  doc: SkriptDocument,
  analysis: DocumentAnalysis,
  options: DiagnosticsOptions,
  diagnostics: Diagnostic[],
  parserErrorLines: ReadonlySet<number>
): Promise<void> {
  const lines = [...analysis.lines.entries()].sort(([left], [right]) => left - right)
  let sinceYield = 0
  let lastYield = Date.now()
  for (const [line, context] of lines) {
    if (context.kind === 'skip' || parserErrorLines.has(line)) continue
    if (doc.lines[line]?.blank) continue
    if (!context.text.trim()) continue
    const warning = await options.versionChecker.check(context.kind, context.text)
    if (warning?.unknown) {
      if (options.checkUnknownSyntax !== false) {
        diagnostics.push({
          range: context.range,
          severity: DiagnosticSeverity.Error,
          code: DiagnosticCodes.unknownSyntax,
          source: DIAGNOSTIC_SOURCE,
          message: warning.message,
          data: { skriptVersion: warning.foundVersion }
        })
      }
    } else if (warning) {
      diagnostics.push({
        range: context.range,
        severity: DiagnosticSeverity.Warning,
        code: warning.addon ? DiagnosticCodes.addonSyntax : DiagnosticCodes.versionSyntax,
        source: DIAGNOSTIC_SOURCE,
        message: warning.message,
        data: warning.addon
          ? { addon: warning.addon.name, addonVersion: warning.addon.version }
          : { skriptVersion: warning.foundVersion, since: warning.since }
      })
    }

    // 500 eşleşmeyen addon satırı ~3 s sürebiliyor; düzenli olarak olay döngüsüne dön ki
    // tamamlama/hover istekleri araya girebilsin.
    sinceYield += 1
    if (sinceYield >= VERSION_YIELD_LINES || Date.now() - lastYield >= VERSION_YIELD_MS) {
      sinceYield = 0
      await yieldToEventLoop()
      lastYield = Date.now()
      if (options.isCurrent && !options.isCurrent()) return
    }
  }
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.sort((left, right) => {
    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line
    }
    if (left.range.start.character !== right.range.start.character) {
      return left.range.start.character - right.range.start.character
    }
    return String(left.code).localeCompare(String(right.code))
  })
}
