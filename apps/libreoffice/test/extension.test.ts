/**
 * Static checks for the shippable bridge extension (extension/): the
 * auto-start-on-launch wiring (Events.xcu binding, menu toggle, sidebar
 * toggle, settings file contract) and the package metadata. The live
 * behavior is covered by test-bridge/ (bridge_e2e.py + autostart_unit.py);
 * here we guard the files against regressions in CI (npm test).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (name: string) => fs.readFile(path.join(extDir, name), 'utf8');

describe('extension: auto-start on launch', () => {
  it('Events.xcu binds OnStartApp to the bridge autostart job and is in the manifest', async () => {
    const events = await read('Events.xcu');
    expect(events).toContain('oor:name="Events" oor:package="org.openoffice.Office"');
    expect(events).toContain('oor:name="OnStartApp"');
    expect(events).toContain('service:org.libreofficeacp.bridge?autostart');
    expect(events).toContain('oor:name="BindingURL"');
    const manifest = await read(path.join('META-INF', 'manifest.xml'));
    expect(manifest).toContain('manifest:full-path="Events.xcu"');
    expect(manifest).toContain('application/vnd.sun.star.configuration-data');
  });

  it('Addons.xcu carries the auto-start toggle menu item next to start/stop', async () => {
    const addons = await read('Addons.xcu');
    expect(addons).toContain('service:org.libreofficeacp.bridge?start');
    expect(addons).toContain('service:org.libreofficeacp.bridge?stop');
    expect(addons).toContain('service:org.libreofficeacp.bridge?toggle-autostart');
    expect(addons).toMatch(/Toggle auto-start bridge on launch/);
  });

  it('acpbridge.py handles autostart / toggle / set-autostart events and the shared settings file', async () => {
    const py = await read('acpbridge.py');
    for (const event of ['"autostart"', '"toggle-autostart"', '"set-autostart-on"', '"set-autostart-off"']) {
      expect(py).toContain(event);
    }
    expect(py).toContain('bridge-settings.json');
    expect(py).toContain('DEFAULT_SETTINGS = {"autoStart": True}');
    // The autostart event must respect the setting, the forced start must not.
    expect(py).toMatch(/if event == "autostart":\s*\n\s*if not autostart_enabled\(\):/);
    expect(py).toMatch(/if event == "start":\s*\n\s*return json\.dumps\(_start_server\(\)\)/);
  });

  it('acppanel.py (sidebar deck) has the auto-start toggle button with a stateful label', async () => {
    const py = await read('acppanel.py');
    expect(py).toContain('"autostart"');
    expect(py).toContain('Auto-start on launch: ON');
    expect(py).toContain('Auto-start on launch: OFF');
    expect(py).toContain('bridge-settings.json');
    // Fourth button at y=180, panel height grew to 218.
    expect(py).toContain('(_autostart_label(), 180, "autostart")');
    expect(py).toContain('LayoutSize(218, 218, 218)');
    // The poll loop keeps the label in sync with menu-side toggles.
    expect(py).toContain('btn_autostart.setLabel(_autostart_label())');
  });

  it('package-oxt.py ships every config file in extension/ (Events.xcu regression guard)', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = await fs.readFile(path.join(here, '..', 'scripts', 'package-oxt.py'), 'utf8');
    const files = await fs.readdir(extDir);
    const topLevel = files.filter((f) => !f.includes(path.sep) && !f.startsWith('.'));
    for (const f of topLevel) {
      if (f === 'META-INF') continue;
      // Every shipped file must be in the FILES list (or be a directory).
      const stat = await fs.stat(path.join(extDir, f));
      if (stat.isFile()) expect(pkg).toContain(`"${f}"`);
    }
    // META-INF/manifest.xml is referenced with its relative path.
    expect(pkg).toContain('"META-INF/manifest.xml"');
    // And the manifest must reference Events.xcu (or the oxt silently
    // loses the OnStartApp binding).
    const manifest = await read(path.join('META-INF', 'manifest.xml'));
    for (const f of files.filter((f) => f.endsWith('.xcu'))) {
      expect(manifest).toContain(`manifest:full-path="${f}"`);
    }
  });

  it('description.xml version is bumped (rule 50: bump on every extension/ change)', async () => {
    const desc = await read('description.xml');
    const m = desc.match(/<version value="([^"]+)"\/>/);
    expect(m).not.toBeNull();
    const [maj, min, patch] = m![1]!.split('.').map(Number);
    expect([maj, min, patch].every((n) => Number.isFinite(n))).toBe(true);
    // 0.1.5 introduced the auto-start feature; never ship an older one.
    expect(maj * 10000 + min * 100 + patch).toBeGreaterThanOrEqual(105);
  });
});

describe('extension: companion-side auto-start reader', () => {
  it('readBridgeAutoStart reads the setting and defaults to true when absent/corrupt', async () => {
    const { readBridgeAutoStart } = await import('../src/bridge/client.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-autostart-'));
    try {
      expect(await readBridgeAutoStart(dir)).toBe(true);
      await fs.writeFile(path.join(dir, 'bridge-settings.json'), JSON.stringify({ autoStart: false }));
      expect(await readBridgeAutoStart(dir)).toBe(false);
      await fs.writeFile(path.join(dir, 'bridge-settings.json'), JSON.stringify({ autoStart: true }));
      expect(await readBridgeAutoStart(dir)).toBe(true);
      await fs.writeFile(path.join(dir, 'bridge-settings.json'), '{ not json');
      expect(await readBridgeAutoStart(dir)).toBe(true);
      await fs.writeFile(path.join(dir, 'bridge-settings.json'), JSON.stringify({ autoStart: 'yes' }));
      expect(await readBridgeAutoStart(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('client.ts exposes readBridgeAutoStart defaulting to true', async () => {
    const client = await fs.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bridge', 'client.ts'),
      'utf8',
    );
    expect(client).toContain('readBridgeAutoStart');
    expect(client).toContain('bridge-settings.json');
    expect(client).toMatch(/export async function readBridgeAutoStart[\s\S]*?return true;/);
  });

  it('server.ts surfaces bridgeAutoStart in /api/status and mentions auto-start in the no-bridge error', async () => {
    const server = await fs.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'),
      'utf8',
    );
    expect(server).toContain('readBridgeAutoStart');
    expect(server).toContain('bridgeAutoStart');
    expect(server).toMatch(/starts automatically on launch/);
  });
});
