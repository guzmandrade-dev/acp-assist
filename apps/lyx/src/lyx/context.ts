/**
 * Build agent-facing context from a saved `.lyx` file.
 *
 * The parser produces the tree; this module flattens it into:
 *  - `extractHeader`: the verbatim header section (reused when assembling
 *    clipboard payloads for paste).
 *  - `buildOutline`: a compact, addressed paragraph list the agent can
 *    reason about (layout names, nesting, first lines of text).
 *
 * Content addressing: paragraphs are numbered [p1], [p2], ... in document
 * order (depth-first through the body). The agent quotes these ids when
 * referring to content.
 */

import { parse, parseRecovering, type LyxNode } from './parser.js';

export interface OutlineEntry {
  id: string;
  layout: string;
  depth: number;
  preview: string;
  hasMath: boolean;
  /** 1-based line number of the paragraph's `\begin_layout` in the file. */
  line: number;
}

export interface DocumentContext {
  /** Verbatim header text, `#...` through `\end_header` inclusive. */
  header: string;
  /** Verbatim text between `\begin_body` and `\end_body`. */
  body: string;
  outline: OutlineEntry[];
  formatVersion?: string;
  textclass?: string;
}

const PREVIEW_LIMIT = 160;

/**
 * Reduce tracked-change markup to the LIVE view of the document: content
 * inside `\change_deleted …` segments is dropped (LyX keeps deleted content
 * in the saved file, but the live buffer the cursor walks and the clipboard
 * export do not contain it), and the `\change_inserted` / `\change_deleted`
 * / `\change_accepted` / `\change_unchanged` marker lines are removed.
 * Without this, a document with pending tracked changes mis-targets: the
 * file-side paragraph text still contains the deleted content while the
 * clipboard payload does not (live-observed 2026-11-22: "Paragraph targeting
 * failed" on the step after a tracked rewrite-at).
 */
export function stripTrackedDeletions(text: string): string {
  const out: string[] = [];
  let deleted = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\\change_deleted\b/.test(line)) {
      deleted = true;
      continue;
    }
    if (/^\\change_(?:inserted|accepted|unchanged)\b/.test(line)) {
      deleted = false;
      continue;
    }
    if (!deleted) out.push(line);
  }
  return out.join('\n');
}

export function extractHeader(lyxText: string): string | null {
  const end = lyxText.indexOf('\\end_header');
  if (end === -1) return null;
  return lyxText.slice(0, end + '\\end_header'.length);
}

export function extractBody(lyxText: string): string | null {
  const start = lyxText.indexOf('\\begin_body');
  const end = lyxText.lastIndexOf('\\end_body');
  if (start === -1 || end === -1 || end < start) return null;
  return lyxText.slice(start + '\\begin_body'.length, end).trim();
}

export function buildDocumentContext(lyxText: string): DocumentContext {
  let root;
  let notes: string[] = [];
  try {
    root = parse(lyxText);
  } catch {
    const recovered = parseRecovering(lyxText);
    root = recovered.document;
    notes = recovered.notes;
  }
  if (notes.length > 0) {
    // Recovering parse: LyX would still open the file; notes kept for debug.
  }

  const formatVersion = findProperty(root.children, 'lyxformat');
  const textclass = findInBlocks(root.children, 'header', 'textclass');

  let counter = 0;
  const outline: OutlineEntry[] = [];
  const body = findBlock(root.children, 'body');
  if (body && body.type === 'block') {
    walk(body.children, 0);
  }

  function walk(nodes: LyxNode[], depth: number): void {
    for (const node of nodes) {
      if (node.type !== 'block') continue;
      if (node.tag === 'deeper') {
        walk(node.children, depth + 1);
      } else if (node.tag === 'layout') {
        const texts = collectTexts(node.children);
        // A TRULY EMPTY paragraph (no live text and no inset) is NOT a row
        // in LyX's live paragraph walk — `paragraph-down` skips it
        // (live-verified 2026-11-23 on LyX 2.5: a doc with
        // Alpha/EMPTY/Beta/Gamma walks as 3 rows). Counting it here shifted
        // every [pN] above an empty shell by one, so targeting failed with
        // "landed on <next paragraph>" (delete-at leaves exactly such a
        // shell when the merge-away is tracked/not applied — observed
        // 2026-11-23 on the PLEE article, p61/p139/p142). Skip empty
        // paragraphs so the outline matches the live walk 1:1. A paragraph
        // holding only an inset (Newpage, Separator, …) IS a walk row —
        // keep those.
        if (texts.length === 0 && !hasAnyInset(node.children)) continue;
        counter++;
        const preview = texts.join(' ').slice(0, PREVIEW_LIMIT);
        outline.push({
          id: `p${counter}`,
          layout: node.args ?? 'Standard',
          line: node.line,
          depth,
          preview,
          hasMath: hasFormulaInset(node.children),
        });
        // Do not descend into layouts: their children are the paragraph's
        // own text and insets, already captured by the preview.
      } else {
        walk(node.children, depth);
      }
    }
  }

  const header = extractHeader(lyxText);
  const bodyText = extractBody(lyxText);

  return {
    header: header ?? '',
    body: bodyText ?? '',
    outline,
    formatVersion,
    textclass,
  };
}

