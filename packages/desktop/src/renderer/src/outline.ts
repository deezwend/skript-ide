import { SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import type { LspDocumentSymbol, LspRange } from './lsp/client'
import type { DocumentManager } from './documents'
import { monaco } from './monaco'

import { l } from '@skript-ide/i18n'
interface FlatSymbol {
  symbol: LspDocumentSymbol
  depth: number
}

const SYMBOL_ICONS: Record<number, { glyph: string; label: string }> = {
  1: { glyph: '▤', label: l('Dosya', 'File') },
  2: { glyph: '▦', label: l('Modül', 'Module') },
  3: { glyph: '▦', label: l('Ad alanı', 'Namespace') },
  4: { glyph: '▦', label: l('Paket', 'Package') },
  5: { glyph: '◇', label: l('Sınıf', 'Class') },
  6: { glyph: 'ƒ', label: l('Metot', 'Method') },
  7: { glyph: '▪', label: l('Özellik', 'Property') },
  8: { glyph: '▪', label: l('Alan', 'Field') },
  9: { glyph: 'ƒ', label: l('Kurucu', 'Constructor') },
  10: { glyph: '◇', label: l('Sayım', 'Enum') },
  11: { glyph: '◇', label: l('Arayüz', 'Interface') },
  12: { glyph: 'ƒ', label: l('Fonksiyon', 'Function') },
  13: { glyph: '◇', label: l('Değişken', 'Variable') },
  14: { glyph: '#', label: l('Sabit', 'Constant') },
  15: { glyph: '"', label: l('Metin', 'String') },
  16: { glyph: '#', label: l('Sayı', 'Number') },
  17: { glyph: '?', label: l('Mantıksal', 'Boolean') },
  18: { glyph: '[ ]', label: l('Dizi', 'Array') },
  19: { glyph: '{ }', label: l('Nesne', 'Object') },
  20: { glyph: '⌘', label: l('Anahtar', 'Key') },
  21: { glyph: '∅', label: l('Boş', 'Null') },
  22: { glyph: '◆', label: l('Sayım üyesi', 'Enum member') },
  23: { glyph: '▦', label: l('Yapı', 'Struct') },
  24: { glyph: '⚡', label: l('Olay', 'Event') },
  25: { glyph: '⊕', label: l('Operatör', 'Operator') },
  26: { glyph: '◇', label: l('Tür parametresi', 'Type parameter') }
}

/**
 * Kenar çubuğundaki ANAHAT görünümü: etkin belgenin `textDocument/documentSymbol` ağacı.
 * Yazarken debounce ile yenilenir; imlecin içinde bulunduğu sembol vurgulanır.
 */
export class OutlinePanel {
  private flat: FlatSymbol[] = []
  private rows: { row: HTMLElement; symbol: LspDocumentSymbol }[] = []
  private contentListener: monaco.IDisposable | null = null
  private timer: number | undefined
  private token = 0
  private current: LspDocumentSymbol | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly docs: DocumentManager,
    private readonly requestSymbols: (uri: string) => Promise<LspDocumentSymbol[] | null>
  ) {
    this.editor.onDidChangeModel(() => this.bindModel())
    this.editor.onDidChangeCursorPosition((event) => this.highlight(event.position))
    this.bindModel()
  }

  /** Sekme görünür olduğunda çağrılır. */
  refresh(): void {
    this.schedule(0)
  }

  private bindModel(): void {
    this.contentListener?.dispose()
    this.contentListener = null
    const model = this.editor.getModel()
    if (model) this.contentListener = model.onDidChangeContent(() => this.schedule())
    this.schedule(0)
  }

  private schedule(delay = 250): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.update(), delay)
  }

  private async update(): Promise<void> {
    const token = ++this.token
    const doc = this.docs.active
    if (!doc) {
      this.showMessage(l('Etkin bir belge yok.', 'No active document.'))
      return
    }
    if (doc.model.getLanguageId() !== SKRIPT_LANGUAGE_ID) {
      this.showMessage(l('Anahat yalnızca Skript dosyaları için kullanılabilir.', 'The outline is only available for Skript files.'))
      return
    }
    if (this.flat.length === 0) this.showMessage(l('Anahat yükleniyor…', 'Loading outline…'))

    let symbols: LspDocumentSymbol[] | null
    try {
      symbols = await this.requestSymbols(doc.model.uri.toString(true).toLowerCase())
    } catch (error) {
      if (token !== this.token) return
      this.showMessage(l(`Anahat alınamadı: ${(error as Error).message}`, `Could not get outline: ${(error as Error).message}`))
      return
    }
    if (token !== this.token) return
    if (symbols === null) {
      this.showMessage(l('Dil sunucusu hazır olduğunda anahat burada görünecek.', 'The outline will appear here when the language server is ready.'))
      return
    }
    if (symbols.length === 0) {
      this.showMessage(l('Bu belgede sembol bulunamadı.', 'No symbols found in this document.'))
      return
    }
    this.render(symbols)
  }

  private showMessage(message: string): void {
    this.flat = []
    this.rows = []
    this.current = null
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = message
    this.container.replaceChildren(empty)
  }

  private render(symbols: LspDocumentSymbol[]): void {
    this.flat = []
    flatten(symbols, 0, this.flat)
    this.rows = []

    const list = document.createElement('div')
    list.className = 'outline-list'
    for (const entry of this.flat) {
      const icon = SYMBOL_ICONS[entry.symbol.kind] ?? { glyph: '▸', label: l('Sembol', 'Symbol') }
      const row = document.createElement('div')
      row.className = 'outline-row'
      row.setAttribute('role', 'treeitem')
      row.tabIndex = 0
      row.style.paddingLeft = `${8 + entry.depth * 12}px`
      row.title = entry.symbol.detail
        ? `${icon.label}: ${entry.symbol.name}\n${entry.symbol.detail}`
        : `${icon.label}: ${entry.symbol.name}`

      const glyph = document.createElement('span')
      glyph.className = 'outline-icon'
      glyph.textContent = icon.glyph
      glyph.setAttribute('aria-label', icon.label)

      const name = document.createElement('span')
      name.className = 'outline-name'
      name.textContent = entry.symbol.name

      row.append(glyph, name)
      if (entry.symbol.detail) {
        const detail = document.createElement('span')
        detail.className = 'outline-detail'
        detail.textContent = entry.symbol.detail
        row.append(detail)
      }

      row.addEventListener('click', () => this.reveal(entry.symbol))
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.reveal(entry.symbol)
        }
      })
      list.append(row)
      this.rows.push({ row, symbol: entry.symbol })
    }

    this.container.replaceChildren(list)
    this.current = null
    this.highlight(this.editor.getPosition())
  }

  private reveal(symbol: LspDocumentSymbol): void {
    const { start, end } = symbol.selectionRange
    this.editor.setPosition({ lineNumber: start.line + 1, column: start.character + 1 })
    this.editor.revealRangeInCenter({
      startLineNumber: start.line + 1,
      startColumn: start.character + 1,
      endLineNumber: end.line + 1,
      endColumn: end.character + 1
    })
    this.editor.focus()
    this.highlight(this.editor.getPosition())
  }

  private highlight(position: monaco.Position | null): void {
    if (!position) return
    const line = position.lineNumber - 1
    const character = position.column - 1

    let current: LspDocumentSymbol | null = null
    let depth = -1
    for (const entry of this.flat) {
      if (!contains(entry.symbol.range, line, character)) continue
      if (entry.depth >= depth) {
        current = entry.symbol
        depth = entry.depth
      }
    }

    for (const { row, symbol } of this.rows) row.classList.toggle('current', symbol === current)
    if (current !== this.current) {
      this.current = current
      const index = current ? this.flat.findIndex((entry) => entry.symbol === current) : -1
      if (index >= 0) this.rows[index]?.row.scrollIntoView({ block: 'nearest' })
    }
  }
}

function flatten(symbols: LspDocumentSymbol[], depth: number, out: FlatSymbol[]): void {
  for (const symbol of symbols) {
    out.push({ symbol, depth })
    if (symbol.children) flatten(symbol.children, depth + 1, out)
  }
}

function contains(range: LspRange, line: number, character: number): boolean {
  const afterStart = line > range.start.line || (line === range.start.line && character >= range.start.character)
  const beforeEnd = line < range.end.line || (line === range.end.line && character <= range.end.character)
  return afterStart && beforeEnd
}
