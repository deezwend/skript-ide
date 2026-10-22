/**
 * Addon syntax veritabanlarını üretir. Veri elle yazılmaz; gerçek Paper + Skript sunucusunda addon kurulu
 * haldeyken Skript'in syntax kayıt defterinden alınır.
 *
 * Yöntem (her Skript/Paper ikilisi için):
 *   1. Yalnızca skript-reflect kurulu sunucu ("referans"): `scripts/addon-dump.sk` betiği skript-reflect ile
 *      kayıt defterini, türleri ve Java fonksiyonlarını JSON'a döker. skript-reflect'in kendi verisi buradan çıkar.
 *   2. skript-reflect + diğer addon (ör. SkBee) kurulu sunucu: aynı döküm. Syntax'ların kökeni kayıt defterinde
 *      yazılı; türler ve fonksiyonlarınki değil, onlar referans dökümüyle farktan bulunur.
 *   3. Addon'un kendi doküman üreticisi varsa (SkBee: `skbee docs`) aynı sunucuda çalıştırılır; ad, açıklama,
 *      örnek ve sürüm bilgisi buradan gelir. Pattern'ler her zaman kayıt defterinden alınır.
 *
 * Hangi addon sürümünün hangi Skript sürümünde deneneceği `ADDON_COMPATIBILITY` tablosundan ("ok" satırları)
 * gelir; önce `npm run verify-addons -w @skript-ide/runtime-validator` çalıştırılmalı.
 *
 * Kullanım (depo kökünden):
 *   npm run generate-addons -w @skript-ide/syntax-db -- --runtime-dir=<klasör>
 *   npm run generate-addons -w @skript-ide/syntax-db -- --runtime-dir=<klasör> --skript=2.17.1
 *   npm run generate-addons -w @skript-ide/syntax-db -- --offline --raw-dir=<klasör>   (sunucusuz, kayıtlı ham dökümden)
 *
 * Seçenekler:
 *   --runtime-dir=<klasör>  Paper/Skript/addon önbelleği ve sunucu klasörlerinin kökü (EULA önceden kabul edilmiş olmalı)
 *   --raw-dir=<klasör>      Ham dökümlerin yazılacağı/okunacağı klasör (varsayılan: <runtime-dir>/addon-raw)
 *   --skript=<sürüm>        Yalnızca bu Skript sürümü
 *   --offline               Sunucu açma; ham dökümleri --raw-dir'den oku
 *   --check                 Dosyaları yazma; üretilen veri depodakiyle aynı mı diye bak
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ADDON_COMPATIBILITY,
  ADDONS,
  EulaRequiredError,
  runtimeVersionsFor,
  SKRIPT_RUNTIMES,
  SkriptServer,
  type AddonSelection
} from '@skript-ide/runtime-validator'
import { convertAddonDump, docCoverage, type AddonDocs, type RegistryDump } from '../src/addon-dump'
import { readSyntaxDatabase } from '../src/node'
import { SYNTAX_KINDS, type SyntaxDatabase } from '../src/schema'
import { ADDON_DATA_DIR, addonDataFile, CATALOG_FILE, diffEntries, PACKAGE_DIR, serialize, writeCatalog } from './catalog'

const DUMP_SCRIPT = join(PACKAGE_DIR, 'scripts', 'addon-dump.sk')
const REFLECT = 'skript-reflect'
const STEP_TIMEOUT_MS = 2 * 60_000

/** Addon'a ait Java paketleri: türleri/fonksiyonları kökenden bağımsız tanımak için. */
const ADDON_PACKAGES: Record<string, readonly string[]> = {
  SkBee: ['com.shanebeestudios.skbee.'],
  [REFLECT]: ['org.skriptlang.reflect.', 'com.btk5h.skriptmirror.']
}

/** Addon'un kendi doküman üreticisi: komut ve sunucu klasörüne göre çıktı dosyası. */
const DOC_COMMANDS: Record<string, { command: string; file: string; done: RegExp }> = {
  SkBee: { command: 'skbee docs', file: join('plugins', 'SkBee', 'json-docs.json'), done: /Finished generating .* docs/ }
}

interface Options {
  runtimeDir?: string
  rawDir: string
  skript?: string
  offline: boolean
  check: boolean
}

function parseArgs(argv: string[]): Options {
  let runtimeDir: string | undefined
  let rawDir: string | undefined
  let skript: string | undefined
  let offline = false
  let check = false
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s, 2)
    if (key === '--runtime-dir') runtimeDir = resolve(value)
    else if (key === '--raw-dir') rawDir = resolve(value)
    else if (key === '--skript') skript = value
    else if (key === '--offline') offline = true
    else if (key === '--check') check = true
    else throw new Error(`Bilinmeyen seçenek: ${arg}`)
  }
  if (!offline && !runtimeDir) throw new Error('--runtime-dir gerekli (ya da --offline --raw-dir).')
  if (!rawDir && !runtimeDir) throw new Error('--raw-dir gerekli.')
  return { runtimeDir, rawDir: rawDir ?? join(runtimeDir!, 'addon-raw'), skript, offline, check }
}

