import { contextBridge, ipcRenderer } from 'electron'
import type { MikoDesktopApi, MikoEvent, MikoSettingsPatch } from './shared/types.js'

const api: MikoDesktopApi = {
  getStatus: () => ipcRenderer.invoke('miko:get-status'),
  getSettings: () => ipcRenderer.invoke('miko:get-settings'),
  updateSettings: (patch: MikoSettingsPatch) => ipcRenderer.invoke('miko:update-settings', patch),
  setListening: (enabled: boolean) => ipcRenderer.invoke('miko:set-listening', enabled),
  listInputDevices: () => ipcRenderer.invoke('miko:list-input-devices'),
  installWakeModel: (confirmedSourceTerms: boolean) => ipcRenderer.invoke('miko:install-wake-model', confirmedSourceTerms),
  startWakeListening: () => ipcRenderer.invoke('miko:start-wake-listening'),
  startKwsTest: () => ipcRenderer.invoke('miko:start-kws-test'),
  setLiveSessionActive: (active: boolean) => ipcRenderer.invoke('miko:set-live-active', active),
  renewLiveSessionLease: () => ipcRenderer.invoke('miko:renew-live-lease'),
  pauseWakeListening: () => ipcRenderer.invoke('miko:pause-wake-listening'),
  endConversation: () => ipcRenderer.invoke('miko:end-conversation'),
  startCodexAuth: () => ipcRenderer.invoke('miko:start-codex-auth'),
  openHomeRail: () => ipcRenderer.invoke('miko:open-home-rail'),
  openSoundSettings: () => ipcRenderer.invoke('miko:open-sound-settings'),
  exportDiagnostics: () => ipcRenderer.invoke('miko:export-diagnostics'),
  showWindow: () => ipcRenderer.invoke('miko:show-window'),
  quit: () => ipcRenderer.invoke('miko:quit'),
  onEvent: (listener: (event: MikoEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: MikoEvent) => listener(payload)
    ipcRenderer.on('miko:event', handler)
    return () => ipcRenderer.removeListener('miko:event', handler)
  },
}

contextBridge.exposeInMainWorld('homerailMiko', api)
