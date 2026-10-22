import { SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import type { ProblemReport, SkriptDiagnostic, ValidationResult } from '../../shared/ipc'
import type { DocumentManager } from './documents'
import { monaco } from './monaco'
import { basename } from './paths'

import { l } from '@skript-ide/i18n'
/** Sunucu doğrulama sonuçlarının marker sahibi (Faz 2). */
const SERVER_MARKER_OWNER = 'skript-server'
/** Monaco LSP istemcisinin publishDiagnostics için kullandığı marker sahibi. */
const LSP_MARKER_OWNER = 'lsp'

type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint'
type ProblemOrigin = 'static' | 'server'

interface ProblemEntry {
  origin: ProblemOrigin
  source: string
  line: number
  column: number
  severity: ProblemSeverity
  message: string
  code?: string
}

interface SourceProblems {
  source: string
  diagnostics: SkriptDiagnostic[]
}

/**
 * PROBLEMLER sekmesi. Yalnızca sekmelerde açık dosyalar için iki kaynağı birlikte gösterir:
 * - "statik": dil sunucusunun canlı tanıları (Monaco marker sahibi `lsp`)
 * - "sunucu": Paper/Skript doğrulama sonuçları (marker sahibi `skript-server`)
 */
export class ProblemsPanel {
  private readonly results = new Map<string, SourceProblems>()
  private validatedOnce = false

  constructor(
    private readonly container: HTMLElement,
    private readonly badge: HTMLElement,
    private readonly docs: DocumentManager,
    private readonly onReveal: (source: string, line: number, column: number) => void
  ) {
    monaco.editor.onDidChangeMarkers(() => this.render())
    this.render()
  }

  get counts(): { errors: number; warnings: number; infos: number; hints: number } {
    const counts = { errors: 0, warnings: 0, infos: 0, hints: 0 }
    for (const entry of this.entries()) {
      if (entry.severity === 'error') counts.errors++
      else if (entry.severity === 'warning') counts.warnings++
      else if (entry.severity === 'info') counts.infos++
      else counts.hints++
    }
    return counts
  }

  /** Sekmedeki sorunlar, dosya ve satır sırasıyla; adsız belgeler başlıklarıyla. Agent'ın `@Problems` etiketi için. */
  report(): ProblemReport[] {
    return this.entries()
      .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.column - b.column)
      .map((entry) => ({
        path: entry.source.startsWith('untitled:') ? this.title(entry.source) : entry.source,
        line: entry.line,
        column: entry.column,
        severity: entry.severity,
        origin: entry.origin,
        message: entry.message,
        ...(entry.code ? { code: entry.code } : {})
      }))
  }

  setResult(result: ValidationResult): void {
    this.validatedOnce = true
    if (result.diagnostics.length) {
      this.results.set(result.source, { source: result.source, diagnostics: sortByLine(result.diagnostics) })
    } else {
      this.results.delete(result.source)
    }
    this.sync()
  }

  /** Skript sürümü değişince eski sunucu sonuçları geçersiz olur. */
  clear(): void {
    this.results.clear()
    this.validatedOnce = false
    this.sync()
  }

  /** Farklı kaydetmeden sonra eski kaynağın sonuçları yeni kaynağa taşınır. */
  renameSource(previous: string, next: string): void {
    if (previous === next) return
    const problems = this.results.get(previous)
    if (!problems) return
    this.results.delete(previous)
    this.results.set(next, { source: next, diagnostics: problems.diagnostics })
    this.sync()
  }

  /** Belgeler değişince (açma, kapama, farklı kaydetme) çağrılır. */
  sync(): void {
    // Kapatılan adsız belgelerin sunucu sorunlarını açacak bir dosya yok
    for (const source of this.results.keys()) {
      if (source.startsWith('untitled:') && !this.docs.findBySource(source)) this.results.delete(source)
    }
    for (const doc of this.docs.documents) {
      const problems = this.results.get(this.docs.sourceId(doc))
      monaco.editor.setModelMarkers(
        doc.model,
        SERVER_MARKER_OWNER,
        problems ? toMarkers(doc.model, problems.diagnostics) : []
      )
    }
    this.render()
  }

  private staticEntries(): ProblemEntry[] {
    const entries: ProblemEntry[] = []
    for (const doc of this.docs.documents) {
      if (doc.model.getLanguageId() !== SKRIPT_LANGUAGE_ID) continue
      const source = this.docs.sourceId(doc)
      for (const marker of monaco.editor.getModelMarkers({ owner: LSP_MARKER_OWNER, resource: doc.model.uri })) {
        entries.push({
          origin: 'static',
          source,
          line: marker.startLineNumber,
          column: marker.startColumn,
          severity: markerSeverity(marker.severity),
          message: marker.message,
          code: typeof marker.code === 'string' ? marker.code : marker.code?.value
        })
      }
    }
    return entries
  }

  private serverEntries(): ProblemEntry[] {
    const entries: ProblemEntry[] = []
    for (const { source, diagnostics } of this.results.values()) {
      // Yalnızca sekmelerde açık olan dosyaların sorunları gösterilir
      if (!this.docs.findBySource(source)) continue
      for (const diagnostic of diagnostics) {
        entries.push({
          origin: 'server',
          source,
          line: diagnostic.line,
          column: 0,
          severity: diagnostic.severity,
          message: diagnostic.message,
          code: diagnostic.code
        })
      }
    }
    return entries
  }

  private entries(): ProblemEntry[] {
    return [...this.staticEntries(), ...this.serverEntries()]
  }

  private title(source: string): string {
    const doc = this.docs.findBySource(source)
    return doc ? this.docs.title(doc) : basename(source)
  }

  private render(): void {
    const entries = this.entries()
    this.badge.hidden = entries.length === 0
    this.badge.textContent = String(entries.length)

    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'panel-empty'
      const hasSkriptDocument = this.docs.documents.some(
        (doc) => doc.model.getLanguageId() === SKRIPT_LANGUAGE_ID
      )
      empty.textContent = this.validatedOnce || hasSkriptDocument
        ? l(
            'Sorun bulunamadı. Statik analiz yazarken, sunucu doğrulaması da her değişiklikte otomatik çalışır (F5 ile elle de).',
            'No problems found. Static analysis runs as you type; server validation also runs automatically on every change (or manually with F5).'
          )
        : l(
            'Henüz doğrulama yapılmadı. Statik analiz yazarken, sunucu doğrulaması da her değişiklikte otomatik çalışır (F5 ile elle de).',
            'Nothing validated yet. Static analysis runs as you type; server validation also runs automatically on every change (or manually with F5).'
          )
      this.container.replaceChildren(empty)
      return
    }

    const groups = new Map<string, ProblemEntry[]>()
    for (const doc of this.docs.documents) groups.set(this.docs.sourceId(doc), [])
    for (const entry of entries) groups.get(entry.source)?.push(entry)

    const list = document.createElement('div')
    list.className = 'problem-list'
    list.setAttribute('role', 'tree')
    for (const [source, group] of groups) {
      if (group.length === 0) continue
      group.sort((a, b) => a.line - b.line || a.column - b.column || (a.origin === b.origin ? 0 : a.origin === 'static' ? -1 : 1))

      const header = document.createElement('div')
      header.className = 'problem-file'
      header.title = source.startsWith('untitled:') ? this.title(source) : source
      const name = document.createElement('span')
      name.textContent = this.title(source)
      const count = document.createElement('span')
      count.className = 'problem-file-count'
      count.textContent = String(group.length)
      header.append(name, count)
      list.append(header)

      for (const entry of group) list.append(this.row(entry))
    }
    this.container.replaceChildren(list)
  }

  private row(entry: ProblemEntry): HTMLElement {
    const row = document.createElement('div')
    row.className = `problem-row ${entry.severity}`
    row.setAttribute('role', 'treeitem')
    row.tabIndex = 0
    row.title = entry.code ? l(`${entry.message}\n\n${entry.code}\nKaynak: ${originLabel(entry.origin)}`, `${entry.message}\n\n${entry.code}\nSource: ${originLabel(entry.origin)}`) : entry.message

    const icon = document.createElement('span')
    icon.className = 'problem-icon'
    icon.textContent = severityIcon(entry.severity)
    icon.setAttribute('aria-label', severityLabel(entry.severity))

    const origin = document.createElement('span')
    origin.className = `problem-origin ${entry.origin}`
    origin.textContent = originLabel(entry.origin)
    origin.title =
      entry.origin === 'static'
        ? l('Dil sunucusunun statik analizi', 'Static analysis by the language server')
        : l('Paper + Skript doğrulaması', 'Paper + Skript validation')

    const message = document.createElement('span')
    message.className = 'problem-message'
    message.textContent = entry.message

    const location = document.createElement('span')
    location.className = 'problem-location'
    location.textContent = l(`[Satır ${entry.line}]`, `[Ln ${entry.line}]`)

    row.append(icon, origin, message, location)
    const reveal = () => this.onReveal(entry.source, entry.line, entry.column)
    row.addEventListener('click', reveal)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') reveal()
    })
    return row
  }
}

