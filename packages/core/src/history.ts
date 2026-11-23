/**
 * Per-document chat-history persistence and restart replay, shared by the
 * companion apps. Histories are keyed by the app's conversation key
 * (document path or URL) and stored as `<sha256-prefix>.json` files.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Turn, TurnMeta } from './types.js';

/** Key for the unsaved-document pseudo conversation. */
export const UNSAVED_KEY = '(unsaved)';

/**
 * Conversation-history replay after an app restart: the agent process is
 * new and has no memory, so it must be briefed on the turns it missed.
 * A turn counts as "replayed" once it has been sent in one prompt.
 */
export const HISTORY_REPLAY_LIMIT = 20;
/** Per-turn character cap when replaying history into a prompt. */
export const HISTORY_REPLAY_CHAR_LIMIT = 500;

/**
 * List persisted conversation keys. Entries whose key fails the optional
 * `exists` check (e.g. the document file is gone) are skipped.
 */
export async function listKnownDocuments(
  historyDir: string,
  options: { exists?: (key: string) => Promise<boolean> } = {},
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(historyDir);
  } catch {
    return [];
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(historyDir, entry), 'utf8');
      const data = JSON.parse(raw) as { key?: string };
      const key = data.key;
      if (typeof key !== 'string' || key === UNSAVED_KEY) continue;
      // Archived conversation files (see archiveHistory) share the key's
      // hash prefix — list each document once.
      if (seen.has(key)) continue;
      if (options.exists && !(await options.exists(key))) continue;
      seen.add(key);
      keys.push(key);
    } catch {
      /* unreadable entry — skip */
    }
  }
  return keys;
}

/** The 16-hex-char file-name prefix every conversation file of `key` starts with. */
function historyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function historyFile(dir: string, key: string): string {
  return path.join(dir, `${historyHash(key)}.json`);
}

export async function loadHistory(dir: string, key: string): Promise<Turn[]> {
  try {
    const raw = await fs.readFile(historyFile(dir, key), 'utf8');
    const data = JSON.parse(raw) as { key?: string; turns: Turn[] };
    if (data.key !== key) return []; // hash collision guard
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

export async function saveHistory(dir: string, key: string, turns: Turn[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // Compact JSON: history grows per turn and the file is rewritten per
  // persisted turn — pretty-printing roughly doubles the bytes written.
  await fs.writeFile(historyFile(dir, key), JSON.stringify({ key, turns }), 'utf8');
}

/** Delete a persisted conversation (used when its key migrates away). */
export async function removeHistory(dir: string, key: string): Promise<void> {
  await fs.rm(historyFile(dir, key), { force: true });
}

// --- multiple conversations per key ------------------------------------------
//
// A document key has ONE active conversation (`<hash>.json`) plus any number
// of archived ones (`<hash>.<stamp>.json`, created by archiveHistory when the
// user starts a new conversation or switches to a previous one). loadHistory
// only ever reads the active file, so archived conversations never leak into
// a fresh session's replay unless explicitly promoted.

/** Filesystem-safe timestamp for archive names: 2026-11-22T20-03-55-123Z. */
function archiveStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** True when `entry` is a conversation file of `key` (active or archived). */
function isConversationFile(entry: string, key: string): boolean {
  const hash = historyHash(key);
  return entry === `${hash}.json` || (entry.startsWith(`${hash}.`) && entry.endsWith('.json'));
}

export interface ConversationMeta {
  /** File name within the history dir (`<hash>.json` for the active one). */
  file: string;
  /** True for the active conversation. */
  active: boolean;
  turnCount: number;
  /** First user turn, whitespace-collapsed and truncated — list preview. */
  preview: string;
  /** Timestamp of the last turn, null when the file has no turns. */
  lastTimestamp: string | null;
}

// The list row truncates visually (CSS ellipsis); the longer text rides
// along in the row's hover tooltip so the full first request is readable.
const PREVIEW_LIMIT = 300;

/** All persisted conversations for a key, most recent first. */
export async function listConversations(dir: string, key: string): Promise<ConversationMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ConversationMeta[] = [];
  for (const entry of entries) {
    if (!isConversationFile(entry, key)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf8');
      const data = JSON.parse(raw) as { key?: string; turns?: Turn[] };
      if (data.key !== key) continue; // hash-prefix collision guard
      const turns = Array.isArray(data.turns) ? data.turns : [];
      const firstUser = turns.find((t) => t.role === 'user')?.content ?? '';
      const last = turns[turns.length - 1];
      out.push({
        file: entry,
        active: entry === `${historyHash(key)}.json`,
        turnCount: turns.length,
        preview: firstUser.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT),
        lastTimestamp: (last && typeof last.timestamp === 'string' ? last.timestamp : null),
      });
    } catch {
      /* unreadable entry — skip */
    }
  }
  out.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));
  return out;
}

