'use strict';

// App version + release-update row in the agent-settings popover.
//
// The version comes from the server-injected panel config (the packaged
// app's package.json version). The update CHECK and DOWNLOAD run in the
// Electron main process over IPC (the panel's CSP forbids cross-origin
// fetch, and the main process can use the OS network stack): the panel
// only renders the status and triggers actions. On Linux the action is
// "open the GitHub releases page" — there is no safe auto-install there;
// Windows/macOS download the installer asset and hand it to the OS.

import {
  CONFIG,
  appVersionRow,
  appVersionEl,
  checkUpdateBtn,
  updateStatusEl,
  updateActionBtn,
} from './state.js';

/** Last update-check status (also driven by the startup push). */
let lastStatus = null;

function electronApi() {
  return window.electron ?? {};
}

function setStatusText(text) {
  if (updateStatusEl) updateStatusEl.textContent = text;
}

function showAction(label, onClick) {
  if (!updateActionBtn) return;
  updateActionBtn.textContent = label;
  updateActionBtn.hidden = false;
  updateActionBtn.onclick = onClick;
}

function hideAction() {
  if (updateActionBtn) {
    updateActionBtn.hidden = true;
    updateActionBtn.onclick = null;
  }
}

function renderStatus(status) {
  lastStatus = status;
  if (!status || !status.packaged) {
    setStatusText(status && status.packaged === false ? 'dev build — no update check' : '');
    hideAction();
    return;
  }
  if (!status.updateAvailable) {
    setStatusText(status.latest ? 'up to date' : 'no published release found');
    hideAction();
    return;
  }
  setStatusText(`v${status.latest} available`);
  if (status.asset) {
    showAction('Download update', () => void downloadUpdate(status));
  } else {
    // Linux (or no matching asset): link to the GitHub releases page.
    showAction('Open release page', () => {
      void electronApi().openExternal?.(status.releaseUrl ?? `https://github.com/guzmandrade-dev/acp-assist/releases`);
    });
  }
}

async function downloadUpdate(status) {
  const asset = status.asset;
  if (!asset || !electronApi().downloadUpdate) return;
  if (checkUpdateBtn) checkUpdateBtn.disabled = true;
  hideAction();
  setStatusText(`downloading ${asset.name}…`);
  const offProgress = electronApi().onUpdaterProgress?.((p) => {
    if (p && !p.done && typeof p.received === 'number') {
      const pct = p.total ? Math.round((p.received / p.total) * 100) : null;
      setStatusText(`downloading ${asset.name}… ${pct === null ? '' : `${pct}%`}`);
    }
  });
  try {
    const result = await electronApi().downloadUpdate(asset);
    if (result && result.ok && result.path) {
      setStatusText('downloaded — run it to install, then restart the app');
      showAction('Open downloaded file', () => {
        void electronApi().openPath?.(result.path);
      });
    } else {
      setStatusText(`download failed: ${result?.error ?? 'unknown error'}`);
      showAction('Retry', () => void downloadUpdate(status));
    }
  } catch (e) {
    setStatusText(`download failed: ${e?.message ?? e}`);
  } finally {
    offProgress?.();
    if (checkUpdateBtn) checkUpdateBtn.disabled = false;
  }
}

export function setupUpdateRow() {
  // Version label: only when the server injected one (packaged unified
  // app; standalone dev hosts leave the row hidden).
  if (CONFIG.version && appVersionRow && appVersionEl) {
    appVersionEl.textContent = `v${CONFIG.version}`;
    appVersionRow.hidden = false;
  } else if (appVersionRow) {
    appVersionRow.hidden = true;
  }
  // Update check only exists in the Electron shell.
  if (checkUpdateBtn && typeof electronApi().checkForUpdates === 'function') {
    checkUpdateBtn.hidden = false;
    checkUpdateBtn.addEventListener('click', () => {
      setStatusText('checking…');
      electronApi().checkForUpdates().then(renderStatus).catch((e) => {
        setStatusText(`check failed: ${e?.message ?? e}`);
      });
    });
  }
  // Startup auto-check result pushed from the main process.
  electronApi().onUpdaterStatus?.(renderStatus);
}
