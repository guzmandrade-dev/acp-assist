/**
 * Electron wiring for the "download the release asset" updater: IPC
 * handlers + the startup check + the asset download. The pure logic
 * (semver, asset picking, API shape) lives in updater-core.ts so tests
 * run in plain Node.
 *
 * Flow: on startup (and on the panel's manual "Check for updates") the
 * main process asks the GitHub releases API for the latest PUBLISHED
 * release; if it is newer than the running build, the panel offers the
 * matching installer asset (Windows nsis .exe / macOS .dmg) for download
 * into the user's Downloads folder — running it installs over the old
 * version. On Linux there is no safe auto-install, so the panel opens
 * the GitHub releases page instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import {
  buildCheckResult,
  fetchLatestRelease,
  RELEASES_PAGE,
  type UpdateCheckResult,
} from './updater-core.js';

export interface UpdaterStatus extends UpdateCheckResult {
  /** False in dev (`npm start`) — only packaged builds check for updates. */
  packaged: boolean;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
  done: boolean;
  path?: string;
  error?: string;
}

/** Path of the last asset this process downloaded (the only path the
 * renderer may ask us to open — keeps `shell:open-path` honest). */
let lastDownloadedPath: string | null = null;

function sendToPanel(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function checkForUpdates(currentVersion: string): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    // Dev runs have no release to compare against.
    return { packaged: false, ...buildCheckResult(currentVersion, null, process.platform) };
  }
  const release = await fetchLatestRelease().catch((err: unknown) => {
    console.warn('updater: release check failed:', err instanceof Error ? err.message : err);
    return null;
  });
  return { packaged: true, ...buildCheckResult(currentVersion, release, process.platform) };
}

/** Download the picked asset into the user's Downloads folder. */
async function downloadAsset(
  asset: { name: string; url: string },
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  let dir = app.getPath('downloads');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
  }
  const dest = path.join(dir, asset.name);
  const res = await fetch(asset.url, {
    headers: { 'user-agent': 'acp-assist-updater' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const total = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  const out = fs.createWriteStream(dest);
  let received = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      out.write(chunk);
      onProgress({ received, total: Number.isNaN(total) ? null : total, done: false });
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  lastDownloadedPath = dest;
  onProgress({ received, total: Number.isNaN(total) ? null : total, done: true, path: dest });
  return dest;
}

/**
 * Register the updater IPC handlers and schedule the one startup check.
 * Call once from the app's main.ts with the version from package.json.
 */
export function initUpdater(currentVersion: string): void {
  ipcMain.handle('app:version', () => currentVersion);

  ipcMain.handle('updater:check', () => checkForUpdates(currentVersion));

  ipcMain.handle('updater:download', async (_event, asset: { name: string; url: string }) => {
    try {
      const dest = await downloadAsset(asset, (p) => sendToPanel('updater:progress', p));
      return { ok: true, path: dest };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendToPanel('updater:progress', { received: 0, total: null, done: true, error: message });
      return { ok: false, error: message };
    }
  });

  // Open the downloaded installer/disk image (only ever the file this
  // process downloaded).
  ipcMain.handle('shell:open-path', async (_event, p: unknown) => {
    if (typeof p === 'string' && p === lastDownloadedPath && fs.existsSync(p)) {
      const err = await shell.openPath(p);
      return err || null;
    }
    return 'refused';
  });

  // Open an external https URL (the GitHub releases page on Linux).
  ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) {
      await shell.openExternal(url);
      return null;
    }
    return 'refused';
  });

  // One non-blocking check shortly after launch; the panel renders the
  // result when it arrives (and can re-check manually anytime).
  app.whenReady().then(() => {
    setTimeout(() => {
      void checkForUpdates(currentVersion).then((status) => {
        if (status.packaged) sendToPanel('updater:status', status);
      });
    }, 3000);
  });
}

export { RELEASES_PAGE };
