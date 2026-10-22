import type { DocumentManager } from './documents'

import { l } from '@skript-ide/i18n'
export function renderTabs(container: HTMLElement, docs: DocumentManager): void {
  container.replaceChildren(
    ...docs.documents.map((doc) => {
      const tab = document.createElement('div')
      tab.className = 'tab'
      tab.setAttribute('role', 'tab')
      tab.classList.toggle('active', doc === docs.active)
      tab.classList.toggle('dirty', docs.isDirty(doc))
      tab.title = doc.path ?? docs.title(doc)

      const label = document.createElement('span')
      label.className = 'tab-label'
      label.textContent = docs.title(doc)

      const close = document.createElement('button')
      close.className = 'tab-close'
      close.title = l('Kapat (Ctrl+W)', 'Close (Ctrl+W)')
      close.textContent = '×'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        docs.close(doc.id)
      })

      tab.addEventListener('click', () => docs.activate(doc.id))
      // Orta tıkla kapat
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) docs.close(doc.id)
      })
      tab.append(label, close)
      return tab
    })
  )
  container.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