function originLabel(origin: ProblemOrigin): string {
  return origin === 'static' ? l('statik', 'static') : l('sunucu', 'server')
}

function severityIcon(severity: ProblemSeverity): string {
  if (severity === 'error') return '⊗'
  if (severity === 'warning') return '⚠'
  if (severity === 'info') return 'ℹ'
  return '✧'
}

function severityLabel(severity: ProblemSeverity): string {
  if (severity === 'error') return l('Hata', 'Error')
  if (severity === 'warning') return l('Uyarı', 'Warning')
  if (severity === 'info') return l('Bilgi', 'Info')
  return l('İpucu', 'Hint')
}

function markerSeverity(severity: monaco.MarkerSeverity): ProblemSeverity {
  if (severity === monaco.MarkerSeverity.Error) return 'error'
  if (severity === monaco.MarkerSeverity.Warning) return 'warning'
  if (severity === monaco.MarkerSeverity.Info) return 'info'
  return 'hint'
}

function sortByLine(diagnostics: SkriptDiagnostic[]): SkriptDiagnostic[] {
  return [...diagnostics].sort((a, b) => a.line - b.line)
}

function toMarkers(model: monaco.editor.ITextModel, diagnostics: SkriptDiagnostic[]): monaco.editor.IMarkerData[] {
  const lineCount = model.getLineCount()
  return diagnostics.map((d) => {
    const line = Math.min(Math.max(d.line, 1), lineCount)
    return {
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: d.message,
      source: 'Skript',
      startLineNumber: line,
      // Girintiyi değil, satırın kendisini çiz
      startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line)
    }
  })
}