/**
 * Archive the active conversation of `key` (rename `<hash>.json` to
 * `<hash>.<stamp>.json`) so it stays available as a "previous session" and is
 * not replayed into new sessions. Returns the archive file name, or null when
 * nothing was persisted for the key.
 */
export async function archiveHistory(dir: string, key: string): Promise<string | null> {
  const active = historyFile(dir, key);
  try {
    await fs.access(active);
  } catch {
    return null;
  }
  const archived = path.join(dir, `${historyHash(key)}.${archiveStamp()}.json`);
  await fs.rename(active, archived);
  return path.basename(archived);
}

/**
 * Promote an archived conversation file of `key` to the active one, archiving
 * the currently active file first. No-op when `file` is already the active
 * name. Throws when the file does not belong to `key`.
 */
export async function promoteConversation(dir: string, key: string, file: string): Promise<void> {
  const base = path.basename(file);
  if (!isConversationFile(base, key)) {
    throw new Error(`"${base}" is not a conversation file of this document.`);
  }
  if (base === `${historyHash(key)}.json`) return; // already active
  const source = path.join(dir, base);
  const raw = await fs.readFile(source, 'utf8');
  const data = JSON.parse(raw) as { key?: string };
  if (data.key !== key) throw new Error('History file key mismatch.');
  await archiveHistory(dir, key); // keep the current active as an archive
  await fs.rename(source, historyFile(dir, key));
}

export interface HistoryReplayOptions {
  /**
   * Fenced content blocks stripped from replayed assistant turns (they
   * are reported via the meta line instead), e.g. /```lyx[\s\S]*?```/g
   * or /```(?:writer|calc|impress)[\s\S]*?```/g.
   */
  blockPattern: RegExp;
  /** Renders the address suffix of an applied action (e.g. " p5"). */
  describeTarget?: (meta: TurnMeta) => string;
}

export function formatHistoryReplay(
  turns: Turn[],
  unseen: number,
  options: HistoryReplayOptions,
): string {
  const count = Math.min(Math.max(0, unseen), turns.length, HISTORY_REPLAY_LIMIT);
  if (count <= 0) return '';
  const lines: string[] = [
    `Conversation so far (earlier turns, replayed because the app was restarted — you have no memory of these):`,
    `The user can see this history; treat it as context, not as a request to continue anything.`,
  ];
  for (const turn of turns.slice(0, count)) {
    const label = turn.role === 'user' ? 'User' : 'You';
    let text = (turn.content ?? '')
      // The replay is context, not a request to re-apply: drop the action
      // tag and any fenced content block (the meta line reports the
      // outcome).
      .replace(options.blockPattern, '')
      .replace(/\[ACTION:\s*[^\]]*\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > HISTORY_REPLAY_CHAR_LIMIT) {
      text = `${text.slice(0, HISTORY_REPLAY_CHAR_LIMIT)}…`;
    }
    lines.push(`- ${label}: ${text}`);
    if (turn.role === 'assistant' && turn.meta) {
      const m = turn.meta;
      if (m.result === 'applied' && m.action !== 'none') {
        const at = options.describeTarget ? options.describeTarget(m) : '';
        lines.push(`  (applied [ACTION: ${m.action}${at}] in the document)`);
      } else if (m.result === 'error') {
        lines.push(`  (action ${m.action} FAILED: ${m.error ?? 'unknown error'})`);
      } else if (m.result === 'cancelled') {
        lines.push(`  (action ${m.action} was cancelled before applying)`);
      }
    }
  }
  return '\n' + lines.join('\n');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `cond` until it returns a truthy value, at `intervalMs` intervals,
 * up to `timeoutMs` total. Returns the first truthy value, or null when
 * the budget ran out. Replaces fixed sleeps after commands with
 * event-verified waits (payload appeared / state changed).
 */
export async function pollUntil<T>(
  cond: () => Promise<T>,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T | null> {
  const interval = options.intervalMs ?? 25;
  const deadline = Date.now() + (options.timeoutMs ?? 500);
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}