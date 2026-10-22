import {
  hasSyntaxDatabase,
  loadAddonDatabase,
  loadSyntaxDatabase,
  resolveAddonDatabase,
  SYNTAX_KINDS,
  SyntaxIndex,
  type SyntaxEntry,
  type SyntaxKind,
  type SyntaxRef
} from '@skript-ide/syntax-db'
import { SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import { monaco } from './monaco'

import { l } from '@skript-ide/i18n'
const KIND_LABELS: Record<SyntaxKind, { plural: string; singular: string; short: string }> = {
  event: { plural: l('Olaylar', 'Events'), singular: l('Olay', 'Event'), short: l('OL', 'EV') },
  condition: { plural: l('Koşullar', 'Conditions'), singular: l('Koşul', 'Condition'), short: l('KO', 'CO') },
  effect: { plural: l('Efektler', 'Effects'), singular: l('Efekt', 'Effect'), short: 'EF' },
  expression: { plural: l('İfadeler', 'Expressions'), singular: l('İfade', 'Expression'), short: l('İF', 'EX') },
  section: { plural: l('Bölümler', 'Sections'), singular: l('Bölüm', 'Section'), short: l('BÖ', 'SE') },
  structure: { plural: l('Yapılar', 'Structures'), singular: l('Yapı', 'Structure'), short: l('YA', 'ST') },
  type: { plural: l('Türler', 'Types'), singular: l('Tür', 'Type'), short: l('TÜ', 'TY') },
  function: { plural: l('Fonksiyonlar', 'Functions'), singular: l('Fonksiyon', 'Function'), short: 'FN' }
}

/** Listede aynı anda çizilen en fazla sonuç; daha fazlası için aramayı daraltmak gerekir. */
const RESULT_LIMIT = 300
const SEARCH_DEBOUNCE_MS = 80

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Pattern içindeki `%tür%` kısımlarını vurgular; metin DOM düğümleriyle kurulur (innerHTML yok). */
function renderPattern(pattern: string): HTMLElement {
  const pre = el('pre', 'syntax-pattern')
  for (const part of pattern.split(/(%[^%\s]+%)/g)) {
    if (!part) continue
    pre.append(part.startsWith('%') && part.endsWith('%') && part.length > 2 ? el('span', 'syntax-placeholder', part) : part)
  }
  return pre
}

export interface SyntaxBrowserElements {
  search: HTMLInputElement
  kind: HTMLSelectElement
  /** Kaynağa göre süzgeç: Skript ya da seçili addon'lardan biri. */
  source: HTMLSelectElement
  count: HTMLElement
  results: HTMLElement
  detail: HTMLElement
}

/**
 * Seçili Skript sürümünün syntax veritabanında arama yapan kenar çubuğu görünümü.
 * Veriyi `@skript-ide/syntax-db` paketinden alır; editöre bağlı değildir.
 */
export class SyntaxBrowser {
  private index: SyntaxIndex | null = null
  private version: string | null = null
  private addons: { name: string; version: string }[] = []
  /** Yüklenen addon verileri: seçimle tam eşleşmiyorsa en yakın Skript sürümünün verisi. */
  private addonNotes: string[] = []
  private results: SyntaxEntry[] = []
  private total = 0
  private selected: SyntaxEntry | null = null
  private loadToken = 0
  private searchTimer: number | undefined

  constructor(private readonly els: SyntaxBrowserElements) {
    els.kind.replaceChildren(
      new Option(l('Tüm türler', 'All kinds'), ''),
      ...SYNTAX_KINDS.map((kind) => new Option(KIND_LABELS[kind].plural, kind))
    )
    els.search.addEventListener('input', () => {
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => this.update(), SEARCH_DEBOUNCE_MS)
    })
    els.search.addEventListener('keydown', (event) => this.onNavigationKey(event))
    els.results.addEventListener('keydown', (event) => this.onNavigationKey(event))
    els.kind.addEventListener('change', () => this.update())
    els.source.addEventListener('change', () => this.update())
    this.renderSources()
    this.showDetailMessage(l('Bir syntax seç.', 'Select a syntax.'))
  }

  get currentVersion(): string | null {
    return this.version
  }

  focusSearch(): void {
    this.els.search.focus()
    this.els.search.select()
  }

  /** Seçili addon'ların kayıtları da listelenir; her kayıt kaynağıyla (Skript / addon adı) etiketlenir. */
  async setAddons(addons: { name: string; version: string }[]): Promise<void> {
    const key = (list: { name: string; version: string }[]) => list.map((a) => `${a.name}@${a.version}`).join(',')
    if (key(addons) === key(this.addons)) return
    this.addons = addons.map(({ name, version }) => ({ name, version }))
    this.renderSources()
    if (this.version) await this.setVersion(this.version, true)
  }

  private renderSources(): void {
    const previous = this.els.source.value
    this.els.source.replaceChildren(
      new Option(l('Tüm kaynaklar', 'All sources'), ''),
      new Option('Skript', 'skript'),
      ...this.addons.map((addon) => new Option(addon.name, addon.name.toLowerCase()))
    )
    this.els.source.value = [...this.els.source.options].some((option) => option.value === previous) ? previous : ''
    this.els.source.hidden = this.addons.length === 0
  }

  /** Başka bir sürüme geçer; seçili kayıt yeni sürümde de varsa seçili kalır. */
  async setVersion(version: string, force = false): Promise<void> {
    if (version === this.version && this.index && !force) return
    const token = ++this.loadToken
    this.version = version
    this.index = null
    if (!hasSyntaxDatabase(version)) {
      this.results = []
      this.renderList(l(`Skript ${version} için syntax veritabanı yok.`, `No syntax database for Skript ${version}.`))
      this.showDetailMessage('')
      return
    }
    this.renderList(l(`Skript ${version} syntax'ları yükleniyor…`, `Loading Skript ${version} syntax…`))
    try {
      const db = await loadSyntaxDatabase(version)
      const notes: string[] = []
      const addonEntries: SyntaxEntry[] = []
      for (const addon of this.addons) {
        const info = resolveAddonDatabase(addon.name, addon.version, version)
        if (!info) {
          notes.push(l(`${addon.name} ${addon.version} için syntax verisi yok`, `No syntax data for ${addon.name} ${addon.version}`))
          continue
        }
        if (!info.exact) notes.push(l(`${addon.name} ${addon.version}: Skript ${info.skriptVersion} verisi gösteriliyor`, `${addon.name} ${addon.version}: showing Skript ${info.skriptVersion} data`))
        try {
          addonEntries.push(...(await loadAddonDatabase(info)).entries)
        } catch (error) {
          notes.push(l(`${addon.name} yüklenemedi: ${(error as Error).message}`, `Could not load ${addon.name}: ${(error as Error).message}`))
        }
      }
      if (token !== this.loadToken) return
      this.addonNotes = notes
      this.index = new SyntaxIndex(addonEntries.length ? { ...db, entries: [...db.entries, ...addonEntries] } : db)
    } catch (error) {
      if (token !== this.loadToken) return
      this.renderList(l(`Yüklenemedi: ${(error as Error).message}`, `Could not load: ${(error as Error).message}`))
      return
    }
    const previous = this.selected
    this.selected = previous ? (this.index.get(previous.kind, previous.id) ?? null) : null
    this.update()
    if (this.selected) this.renderDetail(this.selected)
    else
      this.showDetailMessage(
        previous
          ? l(`“${previous.name}” Skript ${version} sürümünde yok.`, `“${previous.name}” does not exist in Skript ${version}.`)
          : l(l('Bir syntax seç.', 'Select a syntax.'), 'Select a syntax.')
      )
  }

  /** Belirli bir kaydı gösterir (ör. bir tür bağlantısına tıklanınca). */
  reveal(kind: SyntaxKind, id: string): void {
    const entry = this.index?.get(kind, id)
    if (!entry) return
    if (!this.results.includes(entry)) {
      this.els.search.value = ''
      this.els.kind.value = kind
      this.update()
    }
    this.select(entry, true)
  }

  private update(): void {
    if (!this.index) return
    const kind = this.els.kind.value as SyntaxKind | ''
    const source = this.els.source.value
    const all = this.index
      .search(this.els.search.value, { kinds: kind ? [kind] : undefined })
      .filter((entry) => !source || (source === 'skript' ? !entry.addon : entry.addon?.toLowerCase() === source))
    this.total = all.length
    this.results = all.slice(0, RESULT_LIMIT)
    this.renderList(all.length ? null : l('Sonuç yok.', 'No results.'))
  }

  private renderList(message: string | null): void {
    const { results, count } = this.els
    if (message !== null) {
      count.textContent = this.version ? `Skript ${this.version}` : ''
      results.replaceChildren(el('div', 'panel-empty', message))
      return
    }
    count.textContent =
      this.total > this.results.length
        ? l(
            `${this.total} sonuç (ilk ${this.results.length}) · Skript ${this.version}`,
            `${this.total} results (first ${this.results.length}) · Skript ${this.version}`
          )
        : l(`${this.total} sonuç · Skript ${this.version}`, `${this.total} results · Skript ${this.version}`)
    count.title = this.addonNotes.join('\n')
    if (this.addonNotes.length) count.textContent += ' ⚠'

    results.replaceChildren(
      ...this.results.map((entry) => {
        const row = el('div', 'syntax-row')
        row.setAttribute('role', 'option')
        row.dataset.kind = entry.kind
        row.title = entry.patterns[0] ?? entry.name
        row.classList.toggle('selected', entry === this.selected)
        row.setAttribute('aria-selected', String(entry === this.selected))
        const badge = el('span', 'syntax-kind', KIND_LABELS[entry.kind].short)
        badge.title = KIND_LABELS[entry.kind].singular
        const name = el('span', 'syntax-name', entry.name)
        if (entry.deprecated) name.classList.add('deprecated')
        row.append(badge, name)
        if (entry.addon) {
          const source = el('span', 'syntax-source', entry.addon)
          source.title = l(`${entry.addon} addon'unun syntax'ı`, `Syntax from the ${entry.addon} addon`)
          row.append(source)
        }
        row.append(el('span', 'syntax-hint', entry.patterns[0] ?? ''))
        row.addEventListener('click', () => this.select(entry, false))
        return row
      })
    )
  }

  private select(entry: SyntaxEntry, scroll: boolean): void {
    this.selected = entry
    const rows = this.els.results.querySelectorAll<HTMLElement>('.syntax-row')
    rows.forEach((row, i) => {
      const isSelected = this.results[i] === entry
      row.classList.toggle('selected', isSelected)
      row.setAttribute('aria-selected', String(isSelected))
      if (isSelected && scroll) row.scrollIntoView({ block: 'nearest' })
    })
    this.renderDetail(entry)
  }

  private onNavigationKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (this.results.length === 0) return
    event.preventDefault()
    const current = this.selected ? this.results.indexOf(this.selected) : -1
    const next = event.key === 'ArrowDown' ? Math.min(current + 1, this.results.length - 1) : Math.max(current - 1, 0)
    this.select(this.results[next], true)
  }

  private showDetailMessage(message: string): void {
    this.els.detail.replaceChildren(el('div', 'panel-empty', message))
  }

  private renderDetail(entry: SyntaxEntry): void {
    const detail = this.els.detail
    const header = el('div', 'syntax-detail-header')
    header.append(el('h2', undefined, entry.name))
    const chips = el('div', 'syntax-chips')
    chips.append(el('span', `syntax-chip kind-${entry.kind}`, KIND_LABELS[entry.kind].singular))
    chips.append(el('span', `syntax-chip source${entry.addon ? ' addon' : ''}`, entry.addon ? `Addon: ${entry.addon}` : 'Skript'))
    if (entry.deprecated) chips.append(el('span', 'syntax-chip deprecated', l('Kullanımdan kalkmış', 'Deprecated')))
    if (entry.cancellable) chips.append(el('span', 'syntax-chip', l('İptal edilebilir', 'Cancellable')))
    header.append(chips)

    const meta = el('dl', 'syntax-meta')
    const addMeta = (label: string, value: string | Node) => {
      meta.append(el('dt', undefined, label))
      const dd = el('dd')
      dd.append(value)
      meta.append(dd)
    }
    addMeta(l('Eklendiği sürüm', 'Since'), entry.since.length ? entry.since.join(', ') : l('Bilinmiyor', 'Unknown'))
    addMeta(l('Kimlik', 'ID'), entry.id)
    if (entry.returnType) addMeta(l('Döndürdüğü tür', 'Return type'), this.refList([entry.returnType]))
    if (entry.requirements) addMeta(l('Gereksinimler', 'Requirements'), entry.requirements.join(', '))
    if (entry.events) addMeta(l('Kullanıldığı olaylar', 'Used in events'), this.refList(entry.events, 'event'))

    const sections: HTMLElement[] = [header, meta]
    const section = (title: string, ...content: (Node | string)[]) => {
      const box = el('section', 'syntax-section')
      box.append(el('h3', undefined, title), ...content)
      sections.push(box)
    }

    if (entry.patterns.length) {
      const title =
        entry.kind === 'type' ? l('Kullanım', 'Usage') : entry.kind === 'function' ? l('İmza', 'Signature') : l("Pattern'ler", 'Patterns')
      section(title, ...entry.patterns.map(renderPattern))
    }
    if (entry.description) section(l('Açıklama', 'Description'), el('p', 'syntax-description', entry.description))
    if (entry.eventValues) section(l('Olay değerleri', 'Event values'), this.refList(entry.eventValues, 'type', 'event-'))
    if (entry.examples.length) {
      section(l('Örnekler', 'Examples'), ...entry.examples.map((example) => this.renderExample(example)))
    }
    if (entry.keywords) section(l('Anahtar kelimeler', 'Keywords'), el('p', 'syntax-keywords', entry.keywords.join(', ')))

    detail.replaceChildren(...sections)
    detail.scrollTop = 0
  }

  /** Türlere / olaylara verilen referansları, veritabanında varsa tıklanabilir bağlantı yapar. */
  private refList(refs: SyntaxRef[], kind: SyntaxKind = 'type', prefix = ''): HTMLElement {
    const list = el('span', 'syntax-refs')
    refs.forEach((ref, i) => {
      if (i > 0) list.append(', ')
      const label = `${prefix}${ref.name}`
      if (this.index?.get(kind, ref.id)) {
        const link = el('button', 'syntax-link', label)
        link.title = `${KIND_LABELS[kind].singular}: ${ref.id}`
        link.addEventListener('click', () => this.reveal(kind, ref.id))
        list.append(link)
      } else {
        list.append(label)
      }
    })
    return list
  }

  private renderExample(example: string): HTMLElement {
    const box = el('div', 'syntax-example')
    const code = el('pre', 'syntax-example-code')
    code.textContent = example
    // Monaco'nun renklendiricisi metni kendisi kaçışlayarak HTML üretir
    void monaco.editor.colorize(example, SKRIPT_LANGUAGE_ID, { tabSize: 4 }).then((html) => {
      if (code.isConnected) code.innerHTML = html
    })
    const copy = el('button', 'syntax-copy', l('Kopyala', 'Copy'))
    copy.title = l('Örneği panoya kopyala', 'Copy the example to the clipboard')
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(example).then(
        () => (copy.textContent = l('Kopyalandı', 'Copied')),
        () => (copy.textContent = l('Kopyalanamadı', 'Copy failed'))
      )
      window.setTimeout(() => (copy.textContent = l('Kopyala', 'Copy')), 1500)
    })
    box.append(copy, code)
    return box
  }
}
