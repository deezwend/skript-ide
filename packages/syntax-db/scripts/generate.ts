/**
 * Skript syntax veritabanını üretir. Veri elle yazılmaz; Skript'in kendi JSON dokümantasyon
 * üreticisinin (`ch.njol.skript.doc.JSONGenerator`, `/skript gen-docs`) çıktısından türetilir.
 *
 * Kaynaklar:
 *   archive (varsayılan)  SkriptLang/skript-docs deposundaki `docs/archives/<sürüm>/docs.json`. Skript'in
 *                         release-docs iş akışı her sürümde bu dosyayı gerçek bir test sunucusunda
 *                         `gradlew genReleaseDocs` → `skript gen-docs` ile üretip buraya koyar.
 *                         İndirme bir skript-docs commit'ine sabitlenir ve SHA-256 kaydedilir.
 *   server                runtime-validator ile o sürümün Paper + Skript çiftini bu makinede başlatır,
 *                         `sk gen-docs` çalıştırır ve çıkan `docs.json`'u kullanır. EULA onayı daha önce
 *                         verilmiş bir `--runtime-dir` ister; betik EULA'yı asla kendisi kabul etmez.
 *
 * Kullanım (depo kökünden):
 *   npm run generate -w @skript-ide/syntax-db
 *   npm run generate -w @skript-ide/syntax-db -- 2.17.1 2.16.2
 *   npm run generate -w @skript-ide/syntax-db -- --source=server --runtime-dir=<klasör> 2.16.2
 *
 * Seçenekler:
 *   --source=archive|server   Veri kaynağı (varsayılan: archive)
 *   --docs-commit=<sha>       archive: kullanılacak skript-docs commit'i (varsayılan: main'in son commit'i)
 *   --runtime-dir=<klasör>    server: Paper/Skript önbelleği ve sunucu klasörlerinin kökü
 *   --raw-dir=<klasör>        Ham docs.json dosyalarını karşılaştırma için buraya da kaydet
 *   --check                   Dosyaları yazma; üretilen veri depodakiyle aynı mı diye bak
 *
 * Sürüm verilmezse runtime-validator'daki uyumluluk tablosunun (SKRIPT_RUNTIMES) tüm sürümleri üretilir.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EulaRequiredError, runtimeVersionsFor, SKRIPT_RUNTIMES, SkriptServer } from '@skript-ide/runtime-validator'
import { normalizeSkriptDocs, type RawSkriptDocs } from '../src/normalize'
import { SYNTAX_KINDS, type SyntaxDatabase, type SyntaxDatabaseSource } from '../src/schema'
import { CATALOG_FILE, DATA_DIR, diffEntries, serialize, writeCatalog } from './catalog'

const DOCS_REPO = 'SkriptLang/skript-docs'
const USER_AGENT = 'skript-ide/0.1.0 (Skript IDE syntax-db generator)'
const GEN_DOCS_TIMEOUT_MS = 5 * 60_000

interface Options {
  source: 'archive' | 'server'
  versions: string[]
  docsCommit?: string
  runtimeDir?: string
  rawDir?: string
  check: boolean
}

interface RawDocs {
  bytes: Buffer
  source: Omit<SyntaxDatabaseSource, 'jsonFormat' | 'sha256'>
}

function parseArgs(argv: string[]): Options {
  const options: Options = { source: 'archive', versions: [], check: false }
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s, 2)
    switch (key) {
      case '--source':
        if (value !== 'archive' && value !== 'server') throw new Error(`Bilinmeyen kaynak: ${value}`)
        options.source = value
        break
      case '--docs-commit':
        options.docsCommit = value
        break
      case '--runtime-dir':
        options.runtimeDir = resolve(value)
        break
      case '--raw-dir':
        options.rawDir = resolve(value)
        break
      case '--check':
        options.check = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`Bilinmeyen seçenek: ${arg}`)
        options.versions.push(arg)
    }
  }
  if (options.versions.length === 0) options.versions = SKRIPT_RUNTIMES.map((profile) => profile.skript)
  if (options.source === 'server' && !options.runtimeDir) throw new Error('--source=server için --runtime-dir gerekli.')
  return options
}

async function fetchOk(url: string, accept = 'application/json'): Promise<Response> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } })
  if (!response.ok) throw new Error(`${url} isteği başarısız: HTTP ${response.status}`)
  return response
}

// --- Kaynak: skript-docs arşivi ---

async function resolveDocsCommit(requested?: string): Promise<string> {
  const ref = requested ?? 'main'
  const commit = (await (await fetchOk(`https://api.github.com/repos/${DOCS_REPO}/commits/${ref}`)).json()) as { sha: string }
  return commit.sha
}

async function fromArchive(version: string, commit: string): Promise<RawDocs> {
  const url = `https://raw.githubusercontent.com/${DOCS_REPO}/${commit}/docs/archives/${encodeURIComponent(version)}/docs.json`
  const bytes = Buffer.from(await (await fetchOk(url, '*/*')).arrayBuffer())
  return { bytes, source: { kind: 'skript-docs-archive', url, commit } }
}

// --- Kaynak: yerel sunucuda `sk gen-docs` ---

