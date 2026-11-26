/**
 * Panel smoke tests: the shared assets are config-driven and the index
 * handler injects everything the panel needs at boot.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { createPanelBootScript, createPanelIndexHandler, panelPublicDir, type PanelConfig } from '../src/index.js';

const execFileAsync = promisify(execFile);


const testConfig: PanelConfig = {
  appName: 'TestEditor',
  appTitle: 'TestEditor ACP Assist',
  fenceRe: 'test',
  statusKey: 'testAvailable',
  statusMissing: 'TestEditor not running',
  cursorTerm: 'layout',
  hasSaveConsent: true,
  hasInstallFlow: false,
  composerRefreshSelection: false,
  busyText: 'talking to TestEditor…',
  eventPush: false,
  theme: 'theme-test',
};

describe('shared panel assets', () => {
  it('public dir contains the shared panel files', async () => {
    const dir = panelPublicDir();
    await expect(fs.access(path.join(dir, 'index.html'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'app.js'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'style.css'))).resolves.toBeUndefined();
    for (const name of [
      'state.js', 'api.js', 'markdown.js', 'messages.js', 'typing.js',
      'status.js', 'save-consent.js', 'install.js', 'documents.js',
      'events.js', 'conversation.js', 'attachments.js', 'review.js', 'pdf.js',
    ]) {
      await expect(fs.access(path.join(dir, name))).resolves.toBeUndefined();
    }
  });

  it('shared modules are syntactically valid and carry the config seams', async () => {
    const dir = panelPublicDir();
    const entries = await fs.readdir(dir);
    const modules = entries.filter((f) => f.endsWith('.js')).sort();
    expect(modules.length).toBeGreaterThan(1);

    // Syntax-check every module as an ES module: node --check validates
    // import/export without executing the code.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-syntax-'));
    try {
      for (const name of modules) {
        const target = path.join(tmp, name.replace(/\.js$/, '.mjs'));
        await fs.copyFile(path.join(dir, name), target);
        await execFileAsync(process.execPath, ['--check', target]);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }

    // The config seams the apps rely on, across the whole module set.
    const source = (
      await Promise.all(modules.map((name) => fs.readFile(path.join(dir, name), 'utf8')))
    ).join('\n');
    expect(source).toContain('__ACP_PANEL_CONFIG__');
    expect(source).toContain('__ACP_TOKEN__');
    expect(source).toContain('FENCE_RE');
    expect(source).toContain('hasSaveConsent');
    expect(source).toContain('hasInstallFlow');
    expect(source).toContain('composerRefreshSelection');
    expect(source).toContain('busyText');
    expect(source).toContain('eventPush');
  });

  it('shared css carries both themes and both feature sections', async () => {
    const css = await fs.readFile(path.join(panelPublicDir(), 'style.css'), 'utf8');
    expect(css).toContain('theme-lyx');
    expect(css).toContain('.vcs-warn');
    expect(css).toContain('.modal-backdrop');
    expect(css).toContain('.install-btn');
  });

  it('shared index.html carries both apps\' optional elements (hidden)', async () => {
    const html = await fs.readFile(path.join(panelPublicDir(), 'index.html'), 'utf8');
    expect(html).toContain('id="vcs-warn"');
    expect(html).toContain('id="save-consent-backdrop"');
    expect(html).toContain('id="install-btn"');
    expect(html).toContain('id="bridge-spinner"');
    // The "show full operation log" toggle lives in the agent settings panel.
    expect(html).toContain('id="show-full-history"');
  });

  it('panel modules wire the show-full-history setting end to end', async () => {
    const dir = panelPublicDir();
    const read = async (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    // state carries the runtime flag + the checkbox element
    const stateSrc = await read('state.js');
    expect(stateSrc).toContain('showFullHistory');
    expect(stateSrc).toContain('show-full-history');
    // api persists/loads it through /api/settings/agent
    const apiSrc = await read('api.js');
    expect(apiSrc).toContain('showFullHistory');
    // markdown collapses fenced blocks when hidden; messages re-render on toggle
    const mdSrc = await read('markdown.js');
    expect(mdSrc).toContain('state.showFullHistory');
    expect(mdSrc).toContain('block-hidden');
    const msgSrc = await read('messages.js');
    expect(msgSrc).toContain('rerenderAssistantTexts');
    const appSrc = await read('app.js');
    expect(appSrc).toContain('rerenderAssistantTexts');
  });

  it('wires the keep-awake setting and the Continue button end to end', async () => {
    const dir = panelPublicDir();
    const read = async (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    // settings modal row + element refs
    const html = await read('index.html');
    expect(html).toContain('id="keep-awake"');
    const stateSrc = await read('state.js');
    expect(stateSrc).toContain('keepAwakeWhileBusy');
    expect(stateSrc).toContain('setKeepAwake');
    expect(stateSrc).toContain("window.electron?.keepAwake");
    // persisted through /api/settings/agent
    const apiSrc = await read('api.js');
    expect(apiSrc).toContain('keepAwakeWhileBusy');
    // shell only: the row is unhidden when the preload exposes keepAwake
    const appSrc = await read('app.js');
    expect(appSrc).toContain('keepAwakeRow');
    // runs wrap themselves in setKeepAwake(true/false)
    const convSrc = await read('conversation.js');
    expect(convSrc).toContain('setKeepAwake(true)');
    expect(convSrc).toContain('setKeepAwake(false)');
    const reviewSrc = await read('review.js');
    expect(reviewSrc).toContain('setKeepAwake(true)');
    // the safety-limit stop note carries a Continue button that sends "continue"
    expect(convSrc).toContain("stopReason === 'limit'");
    expect(convSrc).toContain('continue-btn');
    expect(convSrc).toContain("sendText('continue')");
    expect(convSrc).toContain('export async function sendText');
    // auto-continue checkbox is wired through settings end to end
    expect(html).toContain('id="auto-continue"');
    expect(stateSrc).toContain('autoContinueEdits');
    expect(apiSrc).toContain('autoContinueEdits');
    expect(appSrc).toContain('autoContinueEl');
  });

  it('the start-working modal carries the previous-conversation picker end to end', async () => {
    const dir = panelPublicDir();
    const read = async (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    const html = await read('index.html');
    // The consolidated modal keeps the save-consent backdrop id but now has
    // the general edit notice, the VCS line, and the session list.
    expect(html).toContain('id="save-consent-backdrop"');
    expect(html).toContain('id="save-consent-vcs"');
    expect(html).toContain('id="save-consent-sessions"');
    expect(html).toContain('id="save-consent-session-list"');
    const scSrc = await read('save-consent.js');
    expect(scSrc).toContain('maybeShowDocIntro');
    // The truncated session preview is readable in full via the row tooltip.
    expect(scSrc).toContain('row.title');
    expect(scSrc).toContain('/conversations');
    expect(scSrc).toContain('state.docIntroDone');
    const convSrc = await read('conversation.js');
    expect(convSrc).toContain('applyDocIntroChoice');
    expect(convSrc).toContain('/conversation/reset');
    expect(convSrc).toContain('/conversation/switch');
    expect(convSrc).toContain('maybeShowDocIntro');
    const docSrc2 = await read('documents.js');
    expect(docSrc2).toContain('maybeShowDocIntro');
    expect(docSrc2).toContain('applyDocIntroChoice');
    const stateSrc = await read('state.js');
    expect(stateSrc).toContain('docIntroDone');
    expect(stateSrc).toContain('save-consent-session-list');
    const css = await read('style.css');
    expect(css).toContain('.session-list');
  });

  it('install.js wires both install flows (LO one-click + OO bridge download)', async () => {
    const js = await fs.readFile(path.join(panelPublicDir(), 'install.js'), 'utf8');
    expect(js).toContain('/api/bridge/install/preflight');
    expect(js).toContain('/api/bridge/plugin');
    expect(js).toContain('/api/bridge/plugin/download');
    expect(js).toContain('bridgeDownload');
  });

  it('review.js wires the structured-review flow end to end', async () => {
    const dir = panelPublicDir();
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    // Review… and Open-in-viewer ship hidden: only PDF mode shows them.
    expect(html).toMatch(/<button id="review"[^>]*\bhidden/);
    expect(html).toMatch(/<button id="open-viewer"[^>]*\bhidden/);
    expect(html).toContain('id="review-backdrop"');
    expect(html).toContain('id="review-target"');
    expect(html).toContain('id="review-run"');
    const js = await fs.readFile(path.join(dir, 'review.js'), 'utf8');
    expect(js).toContain('/review');
    expect(js).toContain('/review/download');
    expect(js).toContain('review-download');
    expect(js).toContain('attachmentId');
    expect(js).toContain('includeImages');
    expect(js).toContain('review-card');
    // PDF mode fixes the review target to the active PDF; suggestion page
    // numbers are jump buttons.
    expect(js).toContain('CONFIG.pdfMode');
    expect(js).toContain('jump-page');
    expect(js).toContain('/jump');
    // app.js loads the modules; state.js carries the element refs
    const appSrc = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
    expect(appSrc).toContain("import './review.js';");
    expect(appSrc).toContain("import './pdf.js';");
    expect(appSrc).toContain('CONFIG.pdfMode');
    const stateSrc = await fs.readFile(path.join(dir, 'state.js'), 'utf8');
    expect(stateSrc).toContain('reviewBtn');
    expect(stateSrc).toContain('openViewerBtn');
    expect(stateSrc).toContain('review-backdrop');
    // pdf.js opens the active PDF in the external viewer, and picks a PDF
    // from disk (native dialog) when none is open; attachments.js opens an
    // attached PDF at its REAL path via webUtils when available.
    const pdfSrc = await fs.readFile(path.join(dir, 'pdf.js'), 'utf8');
    expect(pdfSrc).toContain('open-external');
    expect(pdfSrc).toContain('pickPdf');
    expect(pdfSrc).toContain('/pdf/open');
    expect(pdfSrc).toContain('CONFIG.pdfMode');
    const attSrc = await fs.readFile(path.join(dir, 'attachments.js'), 'utf8');
    expect(attSrc).toContain('/pdf/open');
    expect(attSrc).toContain('getPathForFile');
    expect(attSrc).toContain('CONFIG.pdfMode');
    // PDF mode adapts the composer hint; the doc selector says "Active PDF".
    expect(appSrc).toContain('composer-hint');
    const docSrc = await fs.readFile(path.join(dir, 'documents.js'), 'utf8');
    expect(docSrc).toContain('Active PDF');
    // setDocInfo tracks the active path even without save-consent.
    const scSrc = await fs.readFile(path.join(dir, 'save-consent.js'), 'utf8');
    expect(scSrc).toContain('state.activeDocPath = docPath || null;');
    const css = await fs.readFile(path.join(dir, 'style.css'), 'utf8');
    expect(css).toContain('.review-card');
    expect(css).toContain('.sev-high');
    expect(css).toContain('.jump-page');
    expect(css).toContain('.review-download');
    // The review dialog is left-aligned.
    expect(css).toContain('#review-backdrop .modal');
    // PDF mode replaces the "(unsaved document)" label.
    const convSrc = await fs.readFile(path.join(dir, 'conversation.js'), 'utf8');
    expect(convSrc).toContain('no PDF open');
    expect(convSrc).toContain('CONFIG.pdfMode');
  });

  it('index references the boot script; the boot script carries token + config + theme', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-index-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
    const app = express();
    app.get('/', createPanelIndexHandler(dir, { token: 'tok-123', config: testConfig }));
    app.get('/panel-boot.js', createPanelBootScript({ token: 'tok-123', config: testConfig }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      // CSP-safe: an EXTERNAL script (the tight CSP blocks inline ones).
      expect(html).toContain('<script src="/panel-boot.js"></script>');
      expect(html).not.toContain('window.__ACP_TOKEN__');
      const boot = await (await fetch(`http://127.0.0.1:${port}/panel-boot.js`)).text();
      expect(boot).toContain('window.__ACP_TOKEN__ = "tok-123"');
      expect(boot).toContain('"appName":"TestEditor"');
      expect(boot).toContain('classList.add("theme-test")');
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('omits the theme class when config.theme is null', async () => {
    const boot = createPanelBootScript({ token: 'tok', config: { ...testConfig, theme: null } });
    const app = express();
    app.get('/panel-boot.js', boot);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const js = await (await fetch(`http://127.0.0.1:${port}/panel-boot.js`)).text();
      expect(js).not.toContain('classList.add');
    } finally {
      server.close();
    }
  });

  it('unified config (appId + switcher) scopes the boot URL and serializes the switcher', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-unified-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
    const unifiedConfig: PanelConfig = {
      ...testConfig,
      appId: 'lyx',
      switcher: {
        current: 'lyx',
        apps: [
          { id: 'libreoffice', label: 'LibreOffice' },
          { id: 'lyx', label: 'LyX' },
        ],
      },
    };
    const app = express();
    app.get('/', createPanelIndexHandler(dir, { token: 'tok', config: unifiedConfig }));
    app.get('/panel-boot.js', createPanelBootScript({ token: 'tok', config: unifiedConfig }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain('<script src="/panel-boot.js?app=lyx"></script>');
      const boot = await (await fetch(`http://127.0.0.1:${port}/panel-boot.js`)).text();
      expect(boot).toContain('"appId":"lyx"');
      expect(boot).toContain('"switcher":{"current":"lyx"');
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('standalone config (no appId) keeps the bare boot URL', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-standalone-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
    const app = express();
    app.get('/', createPanelIndexHandler(dir, { token: 'tok', config: testConfig }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain('<script src="/panel-boot.js"></script>');
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('file dropdown click triggers the reconnect action (fresh list on open)', async () => {
    const dir = panelPublicDir();
    const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    // app.js wires the dropdown's mousedown to the same reconnect() the
    // Reconnect button runs.
    const appSrc = await read('app.js');
    expect(appSrc).toContain("docSelect.addEventListener('mousedown'");
    expect(appSrc).toMatch(/docSelect\.addEventListener\('mousedown'[\s\S]{0,120}reconnect\(\)/);
    // conversation.js allows one (re)connect at a time and applies a
    // document picked mid-reconnect to the fresh session.
    const convSrc = await read('conversation.js');
    expect(convSrc).toContain('if (state.busy || state.connecting) return;');
    expect(convSrc).toContain('state.pendingDocSwitch');
    expect(convSrc).toContain('switchDocument');
    // documents.js parks the dropdown pick when there is no session to
    // switch on because a reconnect is in flight.
    const docSrc = await read('documents.js');
    expect(docSrc).toContain('export async function switchDocument(path)');
    expect(docSrc).toContain('state.pendingDocSwitch = docSelect.value;');
    // state.js carries both flags.
    const stateSrc = await read('state.js');
    expect(stateSrc).toContain('connecting: false');
    expect(stateSrc).toContain('pendingDocSwitch: null');
  });

  it('shared panel carries the app-switcher seam (hidden select + wiring)', async () => {
    const dir = panelPublicDir();
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    expect(html).toContain('id="app-select"');
    const appJs = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
    expect(appJs).toContain('CONFIG.switcher');
    expect(appJs).toContain("searchParams.set('app'");
    const css = await fs.readFile(path.join(dir, 'style.css'), 'utf8');
    expect(css).toContain('.app-select');
  });

  it('toolbar is two rows: brand row above, controls row (file dropdown + agent + pin + reconnect) below', async () => {
    const dir = panelPublicDir();
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    // The toolbar splits into a slim brand row and a controls row so the
    // file dropdown stays visible in a narrow panel.
    expect(html).toContain('class="toolbar-row toolbar-brand"');
    expect(html).toContain('class="toolbar-row toolbar-controls"');
    const toolbar = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('<div class="context">'));
    const split = toolbar.indexOf('toolbar-controls');
    expect(split).toBeGreaterThan(0);
    const brand = toolbar.slice(0, split);
    const controls = toolbar.slice(split);
    // Brand row: app logo, (smaller) ACP mark, editor switcher.
    expect(brand).toContain('brand-mark');
    expect(brand).toContain('acp-mark');
    expect(brand).toContain('id="app-select"');
    // Controls row: file dropdown, agent settings, pin, reconnect.
    expect(controls).toContain('id="doc-select"');
    expect(controls).toContain('agent-settings');
    expect(controls).toContain('id="pin"');
    expect(controls).toContain('id="reconnect"');
    // The brand row must come first.
    expect(toolbar.indexOf('toolbar-brand')).toBeLessThan(split);
    // CSS: the toolbar stacks rows vertically; the ACP mark is small.
    const css = await fs.readFile(path.join(dir, 'style.css'), 'utf8');
    expect(css).toMatch(/\.toolbar\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toContain('.toolbar-row');
    expect(css).toContain('.toolbar-brand');
    expect(css).toContain('.toolbar-controls');
    expect(css).toMatch(/\.acp-mark\s*\{[^}]*height:\s*12px/);
    // The editor switcher stays on the LEFT with the brand marks (not
    // right-aligned via margin-left:auto).
    expect(css).not.toMatch(/\.toolbar-brand\s+\.app-select\s*\{[^}]*margin-left:\s*auto/);
  });

  it('composer row carries a New session button wired to a reset + reconnect flow', async () => {
    const dir = panelPublicDir();
    const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    const html = await read('index.html');
    // The button sits in the footer row between attach (+) and the rest.
    expect(html).toContain('id="new-session"');
    const row = html.slice(html.indexOf('<div class="row">'), html.indexOf('</div>', html.indexOf('<div class="row">')));
    expect(row.indexOf('id="attach"')).toBeGreaterThanOrEqual(0);
    expect(row.indexOf('id="new-session"')).toBeGreaterThan(row.indexOf('id="attach"'));
    expect(row.indexOf('id="new-session"')).toBeLessThan(row.indexOf('id="undo"'));
    // state.js carries the element ref.
    const stateSrc = await read('state.js');
    expect(stateSrc).toContain("getElementById('new-session')");
    expect(stateSrc).toContain('newSessionBtn');
    // app.js wires the click handler.
    const appSrc = await read('app.js');
    expect(appSrc).toContain('newSessionBtn');
    expect(appSrc).toMatch(/newSessionBtn\.addEventListener\('click',\s*newSession\)/);
    // conversation.js implements it: archive the active conversation on
    // the current session, then reconnect (fresh agent + empty chat).
    const convSrc = await read('conversation.js');
    expect(convSrc).toContain('export async function newSession()');
    expect(convSrc).toContain('/conversation/reset');
    expect(convSrc).toMatch(/export async function newSession\(\)[\s\S]*?await reconnect\(\)/);
    // status.js disables the button while busy / connecting / no session.
    const statusSrc = await read('status.js');
    expect(statusSrc).toMatch(/newSessionBtn\.disabled\s*=/);
  });
});
