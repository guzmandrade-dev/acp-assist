/**
 * Multi-action run tests: one user message may apply several document
 * edits. The server orchestrates the loop (prompt -> apply -> re-read
 * context -> prompt again) on the SAME ACP session; ACP itself only
 * signals that each single response finished.
 *
 * These tests use a fake agent (scripted replies) and a fake LyXServerClient
 * (in-memory document), driven through the real HTTP/SSE endpoint. They
 * cover: two edits then completion, completion without an edit, and an
 * action error halting the run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  createServer,
  type AgentRunner,
  buildContinuationPrompt,
  parseAction,
  describeAction,
} from '../src/server.js';
import type { LyxServerClient } from '../src/lyxserver/client.js';
import type { RawClipboard } from '../src/clipboard/lyx-clipboard.js';
import { PANEL_CONFIG } from '../src/panel-config.js';

/** LyX panel config for the shared panel. */
const TEST_PANEL_CONFIG = PANEL_CONFIG;

/** Fixed API bearer token for these HTTP-level tests. */
const API_TOKEN = 'test-api-token';

interface FakeDoc {
  file: string;
  dir: string;
  paragraphs: Array<{ layout: string; text: string }>;
}

const fakeDocText = (paragraphs: Array<{ layout: string; text: string }>) =>
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
    paragraphs.map((p) => `\\begin_layout ${p.layout}\n${p.text}\n\\end_layout`).join('\n\n'),
    '',
    '\\end_body',
    '\\end_document',
  ].join('\n');

async function writeFakeDoc(): Promise<FakeDoc> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-multi-'));
  // These tests predate the save-consent gate; their harness documents live
  // in a (marker-only) git working tree, so the disk save is ungated.
  await fs.mkdir(path.join(dir, '.git'));
  const file = path.join(dir, 'doc.lyx');
  const paragraphs = [
    { layout: 'Title', text: 'placeholder title' },
    { layout: 'Standard', text: 'first body' },
    { layout: 'Standard', text: 'second body' },
  ];
  await fs.writeFile(file, fakeDocText(paragraphs), 'utf8');
  return { file, dir, paragraphs };
}

class FakeAgent implements AgentRunner {
  prompts: string[] = [];
  cancelCalls = 0;
  cancelAfterPrompts = Infinity;
  private index = 0;
  constructor(private replies: string[]) {}
  async start() {}
  stop() {}
  async createSession() {}
  cancel() {
    this.cancelCalls += 1;
  }
  async prompt(_sessionId: string, content: ContentBlock[]): Promise<string> {
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    this.prompts.push(text);
    if (this.prompts.length > this.cancelAfterPrompts) {
      // Simulate the user pressing Stop between two edits of one run.
      this.cancel();
    }
    const reply = this.replies[this.index] ?? 'Done.\n[ACTION: none]';
    this.index += 1;
    return reply;
  }
}

/**
 * An agent whose EVERY prompt fails — the step-1 failure case: no turn is
 * recorded, but readStep(1) already saved the user's clipboard text.
 */
class FailingAgent implements AgentRunner {
  prompts: string[] = [];
  async start() {}
  stop() {}
  async createSession() {}
  cancel() {}
  async prompt(_sessionId: string, content: ContentBlock[]): Promise<string> {
    this.prompts.push(content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));
    throw new Error('agent connection lost');
  }
}

/**
 * In-memory LyXServerClient stand-in. Only the LFUNs the message loop uses
 * are implemented; verification reads go through the raw clipboard stub.
 */
