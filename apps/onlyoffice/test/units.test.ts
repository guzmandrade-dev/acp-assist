import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { PluginBridge } from '../src/bridge/plugin-bridge.js';
import { parseAction } from '../src/server.js';
import { parseContentBlock, extractContentBlock, parseStyleSpec, parseTableBlock } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';
import { calcAdapter, parseCalcAction } from '../src/modules/calc.js';
import { impressAdapter, parseImpressAction } from '../src/modules/impress.js';

/** The companion-side PluginBridge driven over real HTTP like the
 * plugin iframe does (hello -> next -> result). */
describe('PluginBridge (HTTP round-trip)', () => {
  it('delivers a queued op to /bridge/next and resolves it via /bridge/result', async () => {
    const bridge = new PluginBridge();
    const app = express();
    app.use(express.json());
    bridge.register(app);
    const srv: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    try {
      // Not connected yet: op() rejects with the user-facing message.
      await expect(bridge.op('context')).rejects.toThrow(/not connected/i);

      // hello (CORS must be open — the plugin iframe is file:// origin).
      const helloRes = await fetch(`${url}/bridge/hello`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'file://' },
        body: JSON.stringify({ plugin: 'acp-bridge', version: '0.2.0', editor: 'word' }),
      });
      expect(helloRes.status).toBe(200);
      expect(helloRes.headers.get('access-control-allow-origin')).toBe('*');

      // Prime the liveness tracker (isConnected needs a fresh long-poll).
      await (await fetch(`${url}/bridge/next?wait=0`)).json();

      const opPromise = bridge.op<{ pong: boolean }>('ping');
      const next = (await (await fetch(`${url}/bridge/next?wait=5`)).json()) as {
        id: string;
        op: string;
      };
      expect(next.op).toBe('ping');

      const result = await fetch(`${url}/bridge/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: next.id, ok: true, data: { pong: true } }),
      });
      expect(result.status).toBe(200);
      await expect(opPromise).resolves.toEqual({ pong: true });
    } finally {
      srv.close();
    }
  });

  it('rejects the op when the plugin reports an error result', async () => {
    const bridge = new PluginBridge();
    const app = express();
    app.use(express.json());
    bridge.register(app);
    const srv: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      await fetch(`${url}/bridge/hello`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor: 'word' }),
      });
      // Prime the liveness tracker, then queue the op.
      await (await fetch(`${url}/bridge/next?wait=0`)).json();
      const opPromise = bridge.op('deleteAt', { index: 99 });
      // Mark the rejection handled immediately (expect().rejects below
      // attaches later; Node would otherwise flag an unhandled rejection).
      void opPromise.catch(() => undefined);
      const next = (await (await fetch(`${url}/bridge/next?wait=5`)).json()) as { id: string };
      await fetch(`${url}/bridge/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: next.id, ok: false, error: 'index 99 out of range' }),
      });
      await expect(opPromise).rejects.toThrow(/out of range/);
    } finally {
      srv.close();
    }
  });

  it('caches selection-change events and notifies subscribers', async () => {
    const bridge = new PluginBridge();
    const app = express();
    app.use(express.json());
    bridge.register(app);
    const srv: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const frames: Record<string, unknown>[] = [];
      const unsub = bridge.onEvent((f) => frames.push(f));
      await fetch(`${url}/bridge/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'selection-change',
          data: { selectionType: 'text', selectedText: 'hello' },
        }),
      });
      expect(bridge.lastSelection).toEqual({ selectionType: 'text', selectedText: 'hello' });
      expect(frames).toEqual([{ refresh: true }]);
      unsub();
      await fetch(`${url}/bridge/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'selection-change',
          data: { selectionType: 'none', selectedText: '' },
        }),
      });
      expect(frames).toHaveLength(1);
    } finally {
      srv.close();
    }
  });
});

/** Writer action grammar. */
describe('parseAction', () => {
  it('parses the plain none tag', () => {
    const outcome = parseAction('Just prose.\n[ACTION: none]');
    expect(outcome.action).toBe('none');
    expect(outcome.target).toBeNull();
    expect(outcome.block).toBeNull();
  });

  it('parses an addressed action with its content block', () => {
    const reply = [
      'Adding the section.',
      '```writer',
      '## Results',
      'The numbers are in.',
      '```',
      '[ACTION: insert-after p2]',
    ].join('\n');
    const outcome = parseAction(reply);
    expect(outcome.action).toBe('insert-after');
    expect(outcome.target).toBe(2);
    expect(outcome.block).toEqual([
      { style: 'Heading 2', runs: [{ text: 'Results', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'The numbers are in.', bold: false, italic: false, code: false }] },
    ]);
  });

  it('extracts the LAST content block when the agent echoes', () => {
    const reply = [
      'Draft: ```writer\nfirst\n```',
      'Final: ```writer\nsecond\n```',
      '[ACTION: rewrite-at p1]',
    ].join('\n');
    const outcome = parseAction(reply);
    expect(outcome.block?.[0]?.runs[0]?.text).toBe('second');
  });
});

