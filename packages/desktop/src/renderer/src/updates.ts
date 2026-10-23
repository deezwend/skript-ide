import type { ReleaseNotes, UpdateStatus } from '../../shared/ipc'
import { api } from './api'

import { l } from '@skript-ide/i18n'
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'kbd', 'li', 'ol', 'p', 'pre', 's', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
])
/** İçeriğiyle birlikte atılan öğeler; diğer bilinmeyen öğelerin yalnızca kendisi atılır, metni kalır. */
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math'])

/**
 * Yayın notlarının HTML'ini izin listesine göre temizler: yalnızca metin biçimlendirme öğeleri ve
 * `http(s)` bağlantıları kalır. Bağlantılar dış tarayıcıda açılır (`target="_blank"`, ana süreç yakalar).
 */
export function sanitizeNotes(html: string): DocumentFragment {
  const source = new DOMParser().parseFromString(html, 'text/html').body
  const fragment = document.createDocumentFragment()
  const copy = (from: Node, to: Node) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (!(child instanceof Element)) continue
      const tag = child.tagName.toLowerCase()
      if (DROPPED_TAGS.has(tag)) continue
      if (!ALLOWED_TAGS.has(tag)) {
        copy(child, to)
        continue
      }
      const node = document.createElement(tag)
      if (tag === 'a') {
        const href = child.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href)) {
          node.setAttribute('href', href)
          node.setAttribute('target', '_blank')
          node.setAttribute('rel', 'noreferrer')
        }
      }
      if (tag === 'details' && child.hasAttribute('open')) node.setAttribute('open', '')
      copy(child, node)
      to.appendChild(node)
    }
  }
  copy(source, fragment)
  return fragment
}

function notesBody(html: string | null, url: string | null): HTMLElement {
  const body = el('div', 'release-notes')
  if (html) body.append(sanitizeNotes(html))
  else body.append(el('p', 'dialog-note', l('Bu sürüm için yayın notu bulunamadı.', 'No release notes were found for this version.')))
  if (url) {
    const link = el('a', 'release-link', l("GitHub'da görüntüle ↗", 'View on GitHub ↗'))
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
    body.append(link)
  }
  return body
}

function actionButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const button = el('button', primary ? 'primary' : undefined, label)
  button.type = 'button'
  button.addEventListener('click', onClick)
  return button
}

/**
 * Güncelleme durumunu durum çubuğunda gösterir, elle denetimin sonucunu ve indirilen güncellemeyi
 * pencerede sunar, güncellemeden sonraki ilk açılışta "Yenilikler" penceresini açar.
 */
export class UpdateUi {
  private status: UpdateStatus = { state: 'idle' }
  /** Güncelleme penceresi açıkken durum değiştikçe yeniden çizilir. */
  private dialogOpen = false
  /** Hangi sürüm için "indirildi" penceresi kendiliğinden açıldı; aynı sürüm için bir daha açılmaz. */
  private announced: string | null = null

  constructor(
    private readonly statusItem: HTMLButtonElement,
    private readonly updateDialog: HTMLDialogElement,
    private readonly whatsNewDialog: HTMLDialogElement
  ) {
    statusItem.addEventListener('click', () => this.openUpdateDialog())
    updateDialog.addEventListener('close', () => (this.dialogOpen = false))
    api.onUpdateStatus((status) => this.apply(status))
    void api.getUpdateStatus().then((status) => this.apply(status))
    void api.takeWhatsNew().then((version) => {
      if (version) void this.showWhatsNew(version)
    })
  }

  private apply(status: UpdateStatus): void {
    this.status = status
    this.renderStatusItem()
    if (status.manual) this.openUpdateDialog()
    else if (status.state === 'downloaded' && this.announced !== status.version) {
      this.announced = status.version
      this.openUpdateDialog()
    } else if (this.dialogOpen) this.renderUpdateDialog()
  }

  private renderStatusItem(): void {
    const status = this.status
    const item = this.statusItem
    item.hidden = false
    item.dataset.state = status.state
    switch (status.state) {
      case 'available':
        item.textContent = l(`↑ Güncelleme: ${status.version}`, `↑ Update: ${status.version}`)
        item.title = l('Yeni sürüm hazır; ayrıntılar için tıkla', 'A new version is available; click for details')
        break
      case 'downloading':
        item.textContent = l(`↓ Güncelleme indiriliyor %${status.percent}`, `↓ Downloading update ${status.percent}%`)
        item.title = l(`Skript IDE ${status.version} indiriliyor`, `Downloading Skript IDE ${status.version}`)
        break
      case 'downloaded':
        item.textContent = l('↻ Güncellemek için yeniden başlat', '↻ Restart to update')
        item.title = l(`Skript IDE ${status.version} kurulmaya hazır`, `Skript IDE ${status.version} is ready to install`)
        break
      default:
        item.hidden = true
    }
  }

