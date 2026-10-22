/**
 * Corpus dosyalarını gerçek Paper + Skript sunucusunda `sk reload` ile yükler ve
 * Skript'in bildirdiği hata/uyarıları `samples/ground-truth/<sürüm>.json` dosyasına yazar.
 *
 * Kullanım:
 *   npx tsx packages/corpus/tools/ground-truth.ts
 *   npx tsx packages/corpus/tools/ground-truth.ts --version 2.17.1 --version 2.12.2
 *   npx tsx packages/corpus/tools/ground-truth.ts --version 2.17.1 --filter nerd-bear --verbose
 *
 * Sunucu kökü varsayılan olarak işletim sisteminin geçici klasöründedir; uygulamanın
 * userData klasörüne yazılmaz. EULA onayı yalnızca bu geçici kök klasörde oluşturulur.
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SKRIPT_VERSION,
  SKRIPT_RUNTIMES,
  SkriptServer,
  ensurePaperJar,
  findJava,
  runtimeVersionsFor,
  stripAnsi,
  type SkriptDiagnostic
} from '@skript-ide/runtime-validator'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const samplesDir = resolve(toolsDir, '..', 'samples')
const groundTruthDir = join(samplesDir, 'ground-truth')

const DEFAULT_ROOT = join(tmpdir(), 'skript-corpus-server')
const DISABLE_TIMEOUT_MS = 10_000

interface CliOptions {
  versions: string[]
  rootDir: string
  javaPath?: string
  filter?: string
  verbose: boolean
  help: boolean
}

interface CorpusEntry {
  path: string
  source: string
  sourcePath: string
  commit: string
  license: string
  kind: 'vanilla' | 'addons'
  addons: string[]
  bytes: number
  lines: number
  sha256: string
}

interface SourcesFile {
  files: CorpusEntry[]
}

interface ReportDiagnostic {
  /** 1 tabanlı satır. */
  line: number
  severity: 'error' | 'warning'
  message: string
  code?: string
}

interface GroundTruthFile {
  path: string
  stagedName: string
  lines: number
  ok: boolean
  durationMs: number
  diagnostics: ReportDiagnostic[]
  /** Doğrulama sırasında oluşan beklenmeyen hata (sunucu zaman aşımı vb.). */
  error?: string
}

interface GroundTruthReport {
  schemaVersion: 1
  generatedAt: string
  skriptVersion: string
  runtime: {
    minecraft: string
    paperBuild: number
    javaMajor: number
    javaPath: string
    javaVersion: string
  }
  methodology: {
    loading: string
    isolation: string
    serverRoot: string
    eula: string
    diagnostics: string
  }
  totals: {
    files: number
    cleanFiles: number
    filesWithErrors: number
    failedFiles: number
    errors: number
    warnings: number
  }
  files: GroundTruthFile[]
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    versions: [DEFAULT_SKRIPT_VERSION],
    rootDir: DEFAULT_ROOT,
    verbose: false,
    help: false
  }
  let versionsProvided = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (!next) throw new Error(`${arg} için bir değer gerekli.`)
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--verbose' || arg === '-v') options.verbose = true
    else if (arg === '--version') {
      if (!versionsProvided) {
        options.versions = []
        versionsProvided = true
      }
      options.versions.push(value())
    } else if (arg.startsWith('--version=')) {
      if (!versionsProvided) {
        options.versions = []
        versionsProvided = true
      }
      options.versions.push(arg.slice('--version='.length))
    } else if (arg.startsWith('--root=')) options.rootDir = resolve(arg.slice('--root='.length))
    else if (arg === '--root') options.rootDir = resolve(value())
    else if (arg.startsWith('--java=')) options.javaPath = arg.slice('--java='.length)
    else if (arg === '--java') options.javaPath = value()
    else if (arg.startsWith('--filter=')) options.filter = arg.slice('--filter='.length)
    else if (arg === '--filter') options.filter = value()
    else throw new Error(`Bilinmeyen seçenek: ${arg}`)
  }

  return options
}

function printHelp(): void {
  const versions = SKRIPT_RUNTIMES.map((profile) => profile.skript).join(', ')
  process.stdout.write(
    [
      'Kullanım: npx tsx packages/corpus/tools/ground-truth.ts [seçenekler]',
      '',
      '  --version <sürüm>   Skript sürümü (birden çok kez verilebilir). Varsayılan: ' + DEFAULT_SKRIPT_VERSION,
      '                      Desteklenenler: ' + versions,
      '  --root <klasör>     Sunucu/önbellek kökü. Varsayılan: ' + DEFAULT_ROOT,
      '  --java <java.exe>   Sunucu için Java yolu (verilmezse runtime-validator arar).',
      '  --filter <metin>    Yalnızca yolu bu metni içeren dosyaları doğrula.',
      '  --verbose           Sunucu durum değişikliklerini de yazdır.',
      '  --help              Bu yardımı göster.',
      '',
      'Yalnızca samples/vanilla/ altındaki dosyalar yüklenir; addon dosyaları gerçek',
      'sunucuda addon jar\'ları olmadan anlamlı sonuç vermeyeceği için atlanır.',
      ''
    ].join('\n')
  )
}

