/**
 * Static + syntax checks for the in-editor bridge plugin
 * (bridge-plugin/): the v0.8.0 auto-start wiring — config.json carries a
 * background+autostart variation (the bridge starts when the editor
 * opens) plus a panel variation (the side panel with the auto-start
 * checkbox), and code.js keeps one polling instance, honors the
 * auto-start flag, and syncs the editor's stopped-background-plugins
 * list. Live behavior needs a real editor; CI guards the files here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge-plugin');
const read = (name: string) => fs.readFile(path.join(pluginDir, name), 'utf8');

describe('bridge-plugin: auto-start (v0.8.0)', () => {
  it('config.json: same GUID, version matches code.js, background+autostart variation 0 and a panel variation', async () => {
    const config = JSON.parse(await read('config.json')) as {
      guid: string;
      version: string;
      variations: Array<Record<string, unknown>>;
    };
    // The GUID must NOT change (reinstall replaces in place).
    expect(config.guid).toBe('asc.{7E2F9A41-6B3C-4D58-9E7A-1F4B8C6D2E39}');
    const code = await read(path.join('scripts', 'code.js'));
    const m = code.match(/var PLUGIN_VERSION = "([^"]+)";/);
    expect(m).not.toBeNull();
    expect(config.version).toBe(m![1]);
    expect(config.version).toBe('0.8.0');
    // variations[0] is the auto-starting background worker (sdkjs only
    // honors autostart on variations[0]); a panel variation keeps the
    // side panel available from the Plugins tab.
    expect(config.variations.length).toBeGreaterThanOrEqual(2);
    const v0 = config.variations[0]!;
    expect(v0['type']).toBe('background');
    expect(v0['autostart']).toBe(true);
    expect(v0['url']).toBe('index.html');
    const panel = config.variations.find((v) => v['type'] === 'panel');
    expect(panel).toBeDefined();
    expect(panel!['url']).toBe('index.html');
    for (const v of config.variations) {
      expect(v['EditorsSupport']).toEqual(['word', 'cell', 'slide']);
    }
  });

  it('code.js is syntactically valid and wires the auto-start behavior', async () => {
    const codePath = path.join(pluginDir, 'scripts', 'code.js');
    // node --check validates without executing.
    await execFileAsync(process.execPath, ['--check', codePath]);
    const code = await read(path.join('scripts', 'code.js'));
    // Own flag + editor-side stopped list + single-instance claim.
    expect(code).toContain('"acp-bridge-autostart"');
    expect(code).toContain('"asc_plugins_background_stopped"');
    expect(code).toContain('"acp-bridge-claim"');
    expect(code).toContain('autostartEnabled()');
    expect(code).toContain('setAutostart(');
    // Auto path refuses to start when disabled; manual Reconnect overrides.
    expect(code).toMatch(/function startBridge\(manual\)/);
    expect(code).toMatch(/if \(!manual && !autostartEnabled\(\)\)/);
    expect(code).toMatch(/startBridge\(true\)/);
    expect(code).toContain('window.Asc.plugin.init = function () { startBridge(false); };');
    // One polling instance: claim taken at init, refreshed per poll,
    // handed over when another instance owns a fresh claim.
    expect(code).toContain('claimPollLoop()');
    expect(code).toMatch(/if \(claim && claim\.id !== INSTANCE_ID\) \{\s*\n\s*status\("bridge handed over/);
    expect(code).toContain('heartbeatTimer = setInterval(refreshClaim, 2000)');
    // The checkbox is wired.
    expect(code).toContain('getElementById("autostart")');
    expect(code).toMatch(/autoEl\.addEventListener\("change", function \(\) \{ setAutostart\(autoEl\.checked\); \}\)/);
  });

  it('index.html: side panel carries the auto-start checkbox (default on)', async () => {
    const html = await read('index.html');
    expect(html).toMatch(/<input id="autostart" type="checkbox" checked/);
    expect(html).toContain('Start bridge automatically when the editor opens');
    expect(html).toContain('id="b-reconnect"');
    expect(html).toContain('id="port"');
  });

  it('companion side points at the auto-start behavior when the bridge is down', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverSrc = await fs.readFile(path.join(here, '..', 'src', 'server.ts'), 'utf8');
    expect(serverSrc).toMatch(/starts automatically when the/);
    expect(serverSrc).toMatch(/Background Plugins list/);
    const configSrc = await fs.readFile(path.join(here, '..', 'src', 'panel-config.ts'), 'utf8');
    expect(configSrc).toMatch(/auto-starts when the editor opens/);
  });
});

describe('bridge-plugin: self-contained (no external SDK URL)', () => {
  it('index.html loads the vendored v1 runtime via relative paths only', async () => {
    const html = await read('index.html');
    expect(html).toContain('src="./v1/plugins.js"');
    expect(html).toContain('href="./v1/plugins.css"');
    // No remote script/link references — the plugin must work offline and
    // inside Euro-Office, which decouples from onlyoffice.github.io.
    const remote = html.match(/(?:src|href)="https?:\/\/[^"]+"/g);
    expect(remote).toBeNull();
  });

  it('v1/plugins.js + v1/plugins.css are vendored with the AGPL header intact', async () => {
    const js = await read('v1/plugins.js');
    const css = await read('v1/plugins.css');
    expect(js).toContain('Copyright Ascensio System SIA');
    expect(js).toContain('GNU Affero General Public License');
    expect(css.length).toBeGreaterThan(1000);
    const notice = await read('v1/NOTICE.md');
    expect(notice).toContain('ONLYOFFICE/onlyoffice.github.io');
    // The loader shim must be self-contained (no further sub-resources).
    expect(js.match(/(?:src|href)\s*=\s*['"][^'"]+['"]/g)).toBeNull();
  });
});
