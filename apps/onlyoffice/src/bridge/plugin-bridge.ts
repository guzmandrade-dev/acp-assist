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
  editor: 'word';
  paragraphs: number;
  /** Normalized paragraph texts (0-based order, trailing newlines stripped). */
  texts: string[];
  /** Paragraph style names in the same order (best effort; may be nulls). */
  styles?: (string | null)[];
  selection: { selectionType: string; selectedText: string };
}

/** One sheet of a cell (spreadsheet) document read. */
export interface SheetSummary {
  name: string;
  /** Used-range address, e.g. "A1:E12" ("" when the sheet is empty). */
  used: string;
  active: boolean;
}

/** One capped TSV block of sheet data (active sheet or selection). */
export interface CalcGridBlock {
  sheet: string;
  /** A1 range of the shown block, e.g. "A1:E12". */
  range: string;
  values: string[][];
  /** Formula text per cell ("" where the cell has no formula). */
  formulas: string[][] | null;
  truncated: boolean;
}

/** The spreadsheet's current selection. */
export interface CalcSelection {
  /** Selected range addresses, first = the primary range. */
  ranges: string[];
  /** Top-left A1 anchor of the primary range, e.g. "B2". */
  anchor: string;
  values: string[][];
  truncated: boolean;
}

/** Cell (spreadsheet) document read (the plugin's `context` op). */
export interface CellDocument {
  editor: 'cell';
  sheets: SheetSummary[];
  /** Active-sheet used-range block (capped; null when the sheet is empty). */
  data: CalcGridBlock | null;
  selection: CalcSelection | null;
}

/** One slide of a slide (presentation) document read. */
export interface SlideSummary {
  /** 0-based slide index. */
  index: number;
  current: boolean;
  /** Title placeholder text (null when the slide has no title frame). */
  title: string | null;
  /** First body paragraph preview (null when empty/absent). */
  bodyPreview: string | null;
  /** Number of body paragraphs (0 when the slide has no body frame). */
  bodyParas: number;
  /** True when a title placeholder frame exists (even if empty). */
  hasTitle: boolean;
  /** True when a body placeholder frame exists (even if empty). */
  hasBody: boolean;
  /** Number of images on the slide (v0.4; 0 when none). */
  images: number;
}

/** Slide (presentation) document read (the plugin's `context` op). */
export interface SlideDocument {
  editor: 'slide';
  count: number;
  /** 0-based index of the current slide. */
  current: number;
  slides: SlideSummary[];
  /** Selected text-frame text, when the user selected one (else null). */
  selectionText: string | null;
}

/** The `context` op result for whichever editor is open. */
export type EditorDocument = WriterDocument | CellDocument | SlideDocument;

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

// --- cell (spreadsheet) op payload types --------------------------------------

export interface WriteCellsArgs {
  /** A1 anchor for the top-left cell of the block (always resolved by
   * the companion — the plugin stays dumb). */
  anchor: string;
  /** TSV rows: one sheet row per entry; "" clears the cell; "=..." is a
   * formula. */
  rows: string[][];
}

export interface InsertRowColArgs {
  /** A1 anchor identifying the row/column the empty one goes ABOVE/LEFT of. */
  anchor: string;
}

export interface InsertRowColResult {
  /** The A1 anchor the plugin actually inserted at (echoed back). */
  anchor: string;
}

// --- slide (presentation) op payload types ------------------------------------

/** Optional per-line run styling for slide text (v0.4). */
export interface SlideRunStyle {
  bold?: boolean;
  italic?: boolean;
  /** Hex color like 'ff6f3d' (no leading #). */
  color?: string;
  /** Font size in points. */
  size?: number;
  /** Font family name. */
  font?: string;
}

/** One slide text line: the text plus optional styling. */
export interface SlideLine {
  text: string;
  style?: SlideRunStyle;
}

export interface SlideContentArgs {
  /** 0-based slide index. */
  index: number;
  title: SlideLine;
  /** Body paragraphs (empty = keep the current body). */
  body: SlideLine[];
}

export interface SlideEditResult {
  count?: number;
  error?: string;
}

export interface InsertImageArgs {
  /** 0-based slide index (null = the current slide). */
  index: number | null;
  /** Image source: an http(s) URL or a base64 data:image/... URI. */
  src: string;
  /** Position and size in EMU (companion-resolved; the plugin stays dumb). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface InsertImageResult {
  added: boolean;
  images: number;
}

export interface SetBackgroundArgs {
  /** 0-based slide index (null = the current slide). */
  index: number | null;
  kind: 'solid' | 'gradient' | 'image';
  /** solid/gradient: hex color like 'ff6f3d'. */
  color?: string;
  /** gradient: second hex stop. */
  color2?: string;
  /** image: source URL/data URI. */
  src?: string;
}

export interface AddNotesArgs {
  /** 0-based slide index (null = the current slide). */
  index: number | null;
  text: string;
}

export interface DeleteSlideArgs {
  /** 0-based slide index. */
  index: number;
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
      // Every poll must get EXACTLY ONE response from ITS OWN timer —
      // a conditional `if (this.waiter)` here once swallowed a poll's
      // response when two long-polls overlapped (a stale fetch from
      // before a reconnect), hanging the plugin's poll loop forever
      // while its status still said "connected" (live-found 2026-11-03).
      const mine = (job: Record<string, unknown> | null) => {
        if (this.waiter === wrapper) this.waiter = null;
        res.json(job ?? {});
      };
      let timer: NodeJS.Timeout;
      const wrapper = (job: Record<string, unknown> | null) => {
        clearTimeout(timer);
        mine(job);
      };
      timer = setTimeout(() => mine(null), waitSec * 1000);
      this.waiter = wrapper;
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