/** Writer insert-table grammar + markdown-table parsing. */
describe('insert-table action', () => {
  it('parses insert-table with its markdown-table block', () => {
    const reply = [
      'Adding a table.',
      '```writer',
      '| Name | Role |',
      '| --- | --- |',
      '| Ada | Eng |',
      '| Grace | Math |',
      '```',
      '[ACTION: insert-table p2]',
    ].join('\n');
    const outcome = parseAction(reply);
    expect(outcome.action).toBe('insert-table');
    expect(outcome.target).toBe(2);
    expect(outcome.block).toBeNull();
    expect(outcome.table).toEqual([
      ['Name', 'Role'],
      ['Ada', 'Eng'],
      ['Grace', 'Math'],
    ]);
  });

  it('parses pipe rows, drops the separator row and tag lines', () => {
    const block = ['| A | B |', '|:-:|---:|', '| 1 | 2 |', '', '| 3 | 4 |'].join('\n');
    expect(parseTableBlock(block)).toEqual([['A', 'B'], ['1', '2'], ['3', '4']]);
  });

  it('skips non-pipe lines and trims cells', () => {
    expect(parseTableBlock('intro text\n|  x  |y|  ')).toEqual([['x', 'y']]);
  });

  it('parses insert-image / add-comment / page-break tags and blocks', () => {
    const img = parseAction(
      '```writer\nimage: data:image/png;base64,AAAA\nwidth: 4cm\n```\n[ACTION: insert-image p3]',
    );
    expect(img.action).toBe('insert-image');
    expect(img.target).toBe(3);
    expect(img.image).toEqual({ src: 'data:image/png;base64,AAAA', widthCm: 4, heightCm: undefined });

    const com = parseAction('```writer\nneeds review\nsecond line\n```\n[ACTION: add-comment p1]');
    expect(com.action).toBe('add-comment');
    expect(com.comment).toBe('needs review\nsecond line');

    const pb = parseAction('[ACTION: page-break p2]');
    expect(pb.action).toBe('page-break');
    expect(pb.target).toBe(2);
    expect(pb.block).toBeNull();
  });
});

/** Markdown-lite content parsing (shared dialect with the LO app). */
describe('parseContentBlock', () => {
  it('maps headings, bullets, quotes, code fences and inline runs', () => {
    const block = [
      '# Title',
      'Plain **bold** and *italic* and `code`.',
      '- item one',
      '> a quote',
      '```',
      'verbatim line',
      '```',
    ].join('\n');
    const paras = parseContentBlock(block);
    expect(paras[0]).toEqual({
      style: 'Heading 1',
      runs: [{ text: 'Title', bold: false, italic: false, code: false }],
    });
    expect(paras[1]?.runs).toEqual([
      { text: 'Plain ', bold: false, italic: false, code: false },
      { text: 'bold', bold: true, italic: false, code: false },
      { text: ' and ', bold: false, italic: false, code: false },
      { text: 'italic', bold: false, italic: true, code: false },
      { text: ' and ', bold: false, italic: false, code: false },
      { text: 'code', bold: false, italic: false, code: true },
      { text: '.', bold: false, italic: false, code: false },
    ]);
    expect(paras[2]?.style).toBe('List');
    expect(paras[2]?.runs[0]?.text).toBe('item one');
    expect(paras[3]).toEqual({ style: 'Quote', runs: [{ text: 'a quote', bold: false, italic: false, code: false }] });
    expect(paras[4]).toEqual({ style: 'Code', runs: [{ text: 'verbatim line' }] });
  });

  it('drops action-tag lines wherever they appear', () => {
    const block = 'one\n[ACTION: none]\ntwo';
    // The tag line flushes the buffer: two separate paragraphs result.
    expect(parseContentBlock(block).map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['one', 'two']);
  });

  it('returns null from extractContentBlock when no writer fence exists', () => {
    expect(extractContentBlock('no fences here')).toBeNull();
  });

  it('recovers an UNCLOSED writer fence (truncated closing fence)', () => {
    const reply = 'I will rebuild it.\n```writer\n# Name\n\n- bullet\n[ACTION: insert-top]';
    expect(extractContentBlock(reply)).toBe('# Name\n\n- bullet\n[ACTION: insert-top]');
  });
});

