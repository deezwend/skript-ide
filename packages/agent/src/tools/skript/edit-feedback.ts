import { realpath } from 'node:fs/promises'
import type { AgentLanguageService, ToolContext, ToolDiagnostic, ToolRange } from '../../tool'
import { displayPath } from '../core/paths'
import { formatDiagnostic } from './get-diagnostics'
import { fileUri, isScript, syncWorkspace } from './shared'

/**
 * Düzenlenen `.sk` dosyalarının düzenlemenin getirdiği yeni sorunlarını tool sonucuna ekler.
 * Böylece model her düzenlemeden sonra ayrıca `get_diagnostics` çağırmak zorunda kalmaz.
 * Düzenlemeler zaten diske yazıldığı için burada hiçbir hata fırlatılmaz: geri bildirim alınamazsa
 * boş string döner ve tool sonucu normal görünür.
 */

export interface ScriptChange {
  /** Kullanıcıya gösterilecek yol (proje köküne göre). */
  path: string
  /** Dosyanın mutlak yolu. */
  file: string
  before: string
  after: string
}

const MAX_LINES = 20
const MAX_FIX_HINTS = 8

export async function scriptFeedback(ctx: ToolContext, changes: readonly ScriptChange[]): Promise<string> {
  const service = ctx.languageService
  if (!service || !ctx.projectRoot) return ''
  const scripts = changes.filter((change) => isScript(change.path) || isScript(change.file))
  if (scripts.length === 0) return ''

  try {
    // Önce çalışma alanı diskten okunur: düzenleme yazıldığı için "sonrası" hâli görülür ve
    // başka dosyalardaki fonksiyonlar/değişkenler de bilinir.
    const root = await realpath(ctx.projectRoot)
    await syncWorkspace(service, root)
    const blocks: string[] = []
    for (const change of scripts) {
      if (ctx.signal.aborted) break
      try {
        blocks.push(await fileFeedback(service, root, change))
      } catch {
        // Tek dosyanın geri bildirimi alınamazsa diğer dosyalarınki yine gösterilir
      }
    }
    return blocks.filter(Boolean).join('')
  } catch {
    return ''
  }
}

interface Counts {
  errors: number
  warnings: number
}

async function fileFeedback(
  service: AgentLanguageService,
  root: string,
  change: ScriptChange
): Promise<string> {
  const uri = fileUri(change.file)
  const shown = displayPath(root, change.file) || change.path
  const beforeDiagnostics = await service.getDiagnosticsForText(uri, change.before)
  const afterDiagnostics = await service.getDiagnosticsForText(uri, change.after)
  const beforeLines = splitLines(change.before)
  const afterLines = splitLines(change.after)

  // Önceki tanılar (severity + kod + mesaj + satır metni) çokluklarıyla sayılır; satır numarası kayabilir
  const previous = new Map<string, { severity: number; count: number }>()
  for (const diagnostic of beforeDiagnostics) {
    const severity = diagnostic.severity ?? 1
    if (severity !== 1 && severity !== 2) continue
    const key = diagnosticKey(diagnostic, beforeLines)
    const entry = previous.get(key)
    if (entry) entry.count += 1
    else previous.set(key, { severity, count: 1 })
  }

  const fresh: ToolDiagnostic[] = []
  const existing: Counts = { errors: 0, warnings: 0 }
  for (const diagnostic of afterDiagnostics) {
    const severity = diagnostic.severity ?? 1
    if (severity !== 1 && severity !== 2) continue
    if (severity === 1) existing.errors += 1
    else existing.warnings += 1
    const key = diagnosticKey(diagnostic, afterLines)
    const entry = previous.get(key)
    if (entry && entry.count > 0) {
      entry.count -= 1
      continue
    }
    fresh.push(diagnostic)
  }

  const fixed: Counts = { errors: 0, warnings: 0 }
  for (const entry of previous.values()) {
    if (entry.count <= 0) continue
    if (entry.severity === 1) fixed.errors += entry.count
    else fixed.warnings += entry.count
  }

  return render(service, uri, shown, fresh, existing, fixed)
}

async function render(
  service: AgentLanguageService,
  uri: string,
  shown: string,
  fresh: readonly ToolDiagnostic[],
  existing: Counts,
  fixed: Counts
): Promise<string> {
  if (fresh.length === 0) {
    const fixedText =
      fixed.errors + fixed.warnings > 0
        ? `${[
            fixed.errors > 0 ? `${fixed.errors} ${plural(fixed.errors, 'error')}` : '',
            fixed.warnings > 0 ? `${fixed.warnings} ${plural(fixed.warnings, 'warning')}` : ''
          ]
            .filter(Boolean)
            .join(', ')} fixed`
        : ''
    const remaining = existing.errors + existing.warnings
    const counts =
      remaining === 0
        ? fixedText || '0 errors, 0 warnings'
        : `${existing.errors} existing ${plural(existing.errors, 'error')}${
            existing.warnings > 0 ? `, ${existing.warnings} existing ${plural(existing.warnings, 'warning')}` : ''
          } remain`
    return `\nNo new problems in ${shown} (${counts}).`
  }

  const errors = fresh.filter((diagnostic) => (diagnostic.severity ?? 1) === 1).length
  const warnings = fresh.length - errors
  const fixedText =
    fixed.errors + fixed.warnings > 0
      ? ` (${[
          fixed.errors > 0 ? `${fixed.errors} ${plural(fixed.errors, 'error')}` : '',
          fixed.warnings > 0 ? `${fixed.warnings} ${plural(fixed.warnings, 'warning')}` : ''
        ]
          .filter(Boolean)
          .join(', ')} fixed)`
      : ''
  const header = `\nDiagnostics for ${shown}: ${errors} new ${plural(errors, 'error')}, ${warnings} new ${plural(warnings, 'warning')}${fixedText}.`

  const lines: string[] = []
  for (const [index, diagnostic] of fresh.slice(0, MAX_LINES).entries()) {
    const fix = index < MAX_FIX_HINTS ? await fixHint(service, uri, diagnostic.range) : ''
    lines.push(`${formatDiagnostic(shown, diagnostic)}${fix}`)
  }
  if (fresh.length > MAX_LINES) lines.push(`(… ${fresh.length - MAX_LINES} more)`)
  return [header, ...lines].join('\n')
}

/** Tanının bulunduğu satır için dil sunucusunun sunduğu ilk hızlı düzeltme. */
async function fixHint(
  service: AgentLanguageService,
  uri: string,
  range: ToolRange
): Promise<string> {
  if (typeof service.getCodeActions !== 'function') return ''
  try {
    const actions = await service.getCodeActions(uri, range)
    const title = actions[0]?.title
    return title ? ` (fix: ${title})` : ''
  } catch {
    return ''
  }
}

function diagnosticKey(diagnostic: ToolDiagnostic, lines: readonly string[]): string {
  const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value
  const line = lines[diagnostic.range.start.line]?.trim() ?? ''
  return `${diagnostic.severity ?? 1}|${diagnostic.code ?? ''}|${message.replace(/\s+/g, ' ').trim()}|${line}`
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}
