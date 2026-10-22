import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, type MenuAction, type ServerStatus, type SkriptIdeApi } from '../shared/ipc'

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
  setSkriptVersion: (version) => ipcRenderer.invoke(IpcChannel.setSkriptVersion, version),
  setAddons: (addons) => ipcRenderer.invoke(IpcChannel.setAddons, addons),
  validateOnVersion: (version, requests) => ipcRenderer.invoke(IpcChannel.validateOnVersion, version, requests)
}

contextBridge.exposeInMainWorld('skriptIde', api)
