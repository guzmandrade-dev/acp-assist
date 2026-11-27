/** LibreOffice panel configuration: consumed by the shared
 * @acp-assist/panel assets via the injected index.html. */
import type { PanelConfig } from '@acp-assist/panel';

export const PANEL_CONFIG: PanelConfig = {
  appName: 'LibreOffice',
  appTitle: 'LibreOffice ACP Assist',
  fenceRe: '(?:writer|calc|impress)',
  statusKey: 'bridgeAvailable',
  statusMissing: 'Bridge not found — open LibreOffice (the bridge starts automatically on launch; menu ACP Assist > Start bridge forces it)',
  cursorTerm: 'style',
  hasSaveConsent: false,
  hasInstallFlow: true,
  composerRefreshSelection: true,
  busyText: 'talking to LibreOffice…',
  eventPush: true,
  theme: null,
  // The bridge .oxt is plain Python-UNO, so it installs into any UNO-based
  // suite; the picker maps these ids to install paths (see
  // src/bridge/install.ts officePathForTargetApp). An explicit officePath
  // agent setting still wins over the picker's choice.
  targetApps: [
    { id: 'auto', label: 'Auto-detect (LibreOffice)', hint: 'Standard LibreOffice install locations.' },
    { id: 'openoffice', label: 'Apache OpenOffice', hint: 'Installs the bridge into Apache OpenOffice instead (needs its Python-UNO bridge on Windows).' },
    { id: 'collabora', label: 'Collabora Office', hint: 'Installs the bridge into Collabora Office instead.' },
  ],
};
