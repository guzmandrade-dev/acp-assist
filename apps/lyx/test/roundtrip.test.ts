/**
 * Fixture round-trip battery: one small but representative .lyx file
 * (fixtures/roundtrip.lyx — headings, emphasis tokens, inline + display
 * formulas, a TODO/yellow Note with a NESTED formula, URL, ref, footnote)
 * driven through every layer that can mangle it: strict parse, outline/
 * context, markup lint, clipboard payload write/read, paste assembly.
 *
 * The choreography half of the battery (paste through the fake LyX over
 * the real SSE endpoint) lives in multi-action.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/lyx/parser.js';
import {
  assemblePasteDocument,
  buildDocumentContext,
  extractBodyLayouts,
  extractFormulaContents,
  findMarkupProblems,
  splitTopLevelParagraphs,
} from '../src/lyx/context.js';
import { LYX_CLIPBOARD_FORMAT, LyxClipboard, type RawClipboard } from '../src/clipboard/lyx-clipboard.js';

const fixturePath = fileURLToPath(new URL('./fixtures/roundtrip.lyx', import.meta.url));
const fixture = fs.readFileSync(fixturePath, 'utf8');
const ctx = buildDocumentContext(fixture);
const body = extractBodyLayouts(fixture)!;

/** Byte-faithful in-memory clipboard: what the real OS clipboard must do. */
function memoryClipboard(): RawClipboard {
  let lyx: Buffer | null = null;
  let text = '';
  return {
    hasFormat: async (f) => (f === LYX_CLIPBOARD_FORMAT ? lyx !== null : text !== ''),
    readFormat: async (f) => (f === LYX_CLIPBOARD_FORMAT ? lyx : null),
    write: async (formats) => {
      lyx = null;
      for (const [k, v] of Object.entries(formats)) {
        if (k === LYX_CLIPBOARD_FORMAT) lyx = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
        else if (k === 'text/plain') text = String(v);
      }
    },
    clear: async () => { lyx = null; text = ''; },
    readText: async () => text,
    writeText: async (t) => { text = t; },
  };
}

describe('roundtrip fixture: parse + context + lint layers', () => {
  it('strict-parses as a whole document', () => {
    expect(() => parse(fixture)).not.toThrow();
  });

  it('has the 7 expected top-level paragraphs (inset-inner layouts not counted)', () => {
    const blocks = splitTopLevelParagraphs(body);
    const layouts = blocks.map((b) => /^\\begin_layout (\S+)/.exec(b)![1]);
    expect(layouts).toEqual(['Section', 'Standard', 'Standard', 'Standard', 'Standard', 'Subsection', 'Standard']);
  });

  it('extracts all three formulas: inline, display (multi-line), note-nested', () => {
    const formulas = extractFormulaContents(body);
    expect(formulas).toHaveLength(3);
    expect(formulas[0]).toBe('$P(F)$');
    expect(formulas[1]).toContain('alignedat');
    expect(formulas[2]).toBe('$x^2 + y^2$');
  });

  it('lint accepts the valid fixture — incl. the legit doubled-backslash row break in display math', () => {
    // The display formula contains a LaTeX \\ row separator; a valid
    // document must produce ZERO markup problems (no false positives).
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('outline marks exactly the math paragraphs and previews carry no inset syntax', () => {
    expect(ctx.outline).toHaveLength(7);
    expect(ctx.outline.map((o) => o.hasMath)).toEqual([false, true, true, true, false, false, false]);
    for (const o of ctx.outline) {
      expect(o.preview).not.toMatch(/status (open|collapsed)/);
      expect(o.preview).not.toMatch(/reference "|LatexCommand/);
    }
    // The note paragraph's preview must show the note text, not the formula's
    // raw markup (previews drop inset content but keep prose).
    expect(ctx.outline[3]!.preview).toContain('TODO: check the formula');
  });
});

describe('roundtrip fixture: clipboard payload layer', () => {
  it('writeLyxDocumentVerified round-trips byte-exact through a byte-faithful clipboard and re-parses', async () => {
    const doc = assemblePasteDocument(ctx.header, body);
    expect(() => parse(doc)).not.toThrow();
    const mem = memoryClipboard();
    const clip = new LyxClipboard(mem);
    expect(await clip.writeLyxDocumentVerified(doc, body)).toBe(true);
    const back = await mem.readFormat(LYX_CLIPBOARD_FORMAT);
    expect(back).not.toBeNull();
    expect(back!.toString('utf8')).toBe(doc);
    expect(() => parse(back!.toString('utf8'))).not.toThrow();
    expect(splitTopLevelParagraphs(extractBodyLayouts(back!.toString('utf8'))!)).toHaveLength(7);
  });

  it('live OS clipboard round-trip (opt-in: LYX_LIVE_CLIPBOARD=1, Windows only)', async () => {
    // Would have caught the 2026-10-04 Electron custom-format bug (payload
    // written as a string instead of bytes -> LyX fell back to literal text).
    if (process.env.LYX_LIVE_CLIPBOARD !== '1' || process.platform !== 'win32') return;
    const { createNativeClipboard } = await import('../src/clipboard/native-clipboard.js');
    const native = createNativeClipboard();
    const clip = new LyxClipboard(native);
    const doc = assemblePasteDocument(ctx.header, body);
    expect(await clip.writeLyxDocumentVerified(doc, body)).toBe(true);
    const back = await native.readFormat(LYX_CLIPBOARD_FORMAT);
    expect(back).not.toBeNull();
    expect(back!.toString('utf8')).toBe(doc);
    expect(() => parse(back!.toString('utf8'))).not.toThrow();
    // PowerShell clipboard host cold start can exceed the 5s default.
  }, 30_000);
});
