// 렌더러에 노출하는 최소 API. ipcRenderer 자체는 노출하지 않는다.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

import type { CtdApi } from '../shared/api';

type Unsub = () => void;
function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsub {
  const h = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: CtdApi = {
  init: () => ipcRenderer.invoke('app:init'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: (kind) => ipcRenderer.invoke('dialog:pickFiles', kind),
  pickAddDir: () => ipcRenderer.invoke('dialog:pickAddDir'),
  saveClipboardImage: () => ipcRenderer.invoke('clip:saveImage'),
  // 드롭한 File의 실제 경로(Electron 32+는 File.path 제거). 경로를 못 얻으면 빈 문자열
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  newSession: (folder, plain) => ipcRenderer.invoke('session:new', folder, plain === true),
  openHistory: (sessionId, force) => ipcRenderer.invoke('history:open', sessionId, force === true),
  refreshHistory: () => ipcRenderer.send('history:refresh'),
  detachTab: (tabId) => ipcRenderer.invoke('tab:detach', tabId),
  terminateTab: (tabId) => ipcRenderer.invoke('tab:terminate', tabId),
  saveCollapsed: (keys) => ipcRenderer.send('ui:collapsed', keys),
  saveTabUi: (session, ui) => ipcRenderer.send('ui:tab', session, ui),
  saveSidebarCollapsed: (collapsed) => ipcRenderer.send('ui:sidebar', collapsed),
  saveSidebarWidth: (width) => ipcRenderer.send('ui:sidebarWidth', width),
  saveHistoryFilter: (filter) => ipcRenderer.send('ui:filter', filter),
  sendInput: (tabId, pane, text) => ipcRenderer.invoke('pane:input', tabId, pane, text),
  sendKeys: (tabId, pane, data) => ipcRenderer.send('pane:keys', tabId, pane, data),
  resizePane: (tabId, pane, cols, rows) => ipcRenderer.send('pane:resize', tabId, pane, cols, rows),
  requestResync: (tabId, pane) => ipcRenderer.send('pane:resync', tabId, pane),
  paneInfo: (tabId, pane) => ipcRenderer.invoke('pane:info', tabId, pane),
  requestStop: (tabId, pane, name) => ipcRenderer.invoke('pane:stop', tabId, pane, name),
  reconnect: (tabId) => ipcRenderer.send('tab:reconnect', tabId),
  onTabState: (cb) => on('tab:state', cb),
  onTabClosed: (cb) => on('tab:closed', cb),
  onHistory: (cb) => on('history:update', cb),
  onRunning: (cb) => on('history:running', cb),
  onDetached: (cb) => on('session:detached', cb),
  onOutput: (cb) => on('pane:output', cb),
  onResync: (cb) => on('pane:resync', cb),
  onSize: (cb) => on('pane:size', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  getLanguage: () => ipcRenderer.invoke('settings:language'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:setLanguage', lang),
  onAppearance: (cb) => on('settings:appearance', cb),
  getAccount: () => ipcRenderer.invoke('account:get'),
  listSessions: () => ipcRenderer.invoke('psmux:sessions'),
  openAppSession: (name) => ipcRenderer.invoke('psmux:open', name),
  appInfo: () => ipcRenderer.invoke('app:info'),
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),
  onUsage: (cb) => on('usage:update', cb),
  renameHistory: (key, title) => ipcRenderer.invoke('history:rename', key, title),
  archiveHistory: (key, archived) => ipcRenderer.invoke('history:archive', key, archived),
  trashPreview: (sessionId) => ipcRenderer.invoke('history:trashPreview', sessionId),
  trashHistory: (sessionId) => ipcRenderer.invoke('history:trash', sessionId),
  terminateHistory: (sessionId) => ipcRenderer.invoke('history:terminate', sessionId),
  attachDetached: (session) => ipcRenderer.invoke('session:attach', session),
  stopDetached: (session) => ipcRenderer.invoke('session:stopDetached', session),
  logout: () => ipcRenderer.invoke('auth:logout'),
  login: () => ipcRenderer.invoke('auth:login'),
  onAccount: (cb) => on('account:update', cb),
  listAgents: (tabId) => ipcRenderer.invoke('agents:list', tabId),
  setLeadAgent: (name) => ipcRenderer.invoke('agents:setLead', name),
  copyAgentTemplate: () => ipcRenderer.invoke('agents:copyTemplate'),
  openAgentsFolder: () => ipcRenderer.invoke('agents:openFolder'),
  getLeadCommand: () => ipcRenderer.invoke('agents:leadCommand'),
};

contextBridge.exposeInMainWorld('ctd', api);
