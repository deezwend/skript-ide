import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { SkriptLogParser, stripAnsi, type SkriptDiagnostic } from './diagnostics'
import { findAddonVersion, type AddonSelection } from './addons'
import { ensureAddonJar, ensurePaperJar, ensureSkriptJar, type DownloadProgress } from './download'
import { EULA_URL, isEulaAccepted, writeEulaAcceptance } from './eula'
import { findJava, JavaNotFoundError } from './java'
import { DEFAULT_VERSIONS, type RuntimeVersions } from './versions'

import { l } from '@skript-ide/i18n'
export type ServerState =
  | 'stopped'
  | 'eula-required'
  | 'preparing'
  | 'starting'
  | 'ready'
  | 'validating'
  | 'stopping'
  | 'error'

export interface AddonLoadStatus {
  name: string
  version: string
  /** `enabled`: eklenti açıldı; `failed`: yüklenemedi/kendini kapattı; `skipped`: indirme bilgisi yok, kurulmadı. */
  state: 'pending' | 'enabled' | 'failed' | 'skipped'
  /** Hata ya da atlanma nedeni (sunucu çıktısından ilk satırlar). */
  message?: string
  /**
   * Eklenti açıldığı halde yüklenirken bildirdiği sorunlar: devre dışı kalan öğe grupları
   * (`NBT Elements DISABLED!`, `… failed to load`) ya da Skript'in bu addon'la ilişkilendirdiği Severe Error.
   */
  problems?: string[]
}

export interface ServerStatus {
  state: ServerState
  /** Kullanıcıya gösterilecek kısa açıklama. */
  message: string
  versions: RuntimeVersions
  eulaUrl: string
  /** Seçili addon'ların bu sunucudaki durumu (addon yoksa boş). */
  addons?: AddonLoadStatus[]
}

export interface ValidationResult {
  /** Çağıranın verdiği kimlik (ör. dosya yolu); sonuçlar buna göre eşlenir. */
  source: string
  /** Sunucuya kopyalanan dosya adı. */
  stagedName: string
  diagnostics: SkriptDiagnostic[]
  /** Skript betiği hatasız yükledi mi (uyarılar sayılmaz). */
  ok: boolean
  durationMs: number
}

export interface SkriptServerOptions {
  /** Önbellek ve sunucu klasörlerinin kökü, ör. Electron `userData/runtime`. */
  rootDir: string
  versions?: RuntimeVersions
  javaPath?: string
  memoryMb?: number
  /** Java sürecine eklenecek ortam değişkenleri. */
  env?: Record<string, string>
  /** `-jar`'dan önce eklenecek JVM argümanları (ör. `-Dskript.forceregisterhooks=true`). */
  jvmArgs?: string[]
  onLog?: (text: string) => void
  onStatus?: (status: ServerStatus) => void
}

export class EulaRequiredError extends Error {
  constructor() {
    super(l(`Sunucuyu başlatmadan önce Minecraft EULA'sını kabul etmen gerekiyor: ${EULA_URL}`, `You need to accept the Minecraft EULA before starting the server: ${EULA_URL}`))
    this.name = 'EulaRequiredError'
  }
}

/** Açılış sürerken sürüm değiştirildi ya da sunucu durduruldu; bu açılış artık geçersiz. */
class LaunchCancelledError extends Error {
  constructor() {
    super(l('Sunucu açılışı iptal edildi.', 'Server startup was cancelled.'))
    this.name = 'LaunchCancelledError'
  }
}

/** Doğrulanan betikler, sunucunun kendi betiklerinden ayrı bu alt klasöre konur. */
const STAGING_FOLDER = 'ide'
const READY_TIMEOUT_MS = 5 * 60_000
const VALIDATE_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 20_000
const LOG_BUFFER_CHARS = 256 * 1024

interface ActiveValidation {
  stagedName: string
  diagnostics: SkriptDiagnostic[]
  finish: (ok: boolean) => void
}

/**
 * Arka planda Skript yüklü headless bir Paper sunucusunu yönetir.
 * Sunucu bir kez başlatılır ve sıcak tutulur; her doğrulama yalnızca `sk reload` gönderir.
 */
export class SkriptServer {
  private _versions: RuntimeVersions
  private readonly cacheDir: string
  private serverDir: string
  /** Her durdurma / sürüm değişikliğinde artar; eski açılışlar bunu görüp vazgeçer. */
  private generation = 0
  private process: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private active: ActiveValidation | null = null
  private readonly parser = new SkriptLogParser((diagnostic) => this.onDiagnostic(diagnostic))
  private lineBuffer = ''
  private log = ''
  private status: ServerStatus