function fakeLyx(
  doc: FakeDoc,
  hooks: { onPaste?: () => Promise<void>; failGoto?: boolean; writeOnly?: boolean; noPaste?: boolean; saveDelayMs?: number } = {},
) {
  let cursor = 0;
  let selection: { p: number; start: number; end: number } | null = null;
  let fileOverride: string | null = null;
  const clip = { text: '' };
  const client = {
    calls: { save: 0, paste: 0, copy: 0, undo: 0 },
    mode: hooks.writeOnly ? 'write-only' : 'pipe',
    /** Test hook: simulate the user focusing another LyX window mid-run. */
    setFile(f: string | null) {
      fileOverride = f;
    },
    async start() {},
    stop() {},
    isAvailable() {
      return true;
    },
    async getFilename() {
      return fileOverride ?? doc.file;
    },
    async getLayout() {
      return doc.paragraphs[cursor]?.layout ?? 'Standard';
    },
    async getSelectionStats(): Promise<[number, number, number]> {
      if (!selection) return [0, 0, 0];
      const text = doc.paragraphs[selection.p].text.slice(selection.start, selection.end);
      return [text.split(/\s+/).filter(Boolean).length, text.length, text.length];
    },
    async save() {
      client.calls.save += 1;
      // Test hook: simulate the blind buffer-write landing late on disk.
      if (hooks.saveDelayMs) await new Promise((r) => setTimeout(r, hooks.saveDelayMs));
      await fs.writeFile(doc.file, fakeDocText(doc.paragraphs), 'utf8');
    },
    async copySelection() {
      client.calls.copy += 1;
      if (!selection) return false;
      const para = doc.paragraphs[selection.p];
      const copied = fakeDocText([
        { layout: para.layout, text: para.text.slice(selection.start, selection.end) },
      ]);
      clip.text = copied;
      // The server's LyxClipboard reads the copied selection through the
      // RAW clipboard stub (not this closure), so mirror it there too.
      (globalThis as { __clipDoc?: string }).__clipDoc = copied;
      return true;
    },
    async beginOfDocument() {
      cursor = 0;
      selection = null;
      return true;
    },
    async paragraphGoto(pit: number) {
      // Test hook: force the direct jump to be rejected (unknown LFUN) so
      // the serial-walk fallback is exercised.
      if (hooks.failGoto) return false;
      if (pit < 0 || pit >= doc.paragraphs.length) return false;
      cursor = pit;
      selection = null;
      return true;
    },
    async paragraphDown() {
      if (cursor >= doc.paragraphs.length - 1) return false;
      cursor += 1;
      selection = null;
      return true;
    },
    async paragraphSelect() {
      selection = { p: cursor, start: 0, end: doc.paragraphs[cursor].text.length };
      return true;
    },
    async collapseSelectionForward() {
      if (selection) cursor = selection.p;
      selection = null;
      return true;
    },
    async collapseSelection() {
      selection = null;
    },
    async breakParagraph() {
      return true;
    },
    async paste() {
      client.calls.paste += 1;
      // Test hook: mid-choreography seam (the paste LFUN is in flight).
      if (hooks.onPaste) await hooks.onPaste();
      // Test hook: simulate a lost paste (nothing lands in the document).
      if (hooks.noPaste) return;
      // LyX reads the x-lyx payload through the OS clipboard (the raw stub
      // in this test), not through this closure: use the global payload.
      const payload = (globalThis as { __clipDoc?: string }).__clipDoc ?? clip.text;
      const match = /\\begin_layout ([^\n]+)\n([\s\S]*?)\n\\end_layout/.exec(payload);
      const layout = match?.[1] ?? 'Standard';
      const text = match?.[2] ?? '';
      if (selection) {
        doc.paragraphs[selection.p] = { layout, text };
        selection = null;
      } else {
        doc.paragraphs.splice(cursor, 0, { layout, text });
      }
    },
    async request() {
      return 'INFO:fake:cmd:';
    },
    async tryRequest() {
      return '';
    },
    async clearSelection() {
      selection = null;
    },
    async deleteSelection() {
      if (!selection) return false;
      doc.paragraphs[selection.p].text = '';
      selection = null;
      return true;
    },
    async mergeAwayParagraph() {
      // No-op for these tests (delete-at is not exercised).
    },
    async mergeWithNextParagraph() {
      return true;
    },
    async undo() {
      client.calls.undo += 1;
    },
  };
  return { client: client as unknown as Partial<LyxServerClient>, clip };
}

const rawClipboard: RawClipboard = {
  async hasFormat() {
    return true;
  },
  async readFormat() {
    return Buffer.from((globalThis as { __clipDoc?: string }).__clipDoc ?? '', 'utf8');
  },
  async write(formats) {
    const clip = formats['application/x-lyx'];
    (globalThis as { __clipDoc?: string }).__clipDoc =
      typeof clip === 'string' ? clip : clip?.toString('utf8');
  },
  async readText() {
    return (globalThis as { __clipText?: string }).__clipText ?? '';
  },
  async writeText(text) {
    (globalThis as { __clipText?: string }).__clipText = text;
    // Observability for the B4 restore tests: count restore writes.
    const g = globalThis as { __clipTextWrites?: number };
    g.__clipTextWrites = (g.__clipTextWrites ?? 0) + 1;
  },
  async clear() {
    (globalThis as { __clipDoc?: string }).__clipDoc = '';
  },
};

