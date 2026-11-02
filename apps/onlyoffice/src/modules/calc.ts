/**
 * Calc module adapter for ONLYOFFICE Desktop Editors: builds the agent's
 * spreadsheet context from the plugin's sheet read (sheets inventory,
 * active-sheet data with values AND formulas, selection) and applies
 * cell-addressed actions through the plugin bridge ops.
 *
 * Same vocabulary and content dialect as the LibreOffice app's calc
 * adapter: A1 ("B2") addressing, ```calc TSV content blocks (one sheet
 * row per line, cells split on tabs; a cell starting with "=" is written
 * as a formula). Difference: ONLYOFFICE Calc has no tracked changes —
 * each edit is ONE plugin callCommand = one undo step (Ctrl+Z).
 *
 * v1 scope: the ACTIVE sheet only (the plugin sandbox has no sheet
 * switching op yet).
 */

import type { PluginBridge, CellDocument, CalcGridBlock, WriteCellsArgs, InsertRowColArgs } from '../bridge/plugin-bridge.js';
import { extractContentBlock, parseTsvBlock, actionTagNote, actionInstructions, createParseActionTag } from './markdown.js';

/** A parsed calc action plus its TSV grid. */
export interface CalcOutcome {
  module: 'calc';
  action: 'none' | 'continue' | 'write-cells' | 'insert-rows' | 'insert-cols' | 'rewrite';
  /** Paragraph/slide address — always null for Calc (A1 lives in `address`). */
  target: number | null;
  /** A1 anchor from the tag (e.g. "B2"), when present. */
  address: string | null;
  /** Parsed TSV rows for write-cells/rewrite; null otherwise. */
  grid: string[][] | null;
  tagNote?: string | null;
}

/** Grammar: [ACTION: name] or [ACTION: name B2] (A1 anchor). The header
 * tolerates tag typos ("[AACTION:"), reported via tagNote; the layered
 * resolution lives in the core factory. */
const parseTag = createParseActionTag({
  actions: 'write-cells|insert-rows|insert-cols|rewrite|none|continue',
  targetPattern: '(?:\\s+([A-Za-z]{1,4}[1-9][0-9]{0,6}))?',
});

const A1_RE = /^[A-Za-z]{1,4}[1-9][0-9]{0,6}$/;

/** Parse an agent reply against the Calc vocabulary. */
export function parseCalcAction(reply: string): CalcOutcome {
  const tag = parseTag(reply);
  const action = tag.action as CalcOutcome['action'];
  const address = tag.target ? tag.target.toUpperCase() : null;
  const contentActions: CalcOutcome['action'][] = ['write-cells', 'rewrite'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply, 'calc') : null;
  return {
    module: 'calc',
    action,
    target: null,
    address,
    grid: needsContent && rawBlock !== null ? parseTsvBlock(rawBlock) : null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${address ? ` ${address}` : ''}]`),
  };
}

// --- A1 helpers (context rendering only; the plugin validates writes) ---

function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "A1:B3" -> {c0, r0, c1, r1} 0-based inclusive; null when malformed. */
function parseRange(a1: string): { c0: number; r0: number; c1: number; r1: number } | null {
  const m = a1.match(/^([A-Za-z]{1,4})([0-9]+):([A-Za-z]{1,4})([0-9]+)$/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  return {
    c0: colToIndex(m[1]),
    r0: Number.parseInt(m[2], 10) - 1,
    c1: colToIndex(m[3]),
    r1: Number.parseInt(m[4], 10) - 1,
  };
}

/** "Sheet1!A1:B3" -> "A1:B3". */
function stripSheet(range: string): string {
  const i = range.indexOf('!');
  return i === -1 ? range : range.slice(i + 1);
}

/** True when the selection is fully covered by the shown sheet data. */
function coveredByData(doc: CellDocument): boolean {
  const sel = doc.selection;
  const data = doc.data;
  if (!sel || !data || data.truncated || sel.truncated) return false;
  const d = parseRange(data.range);
  const s = parseRange(stripSheet(sel.ranges[0] ?? ''));
  if (!d || !s) return false;
  return s.c0 >= d.c0 && s.c1 <= d.c1 && s.r0 >= d.r0 && s.r1 <= d.r1;
}

function toTsv(grid: string[][]): string {
  return grid.map((row) => row.join('\t')).join('\n');
}

function renderGrid(title: string, grid: CalcGridBlock | { sheet: string; range: string; values: string[][]; truncated: boolean }): string {
  const lines: string[] = [title];
  lines.push('```tsv');
  lines.push(toTsv(grid.values));
  if (grid.truncated) lines.push('…(truncated)');
  lines.push('```');
  if ('formulas' in grid && grid.formulas) {
    lines.push('', `${title} — formulas (plain values where no formula):`, '```tsv');
    lines.push(toTsv(grid.formulas));
    if (grid.truncated) lines.push('…(truncated)');
    lines.push('```');
  }
  return lines.join('\n');
}

