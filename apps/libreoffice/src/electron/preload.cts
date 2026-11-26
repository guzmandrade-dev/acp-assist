import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  toggleAlwaysOnTop: () => ipcRenderer.send('window/toggle-always-on-top'),
  /** Hold/release the OS sleep timer while a run is in flight (keepAwakeWhileBusy setting). */
  keepAwake: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keep-awake', on),
});