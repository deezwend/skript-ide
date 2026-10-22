import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { getLocale, l, LOCALE_NAMES, LOCALES, type Locale } from '@skript-ide/i18n'
import { IpcChannel, type MenuAction } from '../shared/ipc'

function send(action: MenuAction) {
  return () => BrowserWindow.getFocusedWindow()?.webContents.send(IpcChannel.menuAction, action)
}

export function buildAppMenu(onSelectLocale: (locale: Locale) => void): Menu {
  // Geri al / yinele Monaco'ya bırakıldı. Menüye eklenirse kısayolları Monaco'dan önce yakalanır.
  const template: MenuItemConstructorOptions[] = [
    {
      label: l('Dosya', 'File'),
      submenu: [
        { label: l('Yeni Dosya', 'New File'), accelerator: 'CmdOrCtrl+N', click: send('new-file') },
        { label: l('Dosya Aç...', 'Open File...'), accelerator: 'CmdOrCtrl+O', click: send('open-file') },
        { label: l('Klasör Aç...', 'Open Folder...'), accelerator: 'CmdOrCtrl+Shift+O', click: send('open-folder') },
        { type: 'separator' },
        { label: l('Kaydet', 'Save'), accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: l('Farklı Kaydet...', 'Save As...'), accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: l('Sekmeyi Kapat', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { type: 'separator' },
        { label: l('Çıkış', 'Exit'), role: 'quit' }
      ]
    },
    {
      label: l('Düzen', 'Edit'),
      submenu: [
        { label: l('Kes', 'Cut'), role: 'cut' },
        { label: l('Kopyala', 'Copy'), role: 'copy' },
        { label: l('Yapıştır', 'Paste'), role: 'paste' }
      ]
    },
    {
      label: 'Skript',
      submenu: [
        { label: l('Doğrula', 'Validate'), accelerator: 'F5', click: send('validate') },
        { type: 'separator' },
        { label: l("Addon'lar...", 'Addons...'), click: send('addons') },
        { label: l('Sürüm Geçiş Asistanı...', 'Version Migration Assistant...'), click: send('migration') },
        { type: 'separator' },
        { label: l('AI Agent', 'AI Agent'), accelerator: 'CmdOrCtrl+Shift+A', click: send('toggle-agent') }
      ]
    },
    {
      label: l('Git', 'Go'),
      submenu: [
        // Ctrl+Shift+O "Klasör Aç"ta; Ctrl+R geliştirmede "Yeniden Yükle", Ctrl+Shift+R Monaco'da refactor.
        { label: l('Sembole Git...', 'Go to Symbol...'), accelerator: 'CmdOrCtrl+Alt+O', click: send('go-to-symbol') }
      ]
    },
    {
      label: l('Görünüm', 'View'),
      submenu: [
        { label: l('Yakınlaştır', 'Zoom In'), role: 'zoomIn' },
        { label: l('Uzaklaştır', 'Zoom Out'), role: 'zoomOut' },
        { label: l('Gerçek Boyut', 'Actual Size'), role: 'resetZoom' },
        { type: 'separator' },
        { label: l('Tam Ekran', 'Full Screen'), role: 'togglefullscreen' },
        { type: 'separator' },
        {
          // Dil adı her iki dilde de bulunabilsin diye ikisi birlikte yazılır
          label: l('Dil (Language)', 'Language (Dil)'),
          submenu: LOCALES.map((locale) => ({
            label: LOCALE_NAMES[locale],
            type: 'radio' as const,
            checked: locale === getLocale(),
            click: () => onSelectLocale(locale)
          }))
        },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' as const },
              { label: l('Yeniden Yükle', 'Reload'), role: 'reload' as const },
              { label: l('Geliştirici Araçları', 'Developer Tools'), role: 'toggleDevTools' as const }
            ])
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
