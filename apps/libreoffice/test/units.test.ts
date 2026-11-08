import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAction } from '../src/server.js';
import { calcAdapter, parseCalcAction } from '../src/modules/calc.js';
import { extractContentBlock, parseContentBlock, parseInline, parseStyleSpec, parseTableBlock, parseTsvBlock } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';
import type { BridgeClient, BridgeDocument } from '../src/bridge/client.js';

const writerDoc = (paragraphs: Array<[string, string]>, extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'writer',
  title: 'Test Document',
  url: 'file:///C:/docs/test.odt',
  paragraphs: paragraphs.map(([text, style], i) => ({ i, text, style })),
  selection: null,
  cursorStyle: 'Standard',
  ...extra,
});

describe('parseAction', () => {
  it('ignores quoted tags mid-reply; only the last non-empty line carries the tag (B5)', () => {
    // Writer, Calc, and Impress vocabularies all restrict to the last
    // non-empty line.
    const quoted = parseAction(
      'You could write [ACTION: insert-after p2] to add a paragraph.\nThis was just an example.',
    );
    expect(quoted.action).toBe('none');

    const calc = parseCalcAction(
      'Example: [ACTION: write-cells B2] would set B2.\nHope that helps!',
    );
    expect(calc.action).toBe('none');

    const final = parseAction('Explanation.\n[ACTION: none]');
    expect(final.action).toBe('none');
    expect(final.tagNote).toBeNull();
  });

  it('parses a plain prose reply as none', () => {
    expect(parseAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      address: null,
      block: null,
      grid: null,
      table: null,
      image: null,
      comment: null,
      tagNote: null,
    });
  });

  it('parses insert-table with its markdown-table block', () => {
    const reply = [
      'Adding a table.',
      '```writer',
      '| Name | Role |',
      '| --- | --- |',
      '| Ada | Eng |',
      '```',
      '[ACTION: insert-table p2]',
    ].join('\n');
    const out = parseAction(reply);
    expect(out.action).toBe('insert-table');
    expect(out.target).toBe(2);
    expect(out.block).toBeNull();
    expect(out.table).toEqual([
      ['Name', 'Role'],
      ['Ada', 'Eng'],
    ]);
  });

  it('parses insert with a content block', () => {
    const reply = 'Here you go.\n```writer\n# Title\nBody line.\n```\n[ACTION: insert]';
    const out = parseAction(reply);
    expect(out.action).toBe('insert');
    expect(out.target).toBeNull();
    expect(out.block).toEqual([
      { style: 'Heading 1', runs: [{ text: 'Title', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'Body line.', bold: false, italic: false, code: false }] },
    ]);
  });

  it('parses addressed actions with target numbers', () => {
    expect(parseAction('[ACTION: insert-after p3]').target).toBe(3);
    expect(parseAction('[ACTION: rewrite-at p12]').action).toBe('rewrite-at');
    expect(parseAction('[ACTION: delete-at p2]').action).toBe('delete-at');
    expect(parseAction('[ACTION: delete-at p2]').block).toBeNull();
    expect(parseAction('[ACTION: read-paragraph p7]').action).toBe('read-paragraph');
    expect(parseAction('[ACTION: read-paragraph p7]').target).toBe(7);
    expect(parseAction('[ACTION: read-paragraph p7]').block).toBeNull();
  });

  it('takes the last tag when several appear', () => {
    expect(parseAction('[ACTION: insert]\nmore text\n[ACTION: none]').action).toBe('none');
  });

  it('content action without a block yields null block (apply refuses)', () => {
    const out = parseAction('I will insert something. [ACTION: insert]');
    expect(out.action).toBe('insert');
    expect(out.block).toBeNull();
  });

  it('auto-corrects typo tags ([AACTION:, doubled letters) and reports the correction', () => {
    const reply = 'Here is the edit.\n\n```writer\nNew text.\n```\n\n[AACTION: rewrite-at p3]';
    const out = parseAction(reply);
    expect(out.action).toBe('rewrite-at');
    expect(out.target).toBe(3);
    expect(out.block).toEqual([
      { style: null, runs: [{ text: 'New text.', bold: false, italic: false, code: false }] },
    ]);
    expect(out.tagNote).toBe('[AACTION: rewrite-at p3]');
  });

  it('accepts a missing colon; canonical tags carry no correction note', () => {
    expect(parseAction('[ACTION insert-after p2]').action).toBe('insert-after');
    expect(parseAction('[ACTION insert-after p2]').target).toBe(2);
    expect(parseAction('[ACTION insert-after p2]').tagNote).toBe('[ACTION insert-after p2]');
    expect(parseAction('[ACTION: insert-after p2]').tagNote).toBeNull();
    expect(parseAction('[ACTION: none]').tagNote).toBeNull();
  });

  it('regression: live-agent reply with a typo tag left the document untouched (2026-10-24)', () => {
    const reply = "Loosening the phrasing.\n\n```writer\nI'm applying for the Support Engineer role.\n```\n\nACTION TAG:\n\n[AACTION: rewrite-at p3]";
    const out = parseAction(reply);
    expect(out.action).toBe('rewrite-at');
    expect(out.target).toBe(3);
    expect(out.block).toEqual([
      { style: null, runs: [{ text: "I'm applying for the Support Engineer role.", bold: false, italic: false, code: false }] },
    ]);
    expect(out.tagNote).toBe('[AACTION: rewrite-at p3]');
  });
});

describe('parseInline', () => {
  it('splits bold and italic runs', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ', bold: false, italic: false, code: false },
      { text: 'b', bold: true, italic: false, code: false },
      { text: ' c', bold: false, italic: false, code: false },
    ]);
  });

  it('code spans win over emphasis markers inside them', () => {
    const runs = parseInline('use `x * y` here');
    expect(runs).toEqual([
      { text: 'use ', bold: false, italic: false, code: false },
      { text: 'x * y', bold: false, italic: false, code: true },
      { text: ' here', bold: false, italic: false, code: false },
    ]);
  });

  it('unclosed markers stay literal', () => {
    expect(parseInline('a * b')).toEqual([
      { text: 'a * b', bold: false, italic: false, code: false },
    ]);
  });
});

