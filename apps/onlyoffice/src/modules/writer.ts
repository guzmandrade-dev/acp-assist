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

import type { PluginBridge, WriterDocument, BlockParagraph, EditResult, InsertTableArgs, InsertTableResult, TableSummary, InsertImageAtArgs, InsertImageAtResult, AddCommentArgs, AddCommentResult, PageBreakArgs, PageBreakResult } from '../bridge/plugin-bridge.js';
import { actionInstructions, preview } from './markdown.js';
import type { ImageBlock } from './markdown.js';
import { defaultImageSizeCm, parseDataUri, sniffImageSize } from '@acp-assist/core';

/** Body size above which only the outline + previews are attached. */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

/** A parsed writer action plus its content block. */
export interface WriterOutcome {
  module: 'writer';
  action:
    | 'none' | 'continue'
    | 'insert' | 'insert-top' | 'insert-after' | 'rewrite' | 'rewrite-at' | 'delete-at'
    | 'insert-table' | 'insert-image' | 'add-comment' | 'page-break';
  /** Parsed content paragraphs; null for actions without content. */
  block: BlockParagraph[] | null;
  /** Parsed table rows for insert-table (markdown-table block); else null. */
  table?: string[][] | null;
  /** Parsed image spec for insert-image; else null. */
  image?: ImageBlock | null;
  /** Comment text for add-comment; else null. */
  comment?: string | null;
  /** 1-based paragraph address for insert-after/rewrite-at/delete-at/insert-table. */
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

/** Describe a table element for the context line (e.g. "table 3x2: Name | Role"). */
function tableLabel(doc: WriterDocument, i: number): string | null {
  if (doc.kinds?.[i] !== 'table') return null;
  const t = doc.tables?.find((t2) => t2.index === i);
  if (!t || t.error) return 'table';
  const head = t.header && t.header.length ? `: ${t.header.join(' | ')}` : '';
  return `table ${t.rows}x${t.cols}${head}`;
}

/** Render the [pN] outline with previews. */
function renderOutline(doc: WriterDocument): string {
  const lines: string[] = [];
  doc.texts.forEach((text, i) => {
    const style = doc.styles?.[i];
    const tbl = tableLabel(doc, i);
    if (tbl) {
      lines.push(`[p${i + 1}] (${tbl})`);
      return;
    }
    const tag = style && style !== 'Normal' ? ` (${style})` : '';
    lines.push(`[p${i + 1}]${tag} ${preview(text)}`);
  });
  return lines.join('\n');
}

/** Body text with [pN] prefixes — full fidelity for normal-size docs. */
function renderFullBody(doc: WriterDocument): string {
  const lines: string[] = [];
  doc.texts.forEach((text, i) => {
    const style = doc.styles?.[i];
    const tbl = tableLabel(doc, i);
    if (tbl) {
      lines.push(`[p${i + 1}] (${tbl})`);
      return;
    }
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
        '- [ACTION: insert-table pN] to insert a TABLE right AFTER paragraph',
        '  [pN] (p0 = very start of the document): include a ```writer block',
        '  with a markdown table (| a | b | lines; first row = header).',
        '- [ACTION: insert-image pN] to insert an IMAGE right AFTER paragraph',
        '  [pN] (p0 = very start): include a ```writer block with an',
        '  `image: <url or data:image/...>` line plus optional `width:`/`height:`',
        '  (cm/in/px). Images appear in the editor after save + reopen.',
        '- [ACTION: add-comment pN] to attach a COMMENT to paragraph [pN]:',
        '  include a ```writer block with the comment text.',
        '- [ACTION: page-break pN] to start paragraph [pN] on a NEW PAGE:',
        '  NO ```writer block, just the tag.',
      ],
      contentFormat: [
        'Content format (```writer block): markdown-lite, one paragraph per line.',
        'Supported: # / ## / ### headings, "- " list items, "> " quotes,',
        'triple-backtick code sections (kept verbatim), and inline **bold**,',
        '*italic*, `code`. Plain lines keep the document default style.',
        'Prefer paragraph styles that already appear in the document context.',
        'For insert-table the same block holds the table instead: pipe-separated',
        'rows, e.g. "| Name | Age |" then "| --- | --- |" then data rows.',
        'Inline links: [link text](https://example.com) inside any line.',
        'List items ("- " bullets, "1. " numbered) become REAL lists.',
      ],
      undoMode: 'undo-only',
      leadRules: [
        '- The document context lists paragraphs as [pN] ids with their styles.',
        '- Tables appear in the context as [pN] (table RxC: header cells).',
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
      `Paragraphs: ${doc.paragraphs}${doc.tables?.length ? `, Tables: ${doc.tables.length}` : ''}${doc.images ? `, Images: ${doc.images}` : ''}`,
      '',
    ].join('\n');

    const vocab = styleVocabulary(doc.texts, styles);
    const vocabBlock = vocab.length
      ? `Paragraph styles in use (prefer these for new content): ${vocab.join(', ')}\n\n`
      : '';

    const bodySize = doc.texts.reduce((n, t) => n + t.length, 0);
    if (bodySize <= OUTLINE_ONLY_BODY_LIMIT) {
      return head + vocabBlock + `Full document ([pN] ids address elements):\n${renderFullBody(doc)}\n`;
    }
    return (
      head +
      vocabBlock +
      `The document is LARGE (${doc.paragraphs} elements), so only this\n` +
      `outline is attached (previews are truncated). Ask the user or use the\n` +
      `outline structure to plan edits; the [pN] addresses are still valid.\n` +
      `${renderOutline(doc)}\n`
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
    if (outcome.action === 'insert-table' && (!outcome.table || outcome.table.length === 0)) {
      throw new Error(
        '[ACTION: insert-table] needs a ```writer block with a markdown table (| a | b | rows).',
      );
    }
    if (outcome.action === 'insert-image' && !outcome.image?.src) {
      throw new Error(
        '[ACTION: insert-image] needs a ```writer block with an `image: <url|data:...>` line.',
      );
    }
    if (outcome.action === 'add-comment' && !outcome.comment) {
      throw new Error('[ACTION: add-comment] needs a ```writer block with the comment text.');
    }
    if (outcome.action === 'rewrite' && !hasSelection) {
      throw new Error('[ACTION: rewrite] but the document has no active selection.');
    }
    const addressed =
      outcome.action === 'insert-after' || outcome.action === 'rewrite-at' ||
      outcome.action === 'delete-at' || outcome.action === 'insert-table' ||
      outcome.action === 'insert-image' || outcome.action === 'add-comment' ||
      outcome.action === 'page-break';
    if (addressed) {
      if (outcome.target === null || outcome.target < 0) {
        throw new Error(`[ACTION: ${outcome.action}] needs a valid paragraph number (e.g. ${outcome.action} p3; p0 = very start).`);
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
      case 'insert-table': {
        const rows = outcome.table ?? [];
        const args: InsertTableArgs = {
          index: outcome.target === 0 ? -1 : outcome.target! - 1,
          rows,
          header: rows.length > 1,
        };
        const r = await bridge.op<InsertTableResult>('insertTable', args as unknown as Record<string, unknown>);
        return `[ACTION: insert-table p${outcome.target} — ${rows.length}x${Math.max(...rows.map((row) => row.length))} table at element ${r.pos}]`;
      }
      case 'insert-image': {
        const image = outcome.image!;
        // Resolve bytes once for size sniffing; pass the original src through
        // (the plugin can fetch http(s) itself — verified in the P5/P6 probes).
        let bytes: Uint8Array | null = null;
        if (/^data:/i.test(image.src)) {
          bytes = parseDataUri(image.src)?.bytes ?? null;
        } else if (/^https?:\/\//i.test(image.src)) {
          try {
            const buf = await (await fetch(image.src)).arrayBuffer();
            bytes = new Uint8Array(buf);
          } catch { bytes = null; }
        }
        const size = defaultImageSizeCm(bytes);
        const widthCm = image.widthCm ?? size.widthCm;
        const heightCm = image.heightCm ?? size.heightCm;
        const emu = (cm: number) => Math.round(cm * 360000);
        const args: InsertImageAtArgs = {
          index: outcome.target === 0 ? -1 : outcome.target! - 1,
          src: image.src,
          w: emu(widthCm),
          h: emu(heightCm),
        };
        const r = await bridge.op<InsertImageAtResult>('insertImageAt', args as unknown as Record<string, unknown>);
        return `[ACTION: insert-image p${outcome.target} — ${widthCm.toFixed(1)}x${heightCm.toFixed(1)}cm image at element ${r.pos} (appears after save+reopen)]`;
      }
      case 'add-comment': {
        const args: AddCommentArgs = { index: outcome.target! - 1, text: outcome.comment ?? '' };
        await bridge.op<AddCommentResult>('addComment', args as unknown as Record<string, unknown>);
        return `[ACTION: add-comment p${outcome.target}]`;
      }
      case 'page-break': {
        const args: PageBreakArgs = { index: Math.max(0, outcome.target! - 1) };
        await bridge.op<PageBreakResult>('pageBreak', args as unknown as Record<string, unknown>);
        return `[ACTION: page-break p${outcome.target}]`;
      }
      default:
        throw new Error(`unsupported action ${outcome.action}`);
    }

    const parts: string[] = [outcome.action];
    if (outcome.target) parts.push(`p${outcome.target}`);
    return `[ACTION: ${parts.join(' ')}]`;
  },
};