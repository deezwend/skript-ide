import type { DirEntry } from '../../shared/ipc'
import { api } from './api'
import { basename, extname } from './paths'

import { l } from '@skript-ide/i18n'
const INDENT_PX = 12

/** Klasör ağacı. Alt klasörler yalnızca açıldıklarında okunur. */
export class Explorer {
  private root: string | null = null
  private activePath: string | null = null
  private readonly expanded = new Set<string>()

  constructor(
    private readonly container: HTMLElement,
    private readonly onOpenFile: (path: string) => void,
    private readonly onOpenFolderRequest: () => void
  ) {
    this.renderEmpty()
  }

  get rootPath(): string | null {
    return this.root
  }

  async setRoot(path: string): Promise<void> {
    this.root = path
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
    this.highlightActive()
  }

  setActive(path: string | null): void {
    this.activePath = path
    this.highlightActive()
  }

  private renderEmpty(): void {
    const message = document.createElement('div')
    message.className = 'explorer-empty'
    message.textContent = l('Henüz bir klasör açılmadı.', 'No folder has been opened yet.')
    const button = document.createElement('button')
    button.textContent = l('Klasör Aç', 'Open Folder')
    button.addEventListener('click', this.onOpenFolderRequest)
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
    children.setAttribute('role', 'group')

    const setOpen = async (open: boolean) => {
      row.classList.toggle('open', open)
      row.setAttribute('aria-expanded', String(open))
      if (open) {
        this.expanded.add(entry.path)
        children.replaceChildren()
        await this.renderChildren(entry.path, children, depth + 1)
        this.highlightActive()
      } else {
        this.expanded.delete(entry.path)
        children.replaceChildren()
      }
    }
    row.addEventListener('click', () => void setOpen(!this.expanded.has(entry.path)))
    if (this.expanded.has(entry.path)) await setOpen(true)

    wrapper.append(row, children)
    return wrapper
  }

  private fileNode(entry: DirEntry, depth: number): HTMLElement {
    const isSkript = extname(entry.path) === '.sk'
    const row = this.row(entry, depth, isSkript ? 'skript' : 'file')
    row.addEventListener('click', () => this.onOpenFile(entry.path))
    return row
  }

  private row(entry: DirEntry, depth: number, kind: 'folder' | 'skript' | 'file'): HTMLElement {
    const row = document.createElement('div')
    row.className = `tree-row ${kind}`
    row.setAttribute('role', 'treeitem')
    row.dataset.path = entry.path
    row.title = entry.path
    row.style.paddingLeft = `${8 + depth * INDENT_PX}px`

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

  private highlightActive(): void {
    this.container.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.path === this.activePath)
    })
  }
}
