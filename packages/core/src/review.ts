/**
 * The structured-review loop, ported from Visual Research Pal's
 * "Generate Report": the agent is asked for a JSON review
 * (title / summary / page-grounded suggestions), the reply is extracted
 * tolerantly and validated against the Zod schema, and a prose-only
 * reply gets exactly ONE conversion retry before the run fails.
 *
 * The review is grounded in the PDF's per-page text (and optionally page
 * images) plus the current conversation, so chat → review → refine is a
 * critical loop: each generated review is recorded as a conversation
 * turn and feeds the next one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse, type ParseError } from 'jsonc-parser';
import JSZip from 'jszip';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AgentRunner } from './types.js';
import { formatPageList } from './pdf.js';

export const suggestionSchema = z.object({
  id: z.string().min(1),
  page: z.number().int().min(1),
  locationHint: z.string().min(1),
  targetType: z.enum(['general', 'section', 'paragraph', 'sentence', 'line', 'figure', 'table']),
  severity: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  action: z.string().min(1),
  rebuttalQuestion: z.string().default(''),
});

export const reviewSchema = z.object({
  title: z.string().default('Untitled'),
  summary: z.string().default(''),
  suggestions: z.array(suggestionSchema).default([]),
});

export type Suggestion = z.infer<typeof suggestionSchema>;
export type Review = z.infer<typeof reviewSchema>;

/** JSON Schema handed to the agent inside the report prompt. */
export const reviewJsonSchema = {
  type: 'object',
  required: ['title', 'summary', 'suggestions'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'page',
          'locationHint',
          'targetType',
          'severity',
          'confidence',
          'rationale',
          'action',
          'rebuttalQuestion',
        ],
        properties: {
          id: { type: 'string' },
          page: { type: 'integer', minimum: 1 },
          locationHint: {
            type: 'string',
            description:
              "Human-readable location, e.g. 'first paragraph of Section 3', 'Figure 2 caption', 'line 42 left column'",
          },
          targetType: {
            type: 'string',
            enum: ['general', 'section', 'paragraph', 'sentence', 'line', 'figure', 'table'],
          },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
          action: { type: 'string' },
          rebuttalQuestion: {
            type: 'string',
            description: 'A question the author can answer by pointing to evidence already in the paper.',
          },
        },
      },
    },
  },
} as const;

/** The default report prompt (Visual Research Pal's built-in). */
export const DEFAULT_REVIEW_PROMPT =
  'Based on our conversation history and the relevant sections of this PDF, ' +
  'produce a structured review. Return JSON with \'title\', \'summary\', and ' +
  '\'suggestions\'. Each suggestion must have \'id\', \'page\', \'locationHint\', ' +
  '\'targetType\' (general/section/paragraph/sentence/line/figure/table), ' +
  '\'severity\' (low/medium/high), \'confidence\' (0-1), \'rationale\', \'action\', ' +
  'and \'rebuttalQuestion\'. Write in the same language as the document\'s main prose.';

/** Cap on the page text sent with a review prompt (chars). */
export const REVIEW_TEXT_LIMIT = 200_000;
/** Cap on page images attached to a review prompt. */
export const MAX_REVIEW_IMAGE_PAGES = 8;
/** Render settings for review page images (visual grounding). */
export const REVIEW_IMAGE_RENDER = { dpi: 150, format: 'jpeg', quality: 80 } as const;
/** Review runs can take much longer than a single edit turn. */
export const REVIEW_TIMEOUT_MS = 600_000;

/**
 * Tolerantly pull the first JSON value out of an agent reply: finds the
 * first `{`/`[`, scans to its MATCHING closing bracket (string-aware, so
 * braces inside strings don't count), and parses that span — markdown
 * fences or prose after the JSON object don't break it. When no balanced
 * span exists (truncated reply), falls back to the span up to the LAST
 * closing bracket in the text.
 */
export function extractFirstJsonValue(text: string): unknown {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start =
    firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start === -1) return null;
  const open = text[start] ?? '{';
  const close = open === '{' ? '}' : ']';
  const tryParse = (raw: string): unknown => {
    const errors: ParseError[] = [];
    const parsed = parse(raw, errors, { allowTrailingComma: true });
    return errors.length === 0 ? parsed : null;
  };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(text.slice(start, i + 1));
        if (parsed !== null) return parsed;
      }
    }
  }
  // Fallback: truncated tail — try up to the last closing bracket anywhere.
  const lastClose = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastClose > start) return tryParse(text.slice(start, lastClose + 1));
  return null;
}