async function loadCorpus(): Promise<CorpusEntry[]> {
  const text = await readFile(join(samplesDir, 'SOURCES.json'), 'utf8')
  const sources = JSON.parse(text) as SourcesFile
  if (!Array.isArray(sources.files)) throw new Error('samples/SOURCES.json içinde files dizisi yok.')
  return sources.files.filter((file) => file.kind === 'vanilla')
}

/**
 * Uygulamanın daha önce indirdiği Paper/Skript jar'larını geçici sunucu önbelleğine kopyalar.
 * Böylece aynı jar'lar yeniden indirilmez; 2.12.2 gibi önbellekte olmayan sürümler indirilir.
 */
async function seedCache(rootDir: string): Promise<number> {
  const cacheDir = join(rootDir, 'cache')
  await mkdir(cacheDir, { recursive: true })
  const appData = process.env['APPDATA']
  const candidates = [
    appData && join(appData, '@skript-ide', 'desktop', 'runtime', 'cache'),
    appData && join(appData, 'Skript IDE', 'runtime', 'cache'),
    appData && join(appData, 'Electron', 'runtime', 'cache')
  ].filter((dir): dir is string => Boolean(dir))

  let copied = 0
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    for (const name of await readdir(dir)) {
      if (!/^(paper-|Skript-).+\.(jar|json)$/i.test(name)) continue
      const destination = join(cacheDir, name)
      if (existsSync(destination)) continue
      await copyFile(join(dir, name), destination)
      copied++
    }
  }
  return copied
}

interface LogWaiter {
  start: number
  pattern: RegExp
  resolve: () => void
  timer: NodeJS.Timeout
}

/**
 * Sunucu çıktısını biriktirir ve belirli bir satırı bekler. Bekleme başladıktan sonraki
 * çıktı taranır; böylece önceki dosyanın "Successfully disabled" satırı yanlış eşleşmez.
 */
class LogWatcher {
  private text = ''
  private readonly waiters: LogWaiter[] = []

  append(chunk: string): void {
    this.text = (this.text + chunk).slice(-2_000_000)
    this.check()
  }

  get content(): string {
    return this.text
  }

  waitFor(pattern: RegExp, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = this.text.length
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`Sunucu çıktısında ${pattern} ${timeoutMs} ms içinde görülmedi.`))
      }, timeoutMs)
      this.waiters.push({ start, pattern, resolve, timer })
      this.check()
    })
  }

  private check(): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.pattern.test(stripAnsi(this.text.slice(waiter.start)))) continue
      clearTimeout(waiter.timer)
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
}

async function unloadStagedScript(
  server: SkriptServer,
  stagedName: string,
  waitFor: (pattern: RegExp, timeoutMs: number) => Promise<void>
): Promise<void> {
  const scriptsDir = join(server.directory, 'plugins', 'Skript', 'scripts', 'ide')
  try {
    server.sendCommand(`sk disable ide/${stagedName}`)
    await waitFor(/Successfully disabled/i, DISABLE_TIMEOUT_MS)
  } catch {
    // Betik zaten kaldırılmış ya da disable çıktısı tanınmamış olabilir; dosyaları yine de temizle.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  await rm(join(scriptsDir, stagedName), { force: true })
  await rm(join(scriptsDir, `-${stagedName}`), { force: true })
}

function uniqueStagedName(index: number, samplePath: string): string {
  const base = basename(samplePath).replace(/\.sk$/i, '')
  const safe = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 48)
  return `gt_${String(index + 1).padStart(3, '0')}_${safe || 'betik'}.sk`
}

function normalizeDiagnostic(diagnostic: SkriptDiagnostic): ReportDiagnostic {
  return {
    line: diagnostic.line,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.code ? { code: diagnostic.code } : {})
  }
}