describe('parseContentBlock', () => {
  it('maps heading, bullet, quote and code fence lines', () => {
    const block = [
      '## Section',
      'normal line',
      '- item one',
      '> quoted',
      '```',
      'let x = 1;',
      '```',
    ].join('\n');
    const paras = parseContentBlock(block);
    expect(paras.map((p) => p.style)).toEqual([
      'Heading 2',
      null,
      'List',
      'Quotations',
      'Preformatted Text',
    ]);
    expect(paras[2].runs[0].text).toBe('item one');
    expect(paras[4].runs[0].text).toBe('let x = 1;');
  });

  it('maps numbered items to Numbering 1 and parses inline links', () => {
    const paras = parseContentBlock('1. first\n2. second\nsee [the docs](https://example.com) now');
    expect(paras[0].style).toBe('Numbering 1');
    expect(paras[1].style).toBe('Numbering 1');
    const last = paras[2];
    expect(last.runs.map((r) => [r.text, r.url])).toEqual([
      ['see ', undefined],
      ['the docs', 'https://example.com'],
      [' now', undefined],
    ]);
  });

  it('joins consecutive plain lines into one paragraph', () => {
    expect(parseContentBlock('one\ntwo').length).toBe(1);
    expect(parseContentBlock('one\n\ntwo').length).toBe(2);
  });

  it('never turns action tags into content (agents put them inside fences)', () => {
    const block = '## Future Work\nA paragraph.\n[ACTION: insert-after p2]';
    expect(parseContentBlock(block)).toEqual([
      { style: 'Heading 2', runs: [{ text: 'Future Work', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'A paragraph.', bold: false, italic: false, code: false }] },
    ]);
  });

  it('drops typo tag lines from content ([AACTION: regression)', () => {
    const block = 'First.\n[AACTION: rewrite-at p3]\nSecond.';
    expect(parseContentBlock(block).map((p) => p.runs.map((r) => r.text).join('')))
      .toEqual(['First.', 'Second.']);
  });

  it('regression: live-agent reply with tag inside the fence, echoed block', () => {
    const reply = [
      '```writer',
      '## Future Work',
      'We plan to extend this.',
      '[ACTION: insert-after p2]',
      '```',
      '```writer',
      '## Future Work',
      'We plan to extend this.',
      '[ACTION: insert-after p2]',
      '```',
    ].join('\n');
    const out = parseAction(reply);
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(2);
    expect(out.block).toEqual([
      { style: 'Heading 2', runs: [{ text: 'Future Work', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'We plan to extend this.', bold: false, italic: false, code: false }] },
    ]);
  });
});

describe('extractContentBlock', () => {
  it('extracts the writer fence and ignores others', () => {
    expect(extractContentBlock('```text\nnope\n```\n```writer\nyes\n```')).toBe('yes\n');
    expect(extractContentBlock('no fences')).toBeNull();
  });

  it('takes the LAST writer fence when the block is echoed', () => {
    const reply = '```writer\nfirst\n```\nExplanation.\n```writer\nsecond\n```';
    expect(extractContentBlock(reply)).toBe('second\n');
  });

  it('recovers an UNCLOSED writer fence (truncated closing fence)', () => {
    // Live-observed 2026-11-07: the reply ended mid-block with the
    // action tag inside the open fence.
    const reply = 'I will rebuild it.\n```writer\n# Name\n\n- bullet\n[ACTION: insert-top]';
    expect(extractContentBlock(reply)).toBe('# Name\n\n- bullet\n[ACTION: insert-top]');
  });

  it('prefers a closed fence over an earlier unclosed one only when later', () => {
    const reply = '```writer\nfirst\n```\nExplanation.\n```writer\nsecond\n[ACTION: insert]';
    expect(extractContentBlock(reply)).toBe('second\n[ACTION: insert]');
  });

  it('still returns null when the opener has no newline/content', () => {
    expect(extractContentBlock('```writer')).toBeNull();
    expect(extractContentBlock('text ```writer')).toBeNull();
  });
});

