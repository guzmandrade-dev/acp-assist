/**
 * Standalone server entry (no Electron): serves the SHARED panel and the
 * API on a dynamic port (PORT env overrides). Used for development and
 * for driving the app end-to-end from scripts/tools. The in-editor
 * plugin connects to this same port (its panel has a port field,
 * default 8790).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createStandaloneServer } from '@acp-assist/panel';
import { PANEL_CONFIG } from './panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createStandaloneServer({
  appName: 'ONLYOFFICE',
  dataDirName: 'oo-acp-assist-dev',
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.settingsDir,
    }),
  // No in-editor status panel reads a discovery record (unlike the LO
  // sidebar); the plugin connects straight to this port.
  writeRecord: async () => {},
});