async function runVersion(options: CliOptions, version: string, corpus: CorpusEntry[]): Promise<void> {
  const profile = SKRIPT_RUNTIMES.find((candidate) => candidate.skript === version)
  if (!profile) {
    throw new Error(`Skript ${version} desteklenmiyor. Desteklenenler: ${SKRIPT_RUNTIMES.map((p) => p.skript).join(', ')}.`)
  }

  await mkdir(options.rootDir, { recursive: true })
  const seeded = await seedCache(options.rootDir)
  if (seeded > 0) process.stdout.write(`[${version}] Önbelleğe ${seeded} dosya kopyalandı.\n`)

  const versions = runtimeVersionsFor(version)
  const cacheDir = join(options.rootDir, 'cache')
  process.stdout.write(`[${version}] Paper ${versions.minecraft} hazırlanıyor…\n`)
  const paper = await ensurePaperJar(cacheDir, versions.minecraft, versions.paperBuild)
  const java = await findJava(paper.javaMinimum, options.javaPath)
  process.stdout.write(`[${version}] Java ${java.major}: ${java.versionText}\n`)

  const watcher = new LogWatcher()
  const server = new SkriptServer({
    rootDir: options.rootDir,
    versions,
    javaPath: java.path,
    memoryMb: 1536,
    onLog: (text) => {
      watcher.append(text)
    },
    onStatus: (status) => {
      if (options.verbose || status.state === 'error' || status.state === 'eula-required') {
        process.stdout.write(`[${version}] ${status.state}: ${status.message}\n`)
      }
    }
  })

  // Kullanıcı test sunucuları için EULA'yı önceden kabul etti; onay yalnızca geçici kök klasörde tutulur.
  await server.acceptEula()

  const waitFor = (pattern: RegExp, timeoutMs: number): Promise<void> => watcher.waitFor(pattern, timeoutMs)

  const results: GroundTruthFile[] = []
  try {
    process.stdout.write(`[${version}] Sunucu başlatılıyor…\n`)
    await server.start()
    process.stdout.write(`[${version}] Sunucu hazır.\n`)

    for (let index = 0; index < corpus.length; index++) {
      const entry = corpus[index]!
      const stagedName = uniqueStagedName(index, entry.path)
      const startedAt = Date.now()
      let fileResult: GroundTruthFile
      try {
        const content = await readFile(join(samplesDir, entry.path), 'utf8')
        const result = await server.validate(entry.path, stagedName, content)
        fileResult = {
          path: entry.path,
          stagedName: result.stagedName,
          lines: entry.lines,
          ok: result.ok,
          durationMs: result.durationMs,
          diagnostics: result.diagnostics
            .map(normalizeDiagnostic)
            .sort((a, b) => a.line - b.line || a.message.localeCompare(b.message))
        }
      } catch (error) {
        fileResult = {
          path: entry.path,
          stagedName,
          lines: entry.lines,
          ok: false,
          durationMs: Date.now() - startedAt,
          diagnostics: [],
          error: error instanceof Error ? error.message : String(error)
        }
      }
      results.push(fileResult)
      const errors = fileResult.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
      const warnings = fileResult.diagnostics.length - errors
      const marker = fileResult.error ? 'HATA' : errors > 0 ? `${errors} hata` : warnings > 0 ? `${warnings} uyarı` : 'temiz'
      process.stdout.write(
        `[${version}] ${String(index + 1).padStart(2, '0')}/${corpus.length} ${entry.path} — ${marker} (${fileResult.durationMs} ms)\n`
      )
      await unloadStagedScript(server, fileResult.stagedName, waitFor)
    }
  } finally {
    await server.stop()
    // Sunucu çıktısını hata ayıklama için geçici klasöre yaz (samples/ altına değil).
    await writeFile(join(options.rootDir, `ground-truth-${version}.log`), watcher.content, 'utf8').catch(() => {})
  }

  const errors = results.reduce(
    (total, file) => total + file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    0
  )
  const warnings = results.reduce(
    (total, file) => total + file.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    0
  )
  const failedFiles = results.filter((file) => file.error).length
  const filesWithErrors = results.filter(
    (file) => !file.error && file.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  ).length

  const report: GroundTruthReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skriptVersion: version,
    runtime: {
      minecraft: versions.minecraft,
      paperBuild: paper.build,
      javaMajor: java.major,
      javaPath: java.path,
      javaVersion: java.versionText
    },
    methodology: {
      loading: 'Her dosya ayrı ayrı `sk reload ide/<dosya>` ile yüklenir.',
      isolation: 'Bir sonraki dosyaya geçmeden önce `sk disable` ile betik kaldırılır; böylece fonksiyon/komut çakışması olmaz.',
      serverRoot: options.rootDir,
      eula: 'EULA onayı yalnızca geçici test kök klasöründe programatik olarak verilir.',
      diagnostics: 'Skript konsolundaki Line N: (dosya) blokları; hata/uyarı ayrımı başlık renginden.'
    },
    totals: {
      files: results.length,
      cleanFiles: results.filter((file) => !file.error && file.diagnostics.length === 0).length,
      filesWithErrors,
      failedFiles,
      errors,
      warnings
    },
    files: results
  }

  await mkdir(groundTruthDir, { recursive: true })
  const output = join(groundTruthDir, `${version}.json`)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.stdout.write(
    `[${version}] Bitti: ${results.length} dosya, ${errors} hata, ${warnings} uyarı, ${failedFiles} başarısız. → ${output}\n`
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const corpus = (await loadCorpus()).filter((entry) => !options.filter || entry.path.includes(options.filter))
  if (corpus.length === 0) throw new Error('Seçilen filtrelere uyan vanilla corpus dosyası yok.')

  process.stdout.write(`Corpus: ${corpus.length} vanilla dosya. Sürümler: ${options.versions.join(', ')}\n`)
  for (const version of options.versions) {
    await runVersion(options, version, corpus)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Hata: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
