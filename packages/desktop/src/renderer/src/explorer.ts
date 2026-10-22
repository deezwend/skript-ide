import type { ContextMenuItem, DirEntry } from '../../shared/ipc'
import { api } from './api'
import { basename, dirname, extname, samePath } from './paths'

import { l } from '@skript-ide/i18n'
const INDENT_PX = 12

export interface ExplorerHooks {
  /** `preserveFocus` ise odak gezginde kalır; klavye kısayolları (kopyala, sil…) çalışmaya devam eder. */
  onOpenFile(path: string, preserveFocus?: boolean): void
  onOpenFolderRequest(): void
  /** Bir dosya ya da klasör yeniden adlandırıldı veya taşındı; açık sekmeler yeni yola geçmeli. */
  onRenamed(oldPath: string, newPath: string): void
  /** Bir öğe geri dönüşüm kutusuna taşındı. */
  onDeleted(path: string): void
  /** Diskte herhangi bir değişiklik oldu (dil sunucusunun çalışma alanı tazelenmeli). */
  onWorkspaceChanged(): void
  onError(error: Error): void
}

interface Selection {
  path: string
  isDirectory: boolean
}

/** Klasör ağacı. Alt klasörler yalnızca açıldıklarında okunur. */
export class Explorer {
  private root: string | null = null
  private activePath: string | null = null
  private selected: Selection | null = null
  /** Kopyala / kes ile işaretlenen öğe; yapıştırınca kullanılır. */
  private clipboard: (Selection & { move: boolean }) | null = null
  private readonly expanded = new Set<string>()

  constructor(
    private readonly container: HTMLElement,
    private readonly hooks: ExplorerHooks
  ) {
    container.tabIndex = 0
    container.addEventListener('keydown', (event) => this.onKeyDown(event))
    container.addEventListener('contextmenu', (event) => {
      if (!this.root) return
      event.preventDefault()
      // Satır dışında (boş alan ya da başlık) açılan menü kök klasörü hedefler
      const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-row')
      if (!row) this.select(null)
      void this.run(() => this.showContextMenu(this.selected ?? { path: this.root!, isDirectory: true }))
    })
    this.renderEmpty()
  }

  get rootPath(): string | null {
    return this.root
  }

  async setRoot(path: string): Promise<void> {
    this.root = path
    this.selected = null
    this.clipboard = null
    this.expanded.clear()
    this.expanded.add(path)
    await this.refresh()
  }

  async refresh(): Promise<void> {
    if (!this.root) return this.renderEmpty()

    const header = document.createElement('div')
    header.className = 'explorer-root'
    header.textContent = basename(this.root).toUpperCase()
    header.title = this.root

    const tree = document.createElement('div')
    tree.className = 'tree'
    tree.setAttribute('role', 'tree')
    await this.renderChildren(this.root, tree, 0)

    this.container.replaceChildren(header, tree)
    this.highlight()
  }

  setActive(path: string | null): void {
    this.activePath = path
    this.highlight()
  }

  private renderEmpty(): void {
    const message = document.createElement('div')
    message.className = 'explorer-empty'
    message.textContent = l('Henüz bir klasör açılmadı.', 'No folder has been opened yet.')
    const button = document.createElement('button')
    button.textContent = l('Klasör Aç', 'Open Folder')
    button.addEventListener('click', () => this.hooks.onOpenFolderRequest())
    message.append(button)
    this.container.replaceChildren(message)
  }

  private async renderChildren(dir: string, parent: HTMLElement, depth: number): Promise<void> {
    let entries: DirEntry[]
    try {
      entries = await api.readDir(dir)
    } catch (error) {
      parent.append(this.note(l(`Okunamadı: ${(error as Error).message}`, `Could not read: ${(error as Error).message}`), depth))
      return
    }
    if (entries.length === 0) {
      parent.append(this.note(l('(boş)', '(empty)'), depth))
      return
    }
    for (const entry of entries) {
      parent.append(entry.isDirectory ? await this.directoryNode(entry, depth) : this.fileNode(entry, depth))
    }
  }

  private async directoryNode(entry: DirEntry, depth: number): Promise<HTMLElement> {
    const wrapper = document.createElement('div')
    const row = this.row(entry, depth, 'folder')
    const children = document.createElement('div')
    children.className = 'tree-children'
    children.setAttribute('role', 'group')

    const setOpen = async (open: boolean) => {
      row.classList.toggle('open', open)
      row.setAttribute('aria-expanded', String(open))
      if (open) {
        this.expanded.add(entry.path)
        children.replaceChildren()
        await this.renderChildren(entry.path, children, depth + 1)
        this.highlight()
      } else {
        this.expanded.delete(entry.path)
        children.replaceChildren()
      }
    }
    row.addEventListener('click', () => {
      this.select({ path: entry.path, isDirectory: true })
      void setOpen(!this.expanded.has(entry.path))
    })
    if (this.expanded.has(entry.path)) await setOpen(true)

    wrapper.append(row, children)
    return wrapper
  }

