/** Build-time üretilen örnek indeksi: `tools/build-examples.ts` yazar, agent'ın `search_examples` tool'u okur. */

export interface ExampleChunk {
  /** Corpus köküne göre `/` ayraçlı yol. */
  path: string
  /** Bloğun ilk satırı (kırpılmış). */
  title: string
  /** 1 tabanlı satır aralığı. */
  start: number
  end: number
  text: string
  /** Blok `maxLines` satırdan uzun; `text` kırpıldı. */
  truncated?: boolean
}

export interface ExampleFileInfo {
  license: string
  /** GitHub deposu, `sahip/ad` biçiminde. */
  source: string
  sourceUrl: string
  sourcePath: string
  addons: string[]
  lines: number
  /** Ground truth'taki hata sayısı; ground truth'ta olmayan (addon) dosyalarda 0. */
  errors: number
  warnings: number
  /** Bu dosyanın doğrulandığı Skript sürümü; addon dosyalarında yok. */
  groundTruth?: string
}

export interface ExampleIndex {
  version: 1
  generatedAt: string
  chunks: ExampleChunk[]
  files: Record<string, ExampleFileInfo>
}

/** Chunk üretimine giren ham dosya; kaynak bilgileri SOURCES.json'dan gelir. */
export interface ExampleInputFile {
  path: string
  text: string
  license: string
  source: string
  sourceUrl: string
  sourcePath: string
  addons: readonly string[]
  /** 1 tabanlı hata satırları; bu satırları içeren bloklar indekse alınmaz. */
  errorLines?: readonly number[]
  warnings?: number
  groundTruth?: string
}

/** Tek bir bloğun en fazla gösterilecek satırı. */
export const DEFAULT_MAX_LINES = 60

const BOM = /^\uFEFF/

/**
 * Bir betiği üst düzey bloklara ayırır: girintisiz, yorum olmayan her satır yeni bir blok başlatır
 * (`on ...:`, `command /...:`, `function ...:`, `options:` vb.). Bloklar 1 tabanlı satır aralığıyla
 * döner; `maxLines`tan uzun olanlar kırpılır. Hata satırı görünen kısımda olan bloklar atlanır.
 */
export function splitTopLevelChunks(
  path: string,
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  errorLines: readonly number[] = []
): ExampleChunk[] {
  const lines = text.replace(BOM, '').split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith('#')) return
    starts.push(index)
  })
  const errors = new Set(errorLines)
  const chunks: ExampleChunk[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    let end = (starts[i + 1] ?? lines.length) - 1
    while (end > start && !lines[end].trim()) end--
    const visibleEnd = Math.min(end + 1, start + maxLines)
    let failed = false
    for (let line = start + 1; line <= visibleEnd; line++) {
      if (errors.has(line)) {
        failed = true
        break
      }
    }
    if (failed) continue
    chunks.push({
      path,
      title: lines[start].trim(),
      start: start + 1,
      end: end + 1,
      text: lines.slice(start, visibleEnd).join('\n'),
      ...(end + 1 > visibleEnd ? { truncated: true } : {})
    })
  }
  return chunks
}

/** Ham dosyalardan kompakt arama indeksi üretir; dosya sırası korunur. */
export function buildExampleIndex(
  files: readonly ExampleInputFile[],
  options: { maxLines?: number; generatedAt?: string } = {}
): ExampleIndex {
  const chunks: ExampleChunk[] = []
  const infos: Record<string, ExampleFileInfo> = {}
  for (const file of files) {
    const errorLines = file.errorLines ?? []
    chunks.push(...splitTopLevelChunks(file.path, file.text, options.maxLines, errorLines))
    infos[file.path] = {
      license: file.license,
      source: file.source,
      sourceUrl: file.sourceUrl,
      sourcePath: file.sourcePath,
      addons: [...file.addons],
      lines: file.text.replace(BOM, '').split('\n').length,
      errors: errorLines.length,
      warnings: file.warnings ?? 0,
      ...(file.groundTruth ? { groundTruth: file.groundTruth } : {})
    }
  }
  return { version: 1, generatedAt: options.generatedAt ?? new Date().toISOString(), chunks, files: infos }
}

export function assertExampleIndex(value: unknown): ExampleIndex {
  const index = value as Partial<ExampleIndex> | null
  if (!index || typeof index !== 'object' || index.version !== 1 || !Array.isArray(index.chunks) || !index.files) {
    throw new Error('Invalid example index.')
  }
  return index as ExampleIndex
}
