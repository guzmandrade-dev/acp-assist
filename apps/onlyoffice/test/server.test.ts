import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServer, type AgentRunner, type AgentSettings } from '../src/server.js';
import { PANEL_CONFIG } from '../src/panel-config.js';
import { PluginBridge, type WriterDocument } from '../src/bridge/plugin-bridge.js';

const API_TOKEN = 'test-api-token';

/**
 * In-memory fake of the in-ONLYOFFICE plugin: overrides op() with the
 * same semantics as the real callCommand ops (insert = fresh paragraphs
 * below the cursor, rewrite-at = replace, delete-at = remove; writeCells
 * splices the TSV rows at the anchor, insertRows/Cols splice an empty
 * row/column; rewriteSlide/insertSlideAfter mutate the deck) so the
 * whole multi-action loop runs without the editor.
 */
class FakePluginBridge extends PluginBridge {
  paragraphs: Array<{ text: string; style: string | null }> = [
    { text: 'Intro paragraph.', style: 'Normal' },
    { text: 'Body paragraph.', style: 'Normal' },
  ];
  editor: 'word' | 'cell' | 'slide' = 'word';
  edits: Array<{ op: string; args: Record<string, unknown> }> = [];
  selection: { selectionType: string; selectedText: string } = { selectionType: 'none', selectedText: '' };
  undoResult: { undone?: boolean; reason?: string; error?: string } = { undone: true };
  /** Cell state: a small grid + the selection the editor would report. */
  cells: string[][] = [['Name', 'Qty'], ['Widget', '2']];
  cellSelection: { ranges: string[]; anchor: string; values: string[][] } | null = {
    ranges: ['B2:C3'],
    anchor: 'B2',
    values: [['', ''], ['', '']],
  };
  /** Slide state: title + body lines + images + notes + background per slide. */
  slides: Array<{ title: string | null; body: string[]; images: string[]; notes: string[]; background: string | null }> = [
    { title: 'First slide', body: ['one', 'two'], images: [], notes: [], background: null },
    { title: 'Second slide', body: [], images: [], notes: [], background: null },
  ];
  currentSlide = 0;
  private cursorAt = 0;

  override isConnected(): boolean {
    return true;
  }

