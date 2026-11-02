/** ONLYOFFICE panel configuration: consumed by the shared
 * @acp-assist/panel assets via the injected index.html. */
import type { PanelConfig } from '@acp-assist/panel';

export const PANEL_CONFIG: PanelConfig = {
  appName: 'ONLYOFFICE',
  appTitle: 'ONLYOFFICE ACP Assist',
  fenceRe: '(?:writer|calc|impress)',
  statusKey: 'bridgeAvailable',
  statusMissing:
    'ONLYOFFICE editor not connected — open the ACP Assist Bridge plugin from the editor\u2019s Plugins tab',
  cursorTerm: 'style',
  hasSaveConsent: false,
  // The .plugin is installed via the editor's own Plugin Manager; there
  // is no one-click install from this panel.
  hasInstallFlow: false,
  composerRefreshSelection: true,
  busyText: 'talking to ONLYOFFICE\u2026',
  eventPush: true,
  theme: null,
};