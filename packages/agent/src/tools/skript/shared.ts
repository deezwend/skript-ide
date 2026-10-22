import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listProjectFiles } from '../../attachments'
import { ToolError, type AgentLanguageService, type ToolContext } from '../../tool'

/** Dil servisine verilen tek dosyanın en büyük boyutu; daha büyükleri çalışma alanına alınmaz. */
const MAX_SCRIPT_BYTES = 1024 * 1024

export function requireLanguageService(ctx: ToolContext): AgentLanguageService {
  if (!ctx.languageService) throw new ToolError('The Skript language service is not available.')
  return ctx.languageService
}

export function isScript(path: string): boolean {
  return path.toLowerCase().endsWith('.sk')
}

export function fileUri(path: string): string {
  return pathToFileURL(path).href
}

/**
 * Projedeki tüm `.sk` dosyalarını diskten okuyup dil servisine çalışma alanı olarak verir; böylece
 * başka dosyada tanımlı fonksiyonlar ve genel değişkenler de bilinir. Dönen yollar köke göre, `/` ile.
 */
export async function syncWorkspace(service: AgentLanguageService, projectRoot: string): Promise<{ path: string; file: string }[]> {
  const root = await realpath(projectRoot)
  const scripts: { path: string; file: string; text: string }[] = []
  for (const path of (await listProjectFiles(root)).filter(isScript)) {
    const file = resolve(root, path)
    try {
      if ((await stat(file)).size > MAX_SCRIPT_BYTES) continue
      scripts.push({ path, file, text: await readFile(file, 'utf8') })
    } catch {
      // Listelendikten sonra silinmiş olabilir
    }
  }
  service.setWorkspaceFiles(
    scripts.map(({ file, text }) => ({ uri: fileUri(file), text })),
    true
  )
  return scripts.map(({ path, file }) => ({ path, file }))
}