export interface ReviewRequest {
  /** Display name of the reviewed source (attachment name / file name). */
  sourceName: string;
  totalPages: number;
  /** The pages being reviewed. */
  pages: number[];
  /** `--- Page N ---`-marked text of those pages. */
  pageText: string;
  /** Rendered conversation history ('' when excluded). */
  history?: string;
  /** Override for DEFAULT_REVIEW_PROMPT. */
  prompt?: string;
  /** Page images (base64) for visual grounding. */
  images?: { data: string; mimeType: string }[];
}

export interface ReviewRunHooks {
  onChunk?: (chunk: string) => void;
  onToolCall?: (tool: { title: string; status: string; kind: string }) => void;
  /** Progress lines (phase changes), streamed to the panel as {"log"}. */
  onLog?: (message: string) => void;
  timeoutMs?: number;
}

/** The report prompt: base prompt + page list + history + schema + the text. */
export function buildReviewPrompt(req: ReviewRequest): string {
  const base = req.prompt?.trim() ? req.prompt : DEFAULT_REVIEW_PROMPT;
  return (
    `${base}\n\n` +
    `Document under review: ${req.sourceName} (${req.totalPages} pages)\n` +
    `Pages to review: ${formatPageList(req.pages)}\n\n` +
    `Conversation history:\n${req.history || '(none)'}\n\n` +
    'IMPORTANT: Your response must be a single valid JSON object matching this schema. ' +
    'Do not wrap it in Markdown code fences and do not add any prose before or after the JSON. ' +
    'If the document has no relevant issues, return an empty suggestions array and a brief summary.\n\n' +
    `Schema:\n${JSON.stringify(reviewJsonSchema, null, 2)}\n\n` +
    `Text of the reviewed pages:\n${req.pageText}`
  );
}

/** The one-shot "convert your prose to this schema" retry prompt. When the
 *  first attempt produced JSON that failed validation, `issues` lists the
 *  exact problems so the retry can fix them. */
export function buildConversionPrompt(prose: string, issues: string[] = []): string {
  return (
    'You just wrote the following review. Now convert it into valid JSON that matches this exact schema. ' +
    'Do not include Markdown fences or any explanation. Respond only with the JSON object.\n\n' +
    (issues.length > 0
      ? `The previous attempt failed schema validation with these problems — fix each of them:\n` +
        `${issues.map((i) => `- ${i}`).join('\n')}\n\n`
      : '') +
    `Schema:\n${JSON.stringify(reviewJsonSchema, null, 2)}\n\n` +
    `Your review text:\n${prose}`
  );
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Normalize common agent slips before schema validation: string numbers
 * ("page": "3"), capitalized enums ("High"), a bare array of suggestions,
 * missing id/rebuttalQuestion. Anything still invalid fails safeParse and
 * goes to the issue-aware retry.
 */
function normalizeReviewCandidate(parsed: unknown): unknown {
  let obj: Record<string, unknown>;
  if (Array.isArray(parsed)) {
    obj = { suggestions: parsed };
  } else if (parsed && typeof parsed === 'object') {
    obj = { ...(parsed as Record<string, unknown>) };
  } else {
    return parsed;
  }
  if (typeof obj.title !== 'string') obj.title = 'Untitled';
  if (typeof obj.summary !== 'string') obj.summary = '';
  const suggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];
  obj.suggestions = suggestions.map((s, i) => {
    if (!s || typeof s !== 'object') return s;
    const sug = { ...(s as Record<string, unknown>) };
    if (typeof sug.id !== 'string' || !sug.id) sug.id = `S${i + 1}`;
    const page = coerceNumber(sug.page);
    if (page !== undefined) sug.page = Math.max(1, Math.trunc(page));
    const confidence = coerceNumber(sug.confidence);
    if (confidence !== undefined) sug.confidence = Math.min(1, Math.max(0, confidence));
    if (typeof sug.severity === 'string') sug.severity = sug.severity.trim().toLowerCase();
    if (typeof sug.targetType === 'string') sug.targetType = sug.targetType.trim().toLowerCase();
    for (const key of ['locationHint', 'rationale', 'action', 'rebuttalQuestion'] as const) {
      if (typeof sug[key] !== 'string') sug[key] = '';
    }
    return sug;
  });
  return obj;
}

