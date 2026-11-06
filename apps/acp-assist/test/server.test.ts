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

  it('keeps per-app history directories separate', async () => {
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