  constructor(private readonly options: SkriptServerOptions) {
    this._versions = options.versions ?? DEFAULT_VERSIONS
    this.cacheDir = join(options.rootDir, 'cache')
    this.serverDir = serverDirFor(options.rootDir, this._versions)
    this.status = { state: 'stopped', message: l('Sunucu kapalı', 'Server stopped'), versions: this._versions, eulaUrl: EULA_URL }
  }

  get versions(): RuntimeVersions {
    return this._versions
  }

  /** Sunucunun klasörü (`servers/paper-<mc>`). */
  get directory(): string {
    return this.serverDir
  }

  get currentStatus(): ServerStatus {
    return this.status
  }

  /** Arayüz sonradan açılırsa konsolu doldurmak için son çıktı. */
  get recentLog(): string {
    return this.log
  }

  get isRunning(): boolean {
    return this.process !== null
  }

  /**
   * Onay kök klasördeki `eula.txt` dosyasında bir kez tutulur ve her sürümün sunucu klasörüne kopyalanır;
   * böylece sürüm değiştirince tekrar sorulmaz. Faz 2'den kalan, yalnızca sunucu klasöründeki onay da geçerlidir.
   */
  async isEulaAccepted(): Promise<boolean> {
    return (await this.findEulaAcceptance()) !== null
  }

  /** Onay içeren bir `eula.txt` klasörü: önce kök, sonra bu sürümün, sonra diğer sürümlerin klasörleri. */
  private async findEulaAcceptance(): Promise<string | null> {
    const serversDir = join(this.options.rootDir, 'servers')
    const others = (await readdir(serversDir).catch(() => [] as string[])).map((name) => join(serversDir, name))
    for (const dir of new Set([this.options.rootDir, this.serverDir, ...others])) {
      if (await isEulaAccepted(dir)) return dir
    }
    return null
  }