interface Harness {
  base: string;
  sessionId: string;
  agent: FakeAgent;
  lyx: ReturnType<typeof fakeLyx>;
  doc: FakeDoc;
  server: Server;
}

async function startHarness(
  replies: string[],
  lyxHooks: { onPaste?: () => Promise<void>; failGoto?: boolean; writeOnly?: boolean; noPaste?: boolean; saveDelayMs?: number } = {},
  agentOverride?: AgentRunner,
): Promise<Harness> {
  const doc = await writeFakeDoc();
  const lyx = fakeLyx(doc, lyxHooks);
  const agent = agentOverride ?? new FakeAgent(replies);
  const app = createServer({
    apiToken: API_TOKEN, panelConfig: PANEL_CONFIG,
    clipboard: rawClipboard,
    historyDir: doc.dir,
    lyxFactory: () => lyx.client as unknown as LyxServerClient,
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
  return { base, sessionId: info.sessionId, agent, lyx, doc, server };
}

async function readSse(res: Response) {
  const frames: Record<string, unknown>[] = [];
  const text = await res.text();
  for (const raw of text.split('\n\n')) {
    const frame = raw.trim();
    if (!frame.startsWith('data: ')) continue;
    try {
      frames.push(JSON.parse(frame.slice(6)));
    } catch {
      /* ignore */
    }
  }
  return frames;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('multi-action runs over the message stream', () => {
  it('restores the user clipboard text after the run', async () => {
    const harness = await startHarness(['Just prose, no edit.\n[ACTION: none]']);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    // The user had text on the clipboard before sending the message; the
    // choreography clobbers it (selection reads), and the run must restore
    // it before the stream closes.
    (globalThis as { __clipText?: string }).__clipText = 'user copied this';
    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'chat only' }),
    });
    await readSse(res);
    expect((globalThis as { __clipText?: string }).__clipText).toBe('user copied this');
  });

  it('restores the user clipboard text when the agent fails before the first turn', async () => {
    // Regression: readStep(1) saves the clipboard text BEFORE the first
    // agent prompt. A step-1 agent failure records no turn; the restore
    // must still run (it used to be gated on the recorded turn).
    const harness = await startHarness([], {}, new FailingAgent());
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    (globalThis as { __clipText?: string }).__clipText = 'user copied this';
    (globalThis as { __clipTextWrites?: number }).__clipTextWrites = 0;
    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_TOKEN },
      body: JSON.stringify({ message: 'chat only' }),
    });
    const frames = await readSse(res);
    expect(frames.some((f) => typeof f.error === 'string' && f.error.includes('agent connection lost'))).toBe(true);
    // The document was untouched and no choreography ran — the only
    // clipboard write is the end-of-run restore.
    expect((globalThis as { __clipTextWrites?: number }).__clipTextWrites).toBe(1);
    expect((globalThis as { __clipText?: string }).__clipText).toBe('user copied this');
  });

  it('applies two edits in one request, then continues to completion', async () => {
    const harness = await startHarness([
      'Fixing the title.\n```lyx\n\\begin_layout Title\nReal title\n\\end_layout\n```\n[ACTION: rewrite-at p1]',
      'Fixing the first body.\n```lyx\n\\begin_layout Standard\nfirst body rewritten\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
      'All sections filled.\n[ACTION: none]',
    ]);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'fill the template' }),
    });
    const frames = await readSse(res);

    expect(harness.doc.paragraphs[0].text).toBe('Real title');
    expect(harness.doc.paragraphs[1].text).toBe('first body rewritten');
    expect(harness.doc.paragraphs[2].text).toBe('second body');
    expect(harness.agent.prompts).toHaveLength(3);
    // The continuation prompt carries the refreshed context and the
    // completed edits so the agent does not repeat them.
    expect(harness.agent.prompts[1]).toContain('Edits already applied');
    expect(harness.agent.prompts[1]).toContain('[ACTION: rewrite-at p1]');
    const applied = frames.filter((f) => typeof f.applied === 'string');
    expect(applied.map((f) => f.applied)).toEqual(['rewrite-at', 'rewrite-at']);
    expect(frames.filter((f) => f.appliedStep).map((f) => f.appliedStep)).toEqual([1, 2]);
    expect(frames.at(-1)).toEqual({ done: true });
    expect(frames.some((f) => f.stopped === 'none')).toBe(true);
  });

  it('refuses to edit when LyX switches active document mid-run', async () => {
    // Regression 2026-11-08: the user focused another LyX window while the
    // agent was thinking; the pipe then reached THAT buffer and the run
    // failed with "Could not copy the selected paragraph for verification"
    // (or worse, could have edited the wrong document). The run must abort
    // with a clear error and paste nothing.
    let lyxRef: ReturnType<typeof fakeLyx> | null = null;
    const agent = new FakeAgent([
        'Rewriting p2.\n```lyx\n\\begin_layout Standard\nrewritten\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
      'Done.\n[ACTION: none]',
    ]);
    const origPrompt = agent.prompt.bind(agent);
    agent.prompt = async (sid: string, content: ContentBlock[]) => {
      // Simulate the focus change happening while the agent "thinks".
      lyxRef?.client.setFile('C:/Users/guzma/Git/tesis-unam/Poster Beamer PLEE.lyx');
      return origPrompt(sid, content);
    };
    const harness = await startHarness([], {}, agent);
    lyxRef = harness.lyx;
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite p2' }),
    });
    const frames = await readSse(res);

    expect(frames.some((f) => typeof f.error === 'string' && f.error.includes('active document changed mid-run'))).toBe(true);
    expect(frames.some((f) => typeof f.applied === 'string')).toBe(false);
    expect(harness.doc.paragraphs[1].text).toBe('first body');
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('write-only mode: verifies the paste in the buffer via clipboard, not the file', async () => {
    // Deaf pipe: gotoParagraph skips the copy-verify for paste actions and
    // applyAction verifies post-paste (save -> re-parse -> block match).
    const harness = await startHarness(
      [
        'Rewriting p2.\n```lyx\n\\begin_layout Standard\nsecond body rewritten\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
        'Done.\n[ACTION: none]',
      ],
      { writeOnly: true, saveDelayMs: 600 },
    );
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite p2' }),
    });
    const frames = await readSse(res);

    expect(harness.doc.paragraphs[1].text).toBe('second body rewritten');
    expect(frames.filter((f) => typeof f.applied === 'string').map((f) => f.applied)).toEqual(['rewrite-at']);
    // The pre-paste probe is skipped; the post-paste buffer verify copies once. No undo ran.
    expect(harness.lyx.client.calls.undo).toBe(0);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('write-only mode: a lost paste is detected from the file and undone', async () => {
    // noPaste simulates the blind paste not landing: post-paste verification
    // must fail, undo must run, and the run must report the error.
    const harness = await startHarness(
      [
        'Rewriting p2.\n```lyx\n\\begin_layout Standard\nsecond body rewritten\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
        'Should not be reached.\n[ACTION: none]',
      ],
      { writeOnly: true, noPaste: true },
    );
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite p2' }),
    });
    const frames = await readSse(res);

    expect(frames.some((f) => typeof f.error === 'string' && f.error.includes('Paste verification failed'))).toBe(true);
    expect(harness.lyx.client.calls.undo).toBe(1);
    expect(harness.doc.paragraphs[1].text).toBe('first body');
    expect(frames.some((f) => typeof f.applied === 'string')).toBe(false);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('falls back to the serial walk when paragraph-goto is rejected', async () => {
    // failGoto simulates an older LyX without the paragraph-goto LFUN (or
    // a rejected jump): gotoParagraph must still address [pN] correctly
    // via buffer-begin + paragraph-down, verified as usual.
    const harness = await startHarness(
      [
        'Rewriting the first body.\n```lyx\n\\begin_layout Standard\nfirst body rewritten\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
        'Done.\n[ACTION: none]',
      ],
      { failGoto: true },
    );
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite the first body' }),
    });
    const frames = await readSse(res);

    expect(harness.doc.paragraphs[0].text).toBe('placeholder title');
    expect(harness.doc.paragraphs[1].text).toBe('first body rewritten');
    expect(frames.filter((f) => typeof f.applied === 'string').map((f) => f.applied)).toEqual(['rewrite-at']);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('stops immediately when the agent has nothing to edit', async () => {
    const harness = await startHarness(['Just prose.\n[ACTION: none]']);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'explain the intro' }),
    });
    const frames = await readSse(res);
    expect(harness.doc.paragraphs[0].text).toBe('placeholder title');
    expect(harness.agent.prompts).toHaveLength(1);
    expect(frames.some((f) => f.action === 'none')).toBe(true);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('stops the run when an action fails (no automatic retry of the edit)', async () => {
    const harness = await startHarness([
      'Trying a bad target.\n```lyx\n\\begin_layout Standard\nx\n\\end_layout\n```\n[ACTION: rewrite-at p999]',
      'This should not be reached.\n```lyx\n\\begin_layout Standard\ny\n\\end_layout\n```\n[ACTION: rewrite-at p1]',
    ]);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite everything' }),
    });
    const frames = await readSse(res);
    expect(harness.doc.paragraphs[0].text).toBe('placeholder title');
    expect(harness.agent.prompts).toHaveLength(1);
    expect(frames.some((f) => typeof f.error === 'string' && f.error.includes('p999'))).toBe(true);
    expect(frames.some((f) => f.stopped === 'error')).toBe(true);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('stops between edits when the user cancels the run', async () => {
    // The user presses Stop while the first edit is being applied: the
    // cancel endpoint flips session.cancelRequested mid-choreography (the
    // paste LFUN is in flight), so the loop must finish that edit and not
    // issue a second prompt. Fired from the fake paste seam to be
    // deterministic — a fixed sleep raced the (now faster) choreography.
    let cancelMidPaste: () => Promise<void> = async () => {};
    const harness = await startHarness(
      [
        'First edit.\n```lyx\n\\begin_layout Title\nReal title\n\\end_layout\n```\n[ACTION: rewrite-at p1]',
        'This should not be reached.\n```lyx\n\\begin_layout Standard\ny\n\\end_layout\n```\n[ACTION: rewrite-at p2]',
      ],
      { onPaste: () => cancelMidPaste() },
    );
    cancelMidPaste = async () => {
      await fetch(`${harness.base}/api/session/${harness.sessionId}/cancel`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } });
    };
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const streamPromise = fetch(
      `${harness.base}/api/session/${harness.sessionId}/message/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ message: 'fill the template' }),
      },
    );
    const frames = await readSse(await streamPromise);

    expect(harness.doc.paragraphs[0].text).toBe('Real title');
    expect(harness.doc.paragraphs[1].text).toBe('first body'); // 2nd edit NOT applied
    expect(harness.agent.prompts).toHaveLength(1); // loop stopped before a 2nd prompt
    expect(frames.some((f) => f.cancelled === true)).toBe(true);
    expect(frames.some((f) => f.stopped === 'cancelled')).toBe(true);
  });

  it('stops at the safety limit after 10 applied edits', async () => {
    const edit = (n: number) =>
      `Edit ${n}.\n\`\`\`lyx\n\\begin_layout Standard\nedit ${n}\n\\end_layout\n\`\`\`\n[ACTION: rewrite-at p2]`;
    const replies = Array.from({ length: 12 }, (_, i) => edit(i + 1));
    const harness = await startHarness(replies);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.doc.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'rewrite the body 20 times' }),
    });
    const frames = await readSse(res);
    expect(harness.doc.paragraphs[1].text).toBe('edit 10'); // 10th edit, cap hit
    expect(harness.agent.prompts).toHaveLength(10); // never an 11th prompt
    expect(frames.filter((f) => typeof f.applied === 'string')).toHaveLength(10);
    expect(frames.some((f) => f.stopped === 'limit')).toBe(true);
    expect(frames.some((f) => typeof f.text === 'string' && f.text.includes('safety limit'))).toBe(true);
  });
});

