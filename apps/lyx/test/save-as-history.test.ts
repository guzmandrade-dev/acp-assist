/**
 * Save-as history migration tests: when an unsaved buffer (placeholder
 * key: `(unsaved)` or LyX's `newfileN.lyx` title) is saved under a real
 * path (Save As, whether triggered by our buffer-write or by the user),
 * the conversation must follow the file — keyed under the NEW path, with
 * the old history file removed. A plain tab switch between saved
 * documents must never migrate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { createServer, type AgentRunner } from '../src/server.js';
import { UNSAVED_KEY, loadHistory } from '@acp-assist/core';
import type { LyxServerClient } from '../src/lyxserver/client.js';
import type { RawClipboard } from '../src/clipboard/lyx-clipboard.js';
import { PANEL_CONFIG } from '../src/panel-config.js';

const API_TOKEN = 'test-api-token';

const fakeDocText = () =>
  [
    '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
    '\\lyxformat 643',
    '\\begin_document',
    '\\begin_header',
    '\\textclass article',
    '\\end_header',
    '',
    '\\begin_body',
    '',
    '\\begin_layout Standard',
    'body',
    '\\end_layout',
    '',
    '\\end_body',
    '\\end_document',
  ].join('\n');

/** Minimal fake agent: records prompts, replies [ACTION: none]. */
class FakeAgent implements AgentRunner {
  prompts: string[] = [];
  async start() {}
  stop() {}
  async createSession() {}
  cancel() {}
  async prompt(_sessionId: string, content: ContentBlock[]): Promise<string> {
    this.prompts.push(content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    return 'Done.\n[ACTION: none]';
  }
}

interface FakeLyx {
  client: LyxServerClient;
  calls: { save: number };
  /** Simulate the user completing Save As: write the new file, retarget. */
  completeSaveAs: (newPath: string) => Promise<void>;
}

/**
 * In-memory LyX stand-in whose active filename can change (save-as).
 * `saveMode: 'deferred'` leaves the Save As dialog "open" (the filename
 * changes only when the test calls completeSaveAs); 'immediate' completes
 * the save-as synchronously inside save().
 */
function fakeLyx(initialFile: string, saveMode: 'deferred' | 'immediate', saveAsPath?: string): FakeLyx {
  const calls = { save: 0 };
  let file = initialFile;
  const client = {
    async start() {},
    stop() {},
    isAvailable() {
      return true;
    },
    async getFilename() {
      return file;
    },
    async getLayout() {
      return 'Standard';
    },
    async getSelectionStats(): Promise<[number, number, number]> {
      return [0, 0, 0];
    },
    async copySelection() {
      return false;
    },
    async save() {
      calls.save += 1;
      if (saveMode === 'immediate' && saveAsPath) {
        await fs.writeFile(saveAsPath, fakeDocText(), 'utf8');
        file = saveAsPath;
      }
    },
    async request() {
      return 'INFO:fake:cmd:';
    },
    async tryRequest() {
      return '';
    },
    async clearSelection() {},
    async collapseSelection() {},
    async collapseSelectionForward() {
      return true;
    },
    async beginOfDocument() {
      return true;
    },
    async breakParagraph() {
      return true;
    },
    async paragraphDown() {
      return false;
    },
    async paragraphSelect() {
      return true;
    },
    async deleteSelection() {
      return false;
    },
    async mergeAwayParagraph() {},
    async mergeWithNextParagraph() {
      return true;
    },
    async paste() {},
    async undo() {},
  } as unknown as LyxServerClient;
  return {
    client,
    calls,
    completeSaveAs: async (newPath: string) => {
      await fs.writeFile(newPath, fakeDocText(), 'utf8');
      file = newPath;
    },
  };
}

const rawClipboard: RawClipboard = {
  async hasFormat() {
    return false;
  },
  async readFormat() {
    return null;
  },
  async write() {
    /* no-op */
  },
  async readText() {
    return '';
  },
  async writeText() {
    /* no-op */
  },
  async clear() {
    /* no-op */
  },
};

interface Harness {
  base: string;
  sessionId: string;
  agent: FakeAgent;
  lyx: FakeLyx;
  dir: string;
  historyDir: string;
  server: Server;
}

async function startHarness(lyx: FakeLyx, dir: string, historyDir: string): Promise<Harness> {
  const agent = new FakeAgent();
  const app = createServer({
    apiToken: API_TOKEN,
    panelConfig: PANEL_CONFIG,
    clipboard: rawClipboard,
    historyDir,
    lyxFactory: () => lyx.client,
    agentFactory: () => agent,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ agent: { command: 'fake', args: [] } }),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status}`);
  const info = await res.json();
  return { base, sessionId: info.sessionId, agent, lyx, dir, historyDir, server };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeDirs() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-saveas-'));
  await fs.mkdir(path.join(dir, '.git')); // VCS: skips the save-consent gate
  const historyDir = path.join(dir, 'history');
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, historyDir };
}

async function postMessage(h: Harness) {
  const res = await fetch(`${h.base}/api/session/${h.sessionId}/message/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ message: 'create a professional CV from the attached PDF' }),
  });
  expect(res.status).toBe(200);
  await res.text(); // drain the SSE stream (runs to {"done":true})
}

