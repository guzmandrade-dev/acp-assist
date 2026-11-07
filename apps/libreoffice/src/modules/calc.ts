/**
 * Calc module adapter: builds the agent's spreadsheet context (sheet
 * inventory, active-sheet data, selection with values AND formulas) and
 * applies cell-addressed actions through the bridge.
 *
 * Addressing is A1 ("B2"); content goes in a ```calc TSV block (one sheet
 * row per line, cells split on tabs; a cell starting with '=' is written
 * as a formula). Edits land inside one undo transaction, recorded as
 * tracked changes.
 */

import type { BridgeClient, BridgeDocument, CalcInfo, CalcSelection } from '../bridge/client.js';
import { extractContentBlock, parseTsvBlock, parseStyleSpec, actionTagNote, actionInstructions, createParseActionTag } from './markdown.js';
import type { ActionOutcome, AppliedAction, AgentAction, ModuleAdapter, SelectionInfo } from './types.js';

/** Grammar: [ACTION: name] or [ACTION: name B2] / [ACTION: name A1:B10]
 * (A1 anchor or range). The header tolerates tag typos ("[AACTION:"),
 * reported via tagNote; the B5 layered resolution lives in the core
 * factory. */
const parseTag = createParseActionTag({
  actions: 'write-cells|insert-rows|insert-cols|rewrite|format-cells|none|continue',
  targetPattern: '(?:\\s+([A-Za-z]{1,4}[1-9][0-9]{0,6}(?::[A-Za-z]{1,4}[1-9][0-9]{0,6})?))?',
});

/** Parse an agent reply against the Calc vocabulary. */
export function parseCalcAction(reply: string): ActionOutcome {
  const tag = parseTag(reply);
  const action = tag.action as AgentAction;
  const address = tag.target ? tag.target.toUpperCase() : null;
  const contentActions: AgentAction[] = ['write-cells', 'rewrite'];
  const needsContent = contentActions.includes(action);
  const needsStyle = action === 'format-cells';
  const rawBlock = needsContent || needsStyle ? extractContentBlock(reply, 'calc') : null;
  return {
    action,
    target: null,
    address,
    block: null,
    grid: needsContent && rawBlock !== null ? parseTsvBlock(rawBlock) : null,
    style: needsStyle && rawBlock !== null ? parseStyleSpec(rawBlock) : null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${address ? ` ${address}` : ''}]`),
  };
}

// --- A1 helpers (context rendering only; the bridge validates writes) ---

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
function coveredByData(calc: CalcInfo | null): boolean {
  const sel = calc?.selection;
  const data = calc?.data;
  if (!sel || !data || data.truncated || sel.truncated) return false;
  if (sel.sheet !== data.sheet) return false;
  const d = parseRange(data.range);
  const s = parseRange(stripSheet(sel.ranges[0] ?? ''));
  if (!d || !s) return false;
  return s.c0 >= d.c0 && s.c1 <= d.c1 && s.r0 >= d.r0 && s.r1 <= d.r1;
}

function toTsv(grid: string[][]): string {
  return grid.map((row) => row.join('\t')).join('\n');
}

function renderGrid(title: string, grid: { values: string[][]; formulas: string[][] | null; truncated: boolean }): string {
  const lines: string[] = [title];
  lines.push('```tsv');
  lines.push(toTsv(grid.values));
  if (grid.truncated) lines.push('…(truncated)');
  lines.push('```');
  if (grid.formulas) {
    lines.push('', `${title} — formulas (plain values where no formula):`, '```tsv');
    lines.push(toTsv(grid.formulas));
    if (grid.truncated) lines.push('…(truncated)');
    lines.push('```');
  }
  return lines.join('\n');
}

