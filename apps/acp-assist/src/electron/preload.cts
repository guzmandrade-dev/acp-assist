import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  toggleAlwaysOnTop: () => ipcRenderer.send('window/toggle-always-on-top'),
  /** Hold/release the OS sleep timer while a run is in flight (keepAwakeWhileBusy setting). */
  keepAwake: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keep-awake', on),
  /** Native "open a PDF" picker; resolves to the absolute path or null. */
  pickPdf: (): Promise<string | null> => ipcRenderer.invoke('acp:pick-pdf'),
  /** The real filesystem path of a File from an <input type="file">. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** The app's own version (from its package.json). */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** Check GitHub for a newer published release; resolves to the status. */
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  /** Download the given release asset; resolves to { ok, path?, error? }. */
  downloadUpdate: (asset: { name: string; url: string }): Promise<unknown> =>
    ipcRenderer.invoke('updater:download', asset),
  /** Open the downloaded installer/disk image (only the downloaded file). */
  openPath: (p: string): Promise<string | null> => ipcRenderer.invoke('shell:open-path', p),
  /** Open an external https URL (e.g. the GitHub releases page). */
  openExternal: (url: string): Promise<string | null> => ipcRenderer.invoke('shell:open-external', url),
  /** Startup update-check result pushed from the main process. */
  onUpdaterStatus: (cb: (status: unknown) => void): (() => void) => {
    const listener = (_e: unknown, status: unknown): void => cb(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  /** Download progress pushed from the main process. */
  onUpdaterProgress: (cb: (p: unknown) => void): (() => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p);
    ipcRenderer.on('updater:progress', listener);
    return () => ipcRenderer.removeListener('updater:progress', listener);
  },
});