  private fileNode(entry: DirEntry, depth: number): HTMLElement {
    const isSkript = extname(entry.path) === '.sk'
    const row = this.row(entry, depth, isSkript ? 'skript' : 'file')
    row.addEventListener('click', () => {
      this.select({ path: entry.path, isDirectory: false })
      this.hooks.onOpenFile(entry.path, true)
    })
    return row
  }

  private row(entry: DirEntry, depth: number, kind: 'folder' | 'skript' | 'file'): HTMLElement {
    const row = document.createElement('div')
    row.className = `tree-row ${kind}`
    row.setAttribute('role', 'treeitem')
    row.dataset.path = entry.path
    row.dataset.depth = String(depth)
    row.title = entry.path
    row.style.paddingLeft = `${8 + depth * INDENT_PX}px`
    // Sağ tık önce satırı seçer; menüyü kapsayıcıdaki dinleyici açar
    row.addEventListener('contextmenu', () => this.select({ path: entry.path, isDirectory: entry.isDirectory }))

    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.textContent = kind === 'folder' ? '›' : kind === 'skript' ? 'sk' : '·'

    const name = document.createElement('span')
    name.className = 'tree-name'
    name.textContent = entry.name

    row.append(icon, name)
    return row
  }

  private note(text: string, depth: number): HTMLElement {
    const note = document.createElement('div')
    note.className = 'tree-note'
    note.style.paddingLeft = `${8 + depth * INDENT_PX + 16}px`
    note.textContent = text
    return note
  }

  private select(selection: Selection | null): void {
    this.selected = selection
    this.highlight()
  }

