import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type InteractiveMode, type ModelSettings, type RunnerEvent, type TemporalApi, type WorkspaceSnapshot } from '../shared/contracts'

const temporal: TemporalApi = {
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  listSessions: (workspacePath) => ipcRenderer.invoke(IPC.listSessions, workspacePath),
  openSession: (workspacePath, sessionId) => ipcRenderer.invoke(IPC.openSession, workspacePath, sessionId),
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  saveDraft: (draft: string, mode: InteractiveMode) => ipcRenderer.invoke(IPC.saveDraft, draft, mode),
  submit: (spec: string, mode: InteractiveMode) => ipcRenderer.invoke(IPC.submit, spec, mode),
  startLoop: (force = false) => ipcRenderer.invoke(IPC.startLoop, force),
  cancelRun: () => ipcRenderer.invoke(IPC.cancelRun),
  endRound: () => ipcRenderer.invoke(IPC.endRound),
  setPermission: (preset) => ipcRenderer.invoke(IPC.setPermission, preset),
  getModelSettings: () => ipcRenderer.invoke(IPC.getModelSettings),
  saveModelSettings: (settings: Omit<ModelSettings, 'hasCredential'> & { credential?: string }) =>
    ipcRenderer.invoke(IPC.saveModelSettings, settings),
  getUiPreferences: () => ipcRenderer.invoke(IPC.getUiPreferences),
  saveUiPreferences: (preferences) => ipcRenderer.invoke(IPC.saveUiPreferences, preferences),
  onSnapshot: (listener: (snapshot: WorkspaceSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.snapshotChanged, handler)
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler)
  },
  onRunnerEvent: (listener: (event: RunnerEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, runnerEvent: RunnerEvent): void => listener(runnerEvent)
    ipcRenderer.on(IPC.runnerEvent, handler)
    return () => ipcRenderer.removeListener(IPC.runnerEvent, handler)
  }
}

contextBridge.exposeInMainWorld('temporal', temporal)
