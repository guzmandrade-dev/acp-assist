/**
 * Port binding for the companion's Express server, kept electron-free so
 * it is unit-testable under plain Node.
 *
 * Rules:
 * - preferredPort 0 = OS-assigned (the default; the discovery record
 *   carries the actual port).
 * - A fixed preferredPort (PORT env or an app's `listenPort`, e.g. 8790
 *   for the ONLYOFFICE plugin's well-known port) is tried first; if it is
 *   taken (EADDRINUSE) the server falls back to an OS-assigned port and
 *   `fellBack` is true.
 * - Windows can silently SHARE a duplicate bind instead of raising
 *   EADDRINUSE (observed live 2026-11-06: two Node processes bound
 *   127.0.0.1:8790 and the first binder answered requests). So after
 *   binding a fixed port we self-probe: GET /api/status with the server's
 *   own bearer token must return 200. A foreign process answering instead
 *   (401 — different token) proves the port is shared; we then close and
 *   rebind on an OS-assigned port.
 */

import type { Express } from 'express';
import type { Server } from 'node:http';

export interface ListenResult {
  server: Server;
  port: number;
  /** True when the preferred port was fixed and had to be abandoned. */
  fellBack: boolean;
}

function tryListen(app: Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

async function ownsPort(port: number, token: string | undefined): Promise<boolean> {
  if (!token) return true; // no auth configured — nothing to distinguish
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function listenWithFallback(
  app: Express,
  preferredPort: number,
  token?: string,
): Promise<ListenResult> {
  let server: Server;
  try {
    server = await tryListen(app, preferredPort);
  } catch {
    if (preferredPort === 0) throw new Error('failed to bind an OS-assigned port');
    server = await tryListen(app, 0);
    const port = (server.address() as { port: number }).port;
    return { server, port, fellBack: true };
  }
  const port = (server.address() as { port: number }).port;
  // A fixed port was requested: make sure WE are the process answering it.
  if (preferredPort !== 0 && !(await ownsPort(port, token))) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await tryListen(app, 0);
    const fallbackPort = (server.address() as { port: number }).port;
    return { server, port: fallbackPort, fellBack: true };
  }
  return { server, port, fellBack: false };
}
