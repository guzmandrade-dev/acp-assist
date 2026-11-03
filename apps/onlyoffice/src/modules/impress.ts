/**
 * Impress module adapter for ONLYOFFICE Desktop Editors: builds the
 * agent's deck context from the plugin's slide read (slide inventory
 * with title/body previews) and applies slide-addressed actions through
 * the plugin bridge ops.
 *
 * Same dialect as the LibreOffice app's impress adapter for the core
 * slide ops: [sN] (1-based) addressing, ```impress content blocks (first
 * line = the slide title, following lines = body paragraphs; one block =
 * one slide). Differences from LO: no tracked changes (one callCommand =
 * one undo step), and v1 has no selected-frame rewrite — the plugin
 * sandbox cannot yet address a selected shape (the selection text is
 * still shown in the prompt as context).
 *
 * v0.4 adds the design surface (live-verified by the P5 probes, AGENTS
 * rules 40-45): per-line run styling (a `{...}` style prefix on any
 * content line), [ACTION: insert-image] (http(s)/data-URI sources — the
 * image EMBEDS correctly but only RENDERS after save+reopen, rule 41),
 * [ACTION: set-background] (solid/gradient/image — repaints live, rule
 * 42), [ACTION: add-notes], and [ACTION: delete-slide sN]. Theme/layout
 * application is deliberately NOT in the vocabulary (rule 43: it
 * corrupts existing placeholder text).
 */

import type { PluginBridge, SlideDocument, SlideContentArgs, SlideLine, SlideRunStyle } from '../bridge/plugin-bridge.js';
import { extractContentBlock, ACTION_TAG_LINE, actionTagNote, actionInstructions, createParseActionTag, preview } from './markdown.js';

/** A parsed slide action plus its content lines. */
export interface ImpressOutcome {
  module: 'impress';
  action:
    | 'none'
    | 'continue'
    | 'rewrite-slide'
    | 'insert-after'
    | 'insert-image'
    | 'set-background'
    | 'add-notes'
    | 'delete-slide';
  /** 1-based slide number from the tag (0 allowed for insert-after = start). */
  target: number | null;
  /** Content paragraphs: entry 0 = the slide title, the rest = body. */
  block: string[] | null;
  tagNote?: string | null;
}

/** Grammar: [ACTION: name] or [ACTION: name sN]. The header tolerates tag
 * typos ("[AACTION:"), reported via tagNote; the layered resolution
 * lives in the core factory. */
const parseTag = createParseActionTag({
  actions: 'rewrite-slide|insert-after|insert-image|set-background|add-notes|delete-slide|none|continue',
  targetPattern: '(?:\\s+s([0-9]+))?',
});

const CONTENT_ACTIONS: Array<ImpressOutcome['action']> = [
  'rewrite-slide',
  'insert-after',
  'insert-image',
  'set-background',
  'add-notes',
];

/** One ```impress block -> plain text lines (title first, then body). */
function blockLines(block: string): string[] {
  return block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ACTION_TAG_LINE.test(line));
}

/** Parse an agent reply against the Impress vocabulary. */
export function parseImpressAction(reply: string): ImpressOutcome {
  const tag = parseTag(reply);
  const action = tag.action as ImpressOutcome['action'];
  const target = tag.target !== null ? Number.parseInt(tag.target, 10) : null;
  const needsContent = CONTENT_ACTIONS.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply, 'impress') : null;
  return {
    module: 'impress',
    action,
    target,
    block: needsContent && rawBlock !== null ? blockLines(rawBlock) : null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${target !== null ? ` s${target}` : ''}]`),
  };
}

// --- style-prefix parsing -------------------------------------------------------

const STYLE_PREFIX = /^\{([^}]*)\}\s*(.*)$/;

/** `#ff6f3d` or `ff6f3d` -> 'ff6f3d'; null when not a valid hex color. */
function normalizeHexColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

/**
 * Parse one content line into a SlideLine. A line may carry an optional
 * style prefix: `{bold; italic; size=28; color=#ff6f3d; font=Georgia}Text`.
 * Unknown attributes are ignored (tolerant); plain lines pass through.
 */