async function getJson(h: Harness, route: string) {
  const res = await fetch(`${h.base}${route}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
  expect(res.status).toBe(200);
  return res.json();
}

describe('save-as history migration', () => {
  it('moves the conversation from a newfileN.lyx placeholder to the saved path when Save As completes after the run', async () => {
    const { dir, historyDir } = await makeDirs();
    // The placeholder path exists on disk (it can collide with a real
    // same-named file, e.g. an older newfile2.lyx — the write-only title
    // fallback used to alias it).
    const placeholder = path.join(dir, 'newfile2.lyx');
    await fs.writeFile(placeholder, fakeDocText(), 'utf8');
    const savedPath = path.join(dir, 'CV ACP Assist.lyx');
    // Deferred: our buffer-write opens Save As, but the user completes it
    // only after the message run finished.
    const lyx = fakeLyx(placeholder, 'deferred');
    const h = await startHarness(lyx, dir, historyDir);
    cleanups.push(() => new Promise<void>((r) => h.server.close(() => r())));

    await postMessage(h);
    // The run was recorded under the placeholder key.
    expect(await loadHistory(historyDir, placeholder)).toHaveLength(2);

    // The user completes Save As; the next document refresh detects the
    // rename and migrates the conversation.
    await lyx.completeSaveAs(savedPath);
    const docs = await getJson(h, `/api/session/${h.sessionId}/documents`);
    expect(docs.active).toBe(savedPath);

    expect(await loadHistory(historyDir, savedPath)).toHaveLength(2);
    expect(await loadHistory(historyDir, placeholder)).toEqual([]);

    const info = await getJson(h, `/api/session/${h.sessionId}`);
    expect(info.documentPath).toBe(savedPath);
    expect(info.conversation).toHaveLength(2);
    expect(info.conversation[0].content).toContain('professional CV');
  });

  it('records directly under the saved path when Save As completes during our save', async () => {
    const { dir, historyDir } = await makeDirs();
    const placeholder = path.join(dir, 'newfile3.lyx');
    await fs.writeFile(placeholder, fakeDocText(), 'utf8');
    const savedPath = path.join(dir, 'CV ACP Assist.lyx');
    const lyx = fakeLyx(placeholder, 'immediate', savedPath);
    const h = await startHarness(lyx, dir, historyDir);
    cleanups.push(() => new Promise<void>((r) => h.server.close(() => r())));

    await postMessage(h);

    // No placeholder history was ever written; the turn is under the new key.
    expect(await loadHistory(historyDir, placeholder)).toEqual([]);
    expect(await loadHistory(historyDir, savedPath)).toHaveLength(2);
    const info = await getJson(h, `/api/session/${h.sessionId}`);
    expect(info.documentPath).toBe(savedPath);
    expect(info.conversation).toHaveLength(2);
  });

  it('moves the (unsaved) conversation to the path when a truly untitled buffer is saved', async () => {
    const { dir, historyDir } = await makeDirs();
    const savedPath = path.join(dir, 'CV ACP Assist.lyx');
    // Pipe-mode unsaved buffer: server-get-filename replies '' -> (unsaved).
    const lyx = fakeLyx('', 'deferred');
    const h = await startHarness(lyx, dir, historyDir);
    cleanups.push(() => new Promise<void>((r) => h.server.close(() => r())));

    await postMessage(h);
    expect(await loadHistory(historyDir, UNSAVED_KEY)).toHaveLength(2);

    // The user saves the buffer (Ctrl+S / Save As) under a real name.
    await lyx.completeSaveAs(savedPath);
    const docs = await getJson(h, `/api/session/${h.sessionId}/documents`);
    expect(docs.active).toBe(savedPath);
    expect(await loadHistory(historyDir, savedPath)).toHaveLength(2);
    expect(await loadHistory(historyDir, UNSAVED_KEY)).toEqual([]);
  });

  it('never migrates on a plain switch between two saved documents', async () => {
    const { dir, historyDir } = await makeDirs();
    const docA = path.join(dir, 'a.lyx');
    const docB = path.join(dir, 'b.lyx');
    await fs.writeFile(docA, fakeDocText(), 'utf8');
    // docB is created "just now" (fresh mtime) on purpose: the fresh-mtime
    // signal alone must NOT migrate — the source key is not a placeholder.
    await fs.writeFile(docB, fakeDocText(), 'utf8');
    const lyx = fakeLyx(docA, 'deferred');
    const h = await startHarness(lyx, dir, historyDir);
    cleanups.push(() => new Promise<void>((r) => h.server.close(() => r())));

    await postMessage(h);
    expect(await loadHistory(historyDir, docA)).toHaveLength(2);

    await lyx.completeSaveAs(docB); // simulate the tab switch
    const docs = await getJson(h, `/api/session/${h.sessionId}/documents`);
    expect(docs.active).toBe(docB);

    // A's history stays on A; B has no conversation.
    expect(await loadHistory(historyDir, docA)).toHaveLength(2);
    expect(await loadHistory(historyDir, docB)).toEqual([]);
    const info = await getJson(h, `/api/session/${h.sessionId}`);
    expect(info.documentPath).toBe(docB);
    expect(info.conversation).toEqual([]);
  });
});