  private a1ToRC(a1: string): { row: number; col: number } {
    const m = /^([A-Za-z]+)([0-9]+)$/.exec(a1);
    if (!m || !m[1] || !m[2]) throw new Error('bad anchor ' + a1);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) & 31);
    return { row: Number.parseInt(m[2], 10) - 1, col: col - 1 };
  }

  private wordDoc(): WriterDocument {
    return {
      editor: 'word',
      paragraphs: this.paragraphs.length,
      texts: this.paragraphs.map((p) => p.text),
      styles: this.paragraphs.map((p) => p.style),
      selection: this.selection,
    };
  }

  private cellDoc() {
    const cols = Math.max(...this.cells.map((r) => r.length));
    const colName = (n: number): string => {
      let s = '';
      let x = n + 1;
      while (x > 0) {
        const rem = (x - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        x = Math.floor((x - 1) / 26);
      }
      return s;
    };
    return {
      editor: 'cell' as const,
      sheets: [{ name: 'Sheet1', used: `A1:${colName(cols - 1)}${this.cells.length}`, active: true }],
      data: {
        sheet: 'Sheet1',
        range: `A1:${colName(cols - 1)}${this.cells.length}`,
        values: this.cells,
        formulas: null,
        truncated: false,
      },
      selection: this.cellSelection,
    };
  }

  private slideDoc() {
    return {
      editor: 'slide' as const,
      count: this.slides.length,
      current: this.currentSlide,
      slides: this.slides.map((s, i) => ({
        index: i,
        current: i === this.currentSlide,
        title: s.title,
        bodyPreview: s.body[0] ?? null,
        bodyParas: s.body.length,
        hasTitle: s.title !== null,
        hasBody: true,
        images: s.images.length,
      })),
      selectionText: null,
    };
  }

  override async op<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    this.edits.push({ op: name, args });
    const paras = (args.paragraphs as Array<{ style: string | null; runs: Array<{ text: string }> }> | undefined) ?? [];
    const plain = paras.map((p) => ({
      text: p.runs.map((r) => r.text).join(''),
      style: p.style,
    }));
    switch (name) {
      case 'ping':
        return { pong: true, editor: this.editor } as T;
      case 'context':
        if (this.editor === 'word') return this.wordDoc() as T;
        if (this.editor === 'cell') return this.cellDoc() as T;
        if (this.editor === 'slide') return this.slideDoc() as T;
        return { editor: this.editor } as T;
      case 'selection':
        return this.selection as T;
      case 'undo':
        return this.undoResult as T;
      case 'insert':
      case 'insertTop': {
        const at = name === 'insertTop' ? 0 : this.cursorAt + 1;
        this.paragraphs.splice(at, 0, ...plain);
        this.cursorAt = at + plain.length - 1;
        return { elements: this.paragraphs.length } as T;
      }
      case 'insertAfter': {
        const at = (args.index as number) + 1;
        this.paragraphs.splice(at, 0, ...plain);
        return { elements: this.paragraphs.length } as T;
      }
      case 'rewriteAt': {
        const at = args.index as number;
        this.paragraphs.splice(at, 1, ...plain);
        return { oldText: '', elements: this.paragraphs.length } as T;
      }
      case 'deleteAt': {
        this.paragraphs.splice(args.index as number, 1);
        return { oldText: '', elements: this.paragraphs.length } as T;
      }
      case 'rewriteSelection': {
        this.paragraphs.splice(this.cursorAt, 1, ...plain);
        return { pasted: true } as T;
      }
      case 'writeCells': {
        const { row, col } = this.a1ToRC(args.anchor as string);
        const rows = args.rows as string[][];
        while (this.cells.length < row + rows.length) this.cells.push([]);
        rows.forEach((cells, r) => {
          const target = this.cells[row + r] ?? (this.cells[row + r] = []);
          cells.forEach((value, c) => {
            target[col + c] = value;
          });
        });
        return { rows: rows.length, anchor: args.anchor } as T;
      }
      case 'insertRows': {
        const { row } = this.a1ToRC(args.anchor as string);
        this.cells.splice(row, 0, []);
        return { anchor: args.anchor } as T;
      }
      case 'insertCols': {
        const { col } = this.a1ToRC(args.anchor as string);
        this.cells.forEach((r) => r.splice(col, 0, ''));
        return { anchor: args.anchor } as T;
      }
      case 'rewriteSlide': {
        const index = args.index as number;
        const slide = this.slides[index];
        if (!slide) throw new Error(`slide index ${index} out of range`);
        const title = args.title as { text: string; style?: Record<string, unknown> };
        const body = (args.body as Array<{ text: string; style?: Record<string, unknown> }>) ?? [];
        slide.title = title.text;
        if (body.length > 0) slide.body = body.map((l) => l.text);
        return { count: this.slides.length } as T;
      }
      case 'insertSlideAfter': {
        const index = args.index as number;
        const title = args.title as { text: string; style?: Record<string, unknown> };
        const body = (args.body as Array<{ text: string; style?: Record<string, unknown> }>) ?? [];
        this.slides.splice(index, 0, {
          title: title.text,
          body: body.map((l) => l.text),
          images: [],
          notes: [],
          background: null,
        });
        return { count: this.slides.length, insertedAt: index } as T;
      }
      case 'insertImage': {
        const index = (args.index as number | null) ?? this.currentSlide;
        const slide = this.slides[index];
        if (!slide) throw new Error(`slide index ${index} out of range`);
        slide.images.push(String(args.src));
        return { added: true, images: slide.images.length } as T;
      }
      case 'setBackground': {
        const index = (args.index as number | null) ?? this.currentSlide;
        const slide = this.slides[index];
        if (!slide) throw new Error(`slide index ${index} out of range`);
        slide.background = String(args.kind);
        return { applied: true, kind: String(args.kind) } as T;
      }
      case 'addNotes': {
        const index = (args.index as number | null) ?? this.currentSlide;
        const slide = this.slides[index];
        if (!slide) throw new Error(`slide index ${index} out of range`);
        slide.notes.push(String(args.text));
        return { applied: true } as T;
      }
      case 'deleteSlide': {
        this.slides.splice(args.index as number, 1);
        return { applied: true, slidesBefore: this.slides.length + 1, slidesAfter: this.slides.length } as T;
      }
      default:
        throw new Error(`fake bridge: unknown op '${name}'`);
    }
  }
}

/** Fake ACP agent with a scripted queue of replies. */
function fakeAgent(replies: string[]): (settings: AgentSettings) => AgentRunner {
  return () => ({
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async () => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake agent out of scripted replies');
      return reply;
    },
  });
}

function sseFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));
}

const publicDir = path.join(os.tmpdir(), 'oo-acp-test-public');
const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + API_TOKEN };