  private highlight(): void {
    const cut = this.clipboard?.move ? this.clipboard.path : null
    this.container.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
      const path = row.dataset.path!
      row.classList.toggle('active', path === this.activePath)
      row.classList.toggle('selected', this.selected !== null && path === this.selected.path)
      row.classList.toggle('cut', cut !== null && path === cut)
    })
  }

  private findRow(path: string): HTMLElement | null {
    return [...this.container.querySelectorAll<HTMLElement>('.tree-row')].find((row) => row.dataset.path === path) ?? null
  }

  // --- İşlemler ---

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.hooks.onError(error as Error)
    }
  }

  /** Yeni öğe ya da yapıştırma için hedef klasör: seçili klasör, seçili dosyanın klasörü ya da kök. */
  private targetDirectory(target: Selection | null = this.selected): string {
    if (!target) return this.root!
    return target.isDirectory ? target.path : dirname(target.path)
  }

  private async showContextMenu(target: Selection): Promise<void> {
    const isRoot = samePath(target.path, this.root!)
    const items: ContextMenuItem[] = [
      { id: 'new-file', label: l('Yeni Dosya…', 'New File…') },
      { id: 'new-folder', label: l('Yeni Klasör…', 'New Folder…') },
      { type: 'separator' },
      { id: 'cut', label: l('Kes', 'Cut'), accelerator: 'CmdOrCtrl+X', enabled: !isRoot },
      { id: 'copy', label: l('Kopyala', 'Copy'), accelerator: 'CmdOrCtrl+C', enabled: !isRoot },
      { id: 'paste', label: l('Yapıştır', 'Paste'), accelerator: 'CmdOrCtrl+V', enabled: this.clipboard !== null },
      { type: 'separator' },
      { id: 'copy-path', label: l('Yolu Kopyala', 'Copy Path') },
      { id: 'reveal', label: l('Dosya Gezgininde Göster', 'Reveal in File Explorer') },
      { type: 'separator' },
      { id: 'rename', label: l('Yeniden Adlandır…', 'Rename…'), accelerator: 'F2', enabled: !isRoot },
      { id: 'delete', label: l('Sil', 'Delete'), accelerator: 'Delete', enabled: !isRoot },
      { type: 'separator' },
      { id: 'refresh', label: l('Yenile', 'Refresh') }
    ]
    const choice = await api.showContextMenu(items)
    if (choice) await this.perform(choice, target)
  }

  private async perform(command: string, target: Selection): Promise<void> {
    switch (command) {
      case 'new-file':
        return this.createItem(this.targetDirectory(target), false)
      case 'new-folder':
        return this.createItem(this.targetDirectory(target), true)
      case 'cut':
      case 'copy':
        this.clipboard = { ...target, move: command === 'cut' }
        return this.highlight()
      case 'paste':
        return this.paste(this.targetDirectory(target))
      case 'copy-path':
        return navigator.clipboard.writeText(target.path)
      case 'reveal':
        return api.revealPath(target.path)
      case 'rename':
        return this.rename(target)
      case 'delete':
        return this.delete(target)
      case 'refresh':
        return this.refresh()
    }
  }

  private async createItem(dir: string, isDirectory: boolean): Promise<void> {
    // Hedef klasör kapalıysa önce açılır ki giriş kutusu içinde görünsün
    if (!this.expanded.has(dir)) {
      this.expanded.add(dir)
      await this.refresh()
    }
    const isRoot = samePath(dir, this.root!)
    const dirRow = isRoot ? null : this.findRow(dir)
    const children = isRoot
      ? this.container.querySelector<HTMLElement>('.tree')
      : (dirRow?.nextElementSibling as HTMLElement | null)
    if (!children) return
    const depth = isRoot ? 0 : Number(dirRow!.dataset.depth) + 1

    const row = document.createElement('div')
    row.className = `tree-row editing ${isDirectory ? 'folder' : 'skript'}`
    row.style.paddingLeft = `${8 + depth * INDENT_PX}px`
    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.textContent = isDirectory ? '›' : 'sk'
    row.append(icon)
    children.querySelector(':scope > .tree-note')?.remove()
    children.prepend(row)

    const name = await this.promptName(row, '')
    if (!name) return void this.refresh()
    const path = isDirectory ? await api.createDirectory(dir, name) : await api.createFile(dir, name)
    this.selected = { path, isDirectory }
    if (isDirectory) this.expanded.add(path)
    await this.refresh()
    this.hooks.onWorkspaceChanged()
    if (!isDirectory) this.hooks.onOpenFile(path)
  }

  private async rename(target: Selection): Promise<void> {
    const row = this.findRow(target.path)
    if (!row) return
    const label = row.querySelector('.tree-name')
    label?.remove()
    row.classList.add('editing')
    const oldName = basename(target.path)
    const name = await this.promptName(row, oldName)
    if (!name || name === oldName) return void this.refresh()
    const newPath = await api.renamePath(target.path, name)
    this.moved(target.path, newPath, target.isDirectory)
    await this.refresh()
  }

  private async delete(target: Selection): Promise<void> {
    const name = basename(target.path)
    const question = target.isDirectory
      ? l(`"${name}" klasörü ve içindekiler geri dönüşüm kutusuna taşınsın mı?`, `Move the folder "${name}" and its contents to the Recycle Bin?`)
      : l(`"${name}" geri dönüşüm kutusuna taşınsın mı?`, `Move "${name}" to the Recycle Bin?`)
    if (!window.confirm(question)) return
    await api.trashPath(target.path)
    if (this.clipboard && isInside(this.clipboard.path, target.path)) this.clipboard = null
    for (const path of [...this.expanded]) if (isInside(path, target.path)) this.expanded.delete(path)
    this.selected = null
    await this.refresh()
    this.hooks.onDeleted(target.path)
    this.hooks.onWorkspaceChanged()
  }

  private async paste(dir: string): Promise<void> {
    const source = this.clipboard
    if (!source) return
    const newPath = await api.transferPath(source.path, dir, source.move)
    if (source.move) {
      // Kesilen öğe bir kez yapıştırılır
      this.clipboard = null
      this.moved(source.path, newPath, source.isDirectory)
    } else {
      this.hooks.onWorkspaceChanged()
    }
    this.expanded.add(dir)
    this.selected = { path: newPath, isDirectory: source.isDirectory }
    await this.refresh()
  }

  /** Yeniden adlandırma / taşıma sonrası açık klasör ve seçim durumunu yeni yola taşır. */
  private moved(oldPath: string, newPath: string, isDirectory: boolean): void {
    if (oldPath === newPath) return
    for (const path of [...this.expanded]) {
      if (!isInside(path, oldPath)) continue
      this.expanded.delete(path)
      this.expanded.add(newPath + path.slice(oldPath.length))
    }
    this.selected = { path: newPath, isDirectory }
    this.hooks.onRenamed(oldPath, newPath)
    this.hooks.onWorkspaceChanged()
  }

  /** Satıra bir ad kutusu yerleştirir; Enter ya da odak kaybı onaylar, Escape vazgeçer. */
  private promptName(row: HTMLElement, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.className = 'tree-input'
      input.value = initial
      input.spellcheck = false
      row.append(input)
      input.focus()
      // Uzantı dışındaki kısım seçili gelir
      const dot = initial.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : initial.length)

      let done = false
      const finish = (value: string | null) => {
        if (done) return
        done = true
        input.remove()
        this.container.focus()
        resolve(value?.trim() || null)
      }
      input.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish(input.value)
        else if (event.key === 'Escape') finish(null)
      })
      input.addEventListener('blur', () => finish(input.value))
      input.addEventListener('click', (event) => event.stopPropagation())
    })
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.root || (event.target as HTMLElement).tagName === 'INPUT') return
    const target = this.selected
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    let command: string | null = null
    if (event.key === 'F2' && target) command = 'rename'
    else if (event.key === 'Delete' && target) command = 'delete'
    else if (mod && key === 'c' && target) command = 'copy'
    else if (mod && key === 'x' && target) command = 'cut'
    else if (mod && key === 'v' && this.clipboard) command = 'paste'
    else if (event.key === 'Enter' && target && !target.isDirectory) return this.hooks.onOpenFile(target.path)
    if (!command) return
    event.preventDefault()
    const selection = target ?? { path: this.root, isDirectory: true }
    if (command !== 'paste' && samePath(selection.path, this.root)) return
    void this.run(() => this.perform(command, selection))
  }
}

/** `path`, `parent`'in kendisi ya da içindeki bir öğe mi. */
export function isInside(path: string, parent: string): boolean {
  if (samePath(path, parent)) return true
  const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return normalize(path).startsWith(normalize(parent) + '/')
}
