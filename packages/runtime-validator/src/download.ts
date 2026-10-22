import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { findAddonVersion } from './addons'

import { l } from '@skript-ide/i18n'
/** PaperMC, API isteklerinde projeyi tanıtan bir User-Agent istiyor. */
const USER_AGENT = 'skript-ide/0.1.0 (Skript IDE runtime validator)'

// https://docs.papermc.io/misc/downloads-service — Fill v3
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'
const SKRIPT_RELEASES_API = 'https://api.github.com/repos/SkriptLang/Skript/releases/tags'

export interface DownloadProgress {
  file: string
  received: number
  total: number | null
}

export interface CachedJar {
  path: string
  fileName: string
}

export interface PaperJar extends CachedJar {
  minecraft: string
  build: number
  /** Bu Minecraft sürümü için Paper'ın istediği en düşük Java sürümü. */
  javaMinimum: number
}

interface PaperManifest {
  minecraft: string
  build: number
  fileName: string
  sha256: string
  javaMinimum: number
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!response.ok) {
    const error = new Error(l(`${url} isteği başarısız: HTTP ${response.status}`, `Request to ${url} failed: HTTP ${response.status}`))
    Object.assign(error, { status: response.status })
    throw error
  }
  return (await response.json()) as T
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number }).status === 404
}

/** Dosyayı `.part` uzantısıyla indirir, SHA-256'yı doğrular ve ancak sonra yerine taşır. */
async function downloadVerified(
  url: string,
  dest: string,
  sha256: string | null,
  onProgress?: (progress: DownloadProgress) => void,
  algorithm: 'sha256' | 'sha512' = 'sha256'
): Promise<void> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok || !response.body) throw new Error(l(`${url} indirilemedi: HTTP ${response.status}`, `Could not download ${url}: HTTP ${response.status}`))

  const total = Number(response.headers.get('content-length')) || null
  const file = dest.split(/[\\/]/).pop()!
  const hash = createHash(algorithm)
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      onProgress?.({ file, received, total })
      callback(null, chunk)
    }
  })

  const part = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(part))
    const actual = hash.digest('hex')
    if (sha256 && actual !== sha256.toLowerCase()) {
      throw new Error(l(`${file} bozuk indi (${algorithm.toUpperCase()} uyuşmuyor). Tekrar dene.`, `${file} was corrupted while downloading (${algorithm.toUpperCase()} mismatch). Try again.`))
    }
    await rename(part, dest)
  } finally {
    await rm(part, { force: true })
  }
}

/**
 * Paper jar'ını önbellekten döndürür, yoksa indirir. Ağ yoksa aynı Minecraft
 * sürümü için daha önce indirilmiş build'e geri düşer.
 */
export async function ensurePaperJar(
  cacheDir: string,
  minecraft: string,
  build: number | undefined,
  onProgress?: (progress: DownloadProgress) => void
): Promise<PaperJar> {
  await mkdir(cacheDir, { recursive: true })
  const manifestPath = join(cacheDir, `paper-${minecraft}${build ? `-${build}` : ''}.json`)

  let manifest: PaperManifest
  try {
    const version = await getJson<{ version: { java: { version: { minimum: number } } } }>(
      `${PAPER_API}/versions/${encodeURIComponent(minecraft)}`
    )
    const buildInfo = await getJson<{
      id: number
      downloads: Record<string, { name: string; url: string; checksums: { sha256: string } }>
    }>(`${PAPER_API}/versions/${encodeURIComponent(minecraft)}/builds/${build ?? 'latest'}`)
    const download = buildInfo.downloads['server:default']
    if (!download) throw new Error(l(`Paper ${minecraft} #${buildInfo.id} için sunucu dosyası yok.`, `No server file for Paper ${minecraft} #${buildInfo.id}.`))

    manifest = {
      minecraft,
      build: buildInfo.id,
      fileName: download.name,
      sha256: download.checksums.sha256,
      javaMinimum: version.version.java.version.minimum
    }
    const path = join(cacheDir, manifest.fileName)
    if (!existsSync(path)) await downloadVerified(download.url, path, manifest.sha256, onProgress)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  } catch (error) {
    if (isNotFound(error)) throw new Error(l(`Paper'da "${minecraft}" sürümü${build ? ` / #${build} build'i` : ''} bulunamadı.`, `Paper version "${minecraft}"${build ? ` / build #${build}` : ''} was not found.`))
    // Çevrimdışı olabilir: daha önce indirilmiş bir build varsa onu kullan
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PaperManifest
    } catch {
      throw new Error(l(`Paper ${minecraft} indirilemedi: ${(error as Error).message}`, `Could not download Paper ${minecraft}: ${(error as Error).message}`))
    }
    if (!existsSync(join(cacheDir, manifest.fileName))) throw error
  }

  return { ...manifest, path: join(cacheDir, manifest.fileName) }
}

/** Skript jar'ını GitHub release'inden indirir; önbellekte varsa ağa çıkmaz. */
export async function ensureSkriptJar(
  cacheDir: string,
  version: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<CachedJar> {
  await mkdir(cacheDir, { recursive: true })
  const cached = (await readdir(cacheDir)).find((name) => name === `Skript-${version}.jar`)
  if (cached) return { path: join(cacheDir, cached), fileName: cached }

  let release: { assets: { name: string; browser_download_url: string; digest?: string | null }[] }
  try {
    release = await getJson(`${SKRIPT_RELEASES_API}/${encodeURIComponent(version)}`)
  } catch (error) {
    if (isNotFound(error)) throw new Error(l(`Skript'in "${version}" sürümü GitHub'da bulunamadı.`, `Skript version "${version}" was not found on GitHub.`))
    throw new Error(l(`Skript ${version} bilgisi alınamadı: ${(error as Error).message}`, `Could not fetch Skript ${version} info: ${(error as Error).message}`))
  }
  const asset = release.assets.find((a) => /^Skript.*\.jar$/i.test(a.name))
  if (!asset) throw new Error(l(`Skript ${version} release'inde jar dosyası yok.`, `The Skript ${version} release has no jar file.`))

  // Dosya adını sürüme göre sabitle ki önbellek kontrolü ağsız çalışsın
  const fileName = `Skript-${version}.jar`
  const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
  await downloadVerified(asset.browser_download_url, join(cacheDir, fileName), sha256, onProgress)
  return { path: join(cacheDir, fileName), fileName }
}

/**
 * Addon jar'ını tablodaki sabit adresten indirir ve sabitlenmiş özetle doğrular; önbellekte varsa ağa çıkmaz.
 * Jar'lar `cache/addons/` altında tutulur, böylece Skript/Paper jar'larıyla karışmaz.
 */
export async function ensureAddonJar(
  cacheDir: string,
  name: string,
  version: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<CachedJar & { addon: string; version: string }> {
  const profile = findAddonVersion(name, version)
  if (!profile) throw new Error(l(`${name} ${version} için indirme bilgisi yok.`, `No download info for ${name} ${version}.`))
  const addonDir = join(cacheDir, 'addons')
  await mkdir(addonDir, { recursive: true })
  const fileName = profile.download.file
  const path = join(addonDir, fileName)
  if (!existsSync(path)) {
    const download = profile.download
    if (download.kind === 'modrinth') await downloadVerified(download.url, path, download.sha512, onProgress, 'sha512')
    else await downloadVerified(download.url, path, download.sha256, onProgress, 'sha256')
  }
  return { path, fileName, addon: name, version }
}