function parseReview(text: string): { review: Review | null; issues: string[] } {
  const parsed = extractFirstJsonValue(text);
  if (parsed === null) return { review: null, issues: ['no JSON object found in the reply'] };
  const result = reviewSchema.safeParse(normalizeReviewCandidate(parsed));
  if (result.success) return { review: result.data, issues: [] };
  const issues = result.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { review: null, issues };
}

/**
 * Run the review loop against the session's agent: prompt once with the
 * report prompt (+ page images), and — when the reply is not schema-valid
 * JSON — once more with the conversion prompt. Throws when both fail.
 */
export async function generateReview(
  agent: AgentRunner,
  sessionId: string,
  req: ReviewRequest,
  hooks: ReviewRunHooks = {},
): Promise<Review> {
  const promptOptions = {
    onChunk: hooks.onChunk,
    onToolCall: hooks.onToolCall,
    timeoutMs: hooks.timeoutMs,
  };
  const images: ContentBlock[] = (req.images ?? []).map((im) => ({
    type: 'image' as const,
    data: im.data,
    mimeType: im.mimeType,
  }));
  const content: ContentBlock[] = [{ type: 'text', text: buildReviewPrompt(req) }, ...images];

  hooks.onLog?.(`Asking the agent for a structured review of ${req.sourceName} (pages ${formatPageList(req.pages)})…`);
  const reply = await agent.prompt(sessionId, content, promptOptions);
  let { review, issues } = parseReview(reply);
  if (!review) {
    hooks.onLog?.(
      `Reply did not match the review schema (${issues.join('; ')}) — asking the agent once to fix it…`,
    );
    const retry = await agent.prompt(
      sessionId,
      [{ type: 'text', text: buildConversionPrompt(reply, issues) }],
      promptOptions,
    );
    const second = parseReview(retry);
    review = second.review;
    if (!review) {
      throw new Error(
        `Agent did not return a JSON object matching the review schema (problems: ${
          second.issues.join('; ') || 'no JSON found'
        }). Response started with: "${retry.slice(0, 200)}"`,
      );
    }
  }
  hooks.onLog?.(`Review ready: ${review.suggestions.length} suggestion(s).`);
  return review;
}

/** Compact one-line-per-suggestion rendering, recorded as the assistant turn. */
export function formatReviewForHistory(review: Review): string {
  const lines = [
    `Structured review — ${review.title}`,
    review.summary,
    `Suggestions (${review.suggestions.length}):`,
    ...review.suggestions.map(
      (s) =>
        `- ${s.id} (p${s.page}, ${s.locationHint}, ${s.targetType}, severity ${s.severity}, ` +
        `${Math.round(s.confidence * 100)}%): ${s.action}`,
    ),
  ];
  return lines.filter((l) => l !== '').join('\n');
}

function formatSuggestionMarkdown(suggestion: Suggestion, index: number): string {
  const parts = [
    `### ${index + 1}. ${suggestion.id}`,
    '',
    `- **Page:** ${suggestion.page}`,
    `- **Location:** ${suggestion.locationHint}`,
    `- **Severity:** ${suggestion.severity}`,
    `- **Confidence:** ${Math.round(suggestion.confidence * 100)}%`,
    '',
    `**Rationale:** ${suggestion.rationale}`,
    '',
    `**Suggested action:** ${suggestion.action}`,
  ];
  if (suggestion.rebuttalQuestion) {
    parts.push('', `**Rebuttal question:** ${suggestion.rebuttalQuestion}`);
  }
  return parts.join('\n');
}

