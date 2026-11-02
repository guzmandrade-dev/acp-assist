import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { PluginBridge } from '../src/bridge/plugin-bridge.js';
import { parseAction } from '../src/server.js';
import { parseContentBlock, extractContentBlock } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';

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
    expect(paras[2]?.runs[0]?.text).toBe('• item one');
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

    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert-top', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'insert-after', target: 2, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'rewrite-at', target: 1, block: [content] });
    await writerAdapter.applyAction(bridge, doc, true, { action: 'rewrite', target: null, block: [content] });
    await writerAdapter.applyAction(bridge, doc, false, { action: 'delete-at', target: 2, block: null });

    expect(calls.map((c) => c.op)).toEqual([
      'insert', 'insertTop', 'insertAfter', 'rewriteAt', 'rewriteSelection', 'deleteAt',
    ]);
    expect(calls[2]?.args).toEqual({ paragraphs: [content], index: 1 });
    expect(calls[5]?.args).toEqual({ index: 1 });
  });

  it('throws before writing when content or preconditions are missing', async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const bridge = recordingBridge(calls);

    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'insert', target: null, block: null }),
    ).rejects.toThrow(/content block/);
    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'rewrite', target: null, block: [{ style: null, runs: [] }] }),
    ).rejects.toThrow(/no active selection/);
    await expect(
      writerAdapter.applyAction(bridge, doc, false, { action: 'delete-at', target: 9, block: null }),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toEqual([]);
  });
});