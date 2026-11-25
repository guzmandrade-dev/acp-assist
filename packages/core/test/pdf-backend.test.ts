/**
 * Tests for the PDF-review mode: the external-viewer detection/opening
 * (with SumatraPDF page jumps and OS-default fallback) and the pdf
 * companion backend (prose-only chat keyed by PDF path, pdf/open,
 * open-external path validation, jump, and the shared /review route
 * defaulting to the active PDF).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  buildViewerCommand,
  createCompanionServer,
  createPdfBackend,
  createPdfExtraRoutes,
  detectExternalViewer,
  describeViewer,
  findSumatraPdf,
  loadPdfDocumentVersioned,
  openPdfExternally,
  type AgentRunner,
  type AgentSettings,
  type Review,
  type VersionedPdfDocument,
} from '../src/index.js';
import { makePdf } from './pdf-fixture.js';

// --- external viewer ------------------------------------------------------------

describe('external viewer detection and commands', () => {
  const winEnv = {
    ProgramFiles: 'C:\\PF',
    'ProgramFiles(x86)': 'C:\\PF86',
    LOCALAPPDATA: 'C:\\LA',
    USERPROFILE: 'C:\\Users\\u',
  };

  it('finds SumatraPDF in a common install path on Windows', () => {
    const exe = findSumatraPdf({
      platform: 'win32',
      env: winEnv,
      existsSync: (p) => p === 'C:\\PF\\SumatraPDF\\SumatraPDF.exe',
      whichSync: () => null,
    });
    expect(exe).toBe('C:\\PF\\SumatraPDF\\SumatraPDF.exe');
  });

  it('prefers the ACP_PDF_VIEWER override and falls back to PATH', () => {
    expect(
      findSumatraPdf({
        platform: 'win32',
        env: { ...winEnv, ACP_PDF_VIEWER: 'D:\\tools\\SumatraPDF.exe' },
        existsSync: (p) => p === 'D:\\tools\\SumatraPDF.exe',
        whichSync: () => null,
      }),
    ).toBe('D:\\tools\\SumatraPDF.exe');
    expect(
      findSumatraPdf({
        platform: 'win32',
        env: winEnv,
        existsSync: () => false,
        whichSync: (cmd) => (cmd === 'SumatraPDF' ? 'C:\\bin\\SumatraPDF.exe' : null),
      }),
    ).toBe('C:\\bin\\SumatraPDF.exe');
  });

  it('returns null off Windows and when not installed', () => {
    expect(findSumatraPdf({ platform: 'linux', env: winEnv })).toBeNull();
    expect(
      findSumatraPdf({ platform: 'win32', env: winEnv, existsSync: () => false, whichSync: () => null }),
    ).toBeNull();
    expect(detectExternalViewer({ platform: 'linux', env: {} })).toEqual({ kind: 'default' });
  });

  it('builds a SumatraPDF command with -reuse-instance and -page for jumps', () => {
    const viewer = { kind: 'sumatra' as const, exe: 'C:\\PF\\SumatraPDF\\SumatraPDF.exe' };
    const open = buildViewerCommand(viewer, 'C:\\papers\\paper.pdf', undefined, 'win32');
    expect(open.cmd).toContain('SumatraPDF');
    expect(open.args).toEqual(['-reuse-instance', 'C:\\papers\\paper.pdf']);
    const jump = buildViewerCommand(viewer, 'C:\\papers\\paper.pdf', 7, 'win32');
    expect(jump.args).toEqual(['-reuse-instance', '-page', '7', 'C:\\papers\\paper.pdf']);
  });

  it('falls back to the OS default opener per platform', () => {
    const viewer = { kind: 'default' as const };
    expect(buildViewerCommand(viewer, '/a/b.pdf', 3, 'win32')).toMatchObject({
      cmd: 'cmd',
      args: ['/c', 'start', '""', '/a/b.pdf'],
    });
    expect(buildViewerCommand(viewer, '/a/b.pdf', 3, 'darwin')).toMatchObject({ cmd: 'open', args: ['/a/b.pdf'] });
    expect(buildViewerCommand(viewer, '/a/b.pdf', 3, 'linux')).toMatchObject({ cmd: 'xdg-open', args: ['/a/b.pdf'] });
  });

  it('openPdfExternally spawns the detected viewer and reports it', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref: () => undefined };
    }) as never;
    const sumatra = await openPdfExternally('C:\\p.pdf', 4, {
      platform: 'win32',
      env: { ...winEnv, ACP_PDF_VIEWER: 'C:\\PF\\SumatraPDF\\SumatraPDF.exe' },
      existsSync: () => true,
      spawnFn: fakeSpawn,
    });
    expect(describeViewer(sumatra.viewer)).toBe('SumatraPDF');
    expect(calls[0]?.args).toEqual(['-reuse-instance', '-page', '4', 'C:\\p.pdf']);

    calls.length = 0;
    const fallback = await openPdfExternally('/p.pdf', undefined, {
      platform: 'linux',
      env: {},
      spawnFn: fakeSpawn,
    });
    expect(describeViewer(fallback.viewer)).toBe('system default viewer');
    expect(calls[0]).toMatchObject({ cmd: 'xdg-open', args: ['/p.pdf'] });
  });
});

// --- pdf companion backend --------------------------------------------------------

const panelConfig = {
  appName: 'PDF',
  appTitle: 'PDF Review — ACP Assist',
  fenceRe: 'pdf',
  statusKey: 'pdfMode',
  statusMissing: 'PDF mode needs no editor',
  cursorTerm: 'page',
  hasSaveConsent: false,
  hasInstallFlow: false,
  composerRefreshSelection: false,
  busyText: 'reading the PDF…',
  eventPush: false,
  theme: null,
  pdfMode: true,
};

function sseFrames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

describe('pdf backend (prose-only chat + pdf routes + /review default)', () => {
  let server: Server;
  let base: string;
  let tmp: string;
  let pdfPath: string;
  let spawned: { cmd: string; args: string[] }[];
  let agentCalls: ContentBlock[][];
  let agentReplies: string[];

  // No real viewer is ever launched in tests.
  const viewerDeps = {
    platform: 'linux' as const,
    env: {} as Record<string, string | undefined>,
    spawnFn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { unref: () => undefined };
    }) as never,
  };

  const fakeAgent = (): AgentRunner => ({
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async (_id, content) => {
      agentCalls.push(content);
      const reply = agentReplies.shift();
      if (reply === undefined) throw new Error('fake agent out of scripted replies');
      return reply;
    },
  });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-pdf-backend-'));
    pdfPath = path.join(tmp, 'paper.pdf');
    await fs.writeFile(pdfPath, makePdf(['Alpha intro text', 'Beta methods text']));
    spawned = [];
    agentCalls = [];
    agentReplies = [];
    const app = createCompanionServer({
      panelConfig,
      historyDir: path.join(tmp, 'history'),
      attachmentsDir: path.join(tmp, 'attachments'),
      logDir: path.join(tmp, 'logs'),
      settingsDir: tmp,
      apiToken: 'pdf-token',
      extractText: async () => 'extracted',
      agentFactory: (_s: AgentSettings) => fakeAgent(),
      backend: createPdfBackend({ viewerDeps }),
      extraRoutes: createPdfExtraRoutes(viewerDeps),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const auth = { authorization: 'Bearer pdf-token', 'content-type': 'application/json' };

  async function newSession(): Promise<string> {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: { command: 'fake', args: [] } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId?: string; documentPath?: string | null };
    if (!body.sessionId) throw new Error('no sessionId');
    expect(body.documentPath).toBeNull();
    return body.sessionId;
  }

  it('status reports pdf mode and the viewer', async () => {
    const res = await fetch(`${base}/api/status`, { headers: auth });
    const body = (await res.json()) as { pdfMode?: boolean; viewer?: string };
    expect(body.pdfMode).toBe(true);
    expect(body.viewer).toBe('system default viewer');
  });

  it('opens a PDF by path and keys the conversation by its path', async () => {
    const sessionId = await newSession();
    const open = await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });
    expect(open.status).toBe(200);
    const opened = (await open.json()) as { active: string; documents: string[] };
    expect(opened.active).toBe(pdfPath);
    expect(opened.documents).toContain(pdfPath);

    const info = (await (
      await fetch(`${base}/api/session/${sessionId}`, { headers: auth })
    ).json()) as { documentPath: string; conversation: unknown[] };
    expect(info.documentPath).toBe(pdfPath);
    expect(info.conversation).toEqual([]);

    // Chat is prose-only: the agent gets the page-marked text and its
    // reply is recorded as a plain chat turn (action "none").
    agentReplies = ['The intro on page 1 is clear; consider adding a roadmap.'];
    const msg = await fetch(`${base}/api/session/${sessionId}/message/stream`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ message: 'what about the intro?' }),
    });
    const frames = sseFrames(await msg.text());
    expect(frames.some((f) => f['action'] === 'none')).toBe(true);
    expect(frames.some((f) => f['done'] === true)).toBe(true);
    const sent = agentCalls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('Alpha intro text');
    expect(sent.text).toContain('--- Page 2 ---');
    expect(sent.text).toContain('read-only');

    const after = (await (
      await fetch(`${base}/api/session/${sessionId}`, { headers: auth })
    ).json()) as { conversation: { role: string; content: string; meta?: { action: string } }[] };
    expect(after.conversation).toHaveLength(2);
    expect(after.conversation[1]?.meta?.action).toBe('none');
  });

  it('rejects non-PDF and missing paths in pdf/open', async () => {
    const sessionId = await newSession();
    const bad = await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/etc/hostname' }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: path.join(tmp, 'nope.pdf') }),
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  it('review defaults to the active PDF and exports the report', async () => {
    const sessionId = await newSession();
    await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });
    agentReplies = [
      JSON.stringify({
        title: 'Paper review',
        summary: 'Needs work on methods.',
        suggestions: [
          {
            id: 'S1',
            page: 2,
            locationHint: 'first paragraph',
            targetType: 'paragraph',
            severity: 'medium',
            confidence: 0.8,
            rationale: 'Unclear sampling.',
            action: 'Describe the sampling procedure.',
            rebuttalQuestion: 'Where is the sample described?',
          },
        ],
      }),
    ];
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ pages: '1-2' }),
    });
    const frames = sseFrames(await res.text());
    const reviewFrame = frames.find((f) => f['review']) as { review: Review; download?: boolean } | undefined;
    expect(reviewFrame?.review.suggestions[0]?.id).toBe('S1');
    expect(reviewFrame?.download).toBe(true);
    // The report prompt carried the page-marked text of the active PDF.
    const sent = agentCalls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('Beta methods text');

    // And it downloads as a ZIP.
    const dl = await fetch(`${base}/api/session/${sessionId}/review/download`, { headers: auth });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/zip');
  });

  it('refuses chat until a PDF is open (no unsaved-document concept)', async () => {
    const sessionId = await newSession();
    agentReplies = ['should never be called'];
    const callsBefore = agentCalls.length;
    const res = await fetch(`${base}/api/session/${sessionId}/message/stream`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ message: 'hello?' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Open a PDF first');
    expect(agentCalls.length).toBe(callsBefore);
  });

  it('open-external only opens session-known PDFs and jumps with -page', async () => {
    const sessionId = await newSession();
    await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });

    const foreign = await fetch(`${base}/api/session/${sessionId}/open-external`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: 'C:\\Windows\\notepad.exe' }),
    });
    expect(foreign.status).toBe(400);

    spawned.length = 0;
    const ok = await fetch(`${base}/api/session/${sessionId}/open-external`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ page: 2 }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; viewer: string; page: number };
    expect(body.ok).toBe(true);
    expect(body.page).toBe(2);
    // linux fallback in tests: xdg-open carries no page; with Sumatra the
    // page would be passed as -page (covered in the viewer unit tests).
    expect(spawned[0]?.cmd).toBe('xdg-open');
    expect(spawned[0]?.args).toEqual([pdfPath]);

    spawned.length = 0;
    const jump = await fetch(`${base}/api/session/${sessionId}/jump`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ page: 2 }),
    });
    expect(jump.status).toBe(200);
    expect(spawned[0]?.args).toEqual([pdfPath]);

    const badPage = await fetch(`${base}/api/session/${sessionId}/jump`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ page: 0 }),
    });
    expect(badPage.status).toBe(400);
  });

  it('jump without an active PDF is refused', async () => {
    const sessionId = await newSession();
    const res = await fetch(`${base}/api/session/${sessionId}/jump`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ page: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

// --- version-checked PDF cache ------------------------------------------------------

describe('loadPdfDocumentVersioned', () => {
  it('reuses the cache while the file is unchanged and re-parses after a re-export', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-pdf-version-'));
    try {
      const p = path.join(tmp, 'doc.pdf');
      await fs.writeFile(p, makePdf(['one page only']));
      const cache = new Map<string, VersionedPdfDocument>();
      const d1 = await loadPdfDocumentVersioned(cache, p);
      expect(d1.totalPages).toBe(1);
      expect(await loadPdfDocumentVersioned(cache, p)).toBe(d1); // cache hit, same object

      // Re-export: new content (different size) + bumped mtime.
      await fs.writeFile(p, makePdf(['one page', 'two pages', 'three pages']));
      const future = new Date(Date.now() + 10_000);
      await fs.utimes(p, future, future);
      const d2 = await loadPdfDocumentVersioned(cache, p);
      expect(d2.totalPages).toBe(3);
      expect(d2).not.toBe(d1);
      expect(d2.text).toContain('three pages');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// --- context once-per-version in the message loop + batched /review route ---------

describe('message-loop context dedup + batched review route', () => {
  let server: Server;
  let base: string;
  let tmp: string;
  let pdfPath: string;
  let agentCalls: ContentBlock[][];
  let agentReplies: string[];
  let usageScript: number[];

  const viewerDeps = {
    platform: 'linux' as const,
    env: {} as Record<string, string | undefined>,
    spawnFn: (() => ({ unref: () => undefined })) as never,
  };

  const fakeAgent = (): AgentRunner => ({
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async (_id, content, options) => {
      agentCalls.push(content);
      const used = usageScript.shift();
      if (used !== undefined) options?.onUsage?.({ used, size: 200_000, cost: null });
      const reply = agentReplies.shift();
      if (reply === undefined) throw new Error('fake agent out of scripted replies');
      return reply;
    },
  });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-pdf-dedup-'));
    pdfPath = path.join(tmp, 'paper.pdf');
    await fs.writeFile(pdfPath, makePdf(['Alpha intro text', 'Beta methods text']));
    agentCalls = [];
    agentReplies = [];
    usageScript = [];
    const app = createCompanionServer({
      panelConfig,
      historyDir: path.join(tmp, 'history'),
      attachmentsDir: path.join(tmp, 'attachments'),
      logDir: path.join(tmp, 'logs'),
      settingsDir: tmp,
      apiToken: 'pdf-token',
      extractText: async () => 'extracted',
      agentFactory: (_s: AgentSettings) => fakeAgent(),
      backend: createPdfBackend({ viewerDeps }),
      extraRoutes: createPdfExtraRoutes(viewerDeps),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const auth = { authorization: 'Bearer pdf-token', 'content-type': 'application/json' };

  async function newSession(): Promise<string> {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: { command: 'fake', args: [] } }),
    });
    const body = (await res.json()) as { sessionId?: string };
    if (!body.sessionId) throw new Error('no sessionId');
    return body.sessionId;
  }

  async function sendMessage(sessionId: string, message: string): Promise<void> {
    const res = await fetch(`${base}/api/session/${sessionId}/message/stream`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ message }),
    });
    const frames = sseFrames(await res.text());
    expect(frames.some((f) => f['done'] === true)).toBe(true);
  }

  const promptText = (i: number) => (agentCalls[i]?.[0] as { text: string }).text;

  it('omits the full PDF text on repeat messages, re-sends after compaction and after a re-export', async () => {
    const sessionId = await newSession();
    await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });

    agentReplies = ['r1', 'r2', 'r3', 'r4'];
    // m2's prompt reports a compaction (used drops >30%) → next message re-sends.
    usageScript = [100_000, 40_000, 100_000, 100_000];

    await sendMessage(sessionId, 'm1');
    expect(promptText(0)).toContain('Full text of the PDF (page-marked)');
    expect(promptText(0)).toContain('Alpha intro text');

    await sendMessage(sessionId, 'm2');
    expect(promptText(1)).toContain('UNCHANGED since the outline/full text');
    expect(promptText(1)).not.toContain('Alpha intro text');

    await sendMessage(sessionId, 'm3'); // hash was cleared by the compaction signal
    expect(promptText(2)).toContain('Full text of the PDF (page-marked)');

    // Re-export the PDF (new page + new mtime): the version check must reload.
    await fs.writeFile(pdfPath, makePdf(['Alpha intro text', 'Beta methods text', 'Gamma conclusions']));
    const future = new Date(Date.now() + 20_000);
    await fs.utimes(pdfPath, future, future);
    await sendMessage(sessionId, 'm4');
    expect(promptText(3)).toContain('Full text of the PDF (page-marked)');
    expect(promptText(3)).toContain('Gamma conclusions');
  });

  it('batches a large review internally and merges the batches (route level)', async () => {
    const sessionId = await newSession();
    // 30 pages × 40 lines × ~55 chars ≈ 67k chars > the 60k default batch
    // budget → 2 batches. (Single-Tj pages would clip at the page edge, so
    // the fixture splits on \n into one Tj per line.)
    const line = 'lorem ipsum dolor sit amet lorem ipsum dolor sit amet!'; // 55 chars
    const page = Array.from({ length: 40 }, () => line).join('\n');
    const bigPdf = path.join(tmp, 'thesis.pdf');
    await fs.writeFile(bigPdf, makePdf(Array.from({ length: 30 }, () => page)));
    await fetch(`${base}/api/session/${sessionId}/pdf/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: bigPdf }),
    });

    const suggestion = (id: string, page: number) => ({
      id,
      page,
      locationHint: 'para',
      targetType: 'paragraph',
      severity: 'low',
      confidence: 0.5,
      rationale: 'r',
      action: 'a',
      rebuttalQuestion: 'q',
    });
    agentReplies = [
      JSON.stringify({ title: 'b1', summary: 's', suggestions: [suggestion('b1-S1', 1)] }),
      JSON.stringify({ title: 'b2', summary: 's', suggestions: [suggestion('b2-S1', 3)] }),
      JSON.stringify({ title: 'final', summary: 'merged', suggestions: [suggestion('s1', 1), suggestion('s2', 3)] }),
    ];
    const callsBefore = agentCalls.length;
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    const frames = sseFrames(await res.text());
    const logs = frames.filter((f) => typeof f['log'] === 'string').map((f) => f['log'] as string);
    expect(logs.some((l) => l.includes('Batch 1/2'))).toBe(true);
    expect(logs.some((l) => l.includes('Batch 2/2'))).toBe(true);
    expect(logs.some((l) => l.includes('Merging'))).toBe(true);
    const reviewFrame = frames.find((f) => f['review']) as { review: Review } | undefined;
    expect(reviewFrame?.review.title).toBe('final');
    expect(reviewFrame?.review.suggestions.map((s) => s.id)).toEqual(['s1', 's2']);

    const newCalls = agentCalls.slice(callsBefore);
    expect(newCalls).toHaveLength(3); // two batch prompts + one consolidation
    expect((newCalls[0]?.[0] as { text: string }).text).toContain('batch 1 of 2');
    expect((newCalls[1]?.[0] as { text: string }).text).toContain('batch 2 of 2');
    expect((newCalls[2]?.[0] as { text: string }).text).toContain('b1-S1');
  });
});
