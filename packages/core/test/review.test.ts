/**
 * Tests for the structured-review feature ported from Visual Research
 * Pal: page-aware PDF handling (pdf.ts), the review schema + report loop
 * (review.ts), and the POST /api/session/:id/review route end to end
 * with a fake agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import JSZip from 'jszip';
import {
  buildConversionPrompt,
  buildReviewPrompt,
  buildReviewZip,
  extractFirstJsonValue,
  formatPageList,
  formatReviewForHistory,
  generateReview,
  getPagesText,
  loadPdfDocument,
  parsePageRange,
  renderPdfPageImages,
  renderReportHtml,
  reviewSchema,
  writeReports,
  createCompanionServer,
  type AgentRunner,
  type AgentSettings,
  type CompanionBackend,
  type Review,
} from '../src/index.js';

// --- minimal PDF fixture ------------------------------------------------------

import { makePdf } from './pdf-fixture.js';

// --- page ranges ---------------------------------------------------------------

describe('parsePageRange / formatPageList', () => {
  it('returns all pages when the range is undefined or empty', () => {
    expect(parsePageRange(5)).toEqual([1, 2, 3, 4, 5]);
    expect(parsePageRange(3, '')).toEqual([1, 2, 3]);
  });

  it('parses singles, ranges, dedupes, sorts, and caps at the bounds', () => {
    expect(parsePageRange(10, '2,5,9')).toEqual([2, 5, 9]);
    expect(parsePageRange(10, '5,2,5,1-3')).toEqual([1, 2, 3, 5]);
    expect(parsePageRange(4, '1-10')).toEqual([1, 2, 3, 4]);
    expect(parsePageRange(5, '0,3,6,foo')).toEqual([3]);
  });

  it('formats compact page lists', () => {
    expect(formatPageList([1, 2, 3, 7])).toBe('1-3, 7');
    expect(formatPageList([4])).toBe('4');
    expect(formatPageList([])).toBe('(none)');
  });
});

// --- JSON extraction + schema ---------------------------------------------------

describe('extractFirstJsonValue', () => {
  it('parses plain JSON', () => {
    expect(extractFirstJsonValue('{"a": 1}')).toEqual({ a: 1 });
  });

  it('finds JSON inside prose and markdown fences', () => {
    expect(extractFirstJsonValue('Here you go:\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(extractFirstJsonValue('prefix {"a": 3} suffix')).toEqual({ a: 3 });
  });

  it('ignores brackets inside strings (string-aware scan)', () => {
    expect(extractFirstJsonValue('{"a": "}"}')).toEqual({ a: '}' });
    expect(extractFirstJsonValue('noise {"a": "}{[", "b": "\\"}"} tail')).toEqual({ a: '}{[', b: '"}' });
  });

  it('tolerates trailing commas', () => {
    expect(extractFirstJsonValue('{"a": 1,}')).toEqual({ a: 1 });
  });

  it('returns null when there is no JSON', () => {
    expect(extractFirstJsonValue('no json here')).toBeNull();
    expect(extractFirstJsonValue('{"unclosed": ')).toBeNull();
  });
});

const validSuggestion = {
  id: 'S1',
  page: 3,
  locationHint: 'first paragraph of Section 2',
  targetType: 'paragraph',
  severity: 'high',
  confidence: 0.9,
  rationale: 'The claim is unsupported.',
  action: 'Add a citation or soften the claim.',
  rebuttalQuestion: 'Where in the paper is this shown?',
};

describe('reviewSchema', () => {
  it('accepts a valid review and applies defaults', () => {
    const review = reviewSchema.parse({ suggestions: [validSuggestion] });
    expect(review.title).toBe('Untitled');
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0]?.rebuttalQuestion).toContain('Where');
  });

  it('rejects invalid severity / out-of-range confidence', () => {
    expect(
      reviewSchema.safeParse({ suggestions: [{ ...validSuggestion, severity: 'critical' }] }).success,
    ).toBe(false);
    expect(
      reviewSchema.safeParse({ suggestions: [{ ...validSuggestion, confidence: 1.5 }] }).success,
    ).toBe(false);
  });
});

// --- prompts ---------------------------------------------------------------------

describe('review prompts', () => {
  it('buildReviewPrompt carries the page list, history, schema, and page text', () => {
    const prompt = buildReviewPrompt({
      sourceName: 'paper.pdf',
      totalPages: 10,
      pages: [1, 2, 3],
      pageText: '--- Page 1 ---\nIntro',
      history: 'User: hello\nAssistant: hi',
    });
    expect(prompt).toContain('paper.pdf (10 pages)');
    expect(prompt).toContain('Pages to review: 1-3');
    expect(prompt).toContain('User: hello');
    expect(prompt).toContain('"targetType"');
    expect(prompt).toContain('--- Page 1 ---');
  });

  it('buildConversionPrompt embeds the prose and the schema', () => {
    const p = buildConversionPrompt('my prose review');
    expect(p).toContain('my prose review');
    expect(p).toContain('"rebuttalQuestion"');
  });
});

// --- the report loop (fake agent) -------------------------------------------------

function fakeAgent(replies: string[], capture?: { contents: ContentBlock[][] }) {
  return (): AgentRunner => ({
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async (_sessionId, content) => {
      capture?.contents.push(content);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake agent out of scripted replies');
      return reply;
    },
  });
}

const reviewJson = JSON.stringify({
  title: 'Paper review',
  summary: 'Solid but needs citations.',
  suggestions: [validSuggestion],
});

describe('generateReview', () => {
  const req = {
    sourceName: 'paper.pdf',
    totalPages: 5,
    pages: [1, 2],
    pageText: '--- Page 1 ---\ntext',
    history: 'User: focus on section 2',
  };

  it('returns the validated review when the agent replies with JSON', async () => {
    const agent = fakeAgent([reviewJson])({} as AgentSettings);
    const review = await generateReview(agent, 's1', req);
    expect(review.title).toBe('Paper review');
    expect(review.suggestions[0]?.id).toBe('S1');
  });

  it('retries once when the first reply is prose', async () => {
    const logs: string[] = [];
    const agent = fakeAgent(['Here is my review in prose…', reviewJson])({} as AgentSettings);
    const review = await generateReview(agent, 's1', req, { onLog: (m) => logs.push(m) });
    expect(review.suggestions).toHaveLength(1);
    expect(logs.some((l) => l.includes('schema'))).toBe(true);
  });

  it('retries once when the first reply is JSON but schema-invalid', async () => {
    const agent = fakeAgent([JSON.stringify({ suggestions: [{ ...validSuggestion, severity: 'nope' }] }), reviewJson])(
      {} as AgentSettings,
    );
    const review = await generateReview(agent, 's1', req);
    expect(review.title).toBe('Paper review');
  });

  it('throws when both attempts fail', async () => {
    const agent = fakeAgent(['prose one', 'still prose'])({} as AgentSettings);
    await expect(generateReview(agent, 's1', req)).rejects.toThrow(/review schema/);
  });

  it('normalizes common agent slips (string numbers, capitalized enums, fences) without a retry', async () => {
    const messy = '```json\n' + JSON.stringify({
      title: 'T',
      summary: 'S',
      suggestions: [
        {
          page: '3',
          locationHint: 'intro',
          targetType: 'Paragraph',
          severity: 'High',
          confidence: '0.85',
          rationale: 'r',
          action: 'a',
        },
      ],
    }) + '\n```\nHope that helps!';
    const capture: { contents: ContentBlock[][] } = { contents: [] };
    const agent = fakeAgent([messy], capture)({} as AgentSettings);
    const review = await generateReview(agent, 's1', req);
    expect(capture.contents).toHaveLength(1); // no retry needed
    const s = review.suggestions[0];
    expect(s?.page).toBe(3);
    expect(s?.severity).toBe('high');
    expect(s?.targetType).toBe('paragraph');
    expect(s?.confidence).toBeCloseTo(0.85);
    expect(s?.id).toBe('S1');
    expect(s?.rebuttalQuestion).toBe('');
  });

  it('names the exact validation issues in the retry prompt', async () => {
    const capture: { contents: ContentBlock[][] } = { contents: [] };
    const agent = fakeAgent(
      [JSON.stringify({ suggestions: [{ ...validSuggestion, severity: 'critical' }] }), reviewJson],
      capture,
    )({} as AgentSettings);
    const review = await generateReview(agent, 's1', req);
    expect(review.suggestions).toHaveLength(1);
    expect(capture.contents).toHaveLength(2);
    const retryPrompt = (capture.contents[1]?.[0] as { text: string }).text;
    expect(retryPrompt).toContain('severity');
    expect(retryPrompt).toContain('critical');
  });

  it('passes page images through as image content blocks', async () => {
    const capture: { contents: ContentBlock[][] } = { contents: [] };
    const agent = fakeAgent([reviewJson], capture)({} as AgentSettings);
    await generateReview(agent, 's1', {
      ...req,
      images: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
    });
    const content = capture.contents[0] ?? [];
    expect(content[0]?.type).toBe('text');
    expect(content[1]).toMatchObject({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' });
  });
});

describe('formatReviewForHistory', () => {
  it('renders one compact line per suggestion', () => {
    const review = reviewSchema.parse({ title: 'T', summary: 'S', suggestions: [validSuggestion] });
    const text = formatReviewForHistory(review);
    expect(text).toContain('Structured review — T');
    expect(text).toContain('- S1 (p3, first paragraph of Section 2');
  });
});

// --- report export -----------------------------------------------------------------

describe('writeReports', () => {
  it('writes report.md and report.json with the expected content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-review-'));
    try {
      const review = reviewSchema.parse({ title: 'My paper', summary: 'Summary.', suggestions: [validSuggestion] });
      const files = await writeReports(review, { markdown: true, json: true }, dir);
      const md = await fs.readFile(files.markdown ?? '', 'utf8');
      expect(md).toContain('# Review: My paper');
      expect(md).toContain('### 1. S1');
      expect(md).toContain('**Severity:** high');
      const json = JSON.parse(await fs.readFile(files.json ?? '', 'utf8')) as Review;
      expect(json.suggestions[0]?.page).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// --- flat HTML report + ZIP ---------------------------------------------------------

describe('renderReportHtml / buildReviewZip', () => {
  const review = reviewSchema.parse({
    title: 'Paper <b>review</b>',
    summary: 'A "summary" with <script>alert(1)</script>',
    suggestions: [validSuggestion],
  });
  const meta = { sourceName: 'paper.pdf', pages: '1-3', generatedAt: '2026-11-16T00:00:00Z' };

  it('renders one flat HTML file with inline styles and no external refs or scripts', () => {
    const html = renderReportHtml(review, meta);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<(link|img)\b/);
    expect(html).not.toMatch(/(src|href)="https?:/);
    // Content is HTML-escaped.
    expect(html).toContain('Paper &lt;b&gt;review&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('S1');
    expect(html).toContain('sev-high');
    expect(html).toContain('paper.pdf');
  });

  it('packs report.html + report.json into a ZIP', async () => {
    const zipBuf = await buildReviewZip(review, meta);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['report.html', 'report.json']);
    const json = JSON.parse(await zip.files['report.json']!.async('string')) as Review;
    expect(json.title).toContain('review');
    const html = await zip.files['report.html']!.async('string');
    expect(html).toContain('<style>');
  });
});

// --- PDF handling -------------------------------------------------------------------

describe('pdf page-aware extraction and rendering', () => {
  it('extracts per-page text with markers and renders page images', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-pdf-'));
    try {
      const pdfPath = path.join(dir, 'paper.pdf');
      await fs.writeFile(pdfPath, makePdf(['Hello ACP page one', 'Second page text here']));

      const doc = await loadPdfDocument(pdfPath);
      expect(doc.totalPages).toBe(2);
      expect(doc.text).toContain('--- Page 1 ---');
      expect(getPagesText(doc, [2])).toContain('Second page text here');
      expect(getPagesText(doc, [1, 2])).toContain('Hello ACP page one');

      const images = await renderPdfPageImages(pdfPath, [1], { dpi: 72, format: 'jpeg', quality: 70 });
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe('image/jpeg');
      expect(Buffer.from(images[0]?.base64 ?? '', 'base64').subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      );
      expect((images[0]?.width ?? 0) > 0).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// --- the /review route end to end ---------------------------------------------------

function stubBackend(documentPath: string): CompanionBackend<unknown> {
  return {
    acp: { appName: 'test-app', writerName: 'TestEditor' },
    mapStatus: () => 500,
    promptTimeoutMs: 5_000,
    createSessionState: async () => ({}),
    conversationKey: () => 'doc-key',
    replayOptions: { blockPattern: /```test[\s\S]*?```/g },
    statusSummary: async () => ({ testAvailable: true }),
    documents: async () => ({ documentPath }),
    switchDocument: async () => ({ documentPath }),
    selection: async () => ({}),
    undo: async () => ({ ok: true }),
    sessionInfo: async (session) => ({ sessionId: session.id, documentPath }),
    readStep: async () => ({ data: {} }),
    buildAutoPrompt: async (_session, _stepData, message) => message,
    buildContinuationPrompt: async (_session, _stepData, message) => message,
    parseAction: () => ({ action: 'none' }),
    applyAction: async () => ({ ok: true, description: 'none' }),
  };
}

const panelConfig = {
  appName: 'TestEditor',
  appTitle: 'TestEditor ACP Assist',
  fenceRe: 'test',
  statusKey: 'testAvailable',
  statusMissing: 'TestEditor not running',
  cursorTerm: 'layout',
  hasSaveConsent: false,
  hasInstallFlow: false,
  composerRefreshSelection: false,
  busyText: 'talking to TestEditor…',
  eventPush: false,
  theme: null,
};

function sseFrames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

describe('POST /api/session/:id/review', () => {
  let server: Server;
  let base: string;
  let tmp: string;
  let pdfPath: string;
  let capture: { contents: ContentBlock[][] };
  let replies: string[];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-review-route-'));
    pdfPath = path.join(tmp, 'paper.pdf');
    await fs.writeFile(pdfPath, makePdf(['Alpha intro text', 'Beta methods text']));
    capture = { contents: [] };
    replies = [];
    const app = createCompanionServer<unknown>({
      panelConfig,
      historyDir: path.join(tmp, 'history'),
      attachmentsDir: path.join(tmp, 'attachments'),
      logDir: path.join(tmp, 'logs'),
      settingsDir: tmp,
      apiToken: 'test-token',
      extractText: async () => 'extracted text',
      backend: stubBackend(pdfPath), // active document IS a pdf here
      agentFactory: () => ({
        start: async () => undefined,
        stop: () => undefined,
        createSession: async () => undefined,
        cancel: () => undefined,
        prompt: async (_id, content) => {
          capture.contents.push(content);
          const reply = replies.shift();
          if (reply === undefined) throw new Error('fake agent out of scripted replies');
          return reply;
        },
      }),
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

  const auth = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

  async function newSession(): Promise<string> {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: { command: 'fake', args: [] } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId?: string };
    if (!body.sessionId) throw new Error('no sessionId');
    return body.sessionId;
  }

  it('reviews an uploaded PDF attachment and serves the report as a ZIP download', async () => {
    const sessionId = await newSession();
    // Attach the PDF.
    const pdfB64 = (await fs.readFile(pdfPath)).toString('base64');
    const up = await fetch(`${base}/api/session/${sessionId}/attachments`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'paper.pdf', data: pdfB64 }),
    });
    const att = (await up.json()) as { id: string };
    expect(up.status).toBe(200);

    replies = [reviewJson];
    capture.contents.length = 0;
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ attachmentId: att.id, pages: '1-2', includeImages: true }),
    });
    expect(res.status).toBe(200);
    const frames = sseFrames(await res.text());

    expect(frames.some((f) => typeof f['log'] === 'string')).toBe(true);
    const reviewFrame = frames.find((f) => f['review']);
    expect(reviewFrame).toBeDefined();
    const review = reviewFrame?.['review'] as Review;
    expect(review.title).toBe('Paper review');
    expect(reviewFrame?.['download']).toBe(true);
    expect(frames.some((f) => f['done'] === true)).toBe(true);

    // The agent saw the page-marked text, the history header, and one page image.
    const content = capture.contents[0] ?? [];
    const textBlock = content[0] as { type: string; text: string };
    expect(textBlock.text).toContain('--- Page 1 ---');
    expect(textBlock.text).toContain('Alpha intro text');
    expect(textBlock.text).toContain('Pages to review: 1-2');
    expect(content.some((c) => c.type === 'image')).toBe(true);

    // The report is NOT written into the app's data dir; it downloads as a
    // ZIP with a flat report.html + report.json.
    const dl = await fetch(`${base}/api/session/${sessionId}/review/download`, { headers: auth });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/zip');
    expect(dl.headers.get('content-disposition')).toContain('review-paper.zip');
    const zip = await JSZip.loadAsync(Buffer.from(await dl.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual(['report.html', 'report.json']);
    const json = JSON.parse(await zip.files['report.json']!.async('string')) as Review;
    expect(json.suggestions[0]?.id).toBe('S1');
    const html = await zip.files['report.html']!.async('string');
    expect(html).toContain('Review: Paper review');
    expect(html).toContain('<style>');
  });

  it('returns 404 from the download route before any review ran', async () => {
    const sessionId = await newSession();
    const dl = await fetch(`${base}/api/session/${sessionId}/review/download`, { headers: auth });
    expect(dl.status).toBe(404);
  });

  it('defaults to the active document when it is a PDF', async () => {
    const sessionId = await newSession();
    replies = [reviewJson];
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ pages: '2' }),
    });
    const frames = sseFrames(await res.text());
    expect(frames.find((f) => f['review'])).toBeDefined();
    const textBlock = (capture.contents.at(-1)?.[0] ?? {}) as { text?: string };
    expect(textBlock.text).toContain('Beta methods text');
    expect(textBlock.text).not.toContain('Alpha intro text');
  });

  it('retries once on prose, then streams the review', async () => {
    const sessionId = await newSession();
    replies = ['my prose review of the paper', reviewJson];
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });
    const frames = sseFrames(await res.text());
    expect(frames.find((f) => f['review'])).toBeDefined();
    expect(frames.filter((f) => typeof f['log'] === 'string').some((f) => String(f['log']).includes('schema'))).toBe(true);
  });

  it('streams an error frame when the agent never returns schema-valid JSON', async () => {
    const sessionId = await newSession();
    replies = ['nope', 'still nope'];
    const res = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: pdfPath }),
    });
    const frames = sseFrames(await res.text());
    expect(frames.some((f) => typeof f['error'] === 'string')).toBe(true);
    expect(frames.some((f) => f['done'] === true)).toBe(true);
  });

  it('rejects a non-PDF target and unknown sessions', async () => {
    const sessionId = await newSession();
    const bad = await fetch(`${base}/api/session/${sessionId}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: '/etc/hostname' }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/session/nope/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
  });
});
