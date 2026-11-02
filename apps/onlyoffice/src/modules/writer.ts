/**
 * Writer module adapter for ONLYOFFICE Desktop Editors: builds the
 * agent's document context from the plugin's paragraph list and applies
 * paragraph-addressed actions through the plugin bridge ops.
 *
 * Same addressing discipline as the LibreOffice adapter: the plugin's
 * `context` op returns paragraphs in document order; [pN] in the prompt
 * is 1-based over that list. Every edit is ONE plugin callCommand = one
 * undo step (AGENTS.md rules 4/15) — no tracked changes exist in
 * ONLYOFFICE, so the agent instructions say undo instead.
 */

import type { PluginBridge, WriterDocument, BlockParagraph, EditResult } from '../bridge/plugin-bridge.js';
import { actionInstructions, preview } from './markdown.js';

/** Body size above which only the outline + previews are attached. */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

/** A parsed writer action plus its content block. */
export interface WriterOutcome {
  module: 'writer';
  action:
    | 'none' | 'continue'
    | 'insert' | 'insert-top' | 'insert-after' | 'rewrite' | 'rewrite-at' | 'delete-at';
  /** Parsed content paragraphs; null for actions without content. */
  block: BlockParagraph[] | null;
  /** 1-based paragraph address for insert-after/rewrite-at/delete-at. */
  target: number | null;
  tagNote?: string | null;
}

/** All paragraph style names in the document, in order of first use. */
function styleVocabulary(texts: string[], styles: Array<string | null> | undefined): string[] {
  const seen = new Set<string>();
  (styles ?? []).forEach((style, i) => {
    if (style && style !== 'Normal' && style !== 'Standard' && texts[i] !== undefined) {
      seen.add(style);
    }
  });
  return [...seen];
}

/** Render the [pN] outline with previews. */
function renderOutline(texts: string[], styles: Array<string | null> | undefined): string {
  const lines: string[] = [];
  texts.forEach((text, i) => {
    const style = styles?.[i];
    const tag = style && style !== 'Normal' ? ` (${style})` : '';
    lines.push(`[p${i + 1}]${tag} ${preview(text)}`);
  });
  return lines.join('\n');
}

/** Body text with [pN] prefixes — full fidelity for normal-size docs. */
function renderFullBody(texts: string[], styles: Array<string | null> | undefined): string {
  const lines: string[] = [];
  texts.forEach((text, i) => {
    const style = styles?.[i];
    const tag = style && style !== 'Normal' ? ` (${style})` : '';
    lines.push(`[p${i + 1}]${tag} ${text}`);
  });
  return lines.join('\n');
}