describe('companion discovery record', () => {
  it('writes and removes companion.json in the assist dir', async () => {
    const { writeCompanionRecord, removeCompanionRecord, assistDir } = await import('../src/bridge/client.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-record-'));
    const prev = process.env.APPDATA;
    process.env.APPDATA = tmp;
    try {
      const file = path.join(assistDir(), 'companion.json');
      await writeCompanionRecord({ pid: 1234, port: 9999, url: 'http://127.0.0.1:9999', exe: null, token: 'tok' });
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(saved).toEqual({ pid: 1234, port: 9999, url: 'http://127.0.0.1:9999', exe: null, token: 'tok' });
      await removeCompanionRecord();
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      process.env.APPDATA = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('discoverBridges ignores foreign-protocol records (B6) and drops dead PIDs', async () => {
    const { discoverBridges } = await import('../src/bridge/client.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-bridges-'));
    const record = (over: Record<string, unknown>) => ({
      app: 'LibreOffice ACP Assist',
      protocol: 1,
      pid: process.pid, // this test process is alive
      port: 45678,
      token: 'tok',
      startedAt: '2026-10-26T00:00:00Z',
      ...over,
    });
    await fs.writeFile(path.join(tmp, `${process.pid}-live.json`), JSON.stringify(record({})));
    await fs.writeFile(path.join(tmp, '999999-foreign.json'), JSON.stringify(record({ pid: 999999, protocol: 99 })));
    await fs.writeFile(path.join(tmp, '888888-dead.json'), JSON.stringify(record({ pid: 888888 })));
    try {
      const found = await discoverBridges(tmp);
      expect(found.map((r) => r.port)).toEqual([45678]); // only the live, same-protocol record
      await expect(fs.access(path.join(tmp, '888888-dead.json'))).rejects.toThrow(); // stale unlinked
      await expect(fs.access(path.join(tmp, '999999-foreign.json'))).resolves.toBeUndefined(); // kept, ignored
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge install: package cache clearing', () => {
  it('clearPackageCache removes uno_packages/cache AND uno_packages.pmap', async () => {
    const { clearPackageCache } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    try {
      const cacheDir = path.join(tmp, 'uno_packages', 'cache', 'registry');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, 'backenddb.xml'), '<xml/>');
      const pmap = path.join(tmp, 'uno_packages', 'uno_packages.pmap');
      await fs.writeFile(pmap, 'Pmp1 stub');
      await fs.access(path.join(tmp, 'uno_packages', 'cache')); // exists before
      await fs.access(pmap); // exists before
      expect(clearPackageCache(tmp)).toBe(true);
      await expect(fs.access(path.join(tmp, 'uno_packages', 'cache'))).rejects.toThrow();
      await expect(fs.access(pmap)).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('clearPackageCache is a no-op when the cache does not exist', async () => {
    const { clearPackageCache } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    try {
      expect(clearPackageCache(tmp)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('findLoUserProfile follows LO_USER_PROFILE override', async () => {
    const { findLoUserProfile } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    const prev = process.env.LO_USER_PROFILE;
    process.env.LO_USER_PROFILE = tmp;
    try {
      expect(findLoUserProfile()).toBe(tmp);
    } finally {
      process.env.LO_USER_PROFILE = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('installBridge clears cache+pmap BETWEEN remove and add (unopkg add retry fix)', async () => {
    const install = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-install-'));
    const oxtPath = path.join(tmp, 'bridge.oxt');
    await fs.writeFile(oxtPath, 'fake');
    // Fake profile with a stale cache AND stale pmap (simulating a
    // previous install that unopkg remove cleaned in the backend DBs
    // but left on disk).
    const profile = path.join(tmp, 'profile');
    await fs.mkdir(path.join(profile, 'uno_packages', 'cache'), { recursive: true });
    const pmap = path.join(profile, 'uno_packages', 'uno_packages.pmap');
    await fs.writeFile(pmap, 'Pmp1 stale');
    const calls: string[][] = [];
    install.setRunUnopkgForTesting(async (cmd) => {
      calls.push(cmd);
      return { ok: true, code: 0, output: 'ok' };
    });
    install.setLoUserProfileForTesting(profile);
    try {
      const result = await install.installBridge('fake-unopkg', oxtPath);
      expect(result.ok).toBe(true);
      // Order matters: remove, then add. The cache clear happens between.
      expect(calls.map((c) => c.slice(1))).toEqual([
        ['remove', 'org.libreofficeacp.bridge'],
        ['add', oxtPath],
      ]);
      // The stale pmap (which would make unopkg add fail with
      // VersionException) is gone before the add ran.
      await expect(fs.access(pmap)).rejects.toThrow();
      await expect(fs.access(path.join(profile, 'uno_packages', 'cache'))).rejects.toThrow();
      const cacheStep = result.steps.find((s) => s.command.includes('clear package cache'));
      expect(cacheStep?.ok).toBe(true);
      // The cache-clear step must come BEFORE the add step.
      const stepOrder = result.steps.map((s) => s.command);
      const clearIdx = stepOrder.findIndex((c) => c.includes('clear package cache'));
      const addIdx = stepOrder.findIndex((c) => c.startsWith('unopkg add'));
      expect(clearIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThan(clearIdx);
    } finally {
      install.setRunUnopkgForTesting(null);
      install.setLoUserProfileForTesting(null);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('writerAdapter context', () => {
  it('renders [pN] outline with styles and previews', () => {
    const doc = writerDoc([
      ['My Title', 'Heading 1'],
      ['First body paragraph', 'Standard'],
    ]);
    const ctx = writerAdapter.buildContextBlock(doc, doc.url);
    expect(ctx).toContain('[p1] (Heading 1) My Title');
    expect(ctx).toContain('[p2] First body paragraph');
    expect(ctx).toContain('file:///C:/docs/test.odt');
  });

  it('lists the style vocabulary without Standard', () => {
    const doc = writerDoc([
      ['T', 'Heading 1'],
      ['b', 'Standard'],
      ['q', 'Quotations'],
    ]);
    const ctx = writerAdapter.buildContextBlock(doc, null);
    expect(ctx).toContain('Heading 1, Quotations');
  });

  it('renders the selection block only when a selection exists', () => {
    expect(writerAdapter.buildSelectionBlock({ hasSelection: false, text: null, cursorStyle: 'Standard', calc: null })).toBe('');
    expect(
      writerAdapter.buildSelectionBlock({ hasSelection: true, text: 'sel text', cursorStyle: 'Standard', calc: null }),
    ).toContain('sel text');
  });

  it('renders table and image elements in the context', () => {
    const doc = writerDoc([['Intro', 'Standard']], {
      paragraphs: [
        { i: 0, text: 'Intro', style: 'Standard', kind: 'paragraph' },
        { i: 1, text: '', style: '', kind: 'table', rows: 3, cols: 2, header: ['Name', 'Role'] },
        { i: 2, text: '', style: '', kind: 'image' },
        { i: 3, text: 'Outro', style: 'Standard', kind: 'paragraph' },
      ],
      images: 1,
    });
    const ctx = writerAdapter.buildContextBlock(doc, doc.url);
    expect(ctx).toContain('[p2] (table 3x2: Name | Role)');
    expect(ctx).toContain('[p3] (image)');
    expect(ctx).toContain('Images: 1');
  });
});

describe('parseTableBlock', () => {
  it('parses pipe rows and drops the separator row', () => {
    const block = ['| A | B |', '|:-:|---:|', '| 1 | 2 |', '', '| 3 | 4 |'].join('\n');
    expect(parseTableBlock(block)).toEqual([['A', 'B'], ['1', '2'], ['3', '4']]);
  });

  it('skips non-pipe lines and trims cells', () => {
    expect(parseTableBlock('intro text\n|  x  |y|  ')).toEqual([['x', 'y']]);
  });
});

describe('writerAdapter applyAction insert-table', () => {
  const recordingBridge = (calls: EditPayload[]) =>
    ({
      async edit(payload: EditPayload) {
        calls.push(payload);
        return {};
      },
    }) as unknown as BridgeClient;

  it('maps insert-table to the insert-table edit mode with rows + header', async () => {
    const calls: EditPayload[] = [];
    const doc = writerDoc([['a', 'Standard'], ['b', 'Standard']]);
    const out = parseAction('```writer\n| H1 | H2 |\n| --- | --- |\n| a | b |\n```\n[ACTION: insert-table p1]');
    const r = await writerAdapter.applyAction(recordingBridge(calls), doc, { hasSelection: false, text: null, cursorStyle: null, calc: null }, out);
    expect(calls).toEqual([
      { mode: 'insert-table', target: 1, tracked: true, paragraphs: undefined, rows: [['H1', 'H2'], ['a', 'b']], header: true },
    ]);
    expect(r.description).toBe('[ACTION: insert-table p1]');
  });

  it('accepts p0 (very start) and rejects a missing table block before writing', async () => {
    const calls: EditPayload[] = [];
    const doc = writerDoc([['a', 'Standard']]);
    await writerAdapter.applyAction(
      recordingBridge(calls), doc,
      { hasSelection: false, text: null, cursorStyle: null, calc: null },
      { action: 'insert-table', target: 0, address: null, block: null, grid: null, table: [['only']], tagNote: null, startedAt: '' },
    );
    expect(calls[0]?.target).toBe(0);
    expect(calls[0]?.header).toBe(false);

    const calls2: EditPayload[] = [];
    await expect(
      writerAdapter.applyAction(
        recordingBridge(calls2), doc,
        { hasSelection: false, text: null, cursorStyle: null, calc: null },
        { action: 'insert-table', target: 1, address: null, block: null, grid: null, table: [], tagNote: null, startedAt: '' },
      ),
    ).rejects.toThrow(/markdown table/);
    expect(calls2).toEqual([]);
  });

  it('maps insert-image / add-comment / page-break to edit modes', async () => {
    const calls: EditPayload[] = [];
    const doc = writerDoc([['a', 'Standard'], ['b', 'Standard']]);
    const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await writerAdapter.applyAction(recordingBridge(calls), doc,
      { hasSelection: false, text: null, cursorStyle: null, calc: null },
      { action: 'insert-image', target: 1, address: null, block: null, grid: null, image: { src: RED }, tagNote: null, startedAt: '' });
    await writerAdapter.applyAction(recordingBridge(calls), doc,
      { hasSelection: false, text: null, cursorStyle: null, calc: null },
      { action: 'add-comment', target: 2, address: null, block: null, grid: null, comment: 'note', tagNote: null, startedAt: '' });
    await writerAdapter.applyAction(recordingBridge(calls), doc,
      { hasSelection: false, text: null, cursorStyle: null, calc: null },
      { action: 'page-break', target: 2, address: null, block: null, grid: null, tagNote: null, startedAt: '' });
    const [img, com, pb] = calls;
    expect(img?.mode).toBe('insert-image');
    expect(img?.target).toBe(1);
    expect(String(img?.src)).toMatch(/^file:\/\/\/.*\.png$/);
    expect(img?.width).toBeGreaterThan(0);
    expect(com?.mode).toBe('add-comment');
    expect(com?.text).toBe('note');
    expect(pb?.mode).toBe('page-break');
    expect(pb?.target).toBe(2);
  });

  it('parses insert-image / add-comment tags and blocks', () => {
    const img = parseAction('```writer\nimage: https://x/y.png\nwidth: 4cm\n```\n[ACTION: insert-image p2]');
    expect(img.action).toBe('insert-image');
    expect(img.image).toEqual({ src: 'https://x/y.png', widthCm: 4, heightCm: undefined });
    const com = parseAction('```writer\nnote text\n```\n[ACTION: add-comment p1]');
    expect(com.comment).toBe('note text');
    const pb = parseAction('[ACTION: page-break p2]');
    expect(pb.action).toBe('page-break');
    expect(pb.block).toBeNull();
  });

  it('read-paragraph fetches the full text without writing', async () => {
    const edits: EditPayload[] = [];
    const bridge = {
      async edit(payload: EditPayload) {
        edits.push(payload);
        return {};
      },
      async paragraph(index: number) {
        return { i: index, text: `full text of p${index + 1}`, style: 'Standard' };
      },
    } as unknown as BridgeClient;
    const doc = writerDoc([['a', 'Standard'], ['b', 'Standard']]);
    const out = parseAction('Need the full paragraph first.\n[ACTION: read-paragraph p2]');
    const r = await writerAdapter.applyAction(bridge, doc, { hasSelection: false, text: null, cursorStyle: null, calc: null }, out);
    expect(edits).toEqual([]);
    expect(r.description).toBe('[ACTION: read-paragraph p2] full text of [p2] (Standard):\nfull text of p2');

    await expect(
      writerAdapter.applyAction(bridge, doc, { hasSelection: false, text: null, cursorStyle: null, calc: null }, parseAction('[ACTION: read-paragraph p9]')),
    ).rejects.toThrow(/does not exist/);
    await expect(
      writerAdapter.applyAction(bridge, doc, { hasSelection: false, text: null, cursorStyle: null, calc: null }, parseAction('[ACTION: read-paragraph]')),
    ).rejects.toThrow(/needs a valid paragraph number/);
  });
});
// --- Calc adapter ---------------------------------------------------------------

import type { CalcInfo, EditPayload } from '../src/bridge/client.js';

const calcInfo = (extra: Partial<CalcInfo> = {}): CalcInfo => ({
  sheets: [{ name: 'Sheet1', usedRange: 'A1:B3', active: true }],
  selection: {
    sheet: 'Sheet1',
    ranges: ['Sheet1!A1:B3'],
    anchor: 'A1',
    rows: 3,
    cols: 2,
    values: [
      ['Name', 'Qty'],
      ['Widget', '5'],
      ['', '10'],
    ],
    formulas: null,
    truncated: false,
  },
  data: {
    sheet: 'Sheet1',
    range: 'A1:B3',
    values: [
      ['Name', 'Qty'],
      ['Widget', '5'],
      ['', '10'],
    ],
    formulas: null,
    truncated: false,
  },
  ...extra,
});

const calcDoc = (extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'calc',
  title: 'Budget',
  url: 'file:///C:/docs/budget.ods',
  calc: calcInfo(),
  cursorStyle: null,
  ...extra,
});

const calcSel = (calc: CalcInfo | null = calcInfo()) => ({
  hasSelection: true,
  text: null,
  cursorStyle: null,
  calc,
});

describe('parseCalcAction', () => {
  it('parses a plain prose reply as none', () => {
    expect(parseCalcAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      address: null,
      block: null,
      grid: null,
      style: null,
      tagNote: null,
    });
  });

  it('parses write-cells with an A1 anchor and a TSV block', () => {
    const reply = 'Here.\n```calc\nTotal\t=SUM(B2:B3)\n\n```\n[ACTION: write-cells C1]';
    const out = parseCalcAction(reply);
    expect(out.action).toBe('write-cells');
    expect(out.address).toBe('C1');
    expect(out.grid).toEqual([['Total', '=SUM(B2:B3)']]);
  });

  it('defaults the anchor to null (selection) and takes the last tag', () => {
    const out = parseCalcAction('[ACTION: insert-rows]\nmore\n[ACTION: insert-rows A5]');
    expect(out.action).toBe('insert-rows');
    expect(out.address).toBe('A5');
    expect(out.grid).toBeNull();
  });

  it('content action without a block yields null grid (apply refuses)', () => {
    const out = parseCalcAction('I will write cells. [ACTION: write-cells]');
    expect(out.action).toBe('write-cells');
    expect(out.grid).toBeNull();
  });

  it('writer tags do not parse in the calc grammar', () => {
    expect(parseCalcAction('[ACTION: rewrite-at p3]').action).toBe('none');
  });

  it('auto-corrects typo tags and reports the correction', () => {
    const out = parseCalcAction('[AACTION: insert-rows A5]');
    expect(out.action).toBe('insert-rows');
    expect(out.address).toBe('A5');
    expect(out.tagNote).toBe('[AACTION: insert-rows A5]');
  });
});

describe('parseTsvBlock', () => {
  it('splits rows on tabs and drops action tags and trailing empties', () => {
    const block = 'A\tB\n[ACTION: none]\nC\tD\n\n\n';
    expect(parseTsvBlock(block)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('extractContentBlock (calc)', () => {
  it('extracts the calc fence and ignores the writer fence', () => {
    expect(extractContentBlock('```writer\nnope\n```\n```calc\nyes\n```', 'calc')).toBe('yes\n');
    expect(extractContentBlock('```calc\nyes\n```')).toBeNull();
  });
});

describe('calcAdapter context', () => {
  it('renders sheets, used range, values, and selection anchor', () => {
    const ctx = calcAdapter.buildContextBlock(calcDoc(), 'file:///C:/docs/budget.ods');
    expect(ctx).toContain('Sheets: Sheet1 (used A1:B3) [active]');
    expect(ctx).toContain('```tsv');
    expect(ctx).toContain('Name\tQty');
    expect(ctx).toContain('Widget\t5');
  });

  it('renders formulas only when present', () => {
    const info = calcInfo({
      selection: { ...calcInfo().selection!, formulas: [['Name', 'Qty'], ['Widget', '5'], ['', '=B2*2']] },
      data: { ...calcInfo().data!, formulas: [['Name', 'Qty'], ['Widget', '5'], ['', '=B2*2']] },
    });
    const ctx = calcAdapter.buildContextBlock(calcDoc({ calc: info }), null);
    expect(ctx).toContain('=B2*2');
  });

  it('does not duplicate the selection grid when the data block covers it', () => {
    const sel = calcSel();
    const block = calcAdapter.buildSelectionBlock(sel);
    expect(block).toContain('Current selection: Sheet1!A1:B3 (anchor A1)');
    expect(block).not.toContain('```tsv');
  });

  it('shows the selection grid when it is outside the data block', () => {
    const info = calcInfo({ data: null });
    const block = calcAdapter.buildSelectionBlock(calcSel(info));
    expect(block).toContain('```tsv');
  });
});

describe('calcAdapter applyAction', () => {
  const edits: EditPayload[] = [];
  const bridge = {
    edit: async (payload: EditPayload) => {
      edits.push(payload);
      return {
        applied: true,
        title: 'Budget',
        mode: payload.mode,
        anchor: payload.anchor ?? 'A1',
      };
    },
  } as unknown as BridgeClient;

  it('write-cells sends the TSV rows to the bridge at the anchor', async () => {
    const out = parseCalcAction('```calc\nTotal\t15\n```\n[ACTION: write-cells C1]');
    const r = await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'write-cells',
      anchor: 'C1',
      rows: [['Total', '15']],
      tracked: true,
    });
    expect(r.description).toBe('[ACTION: write-cells at C1]');
  });

  it('write-cells without an anchor uses the selection', async () => {
    const out = parseCalcAction('```calc\nX\n```\n[ACTION: write-cells]');
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({ anchor: undefined, rows: [['X']] });
  });

  it('insert-rows/insert-cols pass count 1 and the anchor', async () => {
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), parseCalcAction('[ACTION: insert-rows A5]'));
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-rows', anchor: 'A5', count: 1 });
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), parseCalcAction('[ACTION: insert-cols]'));
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-cols', anchor: undefined, count: 1 });
  });

  it('write-cells without a content block is refused with nothing sent', async () => {
    const out = parseCalcAction('Sure. [ACTION: write-cells]');
    const before = edits.length;
    await expect(calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out)).rejects.toThrow('calc');
    expect(edits.length).toBe(before);
  });

  it('rewrite without a Calc selection is refused', async () => {
    const out = parseCalcAction('```calc\nX\n```\n[ACTION: rewrite]');
    await expect(calcAdapter.applyAction(bridge, calcDoc(), calcSel(null), out)).rejects.toThrow('no selection');
  });

  it('parses format-cells with a range address and a style block', () => {
    const out = parseCalcAction('```calc\n{bg=#FFF2CC; bold; size=14}\n```\n[ACTION: format-cells A1:B3]');
    expect(out.action).toBe('format-cells');
    expect(out.address).toBe('A1:B3');
    expect(out.style).toEqual({ bg: 'fff2cc', bold: true, size: 14 });
  });

  it('format-cells sends range vs anchor and the style to the bridge', async () => {
    const rangeOut = parseCalcAction('```calc\n{color=#c00000; underline}\n```\n[ACTION: format-cells B2:D4]');
    const r = await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), rangeOut);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'format-cells',
      anchor: undefined,
      range: 'B2:D4',
      style: { color: 'c00000', underline: true },
      tracked: true,
    });
    expect(r.description).toBe('[ACTION: format-cells B2:D4]');

    const cellOut = parseCalcAction('```calc\n{bg=ff0000; font=Arial; italic}\n```\n[ACTION: format-cells C5]');
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), cellOut);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'format-cells',
      anchor: 'C5',
      range: undefined,
      style: { bg: 'ff0000', font: 'Arial', italic: true },
    });

    // no address: neither anchor nor range — the bridge uses the selection
    const selOut = parseCalcAction('```calc\n{bold}\n```\n[ACTION: format-cells]');
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), selOut);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'format-cells',
      anchor: undefined,
      range: undefined,
      style: { bold: true },
    });
  });

  it('format-cells without a style line is refused with nothing sent', async () => {
    const out = parseCalcAction('```calc\njust text\n```\n[ACTION: format-cells A1]');
    expect(out.style).toBeNull();
    const before = edits.length;
    await expect(calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out)).rejects.toThrow('style line');
    expect(edits.length).toBe(before);
  });
});

describe('parseStyleSpec', () => {
  it('parses all attributes and drops unknown/invalid ones', () => {
    expect(parseStyleSpec('{bg=#ff6f3d; color=00ff00; bold; italic; underline; size=28.5; font=Georgia; bogus; color2=x}')).toEqual({
      bg: 'ff6f3d',
      color: '00ff00',
      bold: true,
      italic: true,
      underline: true,
      size: 29,
      font: 'Georgia',
    });
  });

  it('takes the first style line and ignores action tags', () => {
    expect(parseStyleSpec('noise\n[ACTION: none]\n{bold}\n{color=#123456}')).toEqual({ bold: true });
  });

  it('returns null without a style line or with only invalid values', () => {
    expect(parseStyleSpec('plain text\nmore')).toBeNull();
    expect(parseStyleSpec('{bg=red; size=9999}')).toBeNull();
  });
});

// --- Impress adapter --------------------------------------------------------------

import { impressAdapter, parseImpressAction } from '../src/modules/impress.js';
import type { SlideInfo, SlidesSelectionShape } from '../src/bridge/client.js';

const slide = (i: number, extra: Partial<SlideInfo> = {}): SlideInfo => ({
  i,
  name: `page${i + 1}`,
  current: false,
  shapes: [
    { i: 0, kind: 'title', text: `Title ${i + 1}` },
    { i: 1, kind: 'body', text: `Body A ${i + 1}\nBody B ${i + 1}` },
    { i: 2, kind: 'other', text: null },
  ],
  ...extra,
});

const impressDoc = (extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'impress',
  title: 'Deck',
  url: 'file:///C:/docs/deck.odp',
  slides: [slide(0, { current: true }), slide(1)],
  selection: null,
  cursorStyle: null,
  ...extra,
});

