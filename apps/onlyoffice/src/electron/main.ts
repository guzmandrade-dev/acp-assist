/**
 * Electron main (thin): everything shared lives in
 * @acp-assist/panel createElectronMain; this file only supplies the
 * ONLYOFFICE specifics.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { createElectronMain } from '@acp-assist/panel/electron';
import { createServer } from '../server.js';
import { PANEL_CONFIG } from '../panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createElectronMain({
  windowTitle: 'ONLYOFFICE ACP Assist',
  appName: 'ONLYOFFICE',
  // Per-app userData (Roaming/ONLYOFFICE ACP Assist) so history never
  // cross-seeds with the LyX / LibreOffice apps.
  userDataDirName: 'ONLYOFFICE ACP Assist',
  // DesktopEditors.exe reports its ProcessName as "editors" (always-on-top
  // follows the editor window while it is focused).
  watchedProcessName: 'editors',
  appDistDir: __dirname,
  // Per-app brand mark served over the shared panel's logo.svg.
  assetsDir: path.join(__dirname, '..', '..', 'public'),
  // The in-editor plugin connects OUT to a well-known port (its panel
  // has a port field; this is just the packaged default).
  listenPort: 8790,
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.userDataDir,
      // Packaged app: the .plugin rides in extraResources; dev: the repo copy.
      pluginPath: app.isPackaged
        ? path.join(process.resourcesPath, 'acp-bridge.plugin')
        : path.join(__dirname, '..', '..', 'acp-bridge.plugin'),
    }),
  // No in-editor status panel reads a discovery record; the plugin
  // connects straight to this companion's port.
  writeRecord: async () => {},
  removeRecord: async () => {},
});