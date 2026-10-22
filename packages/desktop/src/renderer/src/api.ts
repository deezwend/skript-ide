// Yalnızca saf veri modülü; paketin geri kalanı Node API'leri kullandığından arayüze alınmaz
import { DEFAULT_SKRIPT_VERSION, SKRIPT_RUNTIMES } from '@skript-ide/runtime-validator/src/versions'
import { checkAddonSelections } from '@skript-ide/runtime-validator/src/addons'
import type { ProjectState, SkriptIdeApi } from '../../shared/ipc'

import { l, parseLocale } from '@skript-ide/i18n'
/**
 * Arayüz Vite sunucusu üzerinden düz bir tarayıcıda açıldığında preload yoktur.
 * Bu durumda editör ve Syntax Tarayıcısı yine çalışır; dosya sistemi ve doğrulama sunucusu devre dışı kalır,
 * sürüm seçimi yalnızca bu sayfa için geçerlidir.
 */
function createBrowserFallback(): SkriptIdeApi {
  const unavailable = (): never => {
    throw new Error(l('Bu işlem yalnızca masaüstü uygulamasında çalışır.', 'This action only works in the desktop app.'))
  }
  let project: ProjectState = { root: null, settings: { skriptVersion: DEFAULT_SKRIPT_VERSION }, fromFile: false }
  return {
    openFolderDialog: async () => unavailable(),
    openFileDialog: async () => unavailable(),
    saveFileDialog: async () => unavailable(),
    readDir: async () => unavailable(),
    readFile: async () => unavailable(),
    writeFile: async () => unavailable(),
    setDirty: () => {},
    onMenuAction: () => () => {},
    platform: 'browser',
    locale:
      parseLocale(new URLSearchParams(location.search).get('lang')) ?? (parseLocale(navigator.language) === 'tr' ? 'tr' : 'en'),
    getMenuLabels: async () => [],
    popupMenu: async () => {},
    getServerStatus: async () => ({
      state: 'stopped',
      message: l('Doğrulama yalnızca masaüstü uygulamasında çalışır', 'Validation only works in the desktop app'),
      versions: { minecraft: '-', skript: '-' },
      eulaUrl: 'https://aka.ms/MinecraftEULA'
    }),
    getServerLog: async () => '',
    startServer: async () => unavailable(),
    acceptEula: async () => unavailable(),
    validate: async () => unavailable(),
    sendServerCommand: async () => unavailable(),
    onServerStatus: () => () => {},
    onServerLog: () => () => {},
    listSkriptVersions: async () =>
      SKRIPT_RUNTIMES.map((profile) => ({ ...profile, isDefault: profile.skript === DEFAULT_SKRIPT_VERSION, javaAvailable: null })),
    openProject: async () => project,
    setSkriptVersion: async (version) => {
      project = { ...project, settings: { ...project.settings, skriptVersion: version } }
      project.addonIssues = checkAddonSelections(project.settings.addons ?? [], version)
      return project
    },
    setAddons: async (addons) => {
      project = { ...project, settings: { ...project.settings, addons } }
      project.addonIssues = checkAddonSelections(addons, project.settings.skriptVersion)
      return project
    },
    validateOnVersion: async () => unavailable()
  }
}

export const api: SkriptIdeApi = window.skriptIde ?? createBrowserFallback()