export const writerAdapter = {
  id: 'writer' as const,

  buildActionInstructions(): string {
    return actionInstructions({
      actions: [
        '- [ACTION: none] to reply in prose only (questions, explanations,',
        '  discussion, outlines, planning).',
        '- [ACTION: insert] to insert NEW paragraph(s) at the CURSOR position:',
        '  include a ```writer block. The content becomes fresh paragraph(s)',
        '  right below the cursor; existing text is never merged or replaced.',
        '- [ACTION: insert-top] to insert NEW content at the VERY BEGINNING of',
        '  the document (titles, abstracts): include a ```writer block.',
        '- [ACTION: insert-after pN] to insert NEW paragraph(s) right AFTER',
        '  paragraph [pN] from the outline: include a ```writer block.',
        '- [ACTION: rewrite] to REPLACE the currently selected text (given',
        '  below): include a ```writer block with the complete replacement.',
        '- [ACTION: rewrite-at pN] to REPLACE the entire paragraph [pN]: include',
        '  a ```writer block with the complete replacement paragraph(s). Use',
        '  this (with several paragraphs) to split one paragraph.',
        '- [ACTION: delete-at pN] to DELETE the entire paragraph [pN]:',
        '  NO ```writer block, just the tag.',
      ],
      contentFormat: [
        'Content format (```writer block): markdown-lite, one paragraph per line.',
        'Supported: # / ## / ### headings, "- " list items, "> " quotes,',
        'triple-backtick code sections (kept verbatim), and inline **bold**,',
        '*italic*, `code`. Plain lines keep the document default style.',
        'Prefer paragraph styles that already appear in the document context.',
      ],
      undoMode: 'undo-only',
      leadRules: [
        '- The document context lists paragraphs as [pN] ids with their styles.',
      ],
      rules: [
        '- For rewrite: output the complete replacement of the selection.',
        '- If nothing is selected you cannot rewrite; choose insert-at/none.',
      ],
      rePrompt: 'fresh paragraph\n  numbers for the next edit.',
    });
  },

  buildContextBlock(doc: WriterDocument, styles: Array<string | null> | undefined): string {
    const head = [
      'Document context',
      '================',
      'File: (active ONLYOFFICE document)',
      `Paragraphs: ${doc.paragraphs}`,
      '',
    ].join('\n');

    const vocab = styleVocabulary(doc.texts, styles);
    const vocabBlock = vocab.length
      ? `Paragraph styles in use (prefer these for new content): ${vocab.join(', ')}\n\n`
      : '';

    const bodySize = doc.texts.reduce((n, t) => n + t.length, 0);
    if (bodySize <= OUTLINE_ONLY_BODY_LIMIT) {
      return head + vocabBlock + `Full document ([pN] ids address paragraphs):\n${renderFullBody(doc.texts, styles)}\n`;
    }
    return (
      head +
      vocabBlock +
      `The document is LARGE (${doc.paragraphs} paragraphs), so only this\n` +
      `outline is attached (previews are truncated). Ask the user or use the\n` +
      `outline structure to plan edits; the [pN] addresses are still valid.\n` +
      `${renderOutline(doc.texts, styles)}\n`
    );
  },

  /**
   * Apply one writer action through the plugin bridge. Throws a
   * user-facing error when the action cannot be applied — nothing is
   * written then (the plugin validates index ranges too).
   */
  async applyAction(
    bridge: PluginBridge,
    doc: WriterDocument,
    hasSelection: boolean,
    outcome: WriterOutcome,
  ): Promise<string> {
    const contentActions = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
    const needsContent = contentActions.includes(outcome.action);
    if (needsContent && (!outcome.block || outcome.block.length === 0)) {
      throw new Error(
        `[ACTION: ${outcome.action}] needs a \`\`\`writer content block; the reply contained none.`,
      );
    }
    if (outcome.action === 'rewrite' && !hasSelection) {
      throw new Error('[ACTION: rewrite] but the document has no active selection.');
    }
    const addressed = outcome.action === 'insert-after' || outcome.action === 'rewrite-at' || outcome.action === 'delete-at';
    if (addressed) {
      if (!outcome.target || outcome.target < 1) {
        throw new Error(`[ACTION: ${outcome.action}] needs a valid paragraph number (e.g. ${outcome.action} p3).`);
      }
      if (outcome.target > doc.paragraphs) {
        throw new Error(`Paragraph [p${outcome.target}] does not exist (document has ${doc.paragraphs}).`);
      }
    }

    const args = needsContent ? { paragraphs: outcome.block ?? [] } : {};
    switch (outcome.action) {
      case 'insert':
        await bridge.op<EditResult>('insert', args);
        break;
      case 'insert-top':
        await bridge.op<EditResult>('insertTop', args);
        break;
      case 'insert-after':
        await bridge.op<EditResult>('insertAfter', { ...args, index: outcome.target! - 1 });
        break;
      case 'rewrite-at':
        await bridge.op<EditResult>('rewriteAt', { ...args, index: outcome.target! - 1 });
        break;
      case 'rewrite':
        await bridge.op<EditResult>('rewriteSelection', args);
        break;
      case 'delete-at':
        await bridge.op<EditResult>('deleteAt', { index: outcome.target! - 1 });
        break;
      default:
        throw new Error(`unsupported action ${outcome.action}`);
    }

    const parts: string[] = [outcome.action];
    if (outcome.target) parts.push(`p${outcome.target}`);
    return `[ACTION: ${parts.join(' ')}]`;
  },
};