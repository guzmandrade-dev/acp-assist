/** ONLYOFFICE panel configuration: consumed by the shared
 * @acp-assist/panel assets via the injected index.html. */
import type { PanelConfig } from '@acp-assist/panel';

export const PANEL_CONFIG: PanelConfig = {
  appName: 'ONLYOFFICE',
  appTitle: 'ONLYOFFICE ACP Assist',
  fenceRe: '(?:writer|calc|impress)',
  statusKey: 'bridgeAvailable',
  statusMissing:
    'ONLYOFFICE editor not connected — the bridge auto-starts when the editor opens; if not, open the ACP Assist Bridge plugin from the Plugins tab',
  cursorTerm: 'style',
  hasSaveConsent: false,
  // The .plugin is installed via the editor's own Plugin Manager; there
  // is no one-click install from this panel — but the panel offers the
  // bundled .plugin as a download (manual install/update path).
  hasInstallFlow: false,
  bridgeDownload: true,
  composerRefreshSelection: true,
  busyText: 'talking to ONLYOFFICE\u2026',
  eventPush: true,
  theme: null,
  // The bridge .plugin runs inside the editor itself; the picker records
  // which desktop build is the target (the Euro-Office fork keeps the same
  // window.Asc plugin API). Drives the targetApp agent setting.
  targetApps: [
    { id: 'onlyoffice', label: 'ONLYOFFICE Desktop Editors', hint: 'The bridge plugin is installed via ONLYOFFICE\'s Plugin Manager.' },
    { id: 'euro-office', label: 'Euro-Office', hint: 'The AGPL ONLYOFFICE fork; the same bridge .plugin works (same window.Asc plugin API).' },
  ],
};