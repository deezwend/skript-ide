import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExampleIndex, type ExampleIndex, type ExampleInputFile } from './examples'

/** Paket içindeki gerçek corpus klasörleri (build ve testler için). */
export const DEFAULT_SAMPLES_DIR = fileURLToPath(new URL('../samples', import.meta.url))
export const EXAMPLE_DATA_PATH = fileURLToPath(new URL('../data/examples.json', import.meta.url))

interface SourcesFile {
  path: string
  source: string
  sourcePath: string
  license: string
  addons?: string[]
}

interface Sources {
  repositories: Record<string, { url: string; license: string }>
  files: SourcesFile[]
}

interface GroundTruthFile {
  path: string
  diagnostics: { line: number; severity: 'error' | 'warning' }[]
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number(part) || 0)
}

function compareVersions(a: string, b: string): number {
  const [pa, pb] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Ground truth dosyaları arasından istenen (yoksa en yeni) Skript sürümünü seçer. */
async function groundTruthVersion(samplesDir: string, wanted?: string): Promise<string | undefined> {
  if (wanted) return wanted
  let names: string[]
  try {
    names = (await readdir(join(samplesDir, 'ground-truth'))).filter((name) => name.endsWith('.json'))
  } catch {
    return undefined
  }
  const versions = names.map((name) => name.slice(0, -'.json'.length)).sort(compareVersions)
  return versions.at(-1)
}

export interface BuildExamplesOptions {
  samplesDir?: string
  /** Ground truth sürümü; verilmezse ground-truth klasöründeki en yenisi. */
  groundTruthVersion?: string
  maxLines?: number
  generatedAt?: string
}

/**
 * `samples/SOURCES.json` ve ground truth'u okuyup tüm corpus dosyalarından örnek indeksi üretir.
 * Ground truth'ta hata satırı olan bloklar indekse alınmaz.
 */
export async function buildExampleIndexFromSamples(options: BuildExamplesOptions = {}): Promise<ExampleIndex> {
  const samplesDir = resolve(options.samplesDir ?? DEFAULT_SAMPLES_DIR)
  const sources = JSON.parse(await readFile(join(samplesDir, 'SOURCES.json'), 'utf8')) as Sources
  const gtVersion = await groundTruthVersion(samplesDir, options.groundTruthVersion)
  const failures = new Map<string, { errors: number[]; warnings: number }>()
  if (gtVersion) {
    const truth = JSON.parse(await readFile(join(samplesDir, 'ground-truth', `${gtVersion}.json`), 'utf8')) as { files: GroundTruthFile[] }
    for (const file of truth.files) {
      failures.set(file.path, {
        errors: file.diagnostics.filter((item) => item.severity === 'error').map((item) => item.line),
        warnings: file.diagnostics.filter((item) => item.severity === 'warning').length
      })
    }
  }

  const inputs: ExampleInputFile[] = []
  for (const entry of sources.files) {
    let text: string
    try {
      text = await readFile(join(samplesDir, entry.path), 'utf8')
    } catch (error) {
      throw new Error(`Cannot read corpus file ${entry.path}: ${(error as Error).message}`)
    }
    const failure = failures.get(entry.path)
    inputs.push({
      path: entry.path,
      text,
      license: entry.license,
      source: entry.source,
      sourceUrl: sources.repositories[entry.source]?.url ?? `https://github.com/${entry.source}`,
      sourcePath: entry.sourcePath,
      addons: entry.addons ?? [],
      errorLines: failure?.errors ?? [],
      warnings: failure?.warnings ?? 0,
      ...(failure && gtVersion ? { groundTruth: gtVersion } : {})
    })
  }
  return buildExampleIndex(inputs, { maxLines: options.maxLines, generatedAt: options.generatedAt })
}