  /** Kullanıcı EULA'yı arayüzde açıkça kabul ettiğinde çağrılır. */
  async acceptEula(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true })
    await writeEulaAcceptance(this.options.rootDir)
    if (this.status.state === 'eula-required') this.setStatus('stopped', l('Sunucu kapalı', 'Server stopped'))
  }

  /**
   * Başka bir Paper + Skript çiftine geçer: çalışan sunucuyu durdurur, yarım kalan açılışı iptal eder.
   * Yeni sunucu bir sonraki `start()` / `validate()` çağrısında (gerekirse jar'lar indirilerek) açılır.
   */
  async switchVersions(versions: RuntimeVersions): Promise<void> {
    const same =
      versions.minecraft === this._versions.minecraft &&
      versions.skript === this._versions.skript &&
      versions.paperBuild === this._versions.paperBuild &&
      addonKey(versions.addons) === addonKey(this._versions.addons)
    if (same) return
    await this.stop()
    this.generation++
    this.startPromise = null
    this._versions = versions
    this.serverDir = serverDirFor(this.options.rootDir, versions)
    this.status = { ...this.status, versions }
    this.setStatus('stopped', l('Sunucu kapalı', 'Server stopped'))
  }

  /** Sunucuyu hazırlar ve başlatır. Zaten çalışıyorsa hazır olmasını bekler. */
  start(): Promise<void> {
    if (!this.startPromise) {
      const generation = this.generation
      const pending: Promise<void> = this.launch(generation).catch((error: Error) => {
        if (this.startPromise === pending) this.startPromise = null
        // Açılış sırasında bilerek durdurulduysa / sürüm değiştiyse bu bir hata değil
        const cancelled = error instanceof LaunchCancelledError || generation !== this.generation
        if (!cancelled && !(error instanceof EulaRequiredError) && this.status.state !== 'stopped') {
          this.setStatus('error', error.message)
        }
        throw error
      })
      this.startPromise = pending
    }
    return this.startPromise
  }

  /** Betiği sunucuya kopyalar, `sk reload` ile yükletir ve Skript'in bildirdiği sorunları döndürür. */
  validate(source: string, fileName: string, content: string): Promise<ValidationResult> {
    const run = this.queue.then(() => this.runValidation(source, fileName, content))
    this.queue = run.catch(() => {})
    return run
  }

  sendCommand(command: string): void {
    if (!this.process) throw new Error(l('Sunucu çalışmıyor.', 'The server is not running.'))
    const line = command.replace(/[\r\n]+/g, ' ').trim()
    if (!line) return
    this.emitLog(`> ${line}\n`)
    this.process.stdin.write(`${line}\n`)
  }

  /** Önce `stop` komutuyla düzgünce kapatmayı dener, olmazsa süreci öldürür. */
  async stop(): Promise<void> {
    const proc = this.process
    if (!proc) {
      // İndirme / hazırlık aşamasındaysa açılışı iptal et
      if (this.startPromise) {
        this.generation++
        this.startPromise = null
        this.setStatus('stopped', l('Sunucu kapalı', 'Server stopped'))
      }
      return
    }
    // Paper açılış bitmeden stdin'deki komutları işlemiyor; yarım kalan test dünyasını korumaya gerek yok
    const booting = this.status.state === 'starting'
    this.setStatus('stopping', l('Sunucu durduruluyor…', 'Stopping server…'))
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    if (booting) {
      proc.kill()
      return exited
    }
    try {
      proc.stdin.write('stop\n')
    } catch {
      // stdin kapanmış olabilir; aşağıdaki zaman aşımı süreci öldürür
    }
    const timer = setTimeout(() => proc.kill(), STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }

  // --- Başlatma ---

  private async launch(generation: number): Promise<void> {
    const versions = this._versions
    const serverDir = this.serverDir
    /** Her beklemeden sonra çağrılır: bu arada sürüm değiştiyse ya da durdurulduysa devam etme. */
    const checkpoint = () => {
      if (generation !== this.generation) throw new LaunchCancelledError()
    }
    const progress = (label: string) => (p: DownloadProgress) => {
      if (generation === this.generation) this.reportProgress(label, p)
    }

    const acceptedIn = await this.findEulaAcceptance()
    checkpoint()
    if (!acceptedIn) {
      this.setStatus('eula-required', l("Minecraft EULA'sının kabul edilmesi gerekiyor", "The Minecraft EULA must be accepted"))
      throw new EulaRequiredError()
    }

    this.setStatus('preparing', l(`Paper ${versions.minecraft} indiriliyor…`, `Downloading Paper ${versions.minecraft}…`))
    const paper = await ensurePaperJar(this.cacheDir, versions.minecraft, versions.paperBuild, progress('Paper'))
    checkpoint()
    this.setStatus('preparing', l(`Skript ${versions.skript} indiriliyor…`, `Downloading Skript ${versions.skript}…`))
    const skript = await ensureSkriptJar(this.cacheDir, versions.skript, progress('Skript'))
    checkpoint()

    // İndirme bilgisi olmayan (tabloda bulunmayan) addon'lar kurulmaz; durumda "skipped" görünür
    const addonJars: string[] = []
    this.addonStatus = (versions.addons ?? []).map((addon) => ({ name: addon.name, version: addon.version, state: 'pending' as const }))
    for (const status of this.addonStatus) {
      if (!findAddonVersion(status.name, status.version)) {
        status.state = 'skipped'
        status.message = l(`${status.name} ${status.version} için indirme bilgisi yok; sunucuya kurulmadı.`, `No download info for ${status.name} ${status.version}; it was not installed on the server.`)
        continue
      }
      this.setStatus('preparing', l(`${status.name} ${status.version} indiriliyor…`, `Downloading ${status.name} ${status.version}…`))
      const jar = await ensureAddonJar(this.cacheDir, status.name, status.version, progress(status.name))
      addonJars.push(jar.path)
      checkpoint()
    }

    this.setStatus('preparing', l('Java aranıyor…', 'Looking for Java…'))
    let java
    try {
      java = await findJava(paper.javaMinimum, this.options.javaPath)
    } catch (error) {
      if (error instanceof JavaNotFoundError) {
        throw new Error(l(`Skript ${versions.skript} (Paper ${versions.minecraft}) için: ${error.message}`, `For Skript ${versions.skript} (Paper ${versions.minecraft}): ${error.message}`))
      }
      throw error
    }
    checkpoint()

    // Kullanıcının verdiği onayı bu sürümün sunucu klasörüne kopyala
    await mkdir(serverDir, { recursive: true })
    if (acceptedIn !== serverDir) await copyFile(join(acceptedIn, 'eula.txt'), join(serverDir, 'eula.txt'))
    await this.prepareServerDir(skript.path, skript.fileName, addonJars)
    const port = await findFreePort()
    await this.writeServerProperties(port)
    checkpoint()

    this.setStatus('starting', l(`Paper ${paper.minecraft} #${paper.build} başlatılıyor…`, `Starting Paper ${paper.minecraft} #${paper.build}…`))
    this.emitLog(`[Skript IDE] ${java.versionText} (${java.path})\n`)
    const proc = spawn(
      java.path,
      [
        `-Xmx${this.options.memoryMb ?? 1024}M`,
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        // Etkileşimli terminal yok; komutlar düz stdin'den okunsun, renkler yine gelsin
        '-Dterminal.jline=false',
        '-Dterminal.ansi=true',
        ...(this.options.jvmArgs ?? []),
        '-jar',
        paper.path,
        'nogui'
      ],
      { cwd: serverDir, windowsHide: true, env: { ...process.env, ...this.options.env } }
    )
    this.process = proc
    this.lineBuffer = ''

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(l('Sunucu 5 dakika içinde açılamadı.', 'The server did not start within 5 minutes.'))), READY_TIMEOUT_MS)
      this.onReady = () => {
        clearTimeout(timer)
        resolve()
      }
      proc.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(l(`Sunucu açılırken kapandı (çıkış kodu ${code}). Ayrıntılar sunucu konsolunda.`, `The server shut down while starting (exit code ${code}). See the server console for details.`)))
      })
    })

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onOutput(chunk))
    proc.stderr.on('data', (chunk: string) => this.emitLog(chunk))
    proc.on('error', (error) => this.emitLog(`[Skript IDE] ${error.message}\n`))
    proc.on('exit', (code) => this.onExit(code))

    await ready
    // `Done` satırına kadar açılmayan addon yüklenememiş demektir (Paper eklentileri ondan önce açar)
    for (const status of this.addonStatus) {
      if (status.state === 'pending') {
        status.state = 'failed'
        status.message ??= l(`${status.name} sunucu açılırken etkinleşmedi. Ayrıntılar sunucu konsolunda.`, `${status.name} was not enabled while the server started. See the server console for details.`)
      }
    }
    const failed = this.addonStatus.filter((status) => status.state === 'failed')
    this.setStatus(
      'ready',
      failed.length
        ? l(
            `Sunucu hazır — yüklenemeyen addon: ${failed.map((s) => `${s.name} ${s.version}`).join(', ')}`,
            `Server ready — addons that failed to load: ${failed.map((s) => `${s.name} ${s.version}`).join(', ')}`
          )
        : l('Sunucu hazır', 'Server ready')
    )
  }

  /** Seçili addon'ların son açılıştaki durumu. */
  get addons(): readonly AddonLoadStatus[] {
    return this.addonStatus
  }

  private addonStatus: AddonLoadStatus[] = []

  /** Paper'ın eklenti yükleme satırlarından addon durumlarını çıkarır. */
  private trackAddonLine(line: string): void {
    // Skript'in "Severe Error" bloğunda ilgili addon'lar ayrı satırlarda `#!#! Ad vSürüm` olarak listelenir.
    if (/#!#! .*(likely related to this error|Full list of addons)/i.test(line)) {
      this.severeBlock = true
      return
    }
    if (this.severeBlock && !/#!#! \S/.test(line)) this.severeBlock = false
    for (const status of this.addonStatus) {
      if (status.state === 'skipped') continue
      const name = escapeRegExp(status.name)
      if (new RegExp(`\\[${name}\\] Enabling ${name}\\b`, 'i').test(line)) {
        if (status.state === 'pending') status.state = 'enabled'
      } else if (new RegExp(`\\[${name}\\] Disabling ${name}\\b`, 'i').test(line)) {
        // Açılır açılmaz kendini kapatan addon (ör. desteklenmeyen sunucu sürümü)
        status.state = 'failed'
        status.message ??= l(`${status.name} kendini devre dışı bıraktı. Ayrıntılar sunucu konsolunda.`, `${status.name} disabled itself. See the server console for details.`)
      } else if (new RegExp(`(could not load|error occurred while enabling|error loading plugin|failed to load).*${name}`, 'i').test(line)) {
        status.state = 'failed'
        status.message = cleanLogLine(line)
      } else if (this.severeBlock && new RegExp(`#!#! ${name} v`, 'i').test(line)) {
        addProblem(status, l('Skript yüklenirken bu addon\'la ilgili bir hata bildirdi (Severe Error).', 'Skript reported an error related to this addon while loading (Severe Error).'))
      } else if (
        new RegExp(`\\[${name}\\] .*(failed to load|\\bDISABLED\\b|not currently supported)`).test(line) &&
        !/\bdisabled\b/.test(line)
      ) {
        addProblem(status, cleanLogLine(line).replace(new RegExp(`^\\[${name}\\]\\s*`, 'i'), ''))
      }
    }
  }

  private severeBlock = false

  private onReady: (() => void) | null = null

  private async prepareServerDir(skriptJar: string, skriptFileName: string, addonJars: readonly string[]): Promise<void> {
    const plugins = join(this.serverDir, 'plugins')
    const staging = join(plugins, 'Skript', 'scripts', STAGING_FOLDER)
    // Her oturum temiz başlasın: önceki oturumda doğrulanan betikler yüklenmesin
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })

    // `plugins/` bu uygulamaya ait: istenen Skript ve addon jar'ları dışında kalan her jar (farklı sürüm,
    // kaldırılan addon) silinir. Addon'ların veri klasörlerine dokunulmaz.
    const wanted = new Map<string, string>([[skriptFileName, skriptJar]])
    for (const jar of addonJars) wanted.set(fileBaseName(jar), jar)
    for (const name of await readdir(plugins)) {
      if (/\.jar$/i.test(name) && !wanted.has(name)) await rm(join(plugins, name))
    }
    for (const [name, source] of wanted) {
      const target = join(plugins, name)
      const [from, existing] = await Promise.all([stat(source), stat(target).catch(() => null)])
      if (existing?.size !== from.size) await copyFile(source, target)
    }
  }

  private async writeServerProperties(port: number): Promise<void> {
    const path = join(this.serverDir, 'server.properties')
    const managed: Record<string, string> = {
      // Yalnızca bu makineden erişilebilir, oyuncu doğrulaması yapılmayan bir test sunucusu
      'server-ip': '127.0.0.1',
      'server-port': String(port),
      'online-mode': 'false',
      'enable-rcon': 'false',
      'enable-query': 'false',
      'max-players': '1',
      motd: l('Skript IDE doğrulama sunucusu', 'Skript IDE validation server'),
      // Dünya üretimini olabildiğince hafif tut
      'level-type': 'minecraft\\:flat',
      'generate-structures': 'false',
      'spawn-protection': '0',
      'view-distance': '2',
      'simulation-distance': '2'
    }
    const existing = await readFile(path, 'utf8').catch(() => '')
    const lines = existing.split(/\r?\n/).filter((line) => {
      const key = line.split('=')[0].trim()
      return line.trim() !== '' && !(key in managed)
    })
    for (const [key, value] of Object.entries(managed)) lines.push(`${key}=${value}`)
    await writeFile(path, lines.join('\n') + '\n', 'utf8')
  }

  // --- Çıktı işleme ---

  private onOutput(chunk: string): void {
    this.emitLog(chunk)
    this.lineBuffer += chunk
    const lines = this.lineBuffer.split('\n')
    this.lineBuffer = lines.pop() ?? ''
    for (const raw of lines) this.onLine(raw.replace(/\r$/, ''))
  }

  private onLine(raw: string): void {
    const line = stripAnsi(raw)
    if (this.onReady && this.addonStatus.length > 0) this.trackAddonLine(line)
    if (this.onReady && /\bDone \([\d.,]+s\)!/.test(line)) {
      this.onReady()
      this.onReady = null
    }
    if (!this.active) return
    this.parser.push(raw)
    const name = escapeRegExp(this.active.stagedName)
    if (new RegExp(`Successfully reloaded .*${name}`).test(line)) {
      this.parser.flush()
      this.active.finish(true)
    } else if (new RegExp(`Encountered \\d+ errors? while reloading .*${name}`).test(line)) {
      this.parser.flush()
      this.active.finish(false)
    } else if (/Can't find the (script|folder)/.test(line)) {
      this.active.finish(false)
    }
  }

  private onDiagnostic(diagnostic: SkriptDiagnostic): void {
    // Sunucudaki başka betiklerin hataları bu doğrulamaya ait değil
    if (this.active && fileBaseName(diagnostic.file) === this.active.stagedName) {
      this.active.diagnostics.push(diagnostic)
    }
  }

  private onExit(code: number | null): void {
    const expected = this.status.state === 'stopping'
    this.process = null
    this.startPromise = null
    this.onReady = null
    this.active?.finish(false)
    this.emitLog(l(`[Skript IDE] Sunucu kapandı (çıkış kodu ${code}).\n`, `[Skript IDE] Server stopped (exit code ${code}).\n`))
    if (expected) this.setStatus('stopped', l('Sunucu kapalı', 'Server stopped'))
    else if (this.status.state !== 'error') this.setStatus('error', l(`Sunucu beklenmedik şekilde kapandı (çıkış kodu ${code})`, `The server stopped unexpectedly (exit code ${code})`))
  }

  // --- Doğrulama ---

  private async runValidation(source: string, fileName: string, content: string): Promise<ValidationResult> {
    await this.start()
    const startedAt = Date.now()
    const stagedName = stagingName(fileName)
    await writeFile(join(this.serverDir, 'plugins', 'Skript', 'scripts', STAGING_FOLDER, stagedName), content, 'utf8')

    this.setStatus('validating', l(`${stagedName} doğrulanıyor…`, `Validating ${stagedName}…`))
    try {
      const diagnostics: SkriptDiagnostic[] = []
      const ok = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.active = null
          reject(new Error(l(`${stagedName} doğrulaması zaman aşımına uğradı.`, `Validation of ${stagedName} timed out.`)))
        }, VALIDATE_TIMEOUT_MS)
        this.active = {
          stagedName,
          diagnostics,
          finish: (result) => {
            clearTimeout(timer)
            this.active = null
            resolve(result)
          }
        }
        this.parser.reset()
        this.sendCommand(`sk reload ${STAGING_FOLDER}/${stagedName}`)
      })
      return {
        source,
        stagedName,
        diagnostics,
        ok: ok && !diagnostics.some((d) => d.severity === 'error'),
        durationMs: Date.now() - startedAt
      }
    } finally {
      if (this.process) this.setStatus('ready', l('Sunucu hazır', 'Server ready'))
    }
  }

  // --- Yardımcılar ---

  private lastProgress = ''

  private reportProgress(label: string, progress: DownloadProgress): void {
    const message = progress.total
      ? l(`${label} indiriliyor… %${Math.floor((progress.received / progress.total) * 100)}`, `Downloading ${label}… ${Math.floor((progress.received / progress.total) * 100)}%`)
      : l(`${label} indiriliyor… ${(progress.received / 1_048_576).toFixed(1)} MB`, `Downloading ${label}… ${(progress.received / 1_048_576).toFixed(1)} MB`)
    if (message === this.lastProgress) return
    this.lastProgress = message
    this.setStatus('preparing', message)
  }

  private emitLog(text: string): void {
    this.log = (this.log + text).slice(-LOG_BUFFER_CHARS)
    this.options.onLog?.(text)
  }

  private setStatus(state: ServerState, message: string): void {
    this.status = { ...this.status, state, message, addons: this.addonStatus.map((status) => ({ ...status })) }
    this.options.onStatus?.(this.status)
  }
}