/** Bir Skript sürümünde gerçek sunucuda çalıştığı doğrulanmış addon sürümleri. */
function compatibleVersions(addon: string, skript: string): string[] {
  return ADDON_COMPATIBILITY.filter((entry) => entry.addon === addon && entry.skript === skript && entry.status === 'ok').map(
    (entry) => entry.addonVersion
  )
}

interface Run {
  skript: string
  /** Araç olarak kurulan skript-reflect sürümü. */
  reflect: string
  /** skript-reflect dışındaki addon (referans koşusunda yok). */
  addon?: AddonSelection
}

function planRuns(skript: string): Run[] {
  const reflect = compatibleVersions(REFLECT, skript)[0]
  if (!reflect) return []
  const runs: Run[] = [{ skript, reflect }]
  for (const profile of ADDONS) {
    if (profile.id === REFLECT) continue
    for (const version of compatibleVersions(profile.id, skript)) runs.push({ skript, reflect, addon: { name: profile.id, version } })
  }
  return runs
}

const runTag = (run: Run) => `skript-${run.skript}+${REFLECT}-${run.reflect}${run.addon ? `+${run.addon.name.toLowerCase()}-${run.addon.version}` : ''}`

async function waitFor(check: () => boolean | Promise<boolean>, what: string, log: () => string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} ${STEP_TIMEOUT_MS / 1000} saniyede bitmedi.\n${log().slice(-2000)}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Sunucuyu açar, dökümü (ve varsa addon dokümanını) ham klasöre yazar. */
async function captureRun(run: Run, runtimeDir: string, rawDir: string): Promise<void> {
  const dir = join(rawDir, runTag(run))
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const addons: AddonSelection[] = [{ name: REFLECT, version: run.reflect }, ...(run.addon ? [run.addon] : [])]
  const versions = { ...runtimeVersionsFor(run.skript), addons }
  let log = ''
  const server = new SkriptServer({
    rootDir: runtimeDir,
    versions,
    // Skript'in kendi gen-docs'u ile aynı: hook syntax'ları ilgili eklenti olmasa da kaydedilsin
    jvmArgs: ['-Dskript.forceregisterhooks=true'],
    onLog: (text) => {
      log += text
    },
    onStatus: (status) => console.log(`    [${status.state}] ${status.message}`)
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
    const failed = server.addons.filter((status) => status.state !== 'enabled')
    if (failed.length) throw new Error(`Addon açılmadı: ${failed.map((s) => `${s.name} ${s.version} (${s.message})`).join(', ')}`)

    const dumpFile = join(dir, 'dump.json')
    const script = (await readFile(DUMP_SCRIPT, 'utf8')).replaceAll('__OUTPUT__', dumpFile.replace(/\\/g, '/'))
    const result = await server.validate('addon-dump', 'addon-dump.sk', script)
    if (!result.ok) throw new Error(`Döküm betiği yüklenmedi: ${result.diagnostics.map((d) => `${d.line}: ${d.message}`).join('; ')}`)
    await waitFor(() => /IDE-DUMP-DONE/.test(log) && existsSync(dumpFile), 'Döküm', () => log)

    const docCommand = run.addon && DOC_COMMANDS[run.addon.name]
    if (docCommand && run.addon) {
      const serverDir = join(runtimeDir, 'servers', `paper-${versions.minecraft}`)
      const docsFile = join(serverDir, docCommand.file)
      await rm(docsFile, { force: true })
      const from = log.length
      server.sendCommand(docCommand.command)
      let produced = true
      try {
        await waitFor(
          () => docCommand.done.test(log.slice(from)) && existsSync(docsFile),
          `${run.addon.name} dokümanı`,
          () => log.slice(from)
        )
      } catch {
        produced = false
      }
      if (produced) {
        await writeFile(join(dir, `${run.addon.name.toLowerCase()}-docs.json`), await readFile(docsFile))
      } else {
        // Eski sürümlerde komut yok (ör. SkBee 3.16.1; konsol yanıtı log'a da düşmüyor): açıklamalar
        // dökümdeki sınıf notlarından gelir.
        console.log(`  ${run.addon.name} ${run.addon.version}: \`${docCommand.command}\` doküman üretmedi, sınıf açıklamaları kullanılıyor`)
      }
    }

    const paperJar = (await readdir(join(runtimeDir, 'cache'))).find((name) => name.startsWith(`paper-${versions.minecraft}-`) && name.endsWith('.jar'))
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({ skript: run.skript, paper: paperJar ?? versions.minecraft, addons }, null, 2) + '\n'
    )
  } finally {
    await server.stop()
  }
}