export const calcAdapter: ModuleAdapter = {
  id: 'calc',

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
        '- [ACTION: format-cells] to restyle the selected cells, or',
        '  [ACTION: format-cells B2] / [ACTION: format-cells A1:B10] for one',
        '  cell / a range: include a ```calc block with ONE style line (see',
        '  below). Cell VALUES are not touched.',
      ],
      contentFormat: [
        'Content format (```calc block): tab-separated cells, one sheet row per',
        'line. A cell starting with "=" is written as a formula (e.g.',
        '=SUM(B2:B10)). An empty cell clears the target cell. Use column',
        'letters in formulas exactly as shown in the document context.',
        'For [ACTION: format-cells] the ```calc block instead carries ONE style',
        'line: {bg=#fff2cc; color=#c00000; bold; italic; underline; size=12;',
        'font=Arial} — omit the parts you do not need. bg = cell background,',
        'color = font color (hex #rrggbb), size = font size in points,',
        'font = font family. Only the listed attributes change.',
      ],
      undoMode: 'tracked-changes',
      rules: [
        '- Cell contents you cannot see in the context are still there: the',
        '  context shows the active sheet\'s used range (capped) and the',
        '  selection. Never overwrite cells outside what the user asked for.',
      ],
      rePrompt: 'fresh context\n  for the next edit.',
    });
  },

  buildContextBlock(doc: BridgeDocument, filePath: string | null): string {
    const calc = doc.calc;
    if (doc.module !== 'calc' || !calc) {
      return `Document context\n================\nActive document is not a Calc document (module: ${doc.module}).`;
    }
    const head = [
      'Document context',
      '================',
      `File: ${filePath ?? '(unsaved document)'}`,
      `Title: ${doc.title}`,
      `Sheets: ${calc.sheets.map((s) => `${s.name} (used ${s.usedRange})${s.active ? ' [active]' : ''}`).join(', ')}`,
      '',
    ].join('\n');
    const parts: string[] = [head];
    if (calc.data && calc.data.values.length > 0) {
      parts.push(renderGrid(`Active sheet "${calc.data.sheet}" (${calc.data.range}) — values:`, calc.data));
      parts.push('');
    } else if (calc.data) {
      parts.push(`Active sheet "${calc.data.sheet}" is empty (used range ${calc.data.range}).`, '');
    }
    if (calc.selection && !coveredByData(calc)) {
      parts.push(renderGrid(`Selected cells (${calc.selection.ranges.join(', ')}, anchor ${calc.selection.anchor}):`, calc.selection));
      parts.push('');
    }
    return parts.join('\n');
  },

  buildSelectionBlock(sel: SelectionInfo): string {
    const cs = sel.calc?.selection;
    if (!cs) return '';
    const lines = ['', `Current selection: ${cs.ranges.join(', ')} (anchor ${cs.anchor})`];
    if (!coveredByData(sel.calc)) {
      lines.push('```tsv');
      lines.push(toTsv(cs.values));
      lines.push('```');
    }
    return lines.join('\n');
  },

  renderOutline(doc: BridgeDocument): string {
    const calc = doc.calc;
    if (!calc) return '';
    return calc.sheets.map((s) => `${s.name} (used ${s.usedRange})${s.active ? ' *' : ''}`).join('\n');
  },

  async applyAction(
    bridge: BridgeClient,
    doc: BridgeDocument,
    sel: SelectionInfo,
    outcome: ActionOutcome,
  ): Promise<AppliedAction> {
    if (outcome.action === 'write-cells' || outcome.action === 'rewrite') {
      if (!outcome.grid || outcome.grid.length === 0) {
        throw new Error(
          `[ACTION: ${outcome.action}] needs a \`\`\`calc TSV content block; the reply contained none.`,
        );
      }
      if (outcome.action === 'rewrite' && !sel.calc?.selection) {
        throw new Error('[ACTION: rewrite] but the spreadsheet has no selection.');
      }
      const r = await bridge.edit({
        mode: 'write-cells',
        anchor: outcome.address ?? undefined,
        tracked: true,
        rows: outcome.grid,
      });
      const at = r.anchor ?? outcome.address ?? 'selection';
      return { description: `[ACTION: write-cells at ${at}]` };
    }
    if (outcome.action === 'insert-rows' || outcome.action === 'insert-cols') {
      const r = await bridge.edit({
        mode: outcome.action,
        anchor: outcome.address ?? undefined,
        count: 1,
        tracked: true,
      });
      const at = r.anchor ?? outcome.address ?? 'selection';
      return { description: `[ACTION: ${outcome.action} at ${at}]` };
    }
    if (outcome.action === 'format-cells') {
      if (!outcome.style || Object.keys(outcome.style).length === 0) {
        throw new Error(
          '[ACTION: format-cells] needs a ```calc block with a style line, e.g. {bg=#fff2cc; bold}.',
        );
      }
      // A range address ("A1:B10") goes in `range`; a bare cell in `anchor`;
      // neither = the bridge restyles the current selection's ranges.
      const isRange = outcome.address !== null && outcome.address.includes(':');
      const r = await bridge.edit({
        mode: 'format-cells',
        anchor: isRange ? undefined : (outcome.address ?? undefined),
        range: isRange ? outcome.address : undefined,
        style: outcome.style,
        tracked: true,
      });
      const at = outcome.address ?? r.anchor ?? 'selection';
      return { description: `[ACTION: format-cells ${at}]` };
    }
    throw new Error(`[ACTION: ${outcome.action}] is not a Calc document action.`);
  },
};
