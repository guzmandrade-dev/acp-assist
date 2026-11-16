/**
 * Page-aware PDF handling for the structured-review flow, ported from
 * Visual Research Pal (minus its viewer): per-page text extraction via
 * pdfjs-dist (legacy build, headless) and page-image rendering via
 * pdf-image-converter (WASM — no external binaries, works on every OS).
 *
 * There is deliberately no PDF viewer here: page images are only ever
 * sent to the agent as ACP image blocks for visual grounding; the panel
 * itself never renders pages.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfConverter } from 'pdf-image-converter';

export interface PdfPage {
  page: number;
  text: string;
}

export interface PdfDocumentInfo {
  /** Absolute path of the PDF. */
  path: string;
  totalPages: number;
  pages: PdfPage[];
  /** Full text with `--- Page N ---` markers — the shape the agent sees. */
  text: string;
}

export interface PdfRenderConfig {
  dpi: number;
  format: 'jpeg' | 'png';
  quality?: number;
}

export interface RenderedPageImage {
  pageNumber: number;
  /** Base64-encoded image, ready for an ACP image content block. */
  base64: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/** Standard fonts ship with pdfjs-dist; point the legacy build at them so
 *  non-embedded fonts (Helvetica & co.) don't warn on every page. */
const standardFontDataUrl = (() => {
  try {
    const require = createRequire(import.meta.url);
    // pdfjs wants a URL-style path with a forward-slash trailing separator.
    return path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/') + '/standard_fonts/';
  } catch {
    return undefined;
  }
})();

/**
 * Parse a page-range string ("1-12,15,18-22") into a sorted, deduplicated,
 * in-bounds page list. Empty/undefined = all pages.
 */
export function parsePageRange(totalPages: number, range?: string): number[] {
  if (!range || range.trim() === '') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  for (const part of range.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = Math.max(1, parseInt(startStr?.trim() ?? '', 10));
      const end = Math.min(totalPages, parseInt(endStr?.trim() ?? '', 10));
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      for (let i = start; i <= end; i += 1) pages.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= totalPages) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Compact page list for prompts/logs: [1,2,3,7] -> "1-3, 7". */
export function formatPageList(pages: number[]): string {
  if (pages.length === 0) return '(none)';
  const parts: string[] = [];
  let start = pages[0] ?? 1;
  let prev = start;
  for (let i = 1; i <= pages.length; i += 1) {
    const p = pages[i];
    if (p !== undefined && p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (p !== undefined) {
      start = p;
      prev = p;
    }
  }
  return parts.join(', ');
}

/** Extract per-page text (with page markers) from a PDF. */
export async function loadPdfDocument(pdfPath: string): Promise<PdfDocumentInfo> {
  const buffer = await fs.readFile(path.resolve(pdfPath));
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise;
  try {
    const pages: PdfPage[] = [];
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ page: i, text: pageText });
      parts.push(`--- Page ${i} ---\n${pageText}`);
      page.cleanup();
    }
    return {
      path: path.resolve(pdfPath),
      totalPages: doc.numPages,
      pages,
      text: parts.join('\n\n'),
    };
  } finally {
    await doc.cleanup();
  }
}

/** The `--- Page N ---`-marked text of the given pages (a subset of the doc). */
export function getPagesText(doc: PdfDocumentInfo, pages: number[]): string {
  const wanted = new Set(pages);
  return doc.pages
    .filter((p) => wanted.has(p.page))
    .map((p) => `--- Page ${p.page} ---\n${p.text}`)
    .join('\n\n');
}

/** Text of a single page ('' when out of bounds). */
export function getPageText(doc: PdfDocumentInfo, pageNumber: number): string {
  return doc.pages.find((p) => p.page === pageNumber)?.text ?? '';
}

/**
 * Render pages to images (returned as base64, never written to disk —
 * they exist only to be sent to the agent as image content blocks).
 */
export async function renderPdfPageImages(
  pdfPath: string,
  pageNumbers: number[],
  render: PdfRenderConfig,
): Promise<RenderedPageImage[]> {
  const buffer = await fs.readFile(path.resolve(pdfPath));
  const converter = new PdfConverter({ dpi: render.dpi, format: render.format });
  const out: RenderedPageImage[] = [];
  for (const pageNumber of pageNumbers) {
    const result = await converter.convertPage(buffer, pageNumber, {
      format: render.format,
      dpi: render.dpi,
      quality: render.quality,
    });
    out.push({
      pageNumber,
      base64: Buffer.from(result.buffer).toString('base64'),
      mimeType: render.format === 'png' ? 'image/png' : 'image/jpeg',
      width: result.width ?? 0,
      height: result.height ?? 0,
    });
  }
  return out;
}