describe('server (fake agent + fake plugin bridge)', () => {
  let httpServer: Server | undefined;
  const historyDir = path.join(os.tmpdir(), 'oo-acp-test-history');

  afterAll(async () => {
    httpServer?.close();
    await fs.rm(historyDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function serve(options: {
    replies?: string[];
    bridge?: FakePluginBridge;
  } = {}): Promise<{ url: string; bridge: FakePluginBridge; close: () => void }> {
    const bridge = options.bridge ?? new FakePluginBridge();
    // Isolated history dir per server: every session keys conversations
    // as '(unsaved)' (the plugin sandbox cannot read file paths), so a
    // shared dir would cross-contaminate tests across runs.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-acp-hist-'));
    const app = createServer({
      apiToken: API_TOKEN,
      publicDir,
      panelConfig: PANEL_CONFIG,
      historyDir: dir,
      pluginBridge: bridge,
      // ALWAYS a fake agent: a real ACP process must never spawn in tests.
      agentFactory: fakeAgent(options.replies ?? []),
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return {
      url,
      bridge,
      close: () => {
        srv.close();
        void fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  it('reports bridge availability from the plugin connection', async () => {
    const { url, close } = await serve();
    try {
      const status = await (await fetch(`${url}/api/status`, { headers })).json();
      expect(status.bridgeAvailable).toBe(true);
    } finally {
      close();
    }
  });

  it('runs a multi-action loop: edit, continuation, then none', async () => {
    const scripted = [
      'Adding the section.\n```writer\n## Results\nThe numbers are in.\n```\n[ACTION: insert-after p2]',
      'One more paragraph inserted.\n```writer\nStill to do.\n```\n[ACTION: insert-after p3]',
      'All edits are now complete.',
    ];
    const { url, bridge, close } = await serve({ replies: scripted });
    try {
      const created = await fetch(`${url}/api/session`, { method: 'POST', headers });
      expect(created.status).toBe(200);

      const res = await fetch(`${url}/api/session/${(await created.json() as { sessionId: string }).sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'Add a Results section after paragraph 2, then a follow-up paragraph.' }),
      });
      const frames = sseFrames(await res.text());
      const applied = frames.filter((f) => 'applied' in f);
      expect(applied.map((f) => f['applied'])).toEqual(['insert-after', 'insert-after']);
      expect(applied[0]).toMatchObject({ applied: 'insert-after', target: 2, module: 'writer' });
      const stopped = frames.find((f) => 'stopped' in f);
      expect(stopped?.['stopped']).toBe('none');
      expect(frames[frames.length - 1]).toEqual({ done: true });

      // The fake plugin applied both edits with paragraph addressing.
      const ops = bridge.edits.map((e) => e.op);
      expect(ops).toContain('insertAfter');
      expect(bridge.paragraphs.map((p) => p.text)).toContain('Results');
    } finally {
      close();
    }
  });

  it('reports the applied action and fresh outline in sessionInfo', async () => {
    const { url, close } = await serve({
      replies: ['Rewritten.\n```writer\nReplacement text.\n```\n[ACTION: rewrite-at p1]', 'Done.'],
    });
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'Rewrite the first paragraph.' }),
      });

      const info = (await (
        await fetch(`${url}/api/session/${session.sessionId}?outline=1`, { headers })
      ).json()) as {
        conversation: Array<{ role: string; meta?: { action: string; result: string } }>;
        outline: string;
        documentPath: string;
      };
      expect(info.outline).toContain('Replacement text.');
      expect(info.documentPath).toBe('(unsaved)');
      const metas = info.conversation.filter((t) => t.meta).map((t) => t.meta);
      expect(metas[0]?.action).toBe('rewrite-at');
      expect(metas[0]?.result).toBe('applied');

      // The light GET skips the outline read.
      const light = (await (await fetch(`${url}/api/session/${session.sessionId}`, { headers })).json()) as { outline: string };
      expect(light.outline).toBe('');
    } finally {
      close();
    }
  });

  it('undo reports success when the plugin undo op works', async () => {
    const { url, close } = await serve();
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      const undo = (await (
        await fetch(`${url}/api/session/${session.sessionId}/undo`, { method: 'POST', headers })
      ).json()) as { ok: boolean };
      expect(undo.ok).toBe(true);
    } finally {
      close();
    }
  });

  it('undo degrades to a Ctrl+Z hint when the plugin cannot undo', async () => {
    const bridge = new FakePluginBridge();
    bridge.undoResult = { error: 'no undo api' };
    const { url, close } = await serve({ bridge });
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      const undo = (await (
        await fetch(`${url}/api/session/${session.sessionId}/undo`, { method: 'POST', headers })
      ).json()) as { ok: boolean; reason: string };
      expect(undo.ok).toBe(false);
      expect(undo.reason).toMatch(/Ctrl\+Z/);
    } finally {
      close();
    }
  });

  it('undo reports the Ctrl+Z hint when the plugin honestly says undone:false (v0.3)', async () => {
    const bridge = new FakePluginBridge();
    bridge.undoResult = { undone: false, reason: 'no plugin undo API — use Ctrl+Z in the editor' };
    const { url, close } = await serve({ bridge });
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      const undo = (await (
        await fetch(`${url}/api/session/${session.sessionId}/undo`, { method: 'POST', headers })
      ).json()) as { ok: boolean; reason: string };
      expect(undo.ok).toBe(false);
      expect(undo.reason).toMatch(/Ctrl\+Z/);
    } finally {
      close();
    }
  });

  it('runs a calc multi-action loop through the cell module', async () => {
    const bridge = new FakePluginBridge();
    bridge.editor = 'cell';
    const scripted = [
      'Writing the block.\n```calc\nName\tQty\nGadget\t=SUM(B2:B10)\n```\n[ACTION: write-cells B2]',
      'Making room above row 2.\n[ACTION: insert-rows A2]',
      'The sheet now holds the data.',
    ];
    const { url, close } = await serve({ bridge, replies: scripted });
    try {
      const created = await fetch(`${url}/api/session`, { method: 'POST', headers });
      const res = await fetch(`${url}/api/session/${(await created.json() as { sessionId: string }).sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'Write the block at B2, then insert a row above row 2.' }),
      });
      const frames = sseFrames(await res.text());
      const applied = frames.filter((f) => 'applied' in f);
      expect(applied.map((f) => f['applied'])).toEqual(['write-cells', 'insert-rows']);
      expect(applied[0]).toMatchObject({ applied: 'write-cells', module: 'calc' });
      // Calc addressing rides in `address`, not `target`.
      expect(applied[0]).toMatchObject({ address: 'B2' });
      expect(frames[frames.length - 1]).toEqual({ done: true });

      // The fake plugin applied both edits with A1 anchoring; the inserted
      // empty row (above row 2) shifted the written block down one row.
      const ops = bridge.edits.filter((e) => e.op !== 'context').map((e) => e.op);
      expect(ops).toEqual(['writeCells', 'insertRows']);
      expect(bridge.cells[2]).toContain('Name');
      expect(bridge.cells[3]).toContain('Gadget');
    } finally {
      close();
    }
  });

  it('runs a slide loop: rewrite a slide, then insert one at the start', async () => {
    const bridge = new FakePluginBridge();
    bridge.editor = 'slide';
    const scripted = [
      'New outline.\n```impress\nRenamed\nfirst point\nsecond point\n```\n[ACTION: rewrite-slide s1]',
      'Adding the opening slide.\n```impress\nOpening\nwelcome\n```\n[ACTION: insert-after s0]',
      'The deck is ready.',
    ];
    const { url, close } = await serve({ bridge, replies: scripted });
    try {
      const created = await fetch(`${url}/api/session`, { method: 'POST', headers });
      const res = await fetch(`${url}/api/session/${(await created.json() as { sessionId: string }).sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'Rewrite slide 1, then add an opening slide at the very start.' }),
      });
      const frames = sseFrames(await res.text());
      const applied = frames.filter((f) => 'applied' in f);
      expect(applied.map((f) => f['applied'])).toEqual(['rewrite-slide', 'insert-after']);
      expect(applied[0]).toMatchObject({ applied: 'rewrite-slide', target: 's1', module: 'impress' });
      expect(frames[frames.length - 1]).toEqual({ done: true });

      // The fake plugin rewrote slide 0 and inserted the new slide at index 0.
      const ops = bridge.edits.filter((e) => e.op !== 'context').map((e) => e.op);
      expect(ops).toEqual(['rewriteSlide', 'insertSlideAfter']);
      expect(bridge.slides[0]?.title).toBe('Opening');
      expect(bridge.slides[1]?.title).toBe('Renamed');
    } finally {
      close();
    }
  });

  it('blocks messages for unknown editor types with a clear error', async () => {
    const bridge = new FakePluginBridge();
    bridge.editor = 'other' as FakePluginBridge['editor'];
    const { url, close } = await serve({ bridge, replies: [] });
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'hello' }),
      });
      // readStep refusals answer as plain JSON before the SSE stream starts.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/Writer, Spreadsheet, and Presentation/i);
    } finally {
      close();
    }
  });

  it('serves the selection from the plugin', async () => {
    const bridge = new FakePluginBridge();
    bridge.selection = { selectionType: 'text', selectedText: 'selected words' };
    const { url, close } = await serve({ bridge });
    try {
      const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers })).json()) as { sessionId: string };
      const sel = (await (
        await fetch(`${url}/api/session/${session.sessionId}/selection`, { headers })
      ).json()) as { hasSelection: boolean; text: string | null; stats: number[] };
      expect(sel.hasSelection).toBe(true);
      expect(sel.text).toBe('selected words');
      expect(sel.stats).toEqual([2]);
    } finally {
      close();
    }
  });
});