export const calcAdapter = {
  id: 'calc' as const,

  buildActionInstructions(): string {
    return actionInstructions({
      actions: [
        '- [ACTION: none] to reply in prose only (questions, explanations,',
        '  discussion, planning).',
        '- [ACTION: write-cells] to write a block of cells with the selection\'s',
        '  top-left cell as the anchor, or [ACTION: write-cells B2] with an',
        '  explicit A1 anchor: include a ```calc block.',
        '- [ACTION: rewrite] to REPLACE the selected cells: include a ```calc',
        '  block with the complete replacement grid (anchored at the',
        '  selection\'s top-left cell).',
        '- [ACTION: insert-rows] to insert one empty row ABOVE the selection\'s',
        '  anchor row, or [ACTION: insert-rows A5] above a given cell.',
        '- [ACTION: insert-cols] to insert one empty column LEFT of the',
        '  selection\'s anchor column, or [ACTION: insert-cols C1].',
      ],
      contentFormat: [
        'Content format (```calc block): tab-separated cells, one sheet row per',
        'line. A cell starting with "=" is written as a formula (e.g.',
        '=SUM(B2:B10)). An empty cell clears the target cell. Use column',
        'letters in formulas exactly as shown in the document context.',
      ],
      undoMode: 'undo-only',
      rules: [
        '- Cell contents you cannot see in the context are still there: the',
        '  context shows the active sheet\'s used range (capped) and the',
        '  selection. Never overwrite cells outside what the user asked for.',
        '- Only the ACTIVE sheet can be edited in this version.',
      ],
      rePrompt: 'fresh context\n  for the next edit.',
    });
  },

  buildContextBlock(doc: CellDocument): string {
    const head = [
      'Document context',
      '================',
      'File: (active ONLYOFFICE spreadsheet)',
      `Sheets: ${doc.sheets.map((s) => `${s.name} (used ${s.used || 'empty'})${s.active ? ' [active]' : ''}`).join(', ')}`,
      '',
    ].join('\n');
    const parts: string[] = [head];
    if (doc.data && doc.data.values.length > 0) {
      parts.push(renderGrid(`Active sheet "${doc.data.sheet}" (${doc.data.range}) — values:`, doc.data));
      parts.push('');
    } else if (doc.data) {
      parts.push(`Active sheet "${doc.data.sheet}" is empty (used range ${doc.data.range}).`, '');
    } else {
      parts.push('The active sheet is empty.', '');
    }
    if (doc.selection && !coveredByData(doc)) {
      parts.push(
        renderGrid(
          `Selected cells (${doc.selection.ranges.join(', ')}, anchor ${doc.selection.anchor}):`,
          { sheet: doc.data?.sheet ?? '', range: doc.selection.ranges[0] ?? doc.selection.anchor, values: doc.selection.values, truncated: doc.selection.truncated },
        ),
      );
      parts.push('');
    }
    return parts.join('\n');
  },

  renderOutline(doc: CellDocument): string {
    return doc.sheets.map((s) => `${s.name} (used ${s.used || 'empty'})${s.active ? ' *' : ''}`).join('\n');
  },

  /**
   * Apply one calc action through the plugin bridge. The A1 anchor is
   * always resolved HERE (tag address or the selection's top-left) so
   * the plugin stays a dumb executor. Throws a user-facing error when
   * the action cannot be applied — nothing is written then.
   */
  async applyAction(bridge: PluginBridge, doc: CellDocument, outcome: CalcOutcome): Promise<string> {
    if (outcome.action === 'none' || outcome.action === 'continue') {
      throw new Error(`[ACTION: ${outcome.action}] is not a Calc document action.`);
    }
    if (outcome.action === 'rewrite' && !doc.selection) {
      throw new Error('[ACTION: rewrite] but the spreadsheet has no selection.');
    }
    const anchor = outcome.address ?? doc.selection?.anchor ?? null;
    if (anchor === null || !A1_RE.test(anchor)) {
      throw new Error(
        `[ACTION: ${outcome.action}] needs an A1 anchor (e.g. ${outcome.action} B2) or an active cell selection.`,
      );
    }
    if (outcome.action === 'write-cells' || outcome.action === 'rewrite') {
      if (!outcome.grid || outcome.grid.length === 0) {
        throw new Error(
          `[ACTION: ${outcome.action}] needs a \`\`\`calc TSV content block; the reply contained none.`,
        );
      }
      await bridge.op('writeCells', { anchor, rows: outcome.grid } satisfies WriteCellsArgs);
      return `[ACTION: write-cells at ${anchor}]`;
    }
    // insert-rows / insert-cols
    const op = outcome.action === 'insert-rows' ? 'insertRows' : 'insertCols';
    await bridge.op(op, { anchor } satisfies InsertRowColArgs);
    return `[ACTION: ${outcome.action} at ${anchor}]`;
  },
};
