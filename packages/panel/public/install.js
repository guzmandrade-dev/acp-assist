'use strict';

// Bridge install affordances: LibreOffice gets the one-click .oxt
// installer (hasInstallFlow — inert when false); ONLYOFFICE gets a
// "Download bridge" button (bridgeDownload) that hands the user the
// bundled acp-bridge.plugin for manual install/update via the editor's
// Plugin Manager — sideloaded plugins have no auto-update, and the
// editor's hash registry blocks anything but the Plugin Manager from
// installing them.

import {
  CONFIG,
  state,
  installBtn,
} from './state.js';

import { api } from './api.js';

import { setStatusText } from './status.js';

/** Show the install button only when the server can actually run it. */
export async function refreshInstallable() {
  if (!installBtn) return;
  if (CONFIG.bridgeDownload) return refreshBridgeDownloadable();
  if (!CONFIG.hasInstallFlow) return;
  try {
    const pre = await api('/api/bridge/install/preflight');
    installBtn.hidden = !pre.canInstall;
  } catch {
    installBtn.hidden = true;
  }
}

export function hideInstallButton() {
  if (installBtn) installBtn.hidden = true;
}

// --- ONLYOFFICE: download the bundled .plugin + show the install steps ----

async function refreshBridgeDownloadable() {
  if (!installBtn || !CONFIG.bridgeDownload) return;
  try {
    const info = await api('/api/bridge/plugin');
    installBtn.hidden = !info.available;
    if (info.available) {
      installBtn.title = info.updateNeeded
        ? `Download acp-bridge.plugin v${info.version} — the connected plugin is v${info.connectedVersion}; reinstall to update`
        : `Download the bundled acp-bridge.plugin (v${info.version ?? '?'}) to install/update the bridge in ONLYOFFICE`;
    }
  } catch {
    installBtn.hidden = true;
  }
}

async function downloadBridgePlugin() {
  if (state.installBusy || !installBtn || !CONFIG.bridgeDownload) return;
  state.installBusy = true;
  installBtn.disabled = true;
  setStatusText('Downloading bridge plugin…');
  try {
    const res = await fetch('/api/bridge/plugin/download', {
      headers: window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'acp-bridge.plugin';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    const info = await api('/api/bridge/plugin');
    showPluginInstructions(info);
    setStatusText('Bridge plugin downloaded — see the install steps.');
  } catch (e) {
    setStatusText(`Download failed: ${e.message ?? e}`);
  } finally {
    state.installBusy = false;
    installBtn.disabled = false;
  }
}

/** Post-download dialog: the manual install steps (server-provided). */
function showPluginInstructions(info) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const h = document.createElement('h2');
  h.textContent = 'Install the bridge plugin in ONLYOFFICE';
  const p = document.createElement('p');
  const code = document.createElement('code');
  code.textContent = 'acp-bridge.plugin';
  p.append('Downloaded ', code, ` (v${info.version ?? 'unknown'} — the version this app ships). Then:`);
  const ol = document.createElement('ol');
  for (const step of info.instructions ?? []) {
    const li = document.createElement('li');
    li.textContent = step;
    ol.appendChild(li);
  }
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const ok = document.createElement('button');
  ok.className = 'modal-primary';
  ok.textContent = 'Got it';
  ok.addEventListener('click', () => backdrop.remove());
  actions.appendChild(ok);
  modal.append(h, p, ol, actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

// --- LibreOffice: one-click .oxt install (touches the REAL profile) --------

async function installBridgeExtension() {
  if (state.installBusy || !installBtn || !CONFIG.hasInstallFlow) return;
  // This touches the user's REAL LibreOffice profile — confirm first,
  // stating the full blast radius: the cache wipe is profile-wide, not
  // extension-specific.
  const okToRun = window.confirm(
    'Install the ACP Assist bridge extension into your LibreOffice?\n' +
    'This modifies your LibreOffice profile. Only the ACP Assist extension ' +
    'is removed and re-added, but the extension-cache clear (uno_packages/cache ' +
    'and uno_packages.pmap) covers ALL extensions in this profile — ' +
    'LibreOffice rebuilds it on the next launch and re-registers them. ' +
    'Close LibreOffice first if it is running.',
  );
  if (!okToRun) return;
  state.installBusy = true;
  installBtn.disabled = true;
  setStatusText('Installing bridge extension…');
  try {
    const r = await api('/api/bridge/install', { method: 'POST' });
    setStatusText(r.message || 'Extension installed. Restart LibreOffice, then use menu ACP Assist > Start bridge.');
    hideInstallButton();
  } catch (e) {
    setStatusText(`Install failed: ${e.message ?? e}`);
  } finally {
    state.installBusy = false;
    installBtn.disabled = false;
  }
}

if (installBtn) {
  if (CONFIG.bridgeDownload) {
    installBtn.textContent = 'Download bridge…';
    installBtn.title = 'Download the bundled acp-bridge.plugin to install/update the bridge in ONLYOFFICE';
  }
  installBtn.addEventListener('click', () => {
    if (CONFIG.bridgeDownload) void downloadBridgePlugin();
    else void installBridgeExtension();
  });
}
