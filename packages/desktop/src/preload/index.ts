import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, type AgentUiEvent, type MenuAction, type ServerStatus, type SkriptIdeApi } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: SkriptIdeApi = {
  openFolderDialog: () => ipcRenderer.invoke(IpcChannel.openFolderDialog),
  openFileDialog: () => ipcRenderer.invoke(IpcChannel.openFileDialog),
  saveFileDialog: (suggestedName) => ipcRenderer.invoke(IpcChannel.saveFileDialog, suggestedName),
  readDir: (dir) => ipcRenderer.invoke(IpcChannel.readDir, dir),
  readFile: (path) => ipcRenderer.invoke(IpcChannel.readFile, path),
  writeFile: (path, content) => ipcRenderer.invoke(IpcChannel.writeFile, path, content),
  setDirty: (dirty) => ipcRenderer.send(IpcChannel.setDirty, dirty),
  onMenuAction: (listener) => subscribe<MenuAction>(IpcChannel.menuAction, listener),
  platform: process.platform,
  locale: ipcRenderer.sendSync(IpcChannel.locale),
  getMenuLabels: () => ipcRenderer.invoke(IpcChannel.menuLabels),
  popupMenu: (index, x, y) => ipcRenderer.invoke(IpcChannel.menuPopup, index, x, y),
  getServerStatus: () => ipcRenderer.invoke(IpcChannel.serverStatus),
  getServerLog: () => ipcRenderer.invoke(IpcChannel.serverLog),
  startServer: () => ipcRenderer.invoke(IpcChannel.serverStart),
  acceptEula: () => ipcRenderer.invoke(IpcChannel.serverAcceptEula),
  validate: (request) => ipcRenderer.invoke(IpcChannel.serverValidate, request),
  sendServerCommand: (command) => ipcRenderer.invoke(IpcChannel.serverCommand, command),
  onServerStatus: (listener) => subscribe<ServerStatus>(IpcChannel.serverStatusChanged, listener),
  onServerLog: (listener) => subscribe<string>(IpcChannel.serverLogOutput, listener),
  listSkriptVersions: () => ipcRenderer.invoke(IpcChannel.skriptVersions),
  openProject: (root) => ipcRenderer.invoke(IpcChannel.openProject, root),
  lastProject: () => ipcRenderer.invoke(IpcChannel.lastProject),
  setSkriptVersion: (version) => ipcRenderer.invoke(IpcChannel.setSkriptVersion, version),
  setAddons: (addons) => ipcRenderer.invoke(IpcChannel.setAddons, addons),
  validateOnVersion: (version, requests) => ipcRenderer.invoke(IpcChannel.validateOnVersion, version, requests),
  agentGetState: () => ipcRenderer.invoke(IpcChannel.agentState),
  agentListProviders: (refresh) => ipcRenderer.invoke(IpcChannel.agentProviders, refresh === true),
  agentSetSettings: (settings) => ipcRenderer.invoke(IpcChannel.agentSetSettings, settings),
  agentSetApiKey: (providerId, key) => ipcRenderer.invoke(IpcChannel.agentSetApiKey, providerId, key),
  agentKeySource: (providerId) => ipcRenderer.invoke(IpcChannel.agentKeySource, providerId),
  agentCodexLogin: () => ipcRenderer.invoke(IpcChannel.agentCodexLogin),
  agentCodexLogout: () => ipcRenderer.invoke(IpcChannel.agentCodexLogout),
  agentSend: (text, problems) => ipcRenderer.invoke(IpcChannel.agentSend, text, problems),
  agentListFiles: () => ipcRenderer.invoke(IpcChannel.agentListFiles),
  agentCancel: () => ipcRenderer.invoke(IpcChannel.agentCancel),
  agentReset: () => ipcRenderer.invoke(IpcChannel.agentReset),
  agentListSessions: () => ipcRenderer.invoke(IpcChannel.agentSessions),
  agentLoadSession: (id) => ipcRenderer.invoke(IpcChannel.agentLoadSession, id),
  agentDeleteSession: (id) => ipcRenderer.invoke(IpcChannel.agentDeleteSession, id),
  agentUndo: () => ipcRenderer.invoke(IpcChannel.agentUndo),
  agentSetGoal: (goal) => ipcRenderer.invoke(IpcChannel.agentSetGoal, goal),
  agentSetPermissionMode: (mode) => ipcRenderer.invoke(IpcChannel.agentSetPermissionMode, mode),
  agentRespondApproval: (id, approved) => ipcRenderer.send(IpcChannel.agentApproval, id, approved),
  onAgentEvent: (listener) => subscribe<AgentUiEvent>(IpcChannel.agentEvent, listener)
}

contextBridge.exposeInMainWorld('skriptIde', api)
