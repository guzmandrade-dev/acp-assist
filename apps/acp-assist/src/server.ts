/**
 * Unified ACP Assist server: ONE Express host running the LyX,
 * LibreOffice, and ONLYOFFICE companion backends side by side, with one
 * editor app active in the panel at a time.
 *
 * Routing: the panel is served at /?app=<id> and the boot script carries
 * an APP-SCOPED bearer token ("<app>:<raw>"), so every /api request is
 * dispatched to the matching sub-server, which re-checks the raw token
 * with its own auth guard. The ONLYOFFICE in-editor plugin's /bridge/*
 * long-polls carry no token (file:// iframe, no secret delivery channel)
 * and always route to the ONLYOFFICE sub-server; the server binds
 * 127.0.0.1 only.
 *
 * Isolation: each sub-server keeps its own sessions and its own history
 * directory (history/<app>), so switching apps never cross-seeds
 * document conversations; agent settings are shared (userData root).
 */

import fsSync from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  createServer as createLyxServer,
  type AgentRunner,
  type AgentSettings,
} from 'lyx-acp-assist/dist/server.js';
import { createNativeClipboard } from 'lyx-acp-assist/dist/clipboard/native-clipboard.js';
import { PANEL_CONFIG as LYX_PANEL_CONFIG } from 'lyx-acp-assist/dist/panel-config.js';
import type { LyxServerClient } from 'lyx-acp-assist/dist/lyxserver/client.js';
import {
  createServer as createLoServer,
} from 'libreoffice-acp-assist/dist/server.js';
import { PANEL_CONFIG as LO_PANEL_CONFIG } from 'libreoffice-acp-assist/dist/panel-config.js';
import type { BridgeClient } from 'libreoffice-acp-assist/dist/bridge/client.js';
import {
  createServer as createOoServer,
} from 'onlyoffice-acp-assist/dist/server.js';
import { PANEL_CONFIG as OO_PANEL_CONFIG } from 'onlyoffice-acp-assist/dist/panel-config.js';
import type { PluginBridge } from 'onlyoffice-acp-assist/dist/bridge/plugin-bridge.js';
import {
  createPanelBootScript,
  createPanelIndexHandler,
  panelPublicDir,
  type PanelConfig,
} from '@acp-assist/panel';

export type UnifiedAppId = 'lyx' | 'libreoffice' | 'onlyoffice';

/** The bundled editor apps, in switcher order. */
const APP_DEFS: { id: UnifiedAppId; label: string }[] = [
  { id: 'libreoffice', label: 'LibreOffice' },
  { id: 'lyx', label: 'LyX' },
  { id: 'onlyoffice', label: 'ONLYOFFICE' },
];

const DEFAULT_APP: UnifiedAppId = 'libreoffice';

interface SubApp {
  id: UnifiedAppId;
  config: PanelConfig;
  server: express.Express;
}

export interface UnifiedServerOptions {
  /** The SHARED panel package's public dir (defaults to panelPublicDir()). */
  publicDir?: string;
  /** Per-app asset overrides served BEFORE the shared panel dir (logo.svg). */
  assetsDir?: string;
  /** Root userData dir; per-app history lives in <historyDir>/<app>. */
  userDataDir: string;
  historyDir?: string;
  attachmentsDir?: string;
  logDir?: string;
  /** LibreOffice bridge .oxt for the one-click install flow. */
  oxtPath?: string;
  /** ONLYOFFICE bridge .plugin for the panel's "Download bridge" flow. */
  pluginPath?: string;
  /** Idle-session GC; see createCompanionServer. */
  sessionIdleMs?: number;
  /** Test hook: fixed per-app bearer tokens. */
  apiTokens?: Partial<Record<UnifiedAppId, string>>;
  /** Test hook: inject a fake agent process into every sub-server. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /** Test hook: inject a fake LyXServerClient. */
  lyxFactory?: () => LyxServerClient;
  /** Test hook: inject a fake LibreOffice bridge client. */
  bridgeFactory?: () => BridgeClient;
  /** Test hook: inject a fake ONLYOFFICE plugin bridge. */
  pluginBridge?: PluginBridge;
}