/** The Markdown report as a string. */
export function renderReportMarkdown(review: Review): string {
  const lines = [
    `# Review: ${review.title}`,
    '',
    review.summary,
    '',
    `## Suggestions (${review.suggestions.length})`,
    '',
  ];
  for (let i = 0; i < review.suggestions.length; i += 1) {
    const s = review.suggestions[i];
    if (s) {
      lines.push(formatSuggestionMarkdown(s, i));
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** The JSON report as a string. */
export function renderReportJson(review: Review): string {
  return JSON.stringify(review, null, 2);
}

/** Write report.md / report.json; returns the written paths. */
export async function writeReports(
  review: Review,
  output: { markdown?: boolean; json?: boolean },
  outputDir: string,
): Promise<{ markdown?: string; json?: string }> {
  await fs.mkdir(outputDir, { recursive: true });
  const files: { markdown?: string; json?: string } = {};
  if (output.markdown !== false) {
    const mdPath = path.join(outputDir, 'report.md');
    await fs.writeFile(mdPath, renderReportMarkdown(review), 'utf8');
    files.markdown = mdPath;
  }
  if (output.json !== false) {
    const jsonPath = path.join(outputDir, 'report.json');
    await fs.writeFile(jsonPath, renderReportJson(review), 'utf8');
    files.json = jsonPath;
  }
  return files;
}

// --- flat HTML report -------------------------------------------------------------

export interface ReportMeta {
  sourceName: string;
  /** Human-readable page list, e.g. "1-12, 15". */
  pages: string;
  generatedAt: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The report as ONE flat HTML file — all styles inline, no images, no
 * external references, no scripts (Lighthouse-report style), so it can be
 * opened anywhere and shared as-is.
 */
export function renderReportHtml(review: Review, meta: ReportMeta): string {
  const items = review.suggestions
    .map(
      (s, i) => `
    <section class="suggestion">
      <h3>${i + 1}. ${escapeHtml(s.id)} <span class="sev sev-${s.severity}">${escapeHtml(s.severity)}</span>
        <span class="conf">${Math.round(s.confidence * 100)}% confidence</span></h3>
      <p class="meta">Page ${s.page} &middot; ${escapeHtml(s.locationHint)} &middot; ${escapeHtml(s.targetType)}</p>
      <p class="rationale">${escapeHtml(s.rationale)}</p>
      <p class="action"><strong>Suggested action:</strong> ${escapeHtml(s.action)}</p>${
        s.rebuttalQuestion
          ? `\n      <p class="rebuttal"><em>Rebuttal question:</em> ${escapeHtml(s.rebuttalQuestion)}</p>`
          : ''
      }
    </section>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review: ${escapeHtml(review.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 2rem;
         background: #f6f7f9; color: #1c1e21; line-height: 1.5; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .75rem; }
  .meta, .conf { color: #6b7280; font-size: .8rem; font-weight: normal; }
  header .meta { margin: 0 0 1rem; }
  .summary { font-size: .95rem; }
  .suggestion { background: #fff; border: 1px solid #e3e5e8; border-radius: 8px;
                padding: .9rem 1.1rem; margin: .75rem 0; }
  .suggestion h3 { font-size: .95rem; margin: 0 0 .3rem; }
  .suggestion p { margin: .35rem 0; font-size: .9rem; }
  .rationale { color: #374151; }
  .rebuttal { color: #6b7280; }
  .sev { font-size: .68rem; font-weight: 700; padding: 1px 8px; border-radius: 999px;
         text-transform: uppercase; letter-spacing: .04em; vertical-align: middle; }
  .sev-high { background: #fdecea; color: #b3261e; }
  .sev-medium { background: #fdf3e0; color: #8a5a14; }
  .sev-low { background: #eceff3; color: #4b5563; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181c; color: #e5e7eb; }
    .suggestion { background: #1f2126; border-color: #33363d; }
    .rationale { color: #d1d5db; }
    .sev-high { background: #4a211d; color: #f2b8b5; }
    .sev-medium { background: #453312; color: #f0cd8a; }
    .sev-low { background: #2c2f36; color: #b6bcc7; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Review: ${escapeHtml(review.title)}</h1>
    <p class="meta">Source: ${escapeHtml(meta.sourceName)} &middot; Pages: ${escapeHtml(meta.pages)} &middot; Generated: ${escapeHtml(meta.generatedAt)}</p>
  </header>
  <p class="summary">${escapeHtml(review.summary)}</p>
  <h2>Suggestions (${review.suggestions.length})</h2>
${items || '  <p>No suggestions — no issues found in the reviewed pages.</p>'}
</main>
</body>
</html>
`;
}

/** Pack the report as a ZIP (flat report.html + report.json) for download. */
export async function buildReviewZip(review: Review, meta: ReportMeta): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('report.html', renderReportHtml(review, meta));
  zip.file('report.json', renderReportJson(review));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