  openUpdateDialog(): void {
    this.dialogOpen = true
    this.renderUpdateDialog()
    if (!this.updateDialog.open) this.updateDialog.showModal()
  }

  private renderUpdateDialog(): void {
    const status = this.status
    const close = () => this.updateDialog.close()
    const form = el('form')
    form.method = 'dialog'
    const actions = el('div', 'dialog-actions')
    let title: string
    let note: string | null = null
    let notes: HTMLElement | null = null

    switch (status.state) {
      case 'checking':
      case 'idle':
        title = l('Güncellemeler denetleniyor…', 'Checking for updates…')
        actions.append(actionButton(l('Kapat', 'Close'), false, close))
        break
      case 'not-available':
        title = l('Skript IDE güncel', 'Skript IDE is up to date')
        note = l(`Kullandığın sürüm (${api.appVersion}) en yenisi.`, `You are using the latest version (${api.appVersion}).`)
        actions.append(
          actionButton(l('Yenilikler', "What's New"), false, () => {
            close()
            void this.showWhatsNew(api.appVersion)
          }),
          actionButton(l('Tamam', 'OK'), true, close)
        )
        break
      case 'unsupported':
        title = l('Güncellemeler denetlenemiyor', "Can't check for updates")
        note = l(
          'Otomatik güncelleme yalnızca kurulum dosyasıyla yüklenen uygulamada çalışır.',
          'Automatic updates only work in the app installed with the setup file.'
        )
        actions.append(actionButton(l('Tamam', 'OK'), true, close))
        break
      case 'error':
        title = l('Güncellemeler denetlenemedi', "Couldn't check for updates")
        note = status.error
        actions.append(
          actionButton(l('Kapat', 'Close'), false, close),
          actionButton(l('Yeniden Dene', 'Try Again'), true, () => void api.checkForUpdates())
        )
        break
      case 'available':
        title = l(`Yeni sürüm: Skript IDE ${status.version}`, `New version: Skript IDE ${status.version}`)
        note = l(`Kullandığın sürüm ${api.appVersion}.`, `You are using ${api.appVersion}.`)
        notes = notesBody(status.notes, null)
        actions.append(
          actionButton(l('Sonra', 'Later'), false, close),
          actionButton(l('İndir', 'Download'), true, () => void api.downloadUpdate())
        )
        break
      case 'downloading':
        title = l(`Skript IDE ${status.version} indiriliyor…`, `Downloading Skript IDE ${status.version}…`)
        {
          const progress = el('progress', 'update-progress')
          progress.max = 100
          progress.value = status.percent
          notes = el('div')
          notes.append(progress, el('p', 'dialog-note', `%${status.percent}`))
        }
        actions.append(actionButton(l('Arka Planda Sürdür', 'Continue in Background'), true, close))
        break
      case 'downloaded':
        title = l(`Skript IDE ${status.version} kurulmaya hazır`, `Skript IDE ${status.version} is ready to install`)
        note = l(
          'Uygulama yeniden başlatılınca güncelleme kurulur. Şimdi yapmazsan uygulamayı kapattığında kurulur.',
          "The update is installed when the app restarts. If you don't restart now, it is installed when you close the app."
        )
        notes = notesBody(status.notes, null)
        actions.append(
          actionButton(l('Sonra', 'Later'), false, close),
          actionButton(l('Yeniden Başlat ve Güncelle', 'Restart and Update'), true, () => void api.installUpdate())
        )
        break
    }

    form.append(el('h2', undefined, title))
    if (note) form.append(el('p', 'dialog-note', note))
    if (notes) form.append(notes)
    form.append(actions)
    this.updateDialog.replaceChildren(form)
  }

  /** Bir sürümün yayın notlarını "Yenilikler" penceresinde gösterir. */
  async showWhatsNew(version: string = api.appVersion): Promise<void> {
    const dialog = this.whatsNewDialog
    const form = el('form')
    form.method = 'dialog'
    const heading = el('h2', undefined, l(`Skript IDE ${version} — Yenilikler`, `Skript IDE ${version} — What's New`))
    const body = el('div', 'release-notes')
    body.append(el('p', 'dialog-note', l('Yayın notları yükleniyor…', 'Loading release notes…')))
    const actions = el('div', 'dialog-actions')
    actions.append(actionButton(l('Kapat', 'Close'), true, () => dialog.close()))
    form.append(heading, body, actions)
    dialog.replaceChildren(form)
    if (!dialog.open) dialog.showModal()

    let notes: ReleaseNotes | null = null
    try {
      notes = await api.getReleaseNotes(version)
    } catch {
      // Not yoksa boş gösterilir
    }
    body.replaceWith(notesBody(notes?.html ?? null, notes?.url ?? null))
  }
}