export function createServer(options: UnifiedServerOptions): express.Express {
  const publicDir = options.publicDir ?? panelPublicDir();
  const userDataDir = options.userDataDir;
  const historyRoot = options.historyDir ?? path.join(userDataDir, 'history');

  const subs = new Map<UnifiedAppId, SubApp>();
  const add = (id: UnifiedAppId, config: PanelConfig, server: express.Express): void => {
    subs.set(id, {
      id,
      config: {
        ...config,
        appId: id,
        switcher: { current: id, apps: APP_DEFS },
      },
      server,
    });
  };

  add(
    'libreoffice',
    LO_PANEL_CONFIG,
    createLoServer({
      panelConfig: LO_PANEL_CONFIG,
      historyDir: path.join(historyRoot, 'libreoffice'),
      attachmentsDir: options.attachmentsDir,
      logDir: options.logDir,
      // Shared agent settings: one agent command for all editor apps.
      settingsDir: userDataDir,
      oxtPath: options.oxtPath,
      sessionIdleMs: options.sessionIdleMs,
      apiToken: options.apiTokens?.libreoffice,
      agentFactory: options.agentFactory,
      bridgeFactory: options.bridgeFactory,
    }),
  );
  add(
    'lyx',
    LYX_PANEL_CONFIG,
    createLyxServer({
      panelConfig: LYX_PANEL_CONFIG,
      clipboard: createNativeClipboard(),
      historyDir: path.join(historyRoot, 'lyx'),
      attachmentsDir: options.attachmentsDir,
      logDir: options.logDir,
      settingsDir: userDataDir,
      sessionIdleMs: options.sessionIdleMs,
      apiToken: options.apiTokens?.lyx,
      agentFactory: options.agentFactory,
      lyxFactory: options.lyxFactory,
    }),
  );
  add(
    'onlyoffice',
    OO_PANEL_CONFIG,
    createOoServer({
      panelConfig: OO_PANEL_CONFIG,
      historyDir: path.join(historyRoot, 'onlyoffice'),
      attachmentsDir: options.attachmentsDir,
      logDir: options.logDir,
      settingsDir: userDataDir,
      sessionIdleMs: options.sessionIdleMs,
      apiToken: options.apiTokens?.onlyoffice,
      agentFactory: options.agentFactory,
      pluginBridge: options.pluginBridge,
      pluginPath: options.pluginPath,
    }),
  );

  // --- root host -----------------------------------------------------------

  const root = express();

  const scopedToken = (sub: SubApp): string =>
    `${sub.id}:${sub.server.locals.apiToken as string}`;

  const indexHandlers = new Map<UnifiedAppId, express.RequestHandler>();
  const bootHandlers = new Map<UnifiedAppId, express.RequestHandler>();
  for (const sub of subs.values()) {
    const token = scopedToken(sub);
    indexHandlers.set(sub.id, createPanelIndexHandler(publicDir, { token, config: sub.config }));
    bootHandlers.set(sub.id, createPanelBootScript({ token, config: sub.config }));
  }

  // The discovery record is read by the LibreOffice sidebar, which probes
  // /api/status — expose the app-scoped LibreOffice token for it.
  const loSub = subs.get('libreoffice');
  if (loSub) root.locals.apiToken = scopedToken(loSub);

  /** Last app the user had open (persisted across launches; re-read per
   * page load so a switch within this run is honored immediately). */
  const activeAppFile = path.join(userDataDir, 'active-app.json');
  const readDefaultApp = (): UnifiedAppId => {
    try {
      const saved = JSON.parse(fsSync.readFileSync(activeAppFile, 'utf8')) as { app?: string };
      if (saved.app && subs.has(saved.app as UnifiedAppId)) return saved.app as UnifiedAppId;
    } catch {
      /* first run */
    }
    return DEFAULT_APP;
  };
  const persistActiveApp = (id: UnifiedAppId): void => {
    fsSync.promises
      .mkdir(userDataDir, { recursive: true })
      .then(() => fsSync.promises.writeFile(activeAppFile, JSON.stringify({ app: id }), 'utf8'))
      .catch(() => undefined);
  };

  const requestedApp = (req: express.Request): UnifiedAppId | null => {
    const q = req.query['app'];
    if (typeof q === 'string' && subs.has(q as UnifiedAppId)) return q as UnifiedAppId;
    return null;
  };

  root.get('/', (req, res, next) => {
    const id = requestedApp(req) ?? readDefaultApp();
    persistActiveApp(id);
    indexHandlers.get(id)?.(req, res, next);
  });

  root.get('/panel-boot.js', (req, res, next) => {
    const id = requestedApp(req);
    if (!id) {
      res.status(400).json({ error: 'app query parameter required' });
      return;
    }
    bootHandlers.get(id)?.(req, res, next);
  });

  if (options.assetsDir) {
    root.use(express.static(options.assetsDir, { maxAge: 0, etag: false, lastModified: false }));
  }
  root.use(express.static(publicDir, { maxAge: 0, etag: false, lastModified: false }));

  // Dispatch everything else to a sub-server. /bridge/* always goes to
  // ONLYOFFICE (the in-editor plugin has no token); /api/* goes to the
  // app encoded in the scoped bearer token, after re-checking the raw
  // token and stripping the prefix for the sub-server's own guard.
  root.use((req, res, next) => {
    if (req.path.startsWith('/bridge/')) {
      subs.get('onlyoffice')?.server(req, res, next);
      return;
    }
    const match = /^Bearer ([a-z]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
    const sub = match ? subs.get(match[1] as UnifiedAppId) : undefined;
    if (!sub || match?.[2] !== (sub.server.locals.apiToken as string)) {
      res.status(401).json({ error: 'unauthorized: API bearer token required' });
      return;
    }
    req.headers.authorization = `Bearer ${match[2]}`;
    sub.server(req, res, next);
  });

  return root;
}
