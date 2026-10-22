import type { MigrationItem, MigrationReport } from './lsp/client'

import { l } from '@skript-ide/i18n'
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const STATUS_TITLES: Record<MigrationItem['status'], string> = {
  removed: l('Hedef sürümde yok', 'Missing in target version'),
  changed: l('Kalıbı değişmiş', 'Pattern changed'),
  new: l('Hedef sürümde yeni', 'New in target version')
}

/** Gerçek sunucuda doğrulamanın dosya başına sonucu. */
export interface MigrationValidation {
  file: string
  ok: boolean
  errors: number
  warnings: number
  messages: string[]
}

export interface MigrationViewHost {
  versions: () => string[]
  currentVersion: () => string
  requestReport: (from: string, to: string) => Promise<MigrationReport>
  /** Raporun satırını editörde gösterir. */
  reveal: (item: MigrationItem) => Promise<void>
  /** Düzeltmeleri belgelere uygular; uygulanan düzeltme sayısını döndürür. */
  applyFixes: (items: MigrationItem[]) => Promise<number>
  /** Projenin `.sk` dosyalarını hedef sürümün gerçek sunucusunda doğrular. */
  validateOnServer: (version: string) => Promise<MigrationValidation[]>
  switchVersion: (version: string) => Promise<void>
  fileLabel: (uri: string) => string
}

/**
 * Sürüm Geçiş Asistanı. Projede kullanılan syntax'ları iki sürümün verisine göre karşılaştırır,
 * kaldırılan / değişen / yeni kullanımları listeler, doğrulanmış düzeltmeleri uygular ve
 * isterse betikleri hedef sürümün gerçek sunucusunda dener.
 */