const impressSel = (frames: SlidesSelectionShape[] | null = null) => ({
  hasSelection: Boolean(frames?.length),
  text: null,
  cursorStyle: null,
  calc: null,
  slidesSelection: frames,
});

describe('parseImpressAction', () => {
  it('parses a plain prose reply as none', () => {
    expect(parseImpressAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      address: null,
      block: null,
      grid: null,
      tagNote: null,
    });
  });

  it('parses rewrite-slide sN with a title-first impress block', () => {
    const reply = 'Here.\n```impress\nNew Title\nFirst point\nSecond point\n```\n[ACTION: rewrite-slide s2]';
    const out = parseImpressAction(reply);
    expect(out.action).toBe('rewrite-slide');
    expect(out.target).toBe(2);
    expect(out.block?.map((p) => p.runs.map((r) => r.text).join('')))
      .toEqual(['New Title', 'First point', 'Second point']);
  });

  it('parses insert-after with s0 and drops action tags from the block', () => {
    const reply = '```impress\nCover\n\n[ACTION: none]\nCovers the deck\n```\n[ACTION: insert-after s0]';
    const out = parseImpressAction(reply);
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(0);
    expect(out.block?.map((p) => p.runs.map((r) => r.text).join('')))
      .toEqual(['Cover', 'Covers the deck']);
  });

  it('defaults the target to null and takes the last tag', () => {
    const out = parseImpressAction('[ACTION: insert-after s2]\nmore\n[ACTION: none]');
    expect(out.action).toBe('none');
    expect(out.target).toBeNull();
  });

  it('content action without a block yields null block (apply refuses)', () => {
    const out = parseImpressAction('I will insert a slide. [ACTION: insert-after s1]');
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(1);
    expect(out.block).toBeNull();
  });

  it('writer/calc tags do not parse in the impress grammar', () => {
    expect(parseImpressAction('[ACTION: insert-after p3]').action).toBe('none');
    expect(parseImpressAction('[ACTION: rewrite-at p2]').action).toBe('none');
    expect(parseImpressAction('[ACTION: write-cells]').action).toBe('none');
    expect(parseImpressAction('[ACTION: insert]').action).toBe('none');
  });

  it('auto-corrects typo tags and reports the correction', () => {
    const out = parseImpressAction('[ACTTION: insert-after s2]');
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(2);
    expect(out.tagNote).toBe('[ACTTION: insert-after s2]');
  });
});

