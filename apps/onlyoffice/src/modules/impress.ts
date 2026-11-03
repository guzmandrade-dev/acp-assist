/**
 * Impress module adapter for ONLYOFFICE Desktop Editors: builds the
 * agent's deck context from the plugin's slide read (slide inventory
 * with title/body previews) and applies slide-addressed actions through
 * the plugin bridge ops.
 *
 * Same vocabulary and content dialect as the LibreOffice app's impress
 * adapter: [sN] (1-based) addressing, ```impress content blocks (first
 * line = the slide title, following lines = body paragraphs; one block =
 * one slide). Differences from LO: no tracked changes (one callCommand =
 * one undo step), and v1 has no selected-frame rewrite — the plugin
 * sandbox cannot yet address a selected shape, so the vocabulary is
 * rewrite-slide + insert-after only (the selection text is still shown
 * in the prompt as context).
 */

import type { PluginBridge, SlideDocument, SlideContentArgs } from '../bridge/plugin-bridge.js';
import { extractContentBlock, ACTION_TAG_LINE, actionTagNote, actionInstructions, createParseActionTag, preview } from './markdown.js';

/** A parsed slide action plus its content lines. */
export interface ImpressOutcome {
  module: 'impress';
  action: 'none' | 'continue' | 'rewrite-slide' | 'insert-after';
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
  actions: 'rewrite-slide|insert-after|none|continue',
  targetPattern: '(?:\\s+s([0-9]+))?',
});

const CONTENT_ACTIONS: Array<ImpressOutcome['action']> = ['rewrite-slide', 'insert-after'];

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
      ],
      contentFormat: [
        'Content format (```impress block): plain text, no markdown. The FIRST',
        'non-empty line is the slide title; every following non-empty line is',
        'one body paragraph (rendered as one bullet/outline point). One block',
        '= one slide. When one request needs SEVERAL new slides, insert the',
        'FIRST one now; the app re-prompts you with fresh context for the next.',
      ],
      undoMode: 'undo-only',
      leadRules: [
        '- The document context lists slides as [sN] ids with their titles and',
        '  body previews.',
      ],
      rules: [
        '- Slides the context shows as having no title/body frame cannot be',
        '  rewritten with rewrite-slide (a fresh slide from insert-after',
        '  always has both).',
        '- There is no frame-level rewrite in this version: rewrite whole',
        '  slides with rewrite-slide instead.',
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
    const title = outcome.block?.[0] ?? '';
    const body = outcome.block?.slice(1) ?? [];

    if (outcome.action === 'rewrite-slide') {
      if (outcome.target === null || outcome.target < 1) {
        throw new Error('[ACTION: rewrite-slide] needs a slide number (e.g. rewrite-slide s2).');
      }
      if (outcome.target > doc.count) {
        throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
      }
      if (!title) {
        throw new Error('[ACTION: rewrite-slide] needs a title line in the ```impress block.');
      }
      await bridge.op('rewriteSlide', { index: outcome.target - 1, title, body } satisfies SlideContentArgs);
      return `[ACTION: rewrite-slide s${outcome.target}]`;
    }

    // insert-after
    if (outcome.target === null || outcome.target < 0) {
      throw new Error('[ACTION: insert-after] needs a slide number (s0 = the very start, e.g. insert-after s2).');
    }
    if (outcome.target > doc.count) {
      throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${doc.count}).`);
    }
    if (!title) {
      throw new Error('[ACTION: insert-after] needs a title line in the ```impress block.');
    }
    await bridge.op('insertSlideAfter', { index: outcome.target, title, body } satisfies SlideContentArgs);
    const where = outcome.target === 0 ? 'at the very start' : `after s${outcome.target}`;
    return `[ACTION: insert-after — new slide ${where}]`;
  },
};
