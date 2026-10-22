/**
 * Değişken analizinin (okunmayan / yazılmayan / yazım hatası / kapsam dışı yerel) corpus üzerindeki çıktısı.
 *
 * Sunucu bu durumlar için hata vermediğinden ground truth yok; araç her uyarıyı satırıyla birlikte
 * `samples/variables-report.json` dosyasına yazar. Yanlış pozitif oranı bu listenin elle incelenmesiyle
 * ölçülür ve README'deki tabloya işlenir (incelenen kayıtlar `review` alanında tutulur).
 *
 * Her depo ayrı bir çalışma alanıdır (`complete: true`): genel değişkenler deponun tüm dosyalarında aranır.
 *
 * Kullanım: npx tsx packages/corpus/tools/measure-variables.ts [--version 2.17.1]
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SkriptLanguageService } from '@skript-ide/language-server'
import { readSyntaxDatabase } from '@skript-ide/syntax-db/node'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const samplesDir = resolve(toolsDir, '..', 'samples')

interface SourceFile {
  path: string
  source: string
}

interface Finding {
  path: string
  line: number
  code: string
  message: string
  text: string
}

function parseVersion(argv: string[]): string {
  const index = argv.indexOf('--version')
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : '2.17.1'
}

async function main(): Promise<void> {
  const version = parseVersion(process.argv.slice(2))
  const sources = JSON.parse(await readFile(join(samplesDir, 'SOURCES.json'), 'utf8')) as { files: SourceFile[] }
  const byRepo = new Map<string, SourceFile[]>()
  for (const file of sources.files) {
    const list = byRepo.get(file.source)
    if (list) list.push(file)
    else byRepo.set(file.source, [file])
  }

  const findings: Finding[] = []
  let files = 0
  let variableUses = 0
  for (const [, repoFiles] of byRepo) {
    const service = new SkriptLanguageService({ loadDatabase: readSyntaxDatabase, skriptVersion: version })
    const texts = new Map<string, string>()
    for (const file of repoFiles) {
      const uri = pathToFileURL(join(samplesDir, file.path)).href
      texts.set(uri, await readFile(join(samplesDir, file.path), 'utf8'))
    }
    service.setWorkspaceFiles([...texts].map(([uri, text]) => ({ uri, text })), true)
    for (const file of repoFiles) {
      const uri = pathToFileURL(join(samplesDir, file.path)).href
      const text = texts.get(uri)!
      const lines = text.split(/\r\n|\n|\r/)
      variableUses += (text.match(/\{(?!@)[^{}]*\}/g) ?? []).length
      files++
      for (const diagnostic of await service.getDiagnostics(uri)) {
        const code = String(diagnostic.code ?? '')
        if (!code.startsWith('variable-')) continue
        findings.push({
          path: file.path,
          line: diagnostic.range.start.line + 1,
          code,
          message: String(diagnostic.message),
          text: (lines[diagnostic.range.start.line] ?? '').trim().slice(0, 160)
        })
      }
    }
  }

  const counts: Record<string, number> = {}
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1
  const reportPath = join(samplesDir, 'variables-report.json')
  let review: unknown = undefined
  try {
    review = (JSON.parse(await readFile(reportPath, 'utf8')) as { review?: unknown }).review
  } catch {
    // ilk çalıştırma
  }
  await writeFile(
    reportPath,
    JSON.stringify({ skriptVersion: version, files, variableUses, counts, review, findings }, null, 2) + '\n',
    'utf8'
  )
  console.log(`${files} dosya, ~${variableUses} değişken kullanımı`)
  for (const [code, count] of Object.entries(counts).sort()) console.log(`  ${code}: ${count}`)
  console.log(`Ayrıntı: ${reportPath}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