describe('impressAdapter context', () => {
  it('renders the [sN] outline with titles, body counts, and the current slide', () => {
    const ctx = impressAdapter.buildContextBlock(impressDoc(), 'file:///C:/docs/deck.odp');
    expect(ctx).toContain('[s1] (current) "Title 1" | body: 2 paragraph(s), 1 other shape(s)');
    expect(ctx).toContain('[s2] "Title 2"');
    expect(ctx).toContain('Body A 1');
    expect(ctx).toContain('Slides: 2');
  });

  it('renders the selection block with frame indices and text', () => {
    const block = impressAdapter.buildSelectionBlock(
      impressSel([{ slide: 1, shape: 0, kind: 'title', text: 'Title 2' }]),
    );
    expect(block).toContain('[s2] frame 0 (title):');
    expect(block).toContain('Title 2');
    expect(impressAdapter.buildSelectionBlock(impressSel(null))).toBe('');
  });

  it('refuses rewrite-slide on a slide without a title frame (context shows it)', () => {
    const doc = impressDoc({
      slides: [{ i: 0, name: 'page1', current: true, shapes: [{ i: 0, kind: 'other', text: null }] }],
    });
    const ctx = impressAdapter.buildContextBlock(doc, null);
    expect(ctx).toContain('(no title frame)');
  });
});