/** The writer adapter's op mapping (content, addressing, validation). */
describe('writerAdapter.applyAction', () => {
  const doc = {
    editor: 'word' as const,
    paragraphs: 2,
    texts: ['Intro paragraph.', 'Body paragraph.'],
    selection: { selectionType: 'none', selectedText: '' },
  };

  function recordingBridge(calls: Array<{ op: string; args: Record<string, unknown> }>) {
    return {
      async op<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
        calls.push({ op: name, args });
        return {} as T;
      },
    };
  }

  it('maps every action to the matching plugin op', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    const content = { style: null, runs: [{ text: 'New paragraph.' }] };

    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert', module: 'writer', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert-top', module: 'writer', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert-after', module: 'writer', target: 2, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'rewrite-at', module: 'writer', target: 1, block: [content] });
    await writerAdapter.applyAction(bridge, doc, true, { action: 'rewrite', module: 'writer', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'delete-at', module: 'writer', target: 2, block: null });

    await writerAdapter.applyAction(bridge, doc, false, {
      action: 'insert-table', module: 'writer', target: 2, block: null,
      table: [['H1', 'H2'], ['a', 'b']],
    });

    expect(calls.map((c) => c.op)).toEqual([
      'insert', 'insertTop', 'insertAfter', 'rewriteAt', 'rewriteSelection', 'deleteAt', 'insertTable',
    ]);
    expect(calls[2]?.args).toEqual({ paragraphs: [content], index: 1 });
    expect(calls[5]?.args).toEqual({ index: 1 });
    expect(calls[6]?.args).toEqual({ index: 1, rows: [['H1', 'H2'], ['a', 'b']], header: true });
  });

  it('maps insert-table p0 to index -1 (very start)', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    await writerAdapter.applyAction(bridge, doc, false, {
      action: 'insert-table', module: 'writer', target: 0, block: null, table: [['only']],
    });
    expect(calls[0]?.args).toEqual({ index: -1, rows: [['only']], header: false });
  });

  it('rejects insert-table without a table block before writing', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'insert-table', module: 'writer', target: 1, block: null, table: [] }),
    ).rejects.toThrow(/markdown table/);
    expect(calls).toEqual([]);
  });

  it('maps insert-image / add-comment / page-break to plugin ops', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await writerAdapter.applyAction(bridge, doc, false, {
      action: 'insert-image', module: 'writer', target: 2, block: null,
      image: { src: RED }, // 1x1 png -> 1px at 96dpi -> ~0.026cm
    });
    await writerAdapter.applyAction(bridge, doc, false, {
      action: 'add-comment', module: 'writer', target: 1, block: null, comment: 'note',
    });
    await writerAdapter.applyAction(bridge, doc, false, {
      action: 'page-break', module: 'writer', target: 2, block: null,
    });
    expect(calls.map((c) => c.op)).toEqual(['insertImageAt', 'addComment', 'pageBreak']);
    expect(calls[0]?.args.index).toBe(1);
    expect(String(calls[0]?.args.src)).toBe(RED);
    expect(calls[0]?.args.w).toBeGreaterThan(0);
    expect(calls[1]?.args).toEqual({ index: 0, text: 'note' });
    expect(calls[2]?.args).toEqual({ index: 1 });
  });

  it('throws before writing when content or preconditions are missing', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'insert', target: null, block: null }),
    ).rejects.toThrow(/content block/);
    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'rewrite', module: 'writer', target: null, block: [{ style: null, runs: [] }] }),
    ).rejects.toThrow(/no active selection/);
    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'delete-at', module: 'writer', target: 9, block: null }),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toEqual([]);
  });
});
/** Calc action grammar + the calc adapter's op mapping. */
describe('calc adapter', () => {
  const doc = {
    editor: 'cell' as const,
    sheets: [{ name: 'Sheet1', used: 'A1:B2', active: true }],
    data: {
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [['Name', 'Qty'], ['Widget', '2']],
      formulas: [['', ''], ['', '']],
      truncated: false,
    },
    selection: { ranges: ['B2:C3'], anchor: 'B2', values: [['', ''], ['', '']], truncated: false },
  };

  function recordingBridge(calls: Array<{ op: string; args: Record<string, unknown> }>) {
    return {
      async op<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
        calls.push({ op: name, args });
        return {} as T;
      },
    };
  }

  it('parses write-cells with an A1 anchor and a TSV grid', () => {
    const reply = [
      'Writing the block.',
      '```calc',
      'Name\tQty',
      'Widget\t=SUM(B2:B10)',
      '```',
      '[ACTION: write-cells B2]',
    ].join('\n');
    const outcome = parseCalcAction(reply);
    expect(outcome.module).toBe('calc');
    expect(outcome.action).toBe('write-cells');
    expect(outcome.address).toBe('B2');
    expect(outcome.grid).toEqual([['Name', 'Qty'], ['Widget', '=SUM(B2:B10)']]);
  });

  it('parses insert-rows without content and keeps the selection anchor', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    const outcome = parseCalcAction('Making room.\n[ACTION: insert-rows]');
    expect(outcome.action).toBe('insert-rows');
    expect(outcome.grid).toBeNull();
    await calcAdapter.applyAction(bridge, doc, outcome);
    // No tag address: the selection's top-left anchor is resolved companion-side.
    expect(calls).toEqual([{ op: 'insertRows', args: { anchor: 'B2' } }]);
  });

  it('maps write-cells/rewrite to the writeCells op and insert-cols to insertCols', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    const grid = [['a', 'b']];

    await calcAdapter.applyAction(bridge, doc, parseCalcAction('```calc\na\tb\n```\n[ACTION: write-cells C1]'));
    await calcAdapter.applyAction(bridge, doc, parseCalcAction('```calc\na\tb\n```\n[ACTION: rewrite]'));
    await calcAdapter.applyAction(bridge, doc, parseCalcAction('[ACTION: insert-cols D4]'));

    expect(calls.map((c) => c.op)).toEqual(['writeCells', 'writeCells', 'insertCols']);
    expect(calls[0]?.args).toEqual({ anchor: 'C1', rows: grid });
    // rewrite anchors at the selection's top-left when the tag has no address.
    expect(calls[1]?.args).toEqual({ anchor: 'B2', rows: grid });
    expect(calls[2]?.args).toEqual({ anchor: 'D4' });
  });

  it('throws before writing when content, anchor, or selection is missing', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    const emptySel = { ...doc, selection: null };

    await expect(
      calcAdapter.applyAction(bridge, doc, parseCalcAction('[ACTION: write-cells B2]')),
    ).rejects.toThrow(/content block/);
    await expect(
      calcAdapter.applyAction(bridge, emptySel, parseCalcAction('[ACTION: insert-rows]')),
    ).rejects.toThrow(/A1 anchor/);
    await expect(
      calcAdapter.applyAction(bridge, emptySel, parseCalcAction('```calc\na\n```\n[ACTION: rewrite]')),
    ).rejects.toThrow(/no selection/);
    expect(calls).toEqual([]);
  });

  it('parses format-cells with a range address and a style block', () => {
    const outcome = parseCalcAction('```calc\n{bg=#FFF2CC; bold; size=14}\n```\n[ACTION: format-cells A1:B3]');
    expect(outcome.action).toBe('format-cells');
    expect(outcome.address).toBe('A1:B3');
    expect(outcome.style).toEqual({ bg: 'fff2cc', bold: true, size: 14 });
  });

  it('maps format-cells to the formatCells op (range vs anchor vs selection)', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    // explicit range
    await calcAdapter.applyAction(
      bridge, doc,
      parseCalcAction('```calc\n{color=#c00000; underline}\n```\n[ACTION: format-cells B2:D4]'),
    );
    expect(calls[0]).toEqual({
      op: 'formatCells',
      args: { anchor: null, range: 'B2:D4', style: { color: 'c00000', underline: true } },
    });

    // bare cell address
    await calcAdapter.applyAction(
      bridge, doc,
      parseCalcAction('```calc\n{bg=ff0000; font=Arial; italic}\n```\n[ACTION: format-cells C5]'),
    );
    expect(calls[1]).toEqual({
      op: 'formatCells',
      args: { anchor: 'C5', range: null, style: { bg: 'ff0000', font: 'Arial', italic: true } },
    });

    // no address: the whole selected range (doc.selection is B2:C3)
    await calcAdapter.applyAction(
      bridge, doc,
      parseCalcAction('```calc\n{bold}\n```\n[ACTION: format-cells]'),
    );
    expect(calls[2]).toEqual({
      op: 'formatCells',
      args: { anchor: null, range: 'B2:C3', style: { bold: true } },
    });
  });

  it('refuses format-cells without a style line or with a bad address', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    const noStyle = parseCalcAction('```calc\njust text\n```\n[ACTION: format-cells A1]');
    expect(noStyle.style).toBeNull();
    await expect(calcAdapter.applyAction(bridge, doc, noStyle)).rejects.toThrow(/style line/);

    // a malformed address does not parse as format-cells at all (the
    // grammar only accepts B2 / A1:B10) — it falls back to 'none'
    const bad = parseCalcAction('```calc\n{bold}\n```\n[ACTION: format-cells A1:B2:C3]');
    expect(bad.action).toBe('none');
    await expect(calcAdapter.applyAction(bridge, doc, bad)).rejects.toThrow(/not a Calc document action/);
    expect(calls).toEqual([]);
  });
});