/** Render the outline as the text block we attach to agent prompts. */
export function renderOutline(outline: OutlineEntry[]): string {
  return outline
    .map((e) => {
      const indent = '  '.repeat(e.depth);
      const math = e.hasMath ? ' [math]' : '';
      // L<line> anchors the paragraph to its file line so the agent can
      // reconcile line-based file reads with the [pN] ids.
      const line = ` L${e.line + 1}`;
      const preview = e.preview ? ` — ${e.preview}` : '';
      return `${indent}[${e.id}] (${e.layout}${math})${line}${preview}`;
    })
    .join('\n');
}

/** Wrap agent-generated body layouts into a full .lyx document for paste. */
export function assemblePasteDocument(header: string, bodyLayouts: string): string {
  const trimmedHeader = header.trim();
  const trimmedBody = bodyLayouts.trim();
  return `${trimmedHeader}\n\n\\begin_body\n\n${trimmedBody}\n\n\\end_body\n\\end_document\n`;
}

/**
 * Extract body layouts from an agent reply. Accepts:
 *  - raw `\begin_layout` blocks
 *  - a full `\begin_document` document
 *  - content between `\begin_body` / `\end_body`
 */
export function extractBodyLayouts(text: string): string | null {
  const fenced = extractLyxFencedBlock(text) ?? text;
  const bodyStart = fenced.indexOf('\\begin_body');
  const bodyEnd = fenced.lastIndexOf('\\end_body');
  if (bodyStart !== -1 && bodyEnd !== -1 && bodyEnd > bodyStart) {
    return fenced.slice(bodyStart + '\\begin_body'.length, bodyEnd).trim();
  }
  if (bodyStart !== -1 && bodyEnd === -1) {
    // Agent wrote \begin_body without its end: take the remainder.
    return fenced.slice(bodyStart + '\\begin_body'.length).trim();
  }
  if (fenced.includes('\\begin_layout')) {
    return fenced.trim();
  }
  return null;
}

/**
 * Split a .lyx body into its TOP-LEVEL layout blocks (paragraphs).
 * `\begin_layout` lines nested inside insets (e.g. a Note's inner
 * `Plain Layout`) do NOT start a block: they sit between a matching
 * `\begin_inset`/`\end_inset` pair. Layout blocks do not nest at the
 * top level.
 */
