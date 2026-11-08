import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readAgentSettingsBody,
  formatHistoryReplay,
  listKnownDocuments,
  loadHistory,
  saveHistory,
  historyFile,
  extractAttachmentText,
  createConversationStore,
  createLogError,
  UNSAVED_KEY,
  type Turn,
  type TurnMeta,
} from '../src/index.js';

// --- settings body validation ---------------------------------------------------

describe('readAgentSettingsBody', () => {
  it('accepts a command string and trims it', () => {
    const out = readAgentSettingsBody({ command: '  vibe-acp ' });
    expect(out).toEqual({ command: 'vibe-acp' });
  });

  it('splits a string args field on whitespace', () => {
    const out = readAgentSettingsBody({ args: 'acp --verbose' });
    expect(out).toEqual({ args: ['acp', '--verbose'] });
  });

  it('keeps only non-empty string entries of an args array', () => {
    const out = readAgentSettingsBody({ args: ['--acp', '  ', 42, 'x'] });
    expect(out).toEqual({ args: ['--acp', 'x'] });
  });

  it('keeps only string-valued env entries', () => {
    const out = readAgentSettingsBody({ env: { A: '1', B: 2, C: 'ok' } });
    expect(out).toEqual({ env: { A: '1', C: 'ok' } });
  });

  it('returns an empty object for garbage input', () => {
    expect(readAgentSettingsBody(null)).toEqual({});
    expect(readAgentSettingsBody('nope')).toEqual({});
    expect(readAgentSettingsBody(7)).toEqual({});
  });

  it('passes through a trimmed officePath and ignores non-strings', () => {
    expect(readAgentSettingsBody({ officePath: '  C:\\Program Files\\Collabora  ' }))
      .toEqual({ officePath: 'C:\\Program Files\\Collabora' });
    expect(readAgentSettingsBody({ officePath: 42 })).toEqual({});
  });

  it('keeps a boolean showFullHistory and ignores non-booleans', () => {
    expect(readAgentSettingsBody({ showFullHistory: false })).toEqual({ showFullHistory: false });
    expect(readAgentSettingsBody({ showFullHistory: true })).toEqual({ showFullHistory: true });
    expect(readAgentSettingsBody({ showFullHistory: 'no' })).toEqual({});
  });
});

// --- history persistence --------------------------------------------------------