describe('impressAdapter applyAction', () => {
  const edits: EditPayload[] = [];
  const bridge = {
    edit: async (payload: EditPayload) => {
      edits.push(payload);
      return {
        applied: true,
        title: 'Deck',
        mode: payload.mode,
        slide: payload.mode === 'insert-slide-after' ? payload.slide : payload.slide ?? 0,
      };
    },
  } as unknown as BridgeClient;

  it('insert-after s1 sends the anchor and the title/body block', async () => {
    const out = parseImpressAction('```impress\nAgenda\nFirst point\nSecond point\n```\n[ACTION: insert-after s1]');
    const r = await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'insert-slide-after',
      slide: 1,
      title: 'Agenda',
      body: ['First point', 'Second point'],
    });
    expect(r.description).toBe('[ACTION: insert-after — new slide after s1]');
  });

  it('insert-after s0 anchors at the very start', async () => {
    const out = parseImpressAction('```impress\nCover\n```\n[ACTION: insert-after s0]');
    const r = await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-slide-after', slide: 0, title: 'Cover', body: [] });
    expect(r.description).toBe('[ACTION: insert-after — new slide at the very start]');
  });

  it('rewrite-slide sN sends the 0-based slide index', async () => {
    const out = parseImpressAction('```impress\nNew Title\nPoint\n```\n[ACTION: rewrite-slide s2]');
    await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'rewrite-slide',
      slide: 1,
      title: 'New Title',
      body: ['Point'],
    });
  });

  it('rewrite sends the first selected frame with plain paragraph lines', async () => {
    const out = parseImpressAction('```impress\nReplacement\nMore text\n```\n[ACTION: rewrite]');
    const sel = impressSel([{ slide: 0, shape: 1, kind: 'body', text: 'Body A 1\nBody B 1' }]);
    const r = await impressAdapter.applyAction(bridge, impressDoc(), sel, out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'rewrite-frame',
      slide: 0,
      shape: 1,
      paragraphs: ['Replacement', 'More text'],
    });
    expect(r.description).toBe('[ACTION: rewrite frame on s1]');
  });

  it('rewrite without a selected text frame is refused with nothing sent', async () => {
    const out = parseImpressAction('```impress\nX\n```\n[ACTION: rewrite]');
    const before = edits.length;
    await expect(impressAdapter.applyAction(bridge, impressDoc(), impressSel(null), out)).rejects.toThrow('selected');
    expect(edits.length).toBe(before);
  });

  it('rewrite-slide without a target or with an out-of-range target is refused', async () => {
    const before = edits.length;
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: rewrite-slide]')),
    ).rejects.toThrow('slide number');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: rewrite-slide s9]')),
    ).rejects.toThrow('does not exist');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: insert-after s9]')),
    ).rejects.toThrow('does not exist');
    expect(edits.length).toBe(before);
  });

  it('content actions without a block are refused with nothing sent', async () => {
    const before = edits.length;
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('Sure. [ACTION: insert-after s1]')),
    ).rejects.toThrow('impress');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('Sure. [ACTION: rewrite]')),
    ).rejects.toThrow('impress');
    expect(edits.length).toBe(before);
  });
});