/** Skript `-` ile başlayan dosyaları devre dışı sayar; adı sunucuda güvenli bir hale getir. */
export function stagingName(fileName: string): string {
  let name = fileBaseName(fileName).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[-.\s]+/, '')
  if (!name.toLowerCase().endsWith('.sk')) name += '.sk'
  return name === '.sk' ? 'betik.sk' : name
}

/** Hem `\` hem `/` ayırıcılarını tanır; Skript Windows'ta `ide\x.sk` yazıyor. */
function serverDirFor(rootDir: string, versions: RuntimeVersions): string {
  return join(rootDir, 'servers', `paper-${versions.minecraft}`)
}

/** Sürüm karşılaştırması için addon listesinin sıradan bağımsız anahtarı. */
/** Sunucu satırından zaman/seviye öneklerini atar: `[13:20:38 ERROR]: x` → `x`. */
function cleanLogLine(line: string): string {
  return line.replace(/^(\[[^\]]*\]:?\s*)+/, '').trim().slice(0, 300)
}

function addProblem(status: AddonLoadStatus, problem: string): void {
  status.problems ??= []
  if (!status.problems.includes(problem) && status.problems.length < 8) status.problems.push(problem)
}

function addonKey(addons: readonly AddonSelection[] | undefined): string {
  return (addons ?? [])
    .map((addon) => `${addon.name.toLowerCase()}@${addon.version}`)
    .sort()
    .join(',')
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error(l('Boş port bulunamadı', 'No free port found')))))
    })
  })
}