async function fromLocalServer(version: string, runtimeDir: string): Promise<RawDocs> {
  const versions = runtimeVersionsFor(version)
  const outputDir = join(runtimeDir, 'gen-docs', version)
  const templateDir = join(runtimeDir, 'gen-docs', 'templates')
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  // Skript, `gen-docs` alt komutunu yalnızca şablon klasörü varsa açıyor (SkriptCommand: Documentation.isDocsTemplateFound()).
  // JSON şablondan bağımsız; HTML üreticisi de yalnızca iskelet dosyasını okuyabilsin diye en küçük şablon yeterli.
  await mkdir(templateDir, { recursive: true })
  await writeFile(join(templateDir, 'template.html'), '${content}\n', 'utf8')

  let log = ''
  const server = new SkriptServer({
    rootDir: runtimeDir,
    versions,
    env: { SKRIPT_DOCS_TEMPLATE_DIR: templateDir, SKRIPT_DOCS_OUTPUT_DIR: outputDir },
    // Skript'in CI'ı da gen-docs'ta bunu veriyor (test/platform/Environment.java): Vault/WorldGuard gibi
    // eklentiler kurulu olmasa da hook syntax'ları kaydedilir, böylece çıktı resmi arşivle aynı olur.
    jvmArgs: ['-Dskript.forceregisterhooks=true'],
    onLog: (text) => {
      log += text
    },
    onStatus: (status) => console.log(`  [${status.state}] ${status.message}`)
  })

  try {
    try {
      await server.start()
    } catch (error) {
      if (error instanceof EulaRequiredError) {
        throw new Error(`${runtimeDir} için Minecraft EULA'sı kabul edilmemiş. Önce uygulamada kabul et; betik bunu senin yerine yapmaz.`)
      }
      throw error
    }
    const docsFile = join(outputDir, 'docs.json')
    const logStart = log.length
    server.sendCommand('sk gen-docs')

    // JSON, HTML'den önce ve tek seferde yazılıyor; dosya ayrıştırılabildiği an hazırdır
    const deadline = Date.now() + GEN_DOCS_TIMEOUT_MS
    let bytes: Buffer | null = null
    while (!bytes) {
      if (existsSync(docsFile)) {
        const candidate = await readFile(docsFile)
        try {
          JSON.parse(candidate.toString('utf8'))
          bytes = candidate
          break
        } catch {
          // Henüz yazılıyor
        }
      }
      const tail = log.slice(logStart)
      if (/Unknown command|Usage: \/skript/i.test(tail)) throw new Error(`Sunucu gen-docs komutunu tanımadı:\n${tail}`)
      if (Date.now() > deadline) throw new Error(`gen-docs ${GEN_DOCS_TIMEOUT_MS / 1000} saniyede bitmedi.\n${tail.slice(-2000)}`)
      await new Promise((r) => setTimeout(r, 500))
    }
    const paperJar = (await readdir(join(runtimeDir, 'cache'))).find((name) => name.startsWith(`paper-${versions.minecraft}-`) && name.endsWith('.jar'))
    return {
      bytes,
      source: { kind: 'local-server', url: `sk gen-docs — Skript ${version} on ${paperJar ?? `Paper ${versions.minecraft}`}` }
    }
  } finally {
    await server.stop()
  }
}



async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const commit = options.source === 'archive' ? await resolveDocsCommit(options.docsCommit) : undefined
  if (commit) console.log(`skript-docs commit: ${commit}`)
  await mkdir(DATA_DIR, { recursive: true })

  let mismatches = 0
  for (const version of options.versions) {
    console.log(`Skript ${version} (${options.source})…`)
    const raw = options.source === 'archive' ? await fromArchive(version, commit!) : await fromLocalServer(version, options.runtimeDir!)
    const sha256 = createHash('sha256').update(raw.bytes).digest('hex')
    if (options.rawDir) {
      await mkdir(options.rawDir, { recursive: true })
      await writeFile(join(options.rawDir, `${version}-${options.source}.json`), raw.bytes)
    }

    let parsed: RawSkriptDocs
    try {
      parsed = JSON.parse(raw.bytes.toString('utf8')) as RawSkriptDocs
    } catch (error) {
      // Örn. Skript 2.10.x arşivi kaçışsız tırnak içerdiği için geçersiz JSON
      throw new Error(`Skript ${version} docs.json geçerli JSON değil: ${(error as Error).message}`)
    }
    const db = normalizeSkriptDocs(parsed, { skriptVersion: version, source: { ...raw.source, sha256 } })
    const text = serialize(db)
    const target = join(DATA_DIR, `skript-${version}.json`)
    const summary = SYNTAX_KINDS.map((kind) => `${kind} ${db.counts[kind]}`).join(', ')

    if (options.check) {
      const existing = existsSync(target) ? (JSON.parse(await readFile(target, 'utf8')) as SyntaxDatabase) : null
      const diff = diffEntries(existing?.entries ?? [], db.entries)
      if (diff) mismatches++
      console.log(`  ${diff ? 'FARKLI' : 'aynı'}: ${summary}`)
      if (diff) console.log(diff)
    } else {
      await writeFile(target, text, 'utf8')
      console.log(`  ${target} (${(text.length / 1024).toFixed(0)} KB): ${summary}`)
    }
  }

  if (options.check) {
    if (mismatches) {
      console.error(`${mismatches} sürümde veri farklı.`)
      process.exitCode = 1
    }
    return
  }
  await writeCatalog()
  console.log(`Katalog güncellendi: ${CATALOG_FILE}`)
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
