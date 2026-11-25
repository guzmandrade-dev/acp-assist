/**
 * Small text helpers shared by the companion apps
 * (the two identical module-local `preview` helpers in the LibreOffice app).
 */

import { createHash } from 'node:crypto';

/**
 * Short single-line preview of a text: whitespace-collapsed, trimmed,
 * capped at `len` characters with an ellipsis. Default 120 = the Writer
 * outline preview length.
 */
export function preview(text: string, len = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= len ? t : `${t.slice(0, len)}…`;
}

/** Stable content hash for the once-per-version context dedup (core loop). */
export function hashContextBlock(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The note a backend embeds in a step-1 prompt INSTEAD of its big context
 * block when the core loop determined the document is unchanged since that
 * block was sent earlier in the same ACP session (content-hash match, no
 * agent compaction since). `readFileHint: false` for sources the agent
 * cannot read as text (PDF mode).
 */
export function contextOmittedNote(fileLabel: string, opts: { readFileHint?: boolean } = {}): string {
  const readFile =
    opts.readFileHint === false
      ? ''
      : ' If you need the exact text of a paragraph, read or search the saved file with your file tools.';
  return (
    `Document context (${fileLabel}): UNCHANGED since the outline/full text sent earlier in this ` +
    `conversation — refer to it above; its paragraph/page addresses are still valid.${readFile}`
  );
}