export class MigrationView {
  private report: MigrationReport | null = null
  private readonly from = el('select')
  private readonly to = el('select')
  private readonly body = el('div', 'migration-body')
  private readonly summary = el('div', 'migration-summary')
  private readonly fixAll = el('button', undefined, l('Tüm düzeltmeleri uygula', 'Apply all fixes'))
  private readonly verify = el('button', undefined, l('Gerçek sunucuda doğrula', 'Validate on real server'))
  private readonly switchButton = el('button', undefined, l('Hedef sürüme geç', 'Switch to target version'))
  private busy = false

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly host: MigrationViewHost
  ) {
    const run = el('button', 'primary', l('Raporla', 'Report'))
    run.type = 'button'
    run.addEventListener('click', () => void this.guard(() => this.load()))
    for (const button of [this.fixAll, this.verify, this.switchButton]) button.type = 'button'
    this.fixAll.addEventListener('click', () => void this.guard(() => this.applyAll()))
    this.verify.addEventListener('click', () => void this.guard(() => this.validate()))
    this.switchButton.addEventListener('click', () =>
      void this.guard(async () => {
        await this.host.switchVersion(this.to.value)
        this.dialog.close()
      })
    )

    const pickers = el('div', 'migration-pickers')
    pickers.append(
      el('label', undefined, l('Kaynak', 'Source')),
      this.from,
      el('span', undefined, '→'),
      el('label', undefined, l('Hedef', 'Target')),
      this.to,
      run
    )

    const close = el('button', undefined, l('Kapat', 'Close'))
    close.type = 'button'
    close.addEventListener('click', () => this.dialog.close())
    const actions = el('div', 'dialog-actions')
    actions.append(this.fixAll, this.verify, this.switchButton, close)

    dialog.replaceChildren(el('h2', undefined, l('Sürüm Geçiş Asistanı', 'Version Migration Assistant')), pickers, this.summary, this.body, actions)
    this.renderActions()
  }

  open(): void {
    const versions = this.host.versions()
    const current = this.host.currentVersion()
    const fill = (select: HTMLSelectElement, value: string) => {
      select.replaceChildren(...versions.map((version) => new Option(`Skript ${version}`, version)))
      select.value = value
    }
    // Varsayılan hedef: mevcut sürümden farklı en yeni sürüm
    fill(this.from, current)
    fill(this.to, versions.find((version) => version !== current) ?? current)
    if (!this.dialog.open) this.dialog.showModal()
    if (!this.report || this.report.from !== this.from.value || this.report.to !== this.to.value) {
      this.report = null
      this.summary.textContent = l('Kaynak ve hedef sürümü seçip "Raporla"ya bas.', 'Pick the source and target versions, then press "Report".')
      this.body.replaceChildren()
      this.renderActions()
    } else this.render()
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.renderActions()
    try {
      await action()
    } catch (error) {
      this.summary.textContent = l(`Hata: ${(error as Error).message}`, `Error: ${(error as Error).message}`)
      this.summary.dataset.kind = 'error'
    } finally {
      this.busy = false
      this.renderActions()
    }
  }

  private async load(): Promise<void> {
    if (this.from.value === this.to.value) {
      this.summary.textContent = l('Kaynak ve hedef sürüm aynı.', 'Source and target versions are the same.')
      return
    }
    this.summary.textContent = l('Proje dosyaları taranıyor…', 'Scanning project files…')
    delete this.summary.dataset.kind
    this.body.replaceChildren()
    this.report = await this.host.requestReport(this.from.value, this.to.value)
    this.render()
  }

  private fixable(): MigrationItem[] {
    return this.report?.items.filter((item) => item.fix) ?? []
  }

  private renderActions(): void {
    const ready = Boolean(this.report) && !this.busy
    this.fixAll.disabled = !ready || this.fixable().length === 0
    this.verify.disabled = !ready
    this.switchButton.disabled = !ready || this.to.value === this.host.currentVersion()
    this.dialog.classList.toggle('busy', this.busy)
  }

  private render(): void {
    const report = this.report
    if (!report) return
    delete this.summary.dataset.kind
    this.summary.textContent =
      l(
        `Skript ${report.from} → ${report.to}: ${report.files} dosya, ${report.checkedLines} satır. ` +
          `Kaldırılan ${report.counts.removed}, değişen ${report.counts.changed}, yeni ${report.counts.new}.`,
        `Skript ${report.from} → ${report.to}: ${report.files} files, ${report.checkedLines} lines. ` +
          `Removed ${report.counts.removed}, changed ${report.counts.changed}, new ${report.counts.new}.`
      )
    if (report.items.length === 0) {
      this.body.replaceChildren(el('p', 'migration-empty', l('Bu geçişten etkilenen kullanım yok.', 'No usages are affected by this migration.')))
      return
    }
    const groups: HTMLElement[] = []
    for (const status of ['removed', 'changed', 'new'] as const) {
      const items = report.items.filter((item) => item.status === status)
      if (items.length === 0) continue
      const group = el('section', `migration-group ${status}`)
      group.append(el('h3', undefined, `${STATUS_TITLES[status]} (${items.length})`))
      for (const item of items) group.append(this.renderItem(item))
      groups.push(group)
    }
    this.body.replaceChildren(...groups)
  }

  private renderItem(item: MigrationItem): HTMLElement {
    const row = el('div', 'migration-item')
    const location = el('button', 'migration-location', `${this.host.fileLabel(item.uri)}:${item.line + 1}`)
    location.type = 'button'
    location.title = l('Editörde göster', 'Show in editor')
    location.addEventListener('click', () => {
      this.dialog.close()
      void this.host.reveal(item)
    })
    row.append(location, el('code', 'migration-text', item.text.trim()), el('div', 'migration-message', item.message))
    if (item.target?.patterns.length) {
      const patterns = el('div', 'migration-patterns')
      patterns.append(el('span', undefined, l('Hedef kalıp: ', 'Target pattern: ')), el('code', undefined, item.target.patterns.slice(0, 3).join('  |  ')))
      row.append(patterns)
    }
    if (item.fix) {
      const fix = el('button', 'migration-fix', l(`Düzelt: ${item.fix.title}`, `Fix: ${item.fix.title}`))
      fix.type = 'button'
      fix.title = item.fix.newText.trim()
      fix.addEventListener('click', () =>
        void this.guard(async () => {
          if ((await this.host.applyFixes([item])) > 0) this.removeItem(item)
        })
      )
      row.append(fix)
    }
    return row
  }

  private removeItem(item: MigrationItem): void {
    if (!this.report) return
    this.report.items = this.report.items.filter((candidate) => candidate !== item)
    this.report.counts[item.status]--
    this.render()
  }

  private async applyAll(): Promise<void> {
    const items = this.fixable()
    const applied = await this.host.applyFixes(items)
    // Satırlar değişti; raporu yeni içerikle baştan üret
    await this.load()
    this.summary.textContent = l(`${applied} düzeltme uygulandı. `, `${applied} fixes applied. `) + this.summary.textContent
  }

  private async validate(): Promise<void> {
    if (!this.report) return
    this.summary.textContent = l(`Skript ${this.to.value} sunucusu hazırlanıyor ve betikler deneniyor… (ilk seferde birkaç dakika sürebilir)`, `Preparing the Skript ${this.to.value} server and testing scripts… (this can take a few minutes the first time)`)
    const results = await this.host.validateOnServer(this.to.value)
    const failed = results.filter((result) => !result.ok).length
    this.summary.textContent = l(`Skript ${this.to.value} gerçek sunucusunda ${results.length} dosya denendi: ${results.length - failed} sorunsuz, ${failed} hatalı.`, `Tested ${results.length} files on a real Skript ${this.to.value} server: ${results.length - failed} passed, ${failed} failed.`)
    this.summary.dataset.kind = failed ? 'error' : 'ok'
    const section = el('section', 'migration-group validation')
    section.append(el('h3', undefined, l('Gerçek sunucu sonucu', 'Real server result')))
    for (const result of results) {
      const row = el('div', `migration-item ${result.ok ? 'ok' : 'failed'}`)
      row.append(
        el('span', 'migration-location', `${result.ok ? '✓' : '✕'} ${result.file}`),
        el('div', 'migration-message', l(`${result.errors} hata, ${result.warnings} uyarı`, `${result.errors} errors, ${result.warnings} warnings`))
      )
      for (const message of result.messages.slice(0, 5)) row.append(el('code', 'migration-text', message))
      section.append(row)
    }
    this.body.prepend(section)
  }
}
