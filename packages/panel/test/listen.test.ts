/**
 * Tests for listenWithFallback: OS-assigned default, fixed preferred port,
 * EADDRINUSE fallback, and the Windows silent duplicate-bind case (a
 * foreign process sharing the pinned port must be detected via the
 * bearer-token self-probe and abandoned).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenWithFallback } from '../src/listen.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A minimal companion-shaped app: /api/status behind a bearer token. */
function makeApp(token: string) {
  const app = express();
  app.locals.apiToken = token;
  app.use((req, res, next) => {
    if (req.headers.authorization === `Bearer ${token}`) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
  app.get('/api/status', (_req, res) => res.json({ ok: true }));
  return app;
}

function listenRaw(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1');
    s.once('error', reject);
    s.once('listening', () => resolve(s));
  });
}

describe('listenWithFallback', () => {
  it('binds an OS-assigned port when preferredPort is 0', async () => {
    const { server, port, fellBack } = await listenWithFallback(makeApp('t1'), 0, 't1');
    servers.push(server);
    expect(fellBack).toBe(false);
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: 'Bearer t1' },
    });
    expect(res.status).toBe(200);
  });

  it('binds a free fixed preferred port and keeps it', async () => {
    const probe = await listenRaw(express(), 0);
    servers.push(probe);
    const free = (probe.address() as AddressInfo).port;
    probe.close();
    const { server, port, fellBack } = await listenWithFallback(makeApp('t2'), free, 't2');
    servers.push(server);
    expect(fellBack).toBe(false);
    expect(port).toBe(free);
  });

  it('falls back to an OS-assigned port when the preferred port is taken', async () => {
    const blocker = await listenRaw(makeApp('foreign'), 0);
    servers.push(blocker);
    const taken = (blocker.address() as AddressInfo).port;
    const { server, port, fellBack } = await listenWithFallback(makeApp('t3'), taken, 't3');
    servers.push(server);
    expect(fellBack).toBe(true);
    expect(port).not.toBe(taken);
    expect(port).toBeGreaterThan(0);
  });

  it('detects a foreign process sharing the pinned port (no EADDRINUSE) and falls back', async () => {
    // Foreign companion already on the port with a DIFFERENT token. On
    // Windows a second bind can "succeed" and share the port; the
    // self-probe must notice (401 instead of 200) and move to a free port.
    const foreign = await listenRaw(makeApp('foreign-token'), 0);
    servers.push(foreign);
    const shared = (foreign.address() as AddressInfo).port;
    // Bind our app to the same port — on Linux this raises EADDRINUSE and
    // the fallback happens in the catch; on Windows it may share the port
    // and the self-probe path handles it. Either way we must end up on a
    // port where OUR token answers 200.
    const { server, port, fellBack } = await listenWithFallback(makeApp('our-token'), shared, 'our-token');
    servers.push(server);
    expect(fellBack).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: 'Bearer our-token' },
    });
    expect(res.status).toBe(200);
  });

  it('falls back when the self-probe on the bound port is answered by a foreign token', async () => {
    // Simulates the Windows silent duplicate-bind on any OS: our bind
    // succeeds, but /api/status with OUR token is not answered 200 (a
    // foreign process shares the port), so the port must be abandoned.
    const probe = await listenRaw(express(), 0);
    servers.push(probe);
    const free = (probe.address() as AddressInfo).port;
    probe.close();
    const { server, port, fellBack } = await listenWithFallback(makeApp('our-token'), free, 'wrong-token');
    servers.push(server);
    expect(fellBack).toBe(true);
    expect(port).not.toBe(free);
  });

  it('keeps a fixed port when the self-probe answers with our own token', async () => {
    const probe = await listenRaw(express(), 0);
    servers.push(probe);
    const free = (probe.address() as AddressInfo).port;
    probe.close();
    const app = makeApp('t5');
    const { server, port, fellBack } = await listenWithFallback(app, free, 't5');
    servers.push(server);
    expect(fellBack).toBe(false);
    expect(port).toBe(free);
  });
});
