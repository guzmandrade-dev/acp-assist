/**
 * Electron main (thin) for the unified ACP Assist app: everything shared
 * lives in @acp-assist/panel createElectronMain; this file only supplies
 * the unified specifics — all three editor process names are watched for
 * the float-on-top follow, and the server is the multi-app dispatcher.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { createElectronMain } from '@acp-assist/panel/electron';
import {
  writeCompanionRecord,
  removeCompanionRecord,
} from 'libreoffice-acp-assist/dist/bridge/client.js';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createElectronMain({
  windowTitle: 'ACP Assist',
  appName: 'ACP Assist',
  // One userData dir for the unified app; per-app histories live in
  // subdirectories of it (see the unified server).
  userDataDirName: 'acp-assist',
  // Float over whichever bundled editor is focused: LyX, soffice.bin
  // (ProcessName "soffice"), or ONLYOFFICE DesktopEditors.exe ("editors").
  watchedProcessName: ['LyX', 'soffice', 'editors'],
  appDistDir: __dirname,
  // The app's own logo.svg (all other panel assets are shared).
  assetsDir: path.join(__dirname, '..', '..', 'public'),
  // Fixed well-known port: the ONLYOFFICE in-editor plugin connects OUT
  // to the companion and cannot read a discovery record (its panel has
  // a port field; 8790 is the packaged default).
  listenPort: 8790,
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      userDataDir: paths.userDataDir,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      // Packaged app: the oxt rides in extraResources; dev: the
      // libreoffice app's repo dir.
      oxtPath: oxtPath(),
      // Same for the ONLYOFFICE bridge plugin (the panel's Download bridge).
      pluginPath: pluginPath(),
    }),
  // Discovery record for the in-LibreOffice status panel (it reads the
  // hardcoded "LibreOffice ACP Assist" dir). The record's URL opens the
  // panel in LibreOffice mode and its token is app-scoped, so the
  // sidebar's /api/status probe routes to the LibreOffice sub-server.
  writeRecord: ({ url, port, token, exe }) =>
    writeCompanionRecord({
      pid: process.pid,
      port,
      url: `${url}/?app=libreoffice`,
      exe,
      token,
    }),
  removeRecord: () => removeCompanionRecord(),
});

function oxtPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'acp-bridge.oxt')
    : path.join(__dirname, '..', '..', '..', 'libreoffice', 'acp-bridge.oxt');
}

function pluginPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'acp-bridge.plugin')
    : path.join(__dirname, '..', '..', '..', 'onlyoffice', 'acp-bridge.plugin');
}
