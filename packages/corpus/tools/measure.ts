/**
 * Corpus dosyalarının statik diagnostics'ini `@skript-ide/language-server` içindeki
 * `SkriptLanguageService` ile üretir ve gerçek sunucu ground-truth'u ile karşılaştırır.
 *
 * Çıktı: samples/report-<skriptSürümü>.json + konsol özeti.
 *
 * Kullanım:
 *   npx tsx packages/corpus/tools/measure.ts
 *   npx tsx packages/corpus/tools/measure.ts --version 2.17.1
 *
 * Language server paketi henüz hazır değilse araç bunu rapora yazar ve 2 koduyla çıkar;
 * sözleşme (faz4-sozlesme.md §3) değişmediği sürece kod hazır olduğunda yeniden çalıştırılabilir.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const samplesDir = resolve(toolsDir, '..', 'samples')
const groundTruthDir = join(samplesDir, 'ground-truth')

interface CliOptions {
  versions: string[]
  outDir: string
  help: boolean
}

interface GroundTruthDiagnostic {
  line: number
  severity: 'error' | 'warning'
  message: string
  code?: string
}

interface GroundTruthFile {
  path: string
  diagnostics: GroundTruthDiagnostic[]
}

interface GroundTruthReport {
  skriptVersion: string
  files: GroundTruthFile[]
}

interface LspPosition {
  line: number
  character: number
}

interface LspDiagnostic {
  range: { start: LspPosition; end: LspPosition }
  severity?: number
  code?: string | number | { value?: string | number }
  message: string
  source?: string
}

interface LanguageService {
  openDocument(uri: string, text: string, version: number): void
  getDiagnostics(uri: string): Promise<LspDiagnostic[]>
  closeDocument(uri: string): void
}

interface LanguageServiceOptions {
  loadDatabase: (skriptVersion: string) => Promise<unknown>
  skriptVersion?: string
}

interface LanguageServerModule {
  SkriptLanguageService?: new (options: LanguageServiceOptions) => LanguageService
}

interface StaticDiagnostic {
  line: number
  severity: 'error' | 'warning'
  code: string
  message: string
}

interface FileResult {
  path: string
  staticDiagnostics: StaticDiagnostic[]
  groundTruthDiagnostics: GroundTruthDiagnostic[]
  truePositives: number
  falsePositives: number
  falseNegatives: number
  severityMismatches: number
  falsePositiveLines: number[]
  falseNegativeLines: number[]
  error?: string
}

interface CodeResult {
  code: string
  truePositives: number
  falsePositives: number
}

interface MeasureReport {
  schemaVersion: 1
  generatedAt: string
  skriptVersion: string
  languageServerAvailable: boolean
  error?: string
  summary: {
    files: number
    measuredFiles: number
    skippedFiles: number
    staticDiagnostics: number
    groundTruthDiagnostics: number
    truePositives: number
    falsePositives: number
    falseNegatives: number
    falsePositiveRate: number
    severityMismatches: number
  } | null
  byCode: CodeResult[]
  topFalsePositiveCodes: { code: string; count: number }[]
  topFalsePositiveFiles: { path: string; lines: number }[]
  files: FileResult[]
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { versions: [], outDir: samplesDir, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (!next) throw new Error(`${arg} için bir değer gerekli.`)
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version') options.versions.push(value())
    else if (arg.startsWith('--version=')) options.versions.push(arg.slice('--version='.length))
    else if (arg === '--out-dir') options.outDir = resolve(value())
    else if (arg.startsWith('--out-dir=')) options.outDir = resolve(arg.slice('--out-dir='.length))
    else throw new Error(`Bilinmeyen seçenek: ${arg}`)
  }
  return options
}

function printHelp(): void {
  process.stdout.write(
    [
      'Kullanım: npx tsx packages/corpus/tools/measure.ts [seçenekler]',
      '',
      '  --version <sürüm>   Ölçülecek Skript sürümü (birden çok kez verilebilir).',
      '                      Verilmezse samples/ground-truth/ altındaki tüm sürümler ölçülür.',
      '  --out-dir <klasör>  Raporların yazılacağı klasör. Varsayılan: samples/',
      '  --help              Bu yardımı göster.',
      ''
    ].join('\n')
  )
}

function codeOf(diagnostic: LspDiagnostic): string {
  const code = diagnostic.code
  if (typeof code === 'string') return code
  if (typeof code === 'number') return String(code)
  if (code && typeof code === 'object' && code.value !== undefined) return String(code.value)
  return '(kod yok)'
}

function severityOf(diagnostic: LspDiagnostic): 'error' | 'warning' | null {
  if (diagnostic.severity === 2) return 'warning'
  // vscode-languageserver: 1 = Error. Eksikse hata kabul etmek yerine yalnızca hata sayılanları al.
  if (diagnostic.severity === 1) return 'error'
  return null
}

async function discoverVersions(): Promise<string[]> {
  const names = await readdir(groundTruthDir).catch(() => [] as string[])
  return names
    .map((name) => /^(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

async function createService(version: string): Promise<LanguageService> {
  const moduleName = '@skript-ide/language-server'
  let module: LanguageServerModule
  try {
    module = (await import(moduleName)) as LanguageServerModule
  } catch (error) {
    throw new Error(
      `@skript-ide/language-server yüklenemedi (paket henüz hazır olmayabilir): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const Service = module.SkriptLanguageService
  if (typeof Service !== 'function') {
    throw new Error('@skript-ide/language-server SkriptLanguageService export etmiyor.')
  }
  return new Service({ loadDatabase: readSyntaxDatabase, skriptVersion: version })
}

function compareFile(file: GroundTruthFile, staticDiagnostics: StaticDiagnostic[]): FileResult {
  const groundTruthLines = new Set(file.diagnostics.map((diagnostic) => diagnostic.line))
  const staticLines = new Set(staticDiagnostics.map((diagnostic) => diagnostic.line))

  let severityMismatches = 0
  for (const diagnostic of staticDiagnostics) {
    if (!groundTruthLines.has(diagnostic.line)) continue
    const serverDiagnostics = file.diagnostics.filter((candidate) => candidate.line === diagnostic.line)
    if (!serverDiagnostics.some((candidate) => candidate.severity === diagnostic.severity)) severityMismatches++
  }

  // TP/FP satır bazlıdır: aynı satırdaki birden çok statik diagnostic tek satır sayılır.
  const truePositiveLines = [...staticLines].filter((line) => groundTruthLines.has(line))
  const falsePositiveLines = [...staticLines].filter((line) => !groundTruthLines.has(line)).sort((a, b) => a - b)
  const falseNegativeLines = [...groundTruthLines].filter((line) => !staticLines.has(line)).sort((a, b) => a - b)

  return {
    path: file.path,
    staticDiagnostics,
    groundTruthDiagnostics: file.diagnostics,
    truePositives: truePositiveLines.length,
    falsePositives: falsePositiveLines.length,
    falseNegatives: falseNegativeLines.length,
    severityMismatches,
    falsePositiveLines,
    falseNegativeLines
  }
}

async function measureVersion(version: string): Promise<MeasureReport> {
  const groundTruthPath = join(groundTruthDir, `${version}.json`)
  const groundTruth = JSON.parse(await readFile(groundTruthPath, 'utf8')) as GroundTruthReport

  let service: LanguageService
  try {
    service = await createService(version)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      skriptVersion: version,
      languageServerAvailable: false,
      error: message,
      summary: null,
      byCode: [],
      topFalsePositiveCodes: [],
      topFalsePositiveFiles: [],
      files: []
    }
  }

  const files: FileResult[] = []
  for (const file of groundTruth.files) {
    const absolutePath = join(samplesDir, file.path)
    const uri = pathToFileURL(absolutePath).href
    let staticDiagnostics: StaticDiagnostic[] = []
    let error: string | undefined
    try {
      const text = await readFile(absolutePath, 'utf8')
      service.openDocument(uri, text, 1)
      const diagnostics = await service.getDiagnostics(uri)
      staticDiagnostics = diagnostics
        .map((diagnostic) => {
          const severity = severityOf(diagnostic)
          if (!severity) return null
          return {
            line: diagnostic.range.start.line + 1,
            severity,
            code: codeOf(diagnostic),
            message: diagnostic.message
          } satisfies StaticDiagnostic
        })
        .filter((diagnostic): diagnostic is StaticDiagnostic => diagnostic !== null)
    } catch (diagnosticError) {
      error = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
    } finally {
      service.closeDocument(uri)
    }
    files.push({ ...compareFile(file, staticDiagnostics), ...(error ? { error } : {}) })
  }

  const measured = files.filter((file) => !file.error)
  const staticDiagnostics = measured.reduce((total, file) => total + file.staticDiagnostics.length, 0)
  const groundTruthDiagnostics = measured.reduce((total, file) => total + file.groundTruthDiagnostics.length, 0)
  const truePositives = measured.reduce((total, file) => total + file.truePositives, 0)
  const falsePositives = measured.reduce((total, file) => total + file.falsePositives, 0)
  const falseNegatives = measured.reduce((total, file) => total + file.falseNegatives, 0)
  const severityMismatches = measured.reduce((total, file) => total + file.severityMismatches, 0)

  const byCodeMap = new Map<string, CodeResult>()
  const seenCodeLines = new Set<string>()
  for (const file of measured) {
    for (const diagnostic of file.staticDiagnostics) {
      const key = `${diagnostic.code}|${file.path}|${diagnostic.line}`
      if (seenCodeLines.has(key)) continue
      seenCodeLines.add(key)
      let entry = byCodeMap.get(diagnostic.code)
      if (!entry) {
        entry = { code: diagnostic.code, truePositives: 0, falsePositives: 0 }
        byCodeMap.set(diagnostic.code, entry)
      }
      if (file.groundTruthDiagnostics.some((candidate) => candidate.line === diagnostic.line)) entry.truePositives++
      else entry.falsePositives++
    }
  }
  const byCode = [...byCodeMap.values()].sort(
    (a, b) => b.falsePositives + b.truePositives - (a.falsePositives + a.truePositives) || a.code.localeCompare(b.code)
  )
  const topFalsePositiveCodes = byCode
    .filter((entry) => entry.falsePositives > 0)
    .sort((a, b) => b.falsePositives - a.falsePositives || a.code.localeCompare(b.code))
    .slice(0, 10)
    .map((entry) => ({ code: entry.code, count: entry.falsePositives }))
  const topFalsePositiveFiles = files
    .filter((file) => file.falsePositiveLines.length > 0)
    .sort((a, b) => b.falsePositiveLines.length - a.falsePositiveLines.length || a.path.localeCompare(b.path))
    .slice(0, 10)
    .map((file) => ({ path: file.path, lines: file.falsePositiveLines.length }))

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skriptVersion: version,
    languageServerAvailable: true,
    summary: {
      files: files.length,
      measuredFiles: measured.length,
      skippedFiles: files.length - measured.length,
      staticDiagnostics,
      groundTruthDiagnostics,
      truePositives,
      falsePositives,
      falseNegatives,
      falsePositiveRate: truePositives + falsePositives === 0 ? 0 : falsePositives / (truePositives + falsePositives),
      severityMismatches
    },
    byCode,
    topFalsePositiveCodes,
    topFalsePositiveFiles,
    files
  }
}

function printSummary(report: MeasureReport): void {
  process.stdout.write(`\n=== Skript ${report.skriptVersion} ===\n`)
  if (!report.languageServerAvailable) {
    process.stdout.write(`Language server kullanılamadı: ${report.error ?? 'bilinmeyen hata'}\n`)
    return
  }
  const summary = report.summary!
  process.stdout.write(
    `Dosya: ${summary.files} (ölçülen ${summary.measuredFiles}, atlanan ${summary.skippedFiles})\n` +
      `Statik diagnostic: ${summary.staticDiagnostics}; sunucu diagnostic: ${summary.groundTruthDiagnostics}\n` +
      `Satır bazlı — gerçek pozitif: ${summary.truePositives}; yanlış pozitif: ${summary.falsePositives}; yanlış negatif: ${summary.falseNegatives}\n` +
      `Yanlış pozitif oranı: %${(summary.falsePositiveRate * 100).toFixed(2)}\n` +
      `Önem derecesi uyuşmazlığı: ${summary.severityMismatches}\n`
  )
  if (report.topFalsePositiveFiles.length > 0) {
    process.stdout.write('En çok yanlış pozitif üreten dosyalar:\n')
    for (const entry of report.topFalsePositiveFiles) {
      process.stdout.write(`  ${entry.path}: ${entry.lines} satır\n`)
    }
  }
  if (report.topFalsePositiveCodes.length === 0) {
    process.stdout.write('Yanlış pozitif kod yok.\n')
    return
  }
  process.stdout.write('En sık yanlış pozitif kodları (diagnostic sayısı):\n')
  for (const entry of report.topFalsePositiveCodes) {
    process.stdout.write(`  ${entry.code}: ${entry.count}\n`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const versions = options.versions.length > 0 ? options.versions : await discoverVersions()
  if (versions.length === 0) throw new Error('samples/ground-truth/ altında ölçülecek sürüm yok.')

  await mkdir(options.outDir, { recursive: true })
  let unavailable = 0
  for (const version of versions) {
    const report = await measureVersion(version)
    const output = join(options.outDir, `report-${version}.json`)
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
    printSummary(report)
    process.stdout.write(`Rapor: ${output}\n`)
    if (!report.languageServerAvailable) unavailable++
  }
  if (unavailable === versions.length) process.exitCode = 2
}

main().catch((error: unknown) => {
  process.stderr.write(`Hata: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