describe('history persistence', () => {
  it('round-trips turns through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-hist-'));
    const turns: Turn[] = [
      { role: 'user', content: 'hello', timestamp: new Date().toISOString() },
    ];
    await saveHistory(dir, 'doc-a', turns);
    expect(await loadHistory(dir, 'doc-a')).toEqual(turns);
    expect(await loadHistory(dir, 'doc-b')).toEqual([]);
    // Compact JSON — the file is rewritten per persisted turn.
    const raw = await fs.readFile(historyFile(dir, 'doc-a'), 'utf8');
    expect(raw).not.toContain('\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hashes keys into distinct stable filenames', () => {
    const a = historyFile('/tmp/x', 'doc-a');
    const b = historyFile('/tmp/x', 'doc-b');
    expect(a).not.toEqual(b);
    expect(path.basename(a)).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it('lists known documents, skipping unsaved and missing keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-hist-'));
    const existing = path.join(dir, 'existing.txt');
    await fs.writeFile(existing, 'x', 'utf8');
    const missing = path.join(dir, 'gone.txt');
    await saveHistory(dir, existing, []);
    await saveHistory(dir, missing, []);
    await saveHistory(dir, UNSAVED_KEY, []);

    const all = await listKnownDocuments(dir);
    expect(all).toContain(existing);
    expect(all).toContain(missing);

    const filtered = await listKnownDocuments(dir, {
      exists: async (key) => key === existing,
    });
    expect(filtered).toEqual([existing]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- restart replay -------------------------------------------------------------

const meta = (m: Partial<TurnMeta>): TurnMeta => ({
  action: 'none',
  result: 'applied',
  ...m,
});

describe('formatHistoryReplay', () => {
  const turns: Turn[] = [
    { role: 'user', content: 'shorten paragraph 3', timestamp: 't1' },
    {
      role: 'assistant',
      content: '```lyx\n\\begin_layout Standard\nnew text\n\\end_layout\n```\n[ACTION: rewrite-at p3]',
      timestamp: 't2',
      meta: meta({ action: 'rewrite-at', target: 3 }),
    },
    {
      role: 'assistant',
      content: 'tried but failed [ACTION: delete-at p2]',
      timestamp: 't3',
      meta: meta({ action: 'delete-at', result: 'error', error: 'paragraph 2 mismatch' }),
    },
  ];

  it('replays up to the unseen count and strips tags and blocks', () => {
    const out = formatHistoryReplay(turns, 3, {
      blockPattern: /```lyx[\s\S]*?```/g,
      describeTarget: (m) => (m.target ? ` p${m.target}` : ''),
    });
    expect(out).toContain('Conversation so far');
    expect(out).toContain('- User: shorten paragraph 3');
    expect(out).not.toContain('begin_layout');
    // The action TAG is stripped from the replayed text; the meta line
    // below it still reports the applied action on purpose.
    const youLines = out.split('\n').filter((l) => l.startsWith('- You:'));
    expect(youLines.length).toBe(2);
    expect(youLines.some((l) => l.includes('[ACTION:'))).toBe(false);
    expect(out).toContain('(applied [ACTION: rewrite-at p3] in the document)');
    expect(out).toContain('(action delete-at FAILED: paragraph 2 mismatch)');
  });

  it('caps each turn at the character limit', () => {
    const long: Turn[] = [
      { role: 'user', content: 'x'.repeat(2_000), timestamp: 't' },
    ];
    const out = formatHistoryReplay(long, 1, { blockPattern: /```lyx[\s\S]*?```/g });
    const line = out.split('\n').find((l) => l.startsWith('- User:')) ?? '';
    expect(line.length).toBeLessThanOrEqual('- User: '.length + 500 + 1); // + ellipsis
  });

  it('renders the LibreOffice-style address variant', () => {
    const calcTurns: Turn[] = [
      {
        role: 'assistant',
        content: '[ACTION: write-cells]',
        timestamp: 't',
        meta: meta({ action: 'write-cells', address: 'B2' }),
      },
    ];
    const out = formatHistoryReplay(calcTurns, 1, {
      blockPattern: /```(?:writer|calc|impress)[\s\S]*?```/g,
      describeTarget: (m) => (m.target ? ` p${m.target}` : m.address ? ` ${m.address}` : ''),
    });
    expect(out).toContain('(applied [ACTION: write-cells B2] in the document)');
  });

  it('returns empty for zero unseen turns', () => {
    expect(formatHistoryReplay(turns, 0, { blockPattern: /```lyx[\s\S]*?```/g })).toBe('');
  });
});

// --- conversation store ----------------------------------------------------------

/** Poll `check` until it passes (100ms interval, 2s deadline). */
async function waitFor(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await check();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('waitFor deadline exceeded');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe('createConversationStore', () => {
  const replayOptions = {
    blockPattern: /```lyx[\s\S]*?```/g,
    describeTarget: (m: TurnMeta) => (m.target ? ` p${m.target}` : ''),
  };

  function makeStore(historyDir?: string) {
    const conversations = new Map<string, Turn[]>();
    const historyHandoff = new Map<string, number>();
    const logError = createLogError(historyDir);
    const store = createConversationStore({
      historyDir,
      logError,
      conversations,
      historyHandoff,
      keyOf: () => 'doc-a',
      replayOptions,
    });
    return { store, conversations, historyHandoff };
  }

  it('records turns and meta in the current conversation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store } = makeStore(dir);
    await store.recordTurn('hello', 'hi there [ACTION: none]');
    await store.recordTurnMeta({ action: 'none', result: 'applied' });
    const turns = await store.ensure('doc-a');
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.content).toBe('hello');
    expect(turns[1]?.role).toBe('assistant');
    // meta lands on the LAST turn (assistant), after the async persist settles
    await waitFor(async () => {
      const stored = await loadHistory(dir, 'doc-a');
      expect(stored).toHaveLength(2);
      expect(stored[1]?.meta?.action).toBe('none');
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records attachment names on the user turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store } = makeStore(dir);
    await store.recordTurn('rewrite my CV', 'done [ACTION: none]', ['cv.pdf']);
    await store.recordTurn('plain message', 'ok [ACTION: none]');
    const turns = await store.ensure('doc-a');
    expect(turns[0]?.attachments).toEqual(['cv.pdf']);
    expect(turns[2]?.attachments).toBeUndefined();
    await store.flush();
    const stored = await loadHistory(dir, 'doc-a');
    expect(stored[0]?.attachments).toEqual(['cv.pdf']);
    expect(stored[2]?.attachments).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('debounces history writes and flush() persists immediately', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store } = makeStore(dir);
    await store.recordTurn('hello', 'hi there [ACTION: none]');
    await store.recordTurnMeta({ action: 'none', result: 'applied' });
    // Still inside the debounce window: nothing on disk yet (turn + meta
    // coalesce into one write).
    expect(await loadHistory(dir, 'doc-a')).toEqual([]);
    // flush() bypasses the debounce and writes everything.
    await store.flush();
    const stored = await loadHistory(dir, 'doc-a');
    expect(stored).toHaveLength(2);
    expect(stored[1]?.meta?.action).toBe('none');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists through the debounce without an explicit flush', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store } = makeStore(dir);
    await store.recordTurn('hello', 'hi');
    await waitFor(async () => {
      expect(await loadHistory(dir, 'doc-a')).toHaveLength(2);
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records action steps without user turns and marks handoff after a reload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const first = makeStore(dir);
    await first.store.recordTurn('edit this', '[ACTION: insert]');
    await first.store.recordActionStep('[ACTION: insert-after p2]', 2);

    // A fresh store over the same history dir simulates a restart: the
    // loaded turns are unseen and must be replayed. Persist is
    // fire-and-forget (matching app behavior), so await the write first.
    await waitFor(async () => {
      expect((await loadHistory(dir, 'doc-a')).length).toBe(3);
    });
    const second = makeStore(dir);
    const turns = await second.store.ensure('doc-a');
    expect(turns).toHaveLength(3);
    expect(second.historyHandoff.get('doc-a')).toBe(3);
    const prefix = second.store.buildHistoryPrefix('doc-a');
    expect(prefix).toContain('Conversation so far');
    expect(prefix).toContain('- User: edit this');
    // unseen count drops to zero only when the caller clears it
    second.historyHandoff.delete('doc-a');
    expect(second.store.buildHistoryPrefix('doc-a')).toBe('');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the last assistant turn untouched when meta targets a user turn', async () => {
    const { store } = makeStore();
    await store.recordTurn('hi', 'hello');
    // Simulate a corrupted shape: append a trailing user turn
    const { store: s2, conversations } = makeStore();
    conversations.set('doc-a', [
      { role: 'user', content: 'only a user turn', timestamp: 't' },
    ]);
    await s2.recordTurnMeta({ action: 'insert', result: 'error', error: 'x' });
    const turns = conversations.get('doc-a') ?? [];
    expect(turns[0]?.meta).toBeUndefined();
  });

  it('migrates a conversation to a new key: turns, handoff, and the history file move', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store, conversations, historyHandoff } = makeStore(dir);
    await store.recordTurn('make my CV', 'done [ACTION: none]');
    await store.recordActionStep('more [ACTION: none]', 2);
    historyHandoff.set('doc-a', 3);
    await store.flush();
    expect((await loadHistory(dir, 'doc-a'))).toHaveLength(3);

    await store.migrate('doc-a', 'C:/docs/CV ACP Assist.lyx');

    expect(conversations.get('doc-a')).toBeUndefined();
    expect(conversations.get('C:/docs/CV ACP Assist.lyx')).toHaveLength(3);
    expect(historyHandoff.get('doc-a')).toBeUndefined();
    expect(historyHandoff.get('C:/docs/CV ACP Assist.lyx')).toBe(3);
    expect(await loadHistory(dir, 'doc-a')).toEqual([]); // source file removed
    expect(await loadHistory(dir, 'C:/docs/CV ACP Assist.lyx')).toHaveLength(3);
    // A fresh store (restart) loads the migrated history under the new key.
    const second = makeStore(dir);
    expect(await second.store.ensure('C:/docs/CV ACP Assist.lyx')).toHaveLength(3);
    expect(second.store.unseenCount('C:/docs/CV ACP Assist.lyx')).toBe(3);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migrate moves a persisted-only conversation (never loaded in memory)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    await saveHistory(dir, '(unsaved)', [{ role: 'user', content: 'hi', timestamp: 't' }]);
    const { store, conversations } = makeStore(dir);
    await store.migrate(UNSAVED_KEY, 'C:/docs/new.lyx');
    expect(conversations.get('C:/docs/new.lyx')).toHaveLength(1);
    expect(await loadHistory(dir, UNSAVED_KEY)).toEqual([]);
    expect(await loadHistory(dir, 'C:/docs/new.lyx')).toHaveLength(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migrate never clobbers an existing target conversation and ignores empty/same-key sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store, conversations } = makeStore(dir);
    await store.recordTurn('source turn', 'source reply');
    await store.flush();
    conversations.set('doc-b', [{ role: 'user', content: 'existing', timestamp: 't' }]);
    await saveHistory(dir, 'doc-b', conversations.get('doc-b')!);

    await store.migrate('doc-a', 'doc-b'); // target occupied -> no-op
    expect(conversations.get('doc-a')).toHaveLength(2);
    expect(conversations.get('doc-b')).toHaveLength(1);
    expect((await loadHistory(dir, 'doc-a'))).toHaveLength(2);

    await store.migrate('doc-a', 'doc-a'); // same key -> no-op
    expect(conversations.get('doc-a')).toHaveLength(2);

    await store.migrate('doc-empty', 'doc-c'); // empty source -> no-op
    expect(conversations.has('doc-c')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migrate cancels a pending debounced write so the source file is not resurrected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-store-'));
    const { store } = makeStore(dir);
    await store.recordTurn('hello', 'hi'); // debounce timer pending, nothing on disk yet
    expect(await loadHistory(dir, 'doc-a')).toEqual([]);
    await store.migrate('doc-a', 'doc-moved');
    expect(await loadHistory(dir, 'doc-moved')).toHaveLength(2);
    // Wait past the debounce window: the old key's file must stay gone.
    await new Promise((r) => setTimeout(r, 700));
    expect(await loadHistory(dir, 'doc-a')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- attachment extraction --------------------------------------------------------

describe('extractAttachmentText', () => {
  it('reads textual extensions directly, capped at the limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-att-'));
    const file = path.join(dir, 'notes.md');
    await fs.writeFile(file, 'y'.repeat(50_000), 'utf8');
    const text = await extractAttachmentText(file, 'notes.md', {
      textualFile: /\.(txt|md)$/i,
    });
    expect(text).not.toBeNull();
    expect(text?.length).toBe(40_000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for a textual file that cannot be read', async () => {
    const out = await extractAttachmentText(
      'C:/definitely/not/here.md',
      'here.md',
      { textualFile: /\.(md)$/i },
    );
    expect(out).toBeNull();
  });

  it('respects the app-provided textual pattern', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-att-'));
    const file = path.join(dir, 'doc.lyx');
    await fs.writeFile(file, '#LyX 2.5', 'utf8');
    // With the LyX app's pattern the file is read directly...
    const direct = await extractAttachmentText(file, 'doc.lyx', {
      textualFile: /\.lyx$/i,
    });
    expect(direct).toBe('#LyX 2.5');
    // ...while a narrow pattern does not match this file.
    expect(/(\.md)$/i.test('doc.lyx')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
// --- image helpers (writer insert-image) ---------------------------------------

import { parseDataUri, toDataUri, sniffImageSize, sizeToCm, defaultImageSizeCm } from '../src/index.js';

describe('image helpers', () => {
  it('round-trips data URIs', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const uri = toDataUri('image/png', bytes);
    const parsed = parseDataUri(uri);
    expect(parsed?.mime).toBe('image/png');
    expect([...(parsed?.bytes ?? [])]).toEqual([1, 2, 3, 250]);
    expect(parseDataUri('not a uri')).toBeNull();
  });

  it('sniffs PNG/GIF/JPEG sizes', () => {
    // 2x3 PNG
    const png = new Uint8Array(24);
    [0x89, 0x50, 0x4e, 0x47].forEach((b, i) => (png[i] = b));
    png[16] = 0; png[17] = 0; png[18] = 0; png[19] = 2;
    png[20] = 0; png[21] = 0; png[22] = 0; png[23] = 3;
    expect(sniffImageSize(png)).toEqual({ width: 2, height: 3 });
    // 4x5 GIF
    const gif = new Uint8Array(24);
    [0x47, 0x49, 0x46].forEach((b, i) => (gif[i] = b));
    gif[6] = 4; gif[7] = 0; gif[8] = 5; gif[9] = 0;
    expect(sniffImageSize(gif)).toEqual({ width: 4, height: 5 });
    // JPEG: SOI + APP0 (len 16 covers its own 2 bytes) + SOF0 (h=6, w=7)
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 6, 0, 7]);
    expect(sniffImageSize(jpg)).toEqual({ width: 7, height: 6 });
    expect(sniffImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('parses sizes and computes default display size', () => {
    expect(sizeToCm('10cm')).toBeCloseTo(10);
    expect(sizeToCm('2in')).toBeCloseTo(5.08);
    expect(sizeToCm('96px')).toBeCloseTo(2.54);
    expect(sizeToCm('nonsense')).toBeNull();
    // 960x480 px at 96dpi = 25.4x12.7cm -> capped to 16cm wide
    const png = new Uint8Array(24);
    [0x89, 0x50, 0x4e, 0x47].forEach((b, i) => (png[i] = b));
    png[19] = 0xc0; png[18] = 0x03; // 960
    png[23] = 0xe0; png[22] = 0x01; // 480
    const size = defaultImageSizeCm(png);
    expect(size.widthCm).toBeCloseTo(16);
    expect(size.heightCm).toBeCloseTo(8);
    expect(defaultImageSizeCm(null)).toEqual({ widthCm: 10, heightCm: 10 });
  });
});
