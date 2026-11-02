/**
 * The app side of the in-ONLYOFFICE plugin bridge.
 *
 * The transport direction is INVERTED from the LibreOffice .oxt bridge:
 * the plugin iframe cannot listen on a port, so the plugin connects OUT
 * to this companion. This module hosts the plugin-facing endpoints on
 * the companion's own Express app (verified live: a file:// plugin
 * iframe fetches http://127.0.0.1:<port>/bridge/* fine with plain
    * Access-Control-Allow-Origin: * — AGENTS.md rule 1):
 *
 *   POST /bridge/hello   plugin announces itself {plugin, version, editor}
 *   GET  /bridge/next   long-poll: next job {id, op, args} ({} on timeout)
 *   POST /bridge/result {id, ok, data|error} — resolves the op() caller
 *   POST /bridge/event  {type: "selection-change", data} — the panel
 *                       refresh feed (AGENTS.md rule 5: no event API
 *                       exists plugin-side; the plugin polls and pushes)
 *
 * `op(name, args)` queues a job for the plugin and awaits its result —
 * the equivalent of the LO BridgeClient's HTTP request methods.
 */

import express from 'express';
import { TIMINGS } from '../timings.js';

/** Error type for a disconnected/unreachable plugin (maps to HTTP 503). */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

// --- op payload types --------------------------------------------------------

/** One run of inline-formatted text inside a block paragraph. */
export interface BlockRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** One paragraph the agent wants written: style name + inline runs. */
export interface BlockParagraph {
  /** Paragraph style name ("Heading 1", "Quote", "Code", ...), or null. */
  style: string | null;
  runs: BlockRun[];
}

/** Writer document read (the plugin's `context` op). */
export interface WriterDocument {
  editor: 'word' | 'cell' | 'slide';
  paragraphs: number;
  /** Normalized paragraph texts (0-based order, trailing newlines stripped). */
  texts: string[];
  /** Paragraph style names in the same order (best effort; may be nulls). */
  styles?: (string | null)[];
  selection: { selectionType: string; selectedText: string };
}

export type EditMode =
  | 'insert' | 'insert-top' | 'insert-after' | 'rewrite-at' | 'delete-at' | 'rewrite';

/** All edit ops send the same content shape; delete-at sends none. */
export interface EditArgs {
  /** 0-based paragraph index (insert-after / rewrite-at / delete-at). */
  index?: number;
  paragraphs?: BlockParagraph[];
}

export interface EditResult {
  /** Elements count after the edit (plugin reports it back). */
  elements?: number;
  /** rewrite-at / delete-at: the replaced/removed paragraph's old text. */
  oldText?: string;
}

// --- the bridge ---------------------------------------------------------------

export interface PluginHello {
  plugin: string;
  version: string;
  editor: 'word' | 'cell' | 'slide';
  at: string;
}

export class PluginBridge {
  private hello: PluginHello | null = null;
  private lastPollAt = 0;
  private queue: Array<{ id: string; op: string; args: Record<string, unknown> }> = [];
  private waiter: ((job: Record<string, unknown> | null) => void) | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  /** Latest selection-change event pushed by the plugin (null = none). */
  lastSelection: { selectionType: string; selectedText: string } | null = null;
  /** Subscribers forwarded every plugin event (the SSE refresh feed). */
  private eventSubs = new Set<(frame: Record<string, unknown>) => void>();

  /** Register the plugin-facing routes on the companion's Express app. */
  register(app: express.Express): void {
    // CORS-open middleware (the plugin iframe is a file:// origin) that
    // also answers the preflight itself; Express 5 rejects bare '*' route
    // patterns, so this cannot be an app.options('/bridge/*') route.
    app.use('/bridge', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    app.post('/bridge/hello', (req, res) => {
      const body = req.body as Partial<PluginHello>;
      if (typeof body?.editor !== 'string') {
        res.status(400).json({ error: 'missing editor' });
        return;
      }
      this.hello = {
        plugin: body.plugin ?? 'unknown',
        version: body.version ?? 'unknown',
        editor: body.editor as PluginHello['editor'],
        at: new Date().toISOString(),
      };
      res.json({ ok: true });
    });

    app.get('/bridge/next', (req, res) => {
      this.lastPollAt = Date.now();
      const waitSec = Math.min(Number(req.query.wait ?? '20'), TIMINGS.pluginPollWaitSec);
      const next = this.queue.shift();
      if (next) {
        res.json(next);
        return;
      }
      const timer = setTimeout(() => {
        if (this.waiter) {
          this.waiter = null;
          res.json({});
        }
      }, waitSec * 1000);
      this.waiter = (job) => {
        clearTimeout(timer);
        this.waiter = null;
        res.json(job);
      };
    });

    app.post('/bridge/result', (req, res) => {
      const body = req.body as { id?: string; ok?: boolean; data?: unknown; error?: string };
      res.json({ ok: true });
      const pending = body?.id !== undefined ? this.pending.get(body.id) : undefined;
      if (!pending) return;
      this.pending.delete(body.id!);
      clearTimeout(pending.timer);
      if (body.ok) pending.resolve(body.data ?? {});
      else pending.reject(new BridgeError(String(body.error ?? 'plugin op failed')));
    });

    app.post('/bridge/event', (req, res) => {
      res.json({ ok: true });
      const body = req.body as { type?: string; data?: unknown };
      if (body?.type === 'selection-change' && body.data) {
        const sel = body.data as { selectionType?: string; selectedText?: string };
        this.lastSelection = {
          selectionType: String(sel.selectionType ?? 'none'),
          selectedText: String(sel.selectedText ?? ''),
        };
        for (const sub of [...this.eventSubs]) sub({ refresh: true });
      }
    });
  }

  /** The plugin's hello (connection identity), or null. */
  get connectedHello(): PluginHello | null {
    return this.hello;
  }

  /** True while the plugin hello arrived and its long-poll is fresh. */
  isConnected(): boolean {
    return this.hello !== null && Date.now() - this.lastPollAt < TIMINGS.pluginStaleMs;
  }

  /** Subscribe to plugin events; returns the unsubscribe function. */
  onEvent(sub: (frame: Record<string, unknown>) => void): () => void {
    this.eventSubs.add(sub);
    return () => {
      this.eventSubs.delete(sub);
    };
  }

  /**
   * Queue one op for the plugin and await its result. BridgeError when
   * the plugin is not connected (the caller maps it to a user-facing
   * message + HTTP 503).
   */
  async op<T>(name: string, args: Record<string, unknown> = {}, timeoutMs = TIMINGS.opTimeoutMs): Promise<T> {
    if (!this.isConnected()) {
      throw new BridgeError(
        'ONLYOFFICE editor not connected. Open the ACP Assist Bridge plugin from ' +
          'the editor\u2019s Plugins tab (it must stay open while you chat).',
      );
    }
    const id = `${Date.now()}-${++this.seq}`;
    const job = { id, op: name, args };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`plugin op '${name}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(job);
      } else {
        this.queue.push(job);
      }
    });
  }
}