// Yalnızca saf veri modülü (addon listesi + uyumluluk tablosu); Node API'si kullanmaz
import { ADDONS, addonCompatibility, recommendedAddonVersion } from '@skript-ide/runtime-validator/src/addons'
import type { AddonSelection } from '../../shared/ipc'

import { l, localize } from '@skript-ide/i18n'
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const STATUS_LABELS = {
  ok: l('✓ çalışıyor', '✓ works'),
  partial: l('◐ kısmen', '◐ partial'),
  failed: l('✕ çalışmıyor', '✕ broken'),
  unknown: l('? denenmedi', '? untested')
}

/** Bir addon sürümünün seçili Skript sürümüyle gerçek sunucuda denenmiş durumu. */
function compatibility(addon: string, version: string, skriptVersion: string): { key: keyof typeof STATUS_LABELS; detail: string } {
  const found = addonCompatibility(addon, version, skriptVersion)
  if (!found) return { key: 'unknown', detail: l(`Skript ${skriptVersion} ile gerçek sunucuda denenmedi.`, `Not tested with Skript ${skriptVersion} on a real server.`) }
  return { key: found.status, detail: `Paper ${found.minecraft}: ${localize(found.detail)}` }
}

/**
 * Addon seçici. Her bilinen addon için onay kutusu ve sürüm listesi gösterir; sürümlerin yanında
 * seçili Skript sürümüyle uyumluluk tablosundaki sonuç yazar. Kaydedilirse yeni seçimi, vazgeçilirse `null` döndürür.
 * Bilinmeyen addon'lar (proje dosyasına elle yazılmış) korunur ve listede uyarıyla gösterilir.
 */
export function pickAddons(
  dialog: HTMLDialogElement,
  current: readonly AddonSelection[],
  skriptVersion: string
): Promise<AddonSelection[] | null> {
  const rows: { id: string; check: HTMLInputElement; select: HTMLSelectElement }[] = []
  const list = el('div', 'addon-list')

  for (const addon of ADDONS) {
    const selected = current.find((selection) => selection.name.toLowerCase() === addon.id.toLowerCase())
    const row = el('div', 'addon-row')
    const label = el('label', 'addon-title')
    const check = el('input')
    check.type = 'checkbox'
    check.checked = Boolean(selected)
    label.append(check, el('span', 'addon-name', addon.id))

    const select = el('select', 'addon-version')
    const recommended = recommendedAddonVersion(addon.id, skriptVersion)
    for (const version of addon.versions) {
      const status = compatibility(addon.id, version.version, skriptVersion)
      const option = new Option(
        `${version.version} — ${STATUS_LABELS[status.key]}${version.version === recommended ? l(' (önerilen)', ' (recommended)') : ''}`,
        version.version
      )
      option.title = status.detail
      select.append(option)
    }
    select.value = selected && addon.versions.some((v) => v.version === selected.version) ? selected.version : (recommended ?? addon.versions[0]!.version)

    const detail = el('div', 'addon-detail')
    const renderDetail = () => {
      const status = compatibility(addon.id, select.value, skriptVersion)
      detail.textContent = status.detail
      detail.dataset.status = status.key
      select.disabled = !check.checked
    }
    select.addEventListener('change', renderDetail)
    check.addEventListener('change', renderDetail)
    renderDetail()

    row.append(label, select, el('div', 'addon-description', addon.description), detail)
    list.append(row)
    rows.push({ id: addon.id, check, select })
  }

  const unknown = current.filter((selection) => !ADDONS.some((addon) => addon.id.toLowerCase() === selection.name.toLowerCase()))
  for (const selection of unknown) {
    const row = el('div', 'addon-row unknown')
    row.append(
      el('span', 'addon-name', `${selection.name} ${selection.version}`),
      el('div', 'addon-detail', l('Bu addon için syntax verisi ve indirme bilgisi yok; proje dosyasında korunur ama sunucuya kurulmaz.', 'There is no syntax data or download info for this addon; it is kept in the project file but not installed on the server.'))
    )
    list.append(row)
  }

  const form = el('form')
  form.method = 'dialog'
  const actions = el('div', 'dialog-actions')
  const cancel = el('button', undefined, l('Vazgeç', 'Cancel'))
  cancel.value = 'cancel'
  cancel.formNoValidate = true
  const save = el('button', 'primary', l('Kaydet', 'Save'))
  save.value = 'save'
  actions.append(cancel, save)
  form.append(
    el('h2', undefined, l("Addon'lar", 'Addons')),
    el(
      'p',
      'dialog-note',
      l(
        `Seçilen addon'ların syntax'ları tamamlama, hover ve tanılarda tanınır; doğrulama sunucusuna da kurulur. ` +
          `Uyumluluk, Skript ${skriptVersion} ile gerçek sunucuda denenmiş sonuçtur.`,
        `The syntax of the selected addons is recognized in completion, hover and diagnostics; they are also installed on the validation server. ` +
          `Compatibility is the result of testing with Skript ${skriptVersion} on a real server.`
      )
    ),
    list,
    actions
  )
  dialog.replaceChildren(form)

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'save') {
          resolve(null)
          return
        }
        const selections: AddonSelection[] = rows
          .filter((row) => row.check.checked)
          .map((row) => ({ name: row.id, version: row.select.value }))
        resolve([...selections, ...unknown])
      },
      { once: true }
    )
    dialog.returnValue = ''
    dialog.showModal()
  })
}
