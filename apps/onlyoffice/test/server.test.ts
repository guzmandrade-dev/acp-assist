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
 * same paragraph semantics as the real callCommand ops (insert = fresh
 * paragraphs below the cursor, rewrite-at = replace, delete-at =
 * remove) so the whole multi-action loop runs without the editor.
 */
class FakePluginBridge extends PluginBridge {
  paragraphs: Array<{ text: string; style: string | null }> = [
    { text: 'Intro paragraph.', style: 'Normal' },
    { text: 'Body paragraph.', style: 'Normal' },
  ];
  editor: 'word' | 'cell' | 'slide' = 'word';
  edits: Array<{ op: string; args: Record<string, unknown> }> = [];
  selection: { selectionType: string; selectedText: string } = { selectionType: 'none', selectedText: '' };
  undoResult: { undone?: boolean; error?: string } = { undone: true };
  private cursorAt = 0;

  override isConnected(): boolean {
    return true;
  }

  private doc(): WriterDocument {
    return {
      editor: this.editor,
      paragraphs: this.paragraphs.length,
      texts: this.paragraphs.map((p) => p.text),
      styles: this.paragraphs.map((p) => p.style),
      selection: this.selection,
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
        return this.doc() as T;
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

  it('blocks messages for non-Writer editors with a clear error', async () => {
    const bridge = new FakePluginBridge();
    bridge.editor = 'cell';
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
      expect(body.error).toMatch(/ONLY Writer documents/i);
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