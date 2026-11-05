/**
 * Writer module adapter: builds the agent's document context from the
 * bridge's paragraph list and applies paragraph-addressed actions.
 *
 * Addressing is direct: the bridge's /document returns paragraphs in
 * document order with stable 0-based indices; [pN] in the prompt is
 * 1-based over that list. No cursor-walking or clipboard round-trips —
 * the bridge does indexed edits inside one undo transaction, recorded
 * as tracked changes.
 */

import type { BridgeClient, BridgeDocument, BlockParagraph, EditMode, WriterParagraph } from '../bridge/client.js';
import { actionInstructions, preview } from './markdown.js';
import type { ActionOutcome, AppliedAction, ModuleAdapter, SelectionInfo } from './types.js';

/** Body size above which only the outline + previews are attached. */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

function isWriterDoc(doc: BridgeDocument): boolean {
  return doc.module === 'writer';
}

/** All paragraph style names in the document, in order of first use. */
function styleVocabulary(doc: BridgeDocument): string[] {
  const seen = new Set<string>();
  for (const p of doc.paragraphs ?? []) {
    if (p.style && p.style !== 'Standard' && p.style !== 'Default Style') seen.add(p.style);
  }
  return [...seen];
}

/** Context line suffix for one element: style tag, or a table/image label. */
function elementLabel(p: WriterParagraph): string {
  if (p.kind === 'table') {
    const head = p.header && p.header.length ? `: ${p.header.join(' | ')}` : '';
    return ` (table ${p.rows ?? '?'}x${p.cols ?? '?'}${head})`;
  }
  if (p.kind === 'image') return ' (image)';
  return p.style && p.style !== 'Standard' ? ` (${p.style})` : '';
}

/** Render the [pN] outline: every element with its style/kind and preview. */
export function renderOutline(doc: BridgeDocument): string {
  const lines: string[] = [];
  for (const p of doc.paragraphs ?? []) {
    lines.push(`[p${p.i + 1}]${elementLabel(p)} ${preview(p.text)}`);
  }
  return lines.join('\n');
}

/** Body text with [pN] prefixes — full fidelity for normal-size docs. */
function renderFullBody(doc: BridgeDocument): string {
  const lines: string[] = [];
  for (const p of doc.paragraphs ?? []) {
    lines.push(`[p${p.i + 1}]${elementLabel(p)} ${p.text}`);
  }
  return lines.join('\n');
}

export const writerAdapter: ModuleAdapter = {
  id: 'writer',

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
      ],
      contentFormat: [
        'Content format (```writer block): markdown-lite, one paragraph per line.',
        'Supported: # / ## / ### headings, "- " list items, "> " quotes,',
        'triple-backtick code sections (kept verbatim), and inline **bold**,',
        '*italic*, `code`. Plain lines keep the document default style.',
        'Prefer paragraph styles that already appear in the document context.',
        'For insert-table the same block holds the table instead: pipe-separated',
        'rows, e.g. "| Name | Age |" then "| --- | --- |" then data rows.',
      ],
      undoMode: 'tracked-changes',
      leadRules: [
        '- The document context lists elements as [pN] ids with their styles;',
        '  tables appear as [pN] (table RxC: header cells), images as (image).',
      ],
      rules: [
        '- For rewrite: output the complete replacement of the selection.',
        '- If nothing is selected you cannot rewrite; choose insert-at/none.',
      ],
      rePrompt: 'fresh paragraph\n  numbers for the next edit.',
    });
  },

  buildContextBlock(doc: BridgeDocument, filePath: string | null): string {
    if (!isWriterDoc(doc)) {
      return `Document context\n================\nActive document is not a Writer document (module: ${doc.module}).`;
    }
    const head = [
      'Document context',
      '================',
      `File: ${filePath ?? '(unsaved document)'}`,
      `Title: ${doc.title}`,
      `Cursor paragraph style: ${doc.cursorStyle ?? 'Standard'}`,
      `Elements: ${(doc.paragraphs ?? []).length}${doc.images ? `, Images: ${doc.images}` : ''}`,
      '',
    ].join('\n');

    const vocab = styleVocabulary(doc);
    const vocabBlock = vocab.length
      ? `Paragraph styles in use (prefer these for new content): ${vocab.join(', ')}\n\n`
      : '';

    const bodySize = (doc.paragraphs ?? []).reduce((n, p) => n + p.text.length, 0);
    if (bodySize <= OUTLINE_ONLY_BODY_LIMIT && !doc.truncated) {
      return head + vocabBlock + `Full document ([pN] ids address paragraphs):\n${renderFullBody(doc)}\n`;
    }
    return (
      head +
      vocabBlock +
      `The document is LARGE (${(doc.paragraphs ?? []).length} paragraphs), so only this\n` +
      `outline is attached (previews are truncated). Ask the user or use the\n` +
      `outline structure to plan edits; the [pN] addresses are still valid.\n` +
      `${renderOutline(doc)}\n`
    );
  },

  buildSelectionBlock(sel: SelectionInfo): string {
    if (!sel.hasSelection) return '';
    return [
      '',
      'Current selection (the user may ask you to rewrite it):',
      '```text',
      sel.text ?? '',
      '```',
    ].join('\n');
  },

  renderOutline(doc: BridgeDocument): string {
    return renderOutline(doc);
  },

  async applyAction(
    bridge: BridgeClient,
    doc: BridgeDocument,
    sel: SelectionInfo,
    outcome: ActionOutcome,
  ): Promise<AppliedAction> {
    const contentModes: EditMode[] = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
    const needsContent = contentModes.includes(outcome.action as EditMode);

    if (outcome.action === 'insert-table' && (!outcome.table || outcome.table.length === 0)) {
      throw new Error(
        '[ACTION: insert-table] needs a ```writer block with a markdown table (| a | b | rows).',
      );
    }
    if (needsContent && (!outcome.block || outcome.block.length === 0)) {
      throw new Error(
        `[ACTION: ${outcome.action}] needs a \`\`\`writer content block; the reply contained none.`,
      );
    }
    if (outcome.action === 'rewrite' && !sel.hasSelection) {
      throw new Error('[ACTION: rewrite] but the document has no active selection.');
    }
    const addressed =
      outcome.action === 'insert-after' || outcome.action === 'rewrite-at' ||
      outcome.action === 'delete-at' || outcome.action === 'insert-table';
    if (addressed) {
      if (outcome.target === null || outcome.target < (outcome.action === 'insert-table' ? 0 : 1)) {
        throw new Error(`[ACTION: ${outcome.action}] needs a valid paragraph number (e.g. ${outcome.action} p3; insert-table also allows p0 = very start).`);
      }
      const count = doc.paragraphs?.length ?? 0;
      if (outcome.target > count) {
        throw new Error(`Paragraph [p${outcome.target}] does not exist (document has ${count}).`);
      }
    }

    const mode = outcome.action as EditMode;
    await bridge.edit({
      mode,
      target: outcome.target,
      tracked: true,
      paragraphs: needsContent ? outcome.block ?? undefined : undefined,
      rows: outcome.action === 'insert-table' ? outcome.table ?? undefined : undefined,
      header: outcome.action === 'insert-table' ? (outcome.table ?? []).length > 1 : undefined,
    });

    const parts: string[] = [outcome.action];
    if (outcome.target) parts.push(`p${outcome.target}`);
    return { description: `[ACTION: ${parts.join(' ')}]` };
  },
};