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
    createFile: async () => unavailable(),
    createDirectory: async () => unavailable(),
    renamePath: async () => unavailable(),
    trashPath: async () => unavailable(),
    transferPath: async () => unavailable(),
    revealPath: async () => unavailable(),
    showContextMenu: async () => null,
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
    lastProject: async () => null,
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
    validateOnVersion: async () => unavailable(),
    agentGetState: async () => ({
      settings: { providerId: null, modelId: null, effort: null, permissionMode: 'ask-when-needed' },
      sessionId: null,
      running: false,
      messages: [],
      keySource: 'none',
      configuredProviders: [],
      encryptionAvailable: false,
      codex: { signedIn: false, email: null, plan: null },
      goal: null,
      todos: [],
      usage: {
        uncached: 0,
        cached: 0,
        written: 0,
        output: 0,
        cost: 0,
        hitRate: null,
        totalHitRate: null,
        contextTokens: 0,
        contextWindow: 0,
        reBilledTokens: 0,
        reBilledCost: 0,
        reBilledCount: 0,
        byModel: []
      },
      permissionMode: 'ask-when-needed'
    }),
    agentListProviders: async () => unavailable(),
    agentSetSettings: async () => unavailable(),
    agentSetApiKey: async () => unavailable(),
    agentKeySource: async () => 'none',
    agentCodexLogin: async () => unavailable(),
    agentCodexLogout: async () => unavailable(),
    agentSend: async () => unavailable(),
    agentListFiles: async () => [],
    agentBtw: async () => unavailable(),
    agentBtwCancel: async () => {},
    agentCancel: async () => {},
    agentReset: async () => {},
    agentListSessions: async () => [],
    agentLoadSession: async () => unavailable(),
    agentDeleteSession: async () => unavailable(),
    agentUndo: async () => unavailable(),
    agentSetGoal: async () => unavailable(),
    agentCompact: async () => unavailable(),
    agentSetPermissionMode: async () => unavailable(),
    agentRespondApproval: () => {},
    onAgentEvent: () => () => {}
  }
}

export const api: SkriptIdeApi = window.skriptIde ?? createBrowserFallback()