export function parseStyleLine(line: string): SlideLine {
  const match = STYLE_PREFIX.exec(line);
  if (match === null) {
    return { text: line };
  }
  const style: SlideRunStyle = {};
  for (const rawAttr of (match[1] ?? '').split(';')) {
    const attr = rawAttr.trim();
    if (attr.length === 0) continue;
    const eq = attr.indexOf('=');
    const key = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? '' : attr.slice(eq + 1).trim();
    if (eq === -1 && (key === 'bold' || key === 'italic')) {
      style[key] = true;
      continue;
    }
    if (key === 'size') {
      const size = Number.parseFloat(value);
      if (Number.isFinite(size) && size >= 1 && size <= 400) style.size = Math.round(size);
      continue;
    }
    if (key === 'color') {
      const color = normalizeHexColor(value);
      if (color !== null) style.color = color;
      continue;
    }
    if (key === 'font' && value.length > 0) {
      style.font = value.slice(0, 60);
      continue;
    }
  }
  return { text: match[2] ?? '', ...(Object.keys(style).length > 0 ? { style } : {}) };
}

/** Parse a block of SlideLines (title first). */
function parseSlideLines(block: string[]): { title: SlideLine; body: SlideLine[] } {
  const lines = block.map(parseStyleLine);
  return { title: lines[0] ?? { text: '' }, body: lines.slice(1) };
}

// --- image-block parsing --------------------------------------------------------

/**
 * Parse EMU-ish measurements: a bare number is EMU, `50%` is a share of
 * the slide's width/height, `2.5in`/`2.5"` are inches. Null when the
 * value cannot be understood.
 */