describe('parseStyleSpec', () => {
  it('parses all attributes and drops unknown/invalid ones', () => {
    expect(parseStyleSpec('{bg=#ff6f3d; color=00ff00; bold; italic; underline; size=28.5; font=Georgia; bogus}')).toEqual({
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

/** Impress action grammar + the impress adapter's op mapping. */
describe('impress adapter', () => {
  const doc = {
    editor: 'slide' as const,
    count: 2,
    current: 0,
    slides: [
      { index: 0, current: true, title: 'First', bodyPreview: 'one', bodyParas: 2, hasTitle: true, hasBody: true, images: 0 },
      { index: 1, current: false, title: null, bodyPreview: null, bodyParas: 0, hasTitle: false, hasBody: true, images: 0 },
    ],
    selectionText: null,
  };

  function recordingBridge(calls: Array<{ op: string; args: Record<string, unknown> }>) {
    return {
      async op<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
        calls.push({ op: name, args });
        return {} as T;
      },
    };
  }

  it('parses rewrite-slide with its content block (title first, then body)', () => {
    const reply = [
      'New outline.',
      '```impress',
      'New Title',
      'first point',
      'second point',
      '```',
      '[ACTION: rewrite-slide s1]',
    ].join('\n');
    const outcome = parseImpressAction(reply);
    expect(outcome.module).toBe('impress');
    expect(outcome.action).toBe('rewrite-slide');
    expect(outcome.target).toBe(1);
    expect(outcome.block).toEqual(['New Title', 'first point', 'second point']);
  });

  it('maps rewrite-slide and insert-after to the matching plugin ops', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    await impressAdapter.applyAction(bridge, doc, parseImpressAction('```impress\nT\nb\n```\n[ACTION: rewrite-slide s1]'));
    await impressAdapter.applyAction(bridge, doc, parseImpressAction('```impress\nT2\nb2\n```\n[ACTION: insert-after s0]'));

    expect(calls.map((c) => c.op)).toEqual(['rewriteSlide', 'insertSlideAfter']);
    expect(calls[0]?.args).toEqual({ index: 0, title: { text: 'T' }, body: [{ text: 'b' }] });
    // insert-after s0 = the very start: the new slide lands at index 0.
    expect(calls[1]?.args).toEqual({ index: 0, title: { text: 'T2' }, body: [{ text: 'b2' }] });
  });

  it('parses the per-line style prefix into run styles', async () => {
    const reply = [
      '```impress',
      '{bold; size=40; color=#ff6f3d; font=Georgia}Quarterly Review',
      '{italic}First point',
      'Plain point',
      '```',
      '[ACTION: rewrite-slide s1]',
    ].join('\n');
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    await impressAdapter.applyAction(recordingBridge(calls), doc, parseImpressAction(reply));
    expect(calls[0]?.args).toEqual({
      index: 0,
      title: { text: 'Quarterly Review', style: { bold: true, size: 40, color: 'ff6f3d', font: 'Georgia' } },
      body: [
        { text: 'First point', style: { italic: true } },
        { text: 'Plain point' },
      ],
    });
  });

  it('parses insert-image blocks (src, at, size) and maps to insertImage', async () => {
    const reply = [
      '```impress',
      'image: https://example.com/logo.png',
      'at: 10%, 50%',
      'size: 30% x 30%',
      '```',
      '[ACTION: insert-image s2]',
    ].join('\n');
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    await impressAdapter.applyAction(recordingBridge(calls), doc, parseImpressAction(reply));
    expect(calls[0]?.op).toBe('insertImage');
    expect(calls[0]?.args).toEqual({
      index: 1,
      src: 'https://example.com/logo.png',
      x: Math.round(12192000 * 0.1),
      y: Math.round(6858000 * 0.5),
      w: Math.round(12192000 * 0.3),
      h: Math.round(6858000 * 0.3),
    });
  });

  it('defaults insert-image placement and targets the current slide without sN', async () => {
    const reply = '```impress\nimage: data:image/png;base64,AAA\n```\n[ACTION: insert-image]';
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    await impressAdapter.applyAction(recordingBridge(calls), doc, parseImpressAction(reply));
    expect(calls[0]?.op).toBe('insertImage');
    expect(calls[0]?.args).toEqual({ index: null, src: 'data:image/png;base64,AAA' });
  });

  it('rejects insert-image with a non-http/data source', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    await expect(
      impressAdapter.applyAction(
        recordingBridge(calls),
        doc,
        parseImpressAction('```impress\nimage: C:\\Users\\me\\pic.png\n```\n[ACTION: insert-image]'),
      ),
    ).rejects.toThrow(/http\(s\):\/\//);
    expect(calls).toEqual([]);
  });

  it('parses set-background lines and maps to setBackground', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['background: solid #1a2b4c', { index: 0, kind: 'solid', color: '1a2b4c' }],
      ['background: gradient #ffffff-#ff6f3d', { index: 0, kind: 'gradient', color: 'ffffff', color2: 'ff6f3d' }],
      ['background: image https://example.com/bg.png', { index: 0, kind: 'image', src: 'https://example.com/bg.png' }],
    ];
    for (const [line, expected] of cases) {
      const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
      await impressAdapter.applyAction(
        recordingBridge(calls),
        doc,
        parseImpressAction(`\`\`\`impress\n${line}\n\`\`\`\n[ACTION: set-background s1]`),
      );
      expect(calls[0]?.op).toBe('setBackground');
      expect(calls[0]?.args).toEqual(expected);
    }
  });

  it('maps add-notes and delete-slide', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);
    await impressAdapter.applyAction(bridge, doc, parseImpressAction('```impress\nRemember the demo.\n```\n[ACTION: add-notes s1]'));
    await impressAdapter.applyAction(bridge, doc, parseImpressAction('[ACTION: delete-slide s2]'));
    expect(calls[0]?.args).toEqual({ index: 0, text: 'Remember the demo.' });
    expect(calls[1]?.args).toEqual({ index: 1 });
  });

  it('throws before writing when content or the slide address is invalid', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    await expect(
      impressAdapter.applyAction(bridge, doc, parseImpressAction('[ACTION: rewrite-slide s1]')),
    ).rejects.toThrow(/content block/);
    await expect(
      impressAdapter.applyAction(bridge, doc, parseImpressAction('```impress\nT\n```\n[ACTION: rewrite-slide s9]')),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toEqual([]);
  });
});