interface CapturedRun {
  run: Run
  dump: RegistryDump
  dumpBytes: Buffer
  docs?: AddonDocs
  docsBytes?: Buffer
  paper: string
}

async function readCaptured(run: Run, rawDir: string): Promise<CapturedRun> {
  const dir = join(rawDir, runTag(run))
  if (!existsSync(join(dir, 'dump.json'))) throw new Error(`${dir} içinde döküm yok; önce sunucuyla üret.`)
  const dumpBytes = await readFile(join(dir, 'dump.json'))
  const info = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { paper: string }
  const docsPath = run.addon ? join(dir, `${run.addon.name.toLowerCase()}-docs.json`) : undefined
  const docsBytes = docsPath && existsSync(docsPath) ? await readFile(docsPath) : undefined
  const dump = JSON.parse(dumpBytes.toString('utf8')) as RegistryDump
  if (dump.skript !== run.skript) throw new Error(`${dir}: döküm Skript ${dump.skript} sürümüne ait, ${run.skript} bekleniyordu.`)
  return {
    run,
    dump,
    dumpBytes,
    docs: docsBytes ? (JSON.parse(docsBytes.toString('utf8')) as AddonDocs) : undefined,
    docsBytes,
    paper: info.paper
  }
}

const sha256 = (...parts: Buffer[]) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** Bir koşunun dökümünden tek addon'un veritabanı. */
function buildDatabase(captured: CapturedRun, addon: AddonSelection, base: SyntaxDatabase, reference?: RegistryDump): SyntaxDatabase {
  const docs = addon.name === captured.run.addon?.name ? captured.docs : undefined
  const docsNote = docs && DOC_COMMANDS[addon.name] ? ` + \`${DOC_COMMANDS[addon.name].command}\`` : ''
  return convertAddonDump({
    addon: addon.name,
    addonVersion: addon.version,
    dump: captured.dump,
    docs,
    base,
    reference,
    packages: ADDON_PACKAGES[addon.name] ?? [],
    source: {
      kind: 'addon-server',
      url: `Skript syntax registry (scripts/addon-dump.sk)${docsNote} — ${addon.name} ${addon.version}, Skript ${captured.run.skript} on ${captured.paper}`,
      sha256: docs && captured.docsBytes ? sha256(captured.dumpBytes, captured.docsBytes) : sha256(captured.dumpBytes)
    },
    jsonFormat: docs ? `addon-dump-1+${addon.name.toLowerCase()}-docs` : 'addon-dump-1'
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(ADDON_DATA_DIR, { recursive: true })
  let mismatches = 0
  let written = 0

  for (const runtime of SKRIPT_RUNTIMES) {
    if (options.skript && runtime.skript !== options.skript) continue
    const runs = planRuns(runtime.skript)
    if (runs.length === 0) {
      console.log(`Skript ${runtime.skript}: uyumlu ${REFLECT} sürümü yok, atlanıyor.`)
      continue
    }
    const base = await readSyntaxDatabase(runtime.skript)
    const captured: CapturedRun[] = []
    for (const run of runs) {
      console.log(`${runTag(run)}…`)
      if (!options.offline) await captureRun(run, options.runtimeDir!, options.rawDir)
      captured.push(await readCaptured(run, options.rawDir))
    }

    const reference = captured[0]
    const outputs: SyntaxDatabase[] = [buildDatabase(reference, { name: REFLECT, version: reference.run.reflect }, base)]
    for (const item of captured.slice(1)) {
      const addon = item.run.addon!
      if (item.docs) {
        const coverage = docCoverage(item.dump, item.docs, addon.name)
        console.log(`  ${addon.name} ${addon.version}: kayıtların ${coverage.matched}/${coverage.total} tanesi dokümanla eşleşti`)
      }
      outputs.push(buildDatabase(item, addon, base, reference.dump))
    }

    for (const db of outputs) {
      const target = join(ADDON_DATA_DIR, addonDataFile(db.addon!.name, db.addon!.version, db.skriptVersion))
      const summary = SYNTAX_KINDS.map((kind) => `${kind} ${db.counts[kind]}`).join(', ')
      if (options.check) {
        const existing = existsSync(target) ? (JSON.parse(await readFile(target, 'utf8')) as SyntaxDatabase) : null
        const diff = diffEntries(existing?.entries ?? [], db.entries)
        if (diff) mismatches++
        console.log(`  ${db.addon!.name} ${db.addon!.version}: ${diff ? 'FARKLI' : 'aynı'} (${summary})`)
        if (diff) console.log(diff)
      } else {
        await writeFile(target, serialize(db), 'utf8')
        written++
        console.log(`  ${target}: ${summary}`)
      }
    }
  }

  if (options.check) {
    if (mismatches) {
      console.error(`${mismatches} addon veritabanı farklı.`)
      process.exitCode = 1
    }
    return
  }
  if (written) {
    await writeCatalog()
    console.log(`Katalog güncellendi: ${CATALOG_FILE}`)
  }
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