describe('bridge install: configurable office target (officePath)', () => {
  const unopkgName = process.platform === 'win32' ? 'unopkg.exe' : 'unopkg';

  async function makeFakeOffice(vendorLine: string, withPython = true) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-office-'));
    const root = path.join(tmp, 'Office');
    const program = path.join(root, 'program');
    await fs.mkdir(program, { recursive: true });
    await fs.writeFile(path.join(program, unopkgName), 'fake unopkg');
    await fs.writeFile(path.join(program, 'versionrc'), `[Product]\n${vendorLine}\n`);
    if (withPython) {
      await fs.writeFile(path.join(program, process.platform === 'win32' ? 'python.exe' : 'python'), 'fake python');
    }
    return { tmp, root, program };
  }

  it('resolveOfficeTarget accepts install root, program dir, and unopkg path', async () => {
    const { resolveOfficeTarget } = await import('../src/bridge/install.js');
    const { tmp, root, program } = await makeFakeOffice('ProductName=LibreOffice');
    try {
      for (const p of [root, program, path.join(program, unopkgName)]) {
        const t = resolveOfficeTarget(p);
        expect(t).not.toBeNull();
        expect(t!.vendor).toBe('libreoffice');
        expect(t!.root).toBe(root);
        expect(t!.unopkg).toBe(path.join(program, unopkgName));
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('detectOfficeVendor reads versionrc (collabora / openoffice) and falls back to the dir name', async () => {
    const { detectOfficeVendor, resolveOfficeTarget } = await import('../src/bridge/install.js');
    const collabora = await makeFakeOffice('ProductName=Collabora Office 24.04');
    const aoo = await makeFakeOffice('ProductName=Apache OpenOffice 4.1');
    const named = await fs.mkdtemp(path.join(os.tmpdir(), 'OpenOffice-'));
    try {
      expect(resolveOfficeTarget(collabora.root)!.vendor).toBe('collabora');
      expect(resolveOfficeTarget(aoo.root)!.vendor).toBe('openoffice');
      expect(detectOfficeVendor(named)).toBe('openoffice');
      expect(detectOfficeVendor(collabora.root)).toBe('collabora');
    } finally {
      await fs.rm(collabora.tmp, { recursive: true, force: true });
      await fs.rm(aoo.tmp, { recursive: true, force: true });
      await fs.rm(named, { recursive: true, force: true });
    }
  });

  it('resolveOfficeTarget returns null for paths without program/unopkg', async () => {
    const { resolveOfficeTarget } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-empty-'));
    try {
      expect(resolveOfficeTarget(tmp)).toBeNull();
      expect(resolveOfficeTarget('')).toBeNull();
      expect(resolveOfficeTarget('   ')).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('findUnopkg prefers the configured officePath over auto-detection', async () => {
    const { findUnopkg } = await import('../src/bridge/install.js');
    const { tmp, root } = await makeFakeOffice('ProductName=Collabora Office');
    const prev = process.env.LO_UNOPKG;
    const envUnopkg = path.join(tmp, 'env-unopkg');
    await fs.writeFile(envUnopkg, 'env unopkg');
    process.env.LO_UNOPKG = envUnopkg;
    try {
      expect(findUnopkg(root)).toBe(path.join(root, 'program', unopkgName));
      // invalid configured path falls back to env/auto
      expect(findUnopkg(path.join(tmp, 'nope'))).toBe(envUnopkg);
    } finally {
      if (prev === undefined) delete process.env.LO_UNOPKG; else process.env.LO_UNOPKG = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('findLoUserProfile scans the configured vendor profile root', async () => {
    const { findLoUserProfile } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profileroot-'));
    // Redirect the per-platform config root to tmp.
    const { tmp: officeTmp, root } = await makeFakeOffice('ProductName=Apache OpenOffice 4.1');
    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    const prevAppdata = process.env.APPDATA;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevLoProfile = process.env.LO_USER_PROFILE;
    try {
      delete process.env.LO_USER_PROFILE;
      if (process.platform === 'win32') {
        process.env.APPDATA = tmp;
        await fs.mkdir(path.join(tmp, 'OpenOffice', '4', 'user'), { recursive: true });
      } else if (process.platform === 'darwin') {
        process.env.HOME = tmp;
        await fs.mkdir(path.join(tmp, 'Library', 'Application Support', 'OpenOffice', '4', 'user'), { recursive: true });
      } else {
        process.env.XDG_CONFIG_HOME = tmp;
        await fs.mkdir(path.join(tmp, 'openoffice', '4', 'user'), { recursive: true });
      }
      const profile = findLoUserProfile(root);
      expect(profile).not.toBeNull();
      expect(profile).toContain('user');
      expect(profile!.toLowerCase()).toContain('openoffice');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserprofile;
      if (prevAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppdata;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevLoProfile === undefined) delete process.env.LO_USER_PROFILE; else process.env.LO_USER_PROFILE = prevLoProfile;
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(officeTmp, { recursive: true, force: true });
    }
  });

  it('officeHasBundledPython checks program/python', async () => {
    const { officeHasBundledPython, resolveOfficeTarget } = await import('../src/bridge/install.js');
    const withPy = await makeFakeOffice('ProductName=Collabora Office', true);
    const noPy = await makeFakeOffice('ProductName=Apache OpenOffice 4.1', false);
    try {
      expect(officeHasBundledPython(resolveOfficeTarget(withPy.root)!)).toBe(true);
      expect(officeHasBundledPython(resolveOfficeTarget(noPy.root)!)).toBe(false);
    } finally {
      await fs.rm(withPy.tmp, { recursive: true, force: true });
      await fs.rm(noPy.tmp, { recursive: true, force: true });
    }
  });

  it('installBridge threads officePath into the profile lookup', async () => {
    const install = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-install-office-'));
    const oxtPath = path.join(tmp, 'bridge.oxt');
    await fs.writeFile(oxtPath, 'fake');
    const profile = path.join(tmp, 'profile');
    await fs.mkdir(path.join(profile, 'uno_packages', 'cache'), { recursive: true });
    install.setRunUnopkgForTesting(async () => ({ ok: true, code: 0, output: 'ok' }));
    install.setLoUserProfileForTesting(profile);
    try {
      const result = await install.installBridge('fake-unopkg', oxtPath, 'C:/some/office');
      expect(result.ok).toBe(true);
      await expect(fs.access(path.join(profile, 'uno_packages', 'cache'))).rejects.toThrow();
    } finally {
      install.setRunUnopkgForTesting(null);
      install.setLoUserProfileForTesting(null);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