export function splitTopLevelLayouts(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;
  let insetDepth = 0;
  for (const line of lines) {
    if (/^\\begin_inset\b/.test(line)) insetDepth++;
    if (current === null) {
      if (insetDepth === 0 && /^\\begin_layout\b/.test(line)) current = [line];
    } else {
      current.push(line);
      if (insetDepth === 0 && /^\\end_layout\b/.test(line)) {
        blocks.push(current.join('\n'));
        current = null;
      }
    }
    if (/^\\end_inset\b/.test(line)) insetDepth = Math.max(0, insetDepth - 1);
  }
  if (current && current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * True for a top-level layout block with no live content: after stripping
 * tracked deletions it holds neither text nor any inset. These are the
 * paragraphs LyX's `paragraph-down` walk skips (live-verified 2026-11-23),
 * so the outline (and any index into paragraph blocks) must skip them too.
 */
export function isEmptyParagraphBlock(block: string): boolean {
  const live = stripTrackedDeletions(block);
  let hasInset = false;
  let hasText = false;
  for (const line of live.split(/\r?\n/)) {
    if (/^\\begin_inset\b/.test(line)) hasInset = true;
    // Property/syntax lines start with `\`; plain text lines do not.
    else if (line.trim() !== '' && !line.startsWith('\\')) hasText = true;
  }
  return !hasInset && !hasText;
}

/**
 * Like {@link splitTopLevelLayouts}, but drops truly empty paragraphs so the
 * returned indices line up with the outline's [pN] ids and with LyX's live
 * paragraph walk.
 */
export function splitTopLevelParagraphs(body: string): string[] {
  return splitTopLevelLayouts(body).filter((b) => !isEmptyParagraphBlock(b));
}

/**
 * Whitespace-insensitive normalization for comparing raw .lyx markup
 * blocks (e.g. a clipboard payload block vs the saved file's block):
 * CRLF, trailing spaces, and blank lines are ignored; leading spaces
 * are preserved (LyX uses them for layout argument lines).
 * Change-tracking marker lines (\change_inserted / \change_deleted /
 * \change_accepted) are stripped: with change tracking ON, LyX wraps pasted
 * content in \change_inserted, so the saved file's block differs from the
 * pasted payload's block only by those markers (live-found 2026-11-08:
 * post-paste verify failed and undid a good edit because of them).
 */
const CHANGE_MARKER_RE = /^\\change_(?:inserted|deleted|accepted|unchanged)\s/;

export function normalizeMarkupBlock(block: string): string {
  // Defensive: drop tracked-deleted segments and marker lines even when
  // the caller did not strip them (verifyParagraphSelection strips first).
  const live = stripTrackedDeletions(block);
  return live
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0 && !CHANGE_MARKER_RE.test(line))
    .join('\n');
}

/**
 * Raw content of every Formula inset in a body (the text between
 * `\begin_inset Formula` and its matching `\end_inset`), trimmed.
 * Formula content never nests other insets, so the nearest `\end_inset`
 * closes it. Handles inline (`$x$` on the begin line) and display
 * (multi-line `$\n...\n$`) formulas.
 */
export function extractFormulaContents(body: string): string[] {
  const out: string[] = [];
  const re = /\\begin_inset Formula\b([\s\S]*?)\\end_inset/g;
  for (const m of body.matchAll(re)) out.push(m[1]!.trim());
  return out;
}

/**
 * Detect markup the agent must fix before we paste it. LyX renders
 * malformed content as literal text or empty insets.
 */
export function findMarkupProblems(body: string): string[] {
  const problems: string[] = [];
  const latexInline = /\\(?:emph|textbf|textit|noun|underline)\\?\{/.exec(body);
  if (latexInline) {
    problems.push(
      `LaTeX-style inline command "${latexInline[0]}" found. LyX markup uses ` +
        'token format instead: \\emph on\\n...\\n\\emph default on their own lines.',
    );
  }
  if (/\\begin\{document\}/.test(body)) problems.push('\\begin{document} is LaTeX, not LyX.');
  if (!body.includes('\\begin_layout')) {
    problems.push('No \\begin_layout block found.');
    return problems;
  }

  // Empty insets: begin_inset line whose args are word-only (type words
  // only, no content) immediately followed by \end_inset. Formula etc.
  // keep content on the begin line, so those with real args are not empty.
  if (/\\begin_inset [A-Za-z][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*\n\\end_inset/.test(body)) {
    problems.push('Empty inset found (\\begin_inset with no content). Remove or fill it.');
  }
  const insetWithBody = /\\begin_inset (Note|Foot|Flex)\b[\s\S]*?(?=\\end_inset)/g;
  for (const m of body.matchAll(insetWithBody)) {
    if (!m[0].includes('\\begin_layout')) {
      problems.push(
        `Inset "${m[1]}" has no inner \\begin_layout Plain Layout block — ` +
          'it will render EMPTY. Every inset with a body must contain ' +
          '\\begin_layout Plain Layout ... \\end_layout.',
      );
    }
  }

  // Literal $...$ math in text (NOT on a \begin_inset Formula line) renders
  // as plain characters, not an equation — live-reported: equations inside
  // TODO notes lost their format when rewritten as raw $...$ inside the
  // note. Math must be a Formula inset, also inside a Note's Plain Layout.
  let inFormula = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\\begin_inset Formula\b/.test(line)) {
      inFormula = true;
      continue;
    }
    if (/^\\end_inset\b/.test(line)) {
      inFormula = false;
      continue;
    }
    if (!inFormula && /\$[^$\n]+\$/.test(line)) {
      problems.push(
        'Literal $...$ math found in text — LyX renders it as plain characters, ' +
          'not an equation (this is how formulas inside notes lose their format). ' +
          'Wrap math in a Formula inset: \\begin_inset Formula $x^2$\\n\\end_inset ' +
          "— also when it sits inside a Note's inner Plain Layout.",
      );
      break;
    }
  }

  // Doubled backslashes inside a Formula inset: in math `\\` is a LaTeX
  // line break, so `$\\mapsto$` renders the command name as literal
  // letters ("mapsto") and the equation loses its format — live-reported
  // in the thesis main body: `$P:Fm\\mapsto\\mathbb{R}$` pasted as
  // the text "Fmmapstomathbb{R}". Formula content uses SINGLE backslashes.
  // A `\\` followed by a newline/space/`$`/`&` is a legitimate row
  // break in display math, so only `\\` directly followed by a letter
  // (or another backslash) is flagged.
  for (const formula of extractFormulaContents(body)) {
    const doubled = /\\\\[\\A-Za-z]/.exec(formula);
    if (doubled) {
      problems.push(
        `Doubled backslash "${doubled[0]}…" inside a Formula inset. Formula content is ` +
          'LaTeX with SINGLE backslashes: write $\rho$, never $\\rho$ — LyX reads ' +
          '\\ as a line break and the command name renders as literal text, so the ' +
          'equation loses its format.',
      );
      break;
    }
  }

  // Words glued to inline insets: a bare newline (or blank line) around an
  // inset is a separator, NOT a space, so "word\n\begin_inset Formula
  // $x$\n\end_inset\n." renders as "wordx." — the missing space is
  // invisible in the raw markup (live-reported 2026-10-24).
  const insetLines = body.split(/\r?\n/);
  const inlineStack: boolean[] = [];
  for (let i = 0; i < insetLines.length; i++) {
    const line = insetLines[i]!;
    if (/^\\begin_inset\b/.test(line)) {
      const inline = INLINE_INSET.test(line);
      inlineStack.push(inline);
      if (inline) {
        const prev = nearestNonBlank(insetLines, i, -1);
        if (prev && !prev.startsWith('\\') && /[A-Za-z0-9]$/.test(prev)) {
          problems.push(
            `Missing space before an inline inset: the text "${prev.trim()}" ` +
              'is glued to \\begin_inset, and a newline is NOT a space in ' +
              '.lyx — it will render "wordX". End that text line with a ' +
              'real space character.',
          );
        }
      }
    } else if (/^\\end_inset\b/.test(line)) {
      if (inlineStack.pop()) {
        const next = nearestNonBlank(insetLines, i, 1);
        if (next && !next.startsWith('\\') && /^[A-Za-z0-9]/.test(next)) {
          problems.push(
            `Missing space after an inline inset: it is glued to the text ` +
              `"${next.trim()}", and a newline is NOT a space in .lyx — it ` +
              'will render "Xword". Start that text line with a real space ' +
              'character (skip it only when punctuation follows).',
          );
        }
      }
    }
  }

  // Glued text across a plain line break: a newline between two text lines
  // is NOT a space in .lyx either — LyX's own writer always keeps an
  // explicit space at the line edge — so "First sentence.\nSecond" pastes
  // as "First sentence.Second" (live-reported 2026-11-22, PLEE article:
  // "probability space.\nThe central idea" landed glued in the saved
  // file). Inset-adjacent joints are covered above; this catches
  // text-to-text joints, including inside Note/Foot inner layouts. Inset
  // property lines (status/key/LatexCommand/...) and verbatim-style inset
  // bodies are syntax, not rendered text: they sit directly on an inset
  // frame, not on a layout frame, and are skipped.
  const frameStack: Array<'layout' | 'inset'> = [];
  const popFrame = (kind: 'layout' | 'inset') => {
    for (let i = frameStack.length - 1; i >= 0; i--) {
      if (frameStack[i] === kind) {
        frameStack.length = i;
        return;
      }
    }
  };
  let lastText: string | null = null;
  for (const line of insetLines) {
    if (/^\\begin_layout\b/.test(line)) {
      frameStack.push('layout');
      lastText = null;
      continue;
    }
    if (/^\\end_layout\b/.test(line)) {
      popFrame('layout');
      lastText = null;
      continue;
    }
    if (/^\\begin_inset\b/.test(line)) {
      frameStack.push('inset');
      lastText = null;
      continue;
    }
    if (/^\\end_inset\b/.test(line)) {
      popFrame('inset');
      lastText = null;
      continue;
    }
    if (line.trim() === '') continue; // blank line: separator, not a space
    if (line.startsWith('\\')) {
      lastText = null; // font/format token or other markup line
      continue;
    }
    if (frameStack[frameStack.length - 1] === 'layout') {
      if (lastText !== null && !lastText.endsWith(' ') && !line.startsWith(' ')) {
        problems.push(
          `Missing space at a line break: "${lastText.trim().slice(-48)}" and ` +
            `"${line.trim().slice(0, 48)}" are joined by a newline, which is NOT a ` +
            'space in .lyx — it will render glued ("…sentence.Next…"). End the ' +
            'first line with a real space character or start the next line with one.',
        );
      }
      lastText = line;
    } else {
      lastText = null;
    }
  }
  return problems;
}

/** Prefer a ```lyx fenced block if the agent used one. */
function extractLyxFencedBlock(text: string): string | null {
  // An unclosed opener still yields its content to end-of-reply (agents
  // occasionally truncate the closing fence mid-block).
  const m = /```lyx\s*\n([\s\S]*?)(?:```|$)/.exec(text);
  return m ? m[1]! : null;
}