describe('multi-action prompt helpers', () => {
  it('builds a continuation prompt with fresh context and completed edits', () => {
    const prompt = buildContinuationPrompt(
      'Document context\n[p1] New first',
      { hasSelection: false, lyxBody: null, text: null, layout: null },
      'fill the template',
      ['[ACTION: rewrite-at p3]', '[ACTION: rewrite-at p4]'],
    );
    expect(prompt).toContain('Original user request:');
    expect(prompt).toContain('fill the template');
    expect(prompt).toContain('[ACTION: rewrite-at p3]');
    expect(prompt).toContain('[ACTION: rewrite-at p4]');
    expect(prompt).toContain('FRESH');
    expect(prompt).toContain('If the request is now complete');
    expect(prompt).toContain('[ACTION: none]');
    expect(prompt).toContain('safety limit of 10');
  });

  it('parses continue as a non-edit action without a body', () => {
    const out = parseAction('More to do, continuing.\n[ACTION: continue]');
    expect(out.action).toBe('continue');
    expect(out.body).toBeNull();
  });

  it('describes an applied action compactly', () => {
    expect(describeAction({ action: 'move', body: null, target: 3, target2: 1 })).toBe(
      '[ACTION: move p3 p1]',
    );
    expect(describeAction({ action: 'insert-top', body: null, target: null, target2: null })).toBe(
      '[ACTION: insert-top]',
    );
  });
});
