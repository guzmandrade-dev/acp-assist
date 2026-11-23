import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../src/server.js';
import type { RawClipboard } from '../src/clipboard/lyx-clipboard.js';
import type { LyxServerClient } from '../src/lyxserver/client.js';
import type { AgentRunner } from '../src/server.js';
import { PANEL_CONFIG } from '../src/panel-config.js';
import { loadHistory, saveHistory, listConversations } from '@acp-assist/core';

const API_TOKEN = 'test-api-token';

const stubClipboard: RawClipboard = {
  async hasFormat() {
    return false;
  },
  async readFormat() {
    return null;
  },
  async write() {},
  async readText() {
    return '';
  },
  async writeText() {},
  async clear() {},
};

function fakeAgent(): AgentRunner {
  return {
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async () => 'ok [ACTION: none]',
  } as unknown as AgentRunner;
}

/** Minimal LyX stand-in: a saved document path, pipe mode, no-ops. */
function fakeLyx(docPath: string) {
  return {
    mode: 'pipe',
    start: async () => undefined,
    stop: () => undefined,
    isAvailable: () => true,
    getFilename: async () => docPath,
    getLayout: async () => 'Standard',
  } as unknown as LyxServerClient;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function startServer(docPath: string, historyDir: string) {
  const app = createServer({
    apiToken: API_TOKEN,
    panelConfig: PANEL_CONFIG,
    clipboard: stubClipboard,
    historyDir,
    agentFactory: () => fakeAgent(),
    lyxFactory: () => fakeLyx(docPath),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` };
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers });
  expect(res.status).toBe(200);
  const info = (await res.json()) as { sessionId: string };
  return { base, headers, sessionId: info.sessionId };
}

describe('per-document conversation routes', () => {
  it('lists, resets (archives), and switches conversations for the current document', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-conv-'));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const docPath = path.join(dir, 'doc.lyx');
    await fs.writeFile(docPath, '#LyX\n', 'utf8');
    const historyDir = path.join(dir, 'history');

    // Seed an "old" conversation and archive it, plus an active one.
    await saveHistory(historyDir, docPath, [
      { role: 'user', content: 'old question', timestamp: '2026-11-20T10:00:00.000Z' },
      { role: 'assistant', content: 'old answer', timestamp: '2026-11-20T10:01:00.000Z' },
    ]);
    const { archiveHistory } = await import('@acp-assist/core');
    const archivedFile = await archiveHistory(historyDir, docPath);
    expect(archivedFile).toMatch(/\.json$/);
    await saveHistory(historyDir, docPath, [
      { role: 'user', content: 'current question', timestamp: '2026-11-22T15:00:00.000Z' },
      { role: 'assistant', content: 'current answer', timestamp: '2026-11-22T15:01:00.000Z' },
    ]);

    const { base, headers, sessionId } = await startServer(docPath, historyDir);

    // GET conversations: active + archived, with metadata.
    const list1 = await (
      await fetch(`${base}/api/session/${sessionId}/conversations`, { headers })
    ).json();
    expect(list1.key).toBe(docPath);
    expect(list1.conversations).toHaveLength(2);
    const active = list1.conversations.find((c: { active: boolean }) => c.active);
    const previous = list1.conversations.find((c: { active: boolean }) => !c.active);
    expect(active.turnCount).toBe(2);
    expect(active.preview).toContain('current question');
    expect(previous.turnCount).toBe(2);
    expect(previous.preview).toContain('old question');
    expect(previous.file).toBe(archivedFile);

    // POST reset: archives the active conversation, clears the replay.
    const reset = await (
      await fetch(`${base}/api/session/${sessionId}/conversation/reset`, {
        method: 'POST',
        headers,
      })
    ).json();
    expect(reset.ok).toBe(true);
    expect(reset.archived).toMatch(/\.json$/);
    // The active file is gone; both conversations are archived now.
    expect(await loadHistory(historyDir, docPath)).toEqual([]);
    const list2 = await (
      await fetch(`${base}/api/session/${sessionId}/conversations`, { headers })
    ).json();
    expect(list2.conversations.every((c: { active: boolean }) => !c.active)).toBe(true);
    expect(list2.conversations).toHaveLength(2);

    // Resetting again with nothing active archives nothing.
    const reset2 = await (
      await fetch(`${base}/api/session/${sessionId}/conversation/reset`, {
        method: 'POST',
        headers,
      })
    ).json();
    expect(reset2.ok).toBe(true);
    expect(reset2.archived).toBeNull();

    // POST switch: promote the old conversation back to active.
    const sw = await (
      await fetch(`${base}/api/session/${sessionId}/conversation/switch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: archivedFile }),
      })
    ).json();
    expect(sw.ok).toBe(true);
    expect(sw.conversation).toHaveLength(2);
    expect(sw.conversation[0].content).toBe('old question');
    const turns = await loadHistory(historyDir, docPath);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.content).toBe('old question');
    const list3 = await (
      await fetch(`${base}/api/session/${sessionId}/conversations`, { headers })
    ).json();
    const active3 = list3.conversations.find((c: { active: boolean }) => c.active);
    expect(active3.preview).toContain('old question');

    // Switching to a foreign file is rejected.
    const bad = await fetch(`${base}/api/session/${sessionId}/conversation/switch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: 'other.json' }),
    });
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toContain('not a conversation file');
  });

  it('listConversations dedupes documents in listKnownDocuments across archives', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-conv-'));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const docPath = path.join(dir, 'doc.lyx');
    const historyDir = path.join(dir, 'history');
    await saveHistory(historyDir, docPath, [
      { role: 'user', content: 'q', timestamp: '2026-11-22T10:00:00.000Z' },
    ]);
    const { archiveHistory, listKnownDocuments } = await import('@acp-assist/core');
    await archiveHistory(historyDir, docPath);
    await saveHistory(historyDir, docPath, [
      { role: 'user', content: 'q2', timestamp: '2026-11-22T11:00:00.000Z' },
    ]);
    // Two files, one key: the document list must contain it exactly once.
    const docs = await listKnownDocuments(historyDir);
    expect(docs.filter((d) => d === docPath)).toHaveLength(1);
    expect((await listConversations(historyDir, docPath)).length).toBe(2);
  });
});