function findBlock(nodes: LyxNode[], tag: string): LyxNode | undefined {
  for (const node of nodes) {
    if (node.type === 'block') {
      if (node.tag === tag) return node;
      const found = findBlock(node.children, tag);
      if (found) return found;
    }
  }
  return undefined;
}

function findProperty(nodes: LyxNode[], key: string): string | undefined {
  for (const node of nodes) {
    if (node.type === 'property' && node.key === key) return node.value;
    if (node.type === 'block') {
      const found = findProperty(node.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

function findInBlocks(nodes: LyxNode[], blockTag: string, key: string): string | undefined {
  const block = findBlock(nodes, blockTag);
  return block && block.type === 'block' ? findProperty(block.children, key) : undefined;
}

/**
 * Inset property lines that the parser stores as plain `text` children of
 * the inset block (they are file syntax, not visible content). Inside an
 * inset, lines like `status open`, `key "..."`, `LatexCommand ...` are
 * arguments LyX never displays in the document — they leak into previews
 * and break the verification comparison (shifting the fuzzy windows).
 */
const INSET_PROP_LINE =
  /^(status\s+(open|collapsed)|key\s|literal\s|name\s|target\s|LatexCommand\s|label\s)/;

/**
 * Quoted inset arguments (`reference "eq:LotJ"`, `plural "false"`, … —
 * CommandInset ref/citation options). The quoted form is required so that
 * prose starting with the same words ("after the proof…") survives.
 */
const INSET_QUOTED_PROP_LINE = /^(reference|plural|caps|noprefix|nolink|prefix|after|before|options|entry|filename|type)\s+"[^"]*"$/;

/**
 * Insets whose content reads as inline prose (formulas, cross-references,
 * citations, URLs). In .lyx the newline — or blank line — between such an
 * inset and adjacent text is a pure separator (LyX renders NO space
 * there), so a space must be an explicit trailing/leading space character
 * on the neighboring text line. Foot/Note insets are excluded (they
 * attach to the preceding word like footnote markers), as are
 * label/index insets (invisible anchors).
 */
const INLINE_INSET =
  /^\\begin_inset (Formula|Flex URL|CommandInset (?:ref|eqref|vref|pageref|vpageref|prettyref|formatted|citation))\b/;

/** Nearest non-blank line from index i in direction dir, or null. */
function nearestNonBlank(lines: string[], i: number, dir: -1 | 1): string | null {
  for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
    if (lines[j]!.trim() !== '') return lines[j]!;
  }
  return null;
}

function isInsetSyntaxLine(text: string): boolean {
  return INSET_PROP_LINE.test(text) || INSET_QUOTED_PROP_LINE.test(text);
}

/**
 * True when the subtree contains a Formula inset. Walks only block nodes
 * and short-circuits on the first hit — O(paragraph), unlike the old
 * JSON.stringify(children).includes('Formula') which was O(total doc
 * bytes) per paragraph.
 */
function hasFormulaInset(nodes: LyxNode[]): boolean {
  for (const node of nodes) {
    if (node.type !== 'block') continue;
    if (node.tag === 'inset' && (node.args ?? '').startsWith('Formula')) return true;
    if (hasFormulaInset(node.children)) return true;
  }
  return false;
}

/**
 * True when the subtree contains ANY inset (Formula, Newpage, Separator,
 * Note, …). An inset is live content: LyX's paragraph walk stops on a
 * paragraph that holds only an inset, so such paragraphs must stay in the
 * outline (only truly empty paragraphs are skipped — see walk()).
 */
function hasAnyInset(nodes: LyxNode[]): boolean {
  for (const node of nodes) {
    if (node.type !== 'block') continue;
    if (node.tag === 'inset') return true;
    if (hasAnyInset(node.children)) return true;
  }
  return false;
}

function collectTexts(
  nodes: LyxNode[],
  insideInset = false,
  changeState: { deleted: boolean } = { deleted: false },
): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'property') {
      // Tracked-change markers: content inside \change_deleted … is NOT
      // part of the live document (LyX's cursor walk and clipboard export
      // exclude it), so previews must skip it too — otherwise a document
      // with pending tracked changes shows the deleted text in the
      // outline and paragraph targeting fails on the next step
      // (live-observed 2026-11-22).
      if (node.key === 'change_deleted') changeState.deleted = true;
      else if (
        node.key === 'change_inserted' ||
        node.key === 'change_accepted' ||
        node.key === 'change_unchanged'
      ) {
        changeState.deleted = false;
      }
      continue;
    }
    if (changeState.deleted) continue;
    if (node.type === 'text') {
      const cleaned = node.text.replace(/\\(begin|end)_[A-Za-z0-9_]+/g, '').trim();
      // Only treat property-like lines as syntax when they sit directly
      // inside an inset block — paragraph text may legitimately start
      // with the same words.
      if (insideInset && isInsetSyntaxLine(cleaned)) continue;
      out.push(cleaned);
    } else if (node.type === 'block') {
      // Skip opaque blocks' raw markup in the preview, but note formulas.
      const inner = collectTexts(node.children, insideInset || node.tag === 'inset', changeState);
      out.push(...inner);
    }
  }
  return out.filter((t) => t.length > 0);
}