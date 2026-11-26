/**
 * Formatting fixture battery (LibreOffice/Writer): one markdown-lite
 * ```writer block exercising every construct the agent can emit — heading,
 * bold/italic/code runs, an inline link, bullet + numbered lists, a quote,
 * a code fence — pinned through parseContentBlock AND through the full
 * parseAction -> writerAdapter.applyAction path, asserting the EditPayload
 * that reaches the UNO bridge carries the formatting intact (tracked: true,
 * per-paragraph styles, per-run bold/italic/code/url). This is the LO
 * equivalent of the LyX roundtrip fixture: "move/copy complex format"
 * without losing it.
 */
import { describe, expect, it } from 'vitest';
import { parseAction } from '../src/server.js';
import { parseContentBlock } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';
import type { BridgeClient, BridgeDocument, EditPayload } from '../src/bridge/client.js';

/** The canonical fixture block: every Writer construct in one place. */
const FIXTURE_BLOCK = [
  '# Results',
  '',
  'A paragraph with **bold**, *italic*, `code`, and a [link](https://example.org).',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted line',
  '',
].join('\n');

const run = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  bold: false,
  italic: false,
  code: false,
  ...extra,
});

const EXPECTED_PARAGRAPHS = [
  { style: 'Heading 1', runs: [run('Results')] },
  {
    style: null,
    runs: [
      run('A paragraph with '),
      run('bold', { bold: true }),
      run(', '),
      run('italic', { italic: true }),
      run(', '),
      run('code', { code: true }),
      run(', and a '),
      { text: 'link', url: 'https://example.org' },
      run('.'),
    ],
  },
  { style: 'List', runs: [run('bullet one')] },
  { style: 'List', runs: [run('bullet two')] },
  { style: 'Numbering 1', runs: [run('first')] },
  { style: 'Numbering 1', runs: [run('second')] },
  { style: 'Quotations', runs: [run('quoted line')] },
];

const writerDoc = (paragraphs: Array<[string, string]>): BridgeDocument => ({
  active: true,
  module: 'writer',
  title: 'Test Document',
  url: 'file:///C:/docs/test.odt',
  paragraphs: paragraphs.map(([text, style], i) => ({ i, text, style })),
  selection: null,
  cursorStyle: 'Standard',
});

const recordingBridge = (calls: EditPayload[]) =>
  ({
    async edit(payload: EditPayload) {
      calls.push(payload);
      return {};
    },
  }) as unknown as BridgeClient;

const NO_SELECTION = { hasSelection: false, text: null, cursorStyle: null, calc: null };

describe('Writer formatting fixture: parseContentBlock', () => {
  it('maps every construct to the exact style + runs structure', () => {
    expect(parseContentBlock(FIXTURE_BLOCK)).toEqual(EXPECTED_PARAGRAPHS);
  });

  it('maps a fenced code block to Preformatted Text paragraphs', () => {
    expect(parseContentBlock('before\n```\ncode line\n```\nafter')).toEqual([
      { style: null, runs: [run('before')] },
      { style: 'Preformatted Text', runs: [{ text: 'code line' }] },
      { style: null, runs: [run('after')] },
    ]);
  });
});

describe('Writer formatting fixture: through parseAction + applyAction (UNO payload)', () => {
  it('rewrite-at carries the full formatted block into the bridge payload, tracked', async () => {
    const calls: EditPayload[] = [];
    const doc = writerDoc([
      ['Intro', 'Standard'],
      ['Old body with format', 'Standard'],
    ]);
    const reply = 'Replacing p2.\n```writer\n' + FIXTURE_BLOCK + '\n```\n[ACTION: rewrite-at p2]';
    const outcome = parseAction(reply);
    expect(outcome.action).toBe('rewrite-at');
    expect(outcome.target).toBe(2);
    expect(outcome.block).toEqual(EXPECTED_PARAGRAPHS);

    const result = await writerAdapter.applyAction(recordingBridge(calls), doc, NO_SELECTION, outcome);
    expect(calls).toEqual([
      { mode: 'rewrite-at', target: 2, tracked: true, paragraphs: EXPECTED_PARAGRAPHS },
    ]);
    expect(result.description).toBe('[ACTION: rewrite-at p2]');
  });

  it('insert-after carries the same formatted block at the addressed position', async () => {
    const calls: EditPayload[] = [];
    const doc = writerDoc([['Intro', 'Standard']]);
    const outcome = parseAction('```writer\n' + FIXTURE_BLOCK + '```\n[ACTION: insert-after p1]');
    await writerAdapter.applyAction(recordingBridge(calls), doc, NO_SELECTION, outcome);
    expect(calls[0]).toMatchObject({ mode: 'insert-after', target: 1, tracked: true });
    expect(calls[0]?.paragraphs).toEqual(EXPECTED_PARAGRAPHS);
  });

  it('table, image and comment fixtures map to their dedicated payloads', async () => {
    const doc = writerDoc([['a', 'Standard']]);

    const tableCalls: EditPayload[] = [];
    const tableOutcome = parseAction(
      '```writer\n| H1 | H2 |\n| --- | --- |\n| a | b |\n```\n[ACTION: insert-table p1]',
    );
    await writerAdapter.applyAction(recordingBridge(tableCalls), doc, NO_SELECTION, tableOutcome);
    expect(tableCalls[0]).toEqual({
      mode: 'insert-table',
      target: 1,
      tracked: true,
      paragraphs: undefined,
      rows: [['H1', 'H2'], ['a', 'b']],
      header: true,
    });

    const imgCalls: EditPayload[] = [];
    const imgOutcome = parseAction('```writer\nimage: https://example.org/x.png\n```\n[ACTION: insert-image p1]');
    await writerAdapter.applyAction(recordingBridge(imgCalls), doc, NO_SELECTION, imgOutcome);
    expect(imgCalls[0]).toMatchObject({ mode: 'insert-image', target: 1, tracked: true, src: 'https://example.org/x.png' });

    const cmtCalls: EditPayload[] = [];
    const cmtOutcome = parseAction('```writer\nNeeds a citation here.\n```\n[ACTION: add-comment p1]');
    await writerAdapter.applyAction(recordingBridge(cmtCalls), doc, NO_SELECTION, cmtOutcome);
    expect(cmtCalls[0]).toMatchObject({ mode: 'add-comment', target: 1, tracked: true, text: 'Needs a citation here.' });
  });
});