/** readPluginVersion: reads the version out of a .plugin zip's config.json. */
describe('readPluginVersion', () => {
  it('reads the version from a stored-zip config.json', async () => {
    const { readPluginVersion } = await import('../src/bridge/plugin-package.js');
    const { makeZip } = await import('./zip-fixture.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-pluginzip-'));
    try {
      const p = path.join(dir, 'acp-bridge.plugin');
      await fs.writeFile(p, makeZip({
        'config.json': JSON.stringify({ name: 'ACP Assist Bridge', version: '0.7.0' }),
        'scripts/code.js': '// code',
      }));
      expect(await readPluginVersion(p)).toBe('0.7.0');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns null for a non-zip file and a missing file', async () => {
    const { readPluginVersion } = await import('../src/bridge/plugin-package.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-pluginzip-'));
    try {
      const p = path.join(dir, 'not-a-zip.plugin');
      await fs.writeFile(p, 'plain bytes, no zip structure');
      expect(await readPluginVersion(p)).toBeNull();
      expect(await readPluginVersion(path.join(dir, 'missing.plugin'))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reads the real packaged plugin when the artifact exists', async () => {
    const { readPluginVersion } = await import('../src/bridge/plugin-package.js');
    const p = new URL('../acp-bridge.plugin', import.meta.url);
    const exists = await fs.stat(p).then(() => true).catch(() => false);
    if (!exists) return; // artifact is gitignored — absent on fresh CI checkouts
    expect(await readPluginVersion(p)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