export function parseExtent(value: string, slideExtent: number): number | null {
  const v = value.trim().toLowerCase();
  if (/^[0-9]+$/.test(v)) return Number.parseInt(v, 10);
  const percent = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(v);
  if (percent !== null) {
    const share = Number.parseFloat(percent[1] ?? '') / 100;
    if (share > 0 && share <= 1) return Math.round(slideExtent * share);
    return null;
  }
  const inch = /^([0-9]+(?:\.[0-9]+)?)(?:in|")$/.exec(v);
  if (inch !== null) {
    const inches = Number.parseFloat(inch[1] ?? '');
    if (inches > 0 && inches <= 50) return Math.round(inches * 914400);
  }
  return null;
}

/** The 16:9 default slide extents (the context reports the real ones;
 * these are the fallback when the read is missing). */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

/** Parse an [ACTION: insert-image] block into plugin args. */
export function parseImageBlock(block: string[]): {
  src: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
} {
  const out: { src: string; x?: number; y?: number; w?: number; h?: number } = { src: '' };
  for (const line of block) {
    const match = /^(image|src|at|position|size)\s*:\s*(.+)$/i.exec(line);
    if (match === null) {
      // A bare first line is tolerated as the source.
      if (!out.src) out.src = line.trim();
      continue;
    }
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (key === 'image' || key === 'src') {
      out.src = value;
    } else if (key === 'at' || key === 'position') {
      const parts = value.split(/[,x]/).map((p) => p.trim());
      if (parts.length === 2) {
        const x = parseExtent(parts[0] ?? '', SLIDE_W);
        const y = parseExtent(parts[1] ?? '', SLIDE_H);
        if (x !== null) out.x = x;
        if (y !== null) out.y = y;
      }
    } else if (key === 'size') {
      const parts = value.split(/[,x]/).map((p) => p.trim());
      if (parts.length === 2) {
        const w = parseExtent(parts[0] ?? '', SLIDE_W);
        const h = parseExtent(parts[1] ?? '', SLIDE_H);
        if (w !== null) out.w = w;
        if (h !== null) out.h = h;
      }
    }
  }
  return out;
}

/** Parse an [ACTION: set-background] block's `background:` line. */
export function parseBackgroundLine(line: string): {
  kind: 'solid' | 'gradient' | 'image';
  color?: string;
  color2?: string;
  src?: string;
} | null {
  const match = /^background\s*:\s*(.+)$/i.exec(line);
  if (match === null) return null;
  const value = (match[1] ?? '').trim();
  const image = /^image\s+(https?:\/\/\S+|data:image\/\S+)$/i.exec(value);
  if (image !== null) return { kind: 'image', src: image[1] ?? '' };
  const gradient = /^gradient\s+#?([0-9a-fA-F]{6})\s*(?:-|to)\s*#?([0-9a-fA-F]{6})$/i.exec(value);
  if (gradient !== null) {
    return { kind: 'gradient', color: (gradient[1] ?? '').toLowerCase(), color2: (gradient[2] ?? '').toLowerCase() };
  }
  const solid = /^solid\s+#?([0-9a-fA-F]{6})$/i.exec(value);
  if (solid !== null) return { kind: 'solid', color: (solid[1] ?? '').toLowerCase() };
  return null;
}

// --- the adapter -----------------------------------------------------------------

export const impressAdapter = {
  id: 'impress' as const,

  buildActionInstructions(): string {
    return actionInstructions({
      actions: [
        '- [ACTION: none] to reply in prose only (questions, explanations,',
        '  discussion, planning).',
        '- [ACTION: rewrite-slide sN] to REPLACE the outline of slide [sN]:',
        '  include a ```impress block whose first line is the new title and the',
        '  following lines are the new body paragraphs (when the block has no',
        '  body lines, only the title is changed).',
        '- [ACTION: insert-after sN] to insert a NEW slide after slide [sN]',
        '  with a title and body: include a ```impress block. Use s0 to insert',
        '  at the very start of the deck (as the new first slide).',
        '- [ACTION: insert-image sN] to place an image on slide [sN] (or the',
        '  current slide when no number is given): the ```impress block has',
        '  `image: <URL or data:image/...>` plus optionally `at: x,y` and',
        '  `size: w,h` where measurements are like `30%` (of the slide),',
        '  `2.5in`, or raw EMU. Default: 20% of the slide width, centered.',
        '  Images EMBED immediately but the user sees them after saving and',
        '  reopening the file — say so in your reply.',
        '- [ACTION: set-background sN] to change slide [sN] background (or the',
        '  current slide without a number): the block line is',
        '  `background: solid #1a2b4c`, `background: gradient #ffffff-#ff6f3d`,',
        '  or `background: image <URL>`.',
        '- [ACTION: add-notes sN] to add speaker notes to slide [sN] (or the',
        '  current slide without a number): the block lines are the notes text.',
        '- [ACTION: delete-slide sN] to DELETE slide [sN] (no block).',
      ],
      contentFormat: [
        'Content format (```impress block): plain text, no markdown. The FIRST',
        'non-empty line is the slide title; every following non-empty line is',
        'one body paragraph (rendered as one bullet/outline point). One block',
        '= one slide. When one request needs SEVERAL new slides, insert the',
        'FIRST one now; the app re-prompts you with fresh context for the next.',
        'Any content line may START with a style prefix to restyle it:',
        '{bold; italic; size=28; color=#ff6f3d; font=Georgia}Styled line —',
        'omit parts you do not need (e.g. {bold;color=#333333}Title).',
      ],
      undoMode: 'undo-only',
      leadRules: [
        '- The document context lists slides as [sN] ids with their titles,',
        '  body previews, and image counts.',
      ],
      rules: [
        '- Slides the context shows as having no title/body frame cannot be',
        '  rewritten with rewrite-slide (a fresh slide from insert-after',
        '  always has both).',
        '- There is no frame-level rewrite in this version: rewrite whole',
        '  slides with rewrite-slide instead.',
        '- Colors are hex (#rrggbb). Slide themes/layouts cannot be changed',
        '  in this version — restyle text and backgrounds instead.',
      ],
      rePrompt: 'fresh slide\n  numbers for the next edit.',
    });
  },

  buildContextBlock(doc: SlideDocument): string {
    const lines: string[] = [
      'Document context',
      '================',
      'File: (active ONLYOFFICE presentation)',
      `Slides: ${doc.count}`,
      '',
    ];
    for (const slide of doc.slides) {
      const current = slide.current ? ' (current)' : '';
      const main = `[s${slide.index + 1}]${current} ${slide.hasTitle ? (slide.title ? `"${slide.title}"` : '(empty title)') : '(no title frame)'}`;
      const detail: string[] = [];
      if (slide.hasBody) {
        detail.push(`body: ${slide.bodyParas} paragraph(s)`);
      } else {
        detail.push('no body frame — rewrite-slide cannot set a body on this slide');
      }
      if (slide.images > 0) detail.push(`${slide.images} image(s)`);
      lines.push(main + (detail.length > 0 ? ` | ${detail.join(', ')}` : ''));
      if (slide.bodyPreview) {
        lines.push(`     ${preview(slide.bodyPreview, 100)}`);
      }
    }
    return lines.join('\n');
  },

  renderOutline(doc: SlideDocument): string {
    return doc.slides
      .map((s) => `[s${s.index + 1}]${s.current ? ' *' : ''} ${s.hasTitle && s.title ? preview(s.title, 100) : '(untitled)'}`)
      .join('\n');
  },

  /**
   * Apply one slide action through the plugin bridge. Throws a
   * user-facing error when the action cannot be applied — nothing is
   * written then (the plugin validates slide ranges too).
   */
  async applyAction(bridge: PluginBridge, doc: SlideDocument, outcome: ImpressOutcome): Promise<string> {
    if (outcome.action === 'none' || outcome.action === 'continue') {
      throw new Error(`[ACTION: ${outcome.action}] is not a presentation document action.`);
    }
    const needsContent = CONTENT_ACTIONS.includes(outcome.action);
    if (needsContent && (!outcome.block || outcome.block.length === 0)) {
      throw new Error(
        `[ACTION: ${outcome.action}] needs a \`\`\`impress content block; the reply contained none.`,
      );
    }
    const block = outcome.block ?? [];

    if (outcome.action === 'rewrite-slide') {
      const { title, body } = parseSlideLines(block);
      if (outcome.target === null || outcome.target < 1) {
        throw new Error('[ACTION: rewrite-slide] needs a slide number (e.g. rewrite-slide s2).');
      }
      if (outcome.target > doc.count) {
        throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
      }
      if (!title.text) {
        throw new Error('[ACTION: rewrite-slide] needs a title line in the ```impress block.');
      }
      await bridge.op('rewriteSlide', { index: outcome.target - 1, title, body } satisfies SlideContentArgs);
      return `[ACTION: rewrite-slide s${outcome.target}]`;
    }

    if (outcome.action === 'insert-after') {
      const { title, body } = parseSlideLines(block);
      if (outcome.target === null || outcome.target < 0) {
        throw new Error('[ACTION: insert-after] needs a slide number (s0 = the very start, e.g. insert-after s2).');
      }
      if (outcome.target > doc.count) {
        throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
      }
      if (!title.text) {
        throw new Error('[ACTION: insert-after] needs a title line in the ```impress block.');
      }
      await bridge.op('insertSlideAfter', { index: outcome.target, title, body } satisfies SlideContentArgs);
      const where = outcome.target === 0 ? 'at the very start' : `after s${outcome.target}`;
      return `[ACTION: insert-after — new slide ${where}]`;
    }

    if (outcome.action === 'insert-image') {
      const image = parseImageBlock(block);
      if (!image.src) {
        throw new Error('[ACTION: insert-image] needs an `image: <URL or data:image/...>` line in the ```impress block.');
      }
      if (!/^(https?:\/\/\S+|data:image\/\S+)$/i.test(image.src)) {
        throw new Error(
          '[ACTION: insert-image] source must be an http(s):// URL or a data:image/... URI (local file paths cannot be read).',
        );
      }
      const index = this.resolveIndex(outcome, doc);
      await bridge.op('insertImage', { index, ...image });
      return `[ACTION: insert-image${outcome.target !== null ? ` s${outcome.target}` : ''} — the image appears after saving and reopening the file]`;
    }

    if (outcome.action === 'set-background') {
      const spec = parseBackgroundLine(block.find((l) => /^background\s*:/i.test(l)) ?? block[0] ?? '');
      if (spec === null) {
        throw new Error(
          '[ACTION: set-background] needs a `background: solid #rrggbb`, `background: gradient #rrggbb-#rrggbb`, or `background: image <URL>` line.',
        );
      }
      const index = this.resolveIndex(outcome, doc);
      await bridge.op('setBackground', { index, ...spec });
      return `[ACTION: set-background${outcome.target !== null ? ` s${outcome.target}` : ''} (${spec.kind})]`;
    }

    if (outcome.action === 'add-notes') {
      const text = block.join('\n');
      if (!text.trim()) {
        throw new Error('[ACTION: add-notes] needs the notes text in the ```impress block.');
      }
      const index = this.resolveIndex(outcome, doc);
      await bridge.op('addNotes', { index, text });
      return `[ACTION: add-notes${outcome.target !== null ? ` s${outcome.target}` : ''}]`;
    }

    // delete-slide
    if (outcome.target === null || outcome.target < 1) {
      throw new Error('[ACTION: delete-slide] needs a slide number (e.g. delete-slide s2).');
    }
    if (outcome.target > doc.count) {
      throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
    }
    await bridge.op('deleteSlide', { index: outcome.target - 1 });
    return `[ACTION: delete-slide s${outcome.target}]`;
  },

  /** Tag slide number (1-based) -> 0-based index; null = current slide. */
  resolveIndex(outcome: ImpressOutcome, doc: SlideDocument): number | null {
    if (outcome.target === null) return null;
    if (outcome.target < 1 || outcome.target > doc.count) {
      throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
    }
    return outcome.target - 1;
  },
};
