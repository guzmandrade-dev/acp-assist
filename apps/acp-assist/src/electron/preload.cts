import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  toggleAlwaysOnTop: () => ipcRenderer.send('window/toggle-always-on-top'),
  /** Hold/release the OS sleep timer while a run is in flight (keepAwakeWhileBusy setting). */
  keepAwake: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keep-awake', on),
  /** Native "open a PDF" picker; resolves to the absolute path or null. */
  pickPdf: (): Promise<string | null> => ipcRenderer.invoke('acp:pick-pdf'),
  /** The real filesystem path of a File from an <input type="file">. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});
