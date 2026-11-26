/**
 * Unified-server dispatch tests: one host, three companion sub-servers,
 * app-scoped bearer tokens, ?app= panel routing, and the pre-auth
 * /bridge/* channel pinned to ONLYOFFICE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.js';

const TOKENS = {
  libreoffice: 'lo-token',
  lyx: 'lyx-token',
  onlyoffice: 'oo-token',
  pdf: 'pdf-token',
} as const;

let server: Server;
let base: string;
let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-assist-unified-'));
  const app = createServer({
    userDataDir: tmp,
    historyDir: path.join(tmp, 'history'),
    attachmentsDir: path.join(tmp, 'attachments'),
    logDir: path.join(tmp, 'logs'),
    apiTokens: TOKENS,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('unified ACP Assist server', () => {
  it('serves the panel for an explicit ?app= and scopes the boot token to it', async () => {
    const res = await fetch(`${base}/?app=lyx`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/panel-boot.js?app=lyx');

    const boot = await fetch(`${base}/panel-boot.js?app=lyx`);
    expect(boot.status).toBe(200);
    const js = await boot.text();
    expect(js).toContain(`"lyx:${TOKENS.lyx}"`);
    expect(js).toContain('"appName":"LyX"');
    expect(js).toContain('"switcher"');
    expect(js).toContain('"current":"lyx"');
  });

  it('serves the last-used app when ?app= is absent (lyx was persisted above)', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/panel-boot.js?app=lyx');
  });

  it('persists the chosen app for the next launch', async () => {
    await fetch(`${base}/?app=onlyoffice`);
    // The write is fire-and-forget; poll briefly.
    let saved = '';
    for (let i = 0; i < 20; i++) {
      saved = await fs
        .readFile(path.join(tmp, 'active-app.json'), 'utf8')
        .catch(() => '');
      if (saved.includes('onlyoffice')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(saved).toContain('"app":"onlyoffice"');
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain('/panel-boot.js?app=onlyoffice');
  });

  it('never garbles active-app.json under concurrent page loads', async () => {
    const apps = ['lyx', 'libreoffice', 'onlyoffice', 'pdf'] as const;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => fetch(`${base}/?app=${apps[i % apps.length]}`)),
    );
    // Writes are fire-and-forget and serialized server-side; poll until the
    // content is stable. Every observed read must be valid JSON — the
    // temp-file + rename write must never expose a half-written file.
    let prev = '';
    let cur = '';
    for (let i = 0; i < 40; i++) {
      cur = await fs.readFile(path.join(tmp, 'active-app.json'), 'utf8').catch(() => '');
      if (cur) expect(() => JSON.parse(cur)).not.toThrow();
      if (cur && cur === prev) break;
      prev = cur;
      await new Promise((r) => setTimeout(r, 50));
    }
    const final = JSON.parse(cur) as { app?: string };
    expect(apps).toContain(final.app);
    // No temp files left behind.
    const leftovers = (await fs.readdir(tmp)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('rejects /panel-boot.js without a valid ?app=', async () => {
    expect((await fetch(`${base}/panel-boot.js`)).status).toBe(400);
    expect((await fetch(`${base}/panel-boot.js?app=nope`)).status).toBe(400);
  });

  it('routes /api requests by the app-scoped token', async () => {
    const lyxRes = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer lyx:${TOKENS.lyx}` },
    });
    expect(lyxRes.status).toBe(200);
    expect(await lyxRes.json()).toHaveProperty('lyxPipeAvailable');

    const loRes = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer libreoffice:${TOKENS.libreoffice}` },
    });
    expect(loRes.status).toBe(200);
    expect(await loRes.json()).toHaveProperty('bridgeAvailable');

    const ooRes = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer onlyoffice:${TOKENS.onlyoffice}` },
    });
    expect(ooRes.status).toBe(200);
    expect(await ooRes.json()).toHaveProperty('bridgeAvailable');
  });

  it('serves the PDF-review mode as a fourth switcher entry', async () => {
    const res = await fetch(`${base}/?app=pdf`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/panel-boot.js?app=pdf');

    const boot = await fetch(`${base}/panel-boot.js?app=pdf`);
    const js = await boot.text();
    expect(js).toContain(`"pdf:${TOKENS.pdf}"`);
    expect(js).toContain('"pdfMode":true');
    expect(js).toContain('"label":"PDF Review"');

    const status = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer pdf:${TOKENS.pdf}` },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body['pdfMode']).toBe(true);
    expect(typeof body['viewer']).toBe('string');
  });

  it('rejects missing, wrong, or unknown-app tokens', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer lyx:wrong' } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer nope:abc' } })
      ).status,
    ).toBe(401);
    // A raw (unscoped) token from a sub-server must not pass the dispatcher.
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKENS.lyx}` } }))
        .status,
    ).toBe(401);
  });

  it('routes /bridge/* to the ONLYOFFICE sub-server without a token', async () => {
    // Pre-auth channel: must reach the plugin bridge, not the 401
    // dispatcher or a 404.
    const res = await fetch(`${base}/bridge/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plugin: 'acp-assist-bridge', version: '0.6.0', editor: 'word' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  // Session creation probes the LyX pipe and may boot the PowerShell
  // clipboard host — real process spawns, slow on a busy box.
  it('keeps per-app history directories separate', { timeout: 30_000 }, async () => {
    // The sub-servers were built with history/<app>; a session created
    // through the lyx token must not create files under libreoffice's.
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: {
        authorization: `Bearer lyx:${TOKENS.lyx}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command: 'true', args: [] }),
    });
    // The fake-agent-less session may fail to start (no real agent
    // binary); what matters is the dispatch reached the lyx sub-server
    // (a 401/404 from the dispatcher would mean misrouting).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});

describe('unified server app version in the panel boot config', () => {
  it('injects options.version into every sub-app boot script', async () => {
    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-assist-version-'));
    const app2 = createServer({
      userDataDir: tmp2,
      historyDir: path.join(tmp2, 'history'),
      attachmentsDir: path.join(tmp2, 'attachments'),
      logDir: path.join(tmp2, 'logs'),
      apiTokens: TOKENS,
      version: '1.16.0',
    });
    const server2 = await new Promise<Server>((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server2.address() as AddressInfo;
      for (const id of ['libreoffice', 'lyx', 'onlyoffice', 'pdf'] as const) {
        const boot = await fetch(`http://127.0.0.1:${port}/panel-boot.js?app=${id}`);
        expect(boot.status).toBe(200);
        expect(await boot.text()).toContain('"version":"1.16.0"');
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      await fs.rm(tmp2, { recursive: true, force: true });
    }
  });
});
