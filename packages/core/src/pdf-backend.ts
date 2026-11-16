/**
 * The PDF-review mode's companion backend (the unified app's fourth
 * switcher entry, "PDF Review"). The "document" is a read-only PDF:
 *
 * - conversation history is keyed by the active PDF's absolute path
 *   (same mechanism as the editor apps keying by document path), so the
 *   question → suggestion → repeat loop persists per PDF across restarts;
 * - chat is PROSE-ONLY: parseAction always reports "none", so nothing is
 *   ever written into the PDF — the agent answers with questions and
 *   suggestions the user applies in their real editor;
 * - the PDF can be opened in the user's own viewer (Open in viewer /
 *   jump-to-page routes) — see external-viewer.ts; SumatraPDF is used
 *   for page jumps when detected, otherwise the OS default viewer;
 * - the structured report itself is the shared POST /review route in
 *   companion.ts, whose "active document is a PDF" default is exactly
 *   this mode's active PDF.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PanelConfig } from '@acp-assist/panel';
import {
  UNSAVED_KEY,
  REVIEW_TEXT_LIMIT,
  buildAttachmentBlock,
  describeViewer,
  detectExternalViewer,
  loadPdfDocument,
  openPdfExternally,
  type CompanionBackend,
  type PdfDocumentInfo,
} from './index.js';

export interface PdfBackendState {
  /** PDFs opened in this session. */
  pdfs: string[];
  /** The active PDF (conversation key), null until one is opened. */
  activePdf: string | null;
  /** Per-session page-aware text cache, keyed by absolute path. */
  docCache: Map<string, PdfDocumentInfo>;
}

export interface PdfBackendOptions {
  /**
   * Attachment extensions read as plain text when attached for context
   * (e.g. the .tex source next to the compiled PDF); everything else
   * goes through the app's markitdown converter chain.
   */
  textualExtensions?: readonly string[];
  /**
   * Injected into the external-viewer detection/opening (tests pass a
   * fake spawn so no real viewer is launched).
   */
  viewerDeps?: import('./external-viewer.js').ViewerDeps;
}

/** Panel config for the PDF-review mode (unified app's pdf entry). */
export const PDF_PANEL_CONFIG: PanelConfig = {
  appName: 'PDF',
  appTitle: 'PDF Review — ACP Assist',
  fenceRe: 'pdf',
  statusKey: 'pdfMode',
  statusMissing: 'PDF mode needs no editor',
  cursorTerm: 'page',
  hasSaveConsent: false,
  hasInstallFlow: false,
  composerRefreshSelection: false,
  busyText: 'reading the PDF…',
  eventPush: false,
  theme: null,
  pdfMode: true,
};

export function createPdfBackend(options: PdfBackendOptions = {}): CompanionBackend<PdfBackendState> {
  const viewerDeps = options.viewerDeps;
  /** All PDFs this session knows about (opened this session + persisted history). */
  function allPdfs(session: { state: PdfBackendState; knownDocuments: Set<string> }): string[] {
    return [...new Set([...session.state.pdfs, ...session.knownDocuments])].filter((p) => /\.pdf$/i.test(p));
  }

  function documentList(session: { state: PdfBackendState; knownDocuments: Set<string> }) {
    return {
      active: session.state.activePdf,
      versionControlled: null,
      documents: allPdfs(session),
    };
  }

  async function docFor(
    session: { state: PdfBackendState },
    pdfPath: string,
  ): Promise<PdfDocumentInfo> {
    const cached = session.state.docCache.get(pdfPath);
    if (cached) return cached;
    const doc = await loadPdfDocument(pdfPath);
    session.state.docCache.set(pdfPath, doc);
    return doc;
  }

  return {
    acp: { appName: 'pdf-acp-assist', writerName: 'the PDF' },
    mapStatus: (err) =>
      /unknown session/i.test(err instanceof Error ? err.message : String(err)) ? 404 : 500,
    promptTimeoutMs: 300_000,

    async createSessionState() {
      return { pdfs: [], activePdf: null, docCache: new Map() };
    },

    conversationKey(session) {
      return session.state.activePdf ?? UNSAVED_KEY;
    },

    replayOptions: { blockPattern: /```[a-z-]*[\s\S]*?```/gi },

    async statusSummary() {
      return { pdfMode: true, viewer: describeViewer(detectExternalViewer(viewerDeps)) };
    },

    async documents(session) {
      if (session.state.activePdf) await session.ensureConversation(session.state.activePdf);
      return documentList(session);
    },

    async switchDocument(session, target) {
      if (!/\.pdf$/i.test(target)) throw new Error('PDF mode opens only .pdf files.');
      const resolved = path.resolve(target);
      await fs.access(resolved).catch(() => {
        throw new Error(`No such file: ${resolved}`);
      });
      if (!session.state.pdfs.includes(resolved)) session.state.pdfs.push(resolved);
      session.knownDocuments.add(resolved);
      session.state.activePdf = resolved;
      await session.ensureConversation(resolved);
      return documentList(session);
    },

    async selection() {
      return { hasSelection: false };
    },

    async undo() {
      return {
        ok: false,
        error: 'PDF mode is read-only — the PDF is never edited, so there is nothing to undo.',
        description: '',
      };
    },

    async sessionInfo(session, opts) {
      const active = session.state.activePdf;
      const key = active ?? UNSAVED_KEY;
      if (active) await session.ensureConversation(key);
      let outline = '';
      if (active && opts.outline) {
        const doc = await docFor(session, active);
        outline = `PDF document, ${doc.totalPages} pages.`;
      }
      return {
        sessionId: session.id,
        documentPath: active,
        documents: allPdfs(session),
        versionControlled: null,
        outline,
        conversation: session.conversations.get(key) ?? [],
      };
    },

    async readStep(session) {
      const active = session.state.activePdf;
      // PDF mode has no "unsaved document" concept: chat is per-PDF, so a
      // message before any PDF is opened is refused with a clear hint.
      if (!active) {
        return {
          blocked: {
            status: 400,
            body: {
              error:
                'Open a PDF first — attach one with + or give a path. ' +
                'PDF Review chat is keyed by the PDF, one conversation per file.',
            },
          },
        };
      }
      const doc = await docFor(session, active);
      return { data: { doc } };
    },

    async buildAutoPrompt(session, stepData, message, attachments, historyPrefix) {
      const { doc } = stepData as { doc: PdfDocumentInfo | null };
      const parts: string[] = [];
      if (doc) {
        parts.push(
          `You are discussing the PDF document at "${doc.path}" (${doc.totalPages} pages).`,
        );
        parts.push(
          'The PDF is read-only: answer in prose with questions and suggestions — ' +
            'never emit an action tag; the user applies any changes in their own editor.',
        );
        if (historyPrefix) parts.push(historyPrefix);
        let text = doc.text;
        if (text.length > REVIEW_TEXT_LIMIT) {
          text = `${text.slice(0, REVIEW_TEXT_LIMIT)}\n\n[TRUNCATED]`;
        }
        parts.push(`Full text of the PDF (page-marked):\n${text}`);
      } else {
        parts.push(
          'No PDF is open in this session yet. Open one with the + button (attach a PDF) ' +
            'or by path, then ask your question.',
        );
        if (historyPrefix) parts.push(historyPrefix);
      }
      parts.push(...buildAttachmentBlock(attachments));
      parts.push(`User message:\n${message}`);
      return parts.join('\n\n');
    },

    async buildContinuationPrompt(_session, _stepData, originalMessage) {
      return originalMessage;
    },

    /** Prose-only mode: every reply is a chat answer, never a document action. */
    parseAction: () => ({ action: 'none' }),

    async applyAction() {
      return { ok: false, error: 'PDF mode is prose-only; the PDF is never edited.', description: '' };
    },
  };
}

/**
 * The PDF mode's app-only routes, for CompanionServerOptions.extraRoutes:
 * open a PDF as the active document, open a session PDF in the external
 * viewer, and jump to a page in it.
 */
export function createPdfExtraRoutes(viewerDeps?: import('./external-viewer.js').ViewerDeps): (
  app: import('express').Express,
  ctx: {
    wrap: import('./settings.js').WrapFn;
    getSession: (id: string | string[] | undefined) => import('./companion.js').CompanionSession<PdfBackendState>;
  },
) => void {
  return (app, { wrap, getSession }) => {
    /** Open a PDF (by path or as an uploaded attachment) as the active document. */
    app.post(
      '/api/session/:id/pdf/open',
      wrap(async (req, res) => {
        const session = getSession(req.params['id']);
        const body = (req.body ?? {}) as { path?: string; attachmentId?: string };
        let pdfPath: string | null = null;
        if (typeof body.attachmentId === 'string' && body.attachmentId) {
          const att = session.attachments.find((a) => a.id === body.attachmentId);
          if (!att || !/\.pdf$/i.test(att.name)) {
            res.status(400).json({ error: 'Unknown PDF attachment.' });
            return;
          }
          pdfPath = att.path;
        } else if (typeof body.path === 'string' && body.path.trim()) {
          pdfPath = path.resolve(body.path.trim());
        } else {
          res.status(400).json({ error: 'path or attachmentId is required.' });
          return;
        }
        const target = pdfPath;
        if (!/\.pdf$/i.test(target)) {
          res.status(400).json({ error: 'Only .pdf files can be opened in PDF mode.' });
          return;
        }
        await fs.access(target).catch(() => {
          throw new Error(`No such file: ${target}`);
        });
        const resolved = path.resolve(target);
        if (!session.state.pdfs.includes(resolved)) session.state.pdfs.push(resolved);
        session.knownDocuments.add(resolved);
        session.state.activePdf = resolved;
        await session.ensureConversation(resolved);
        res.json({
          active: session.state.activePdf,
          versionControlled: null,
          documents: [...new Set([...session.state.pdfs, ...session.knownDocuments])].filter((p) => /\.pdf$/i.test(p)),
        });
      }),
    );

    /**
     * Open a PDF of this session in the user's external viewer
     * (SumatraPDF when detected — with -page when given — else the OS
     * default). The path is validated against the session's known PDFs
     * so the panel cannot be used to open arbitrary files.
     */
    app.post(
      '/api/session/:id/open-external',
      wrap(async (req, res) => {
        const session = getSession(req.params['id']);
        const body = (req.body ?? {}) as { path?: string; page?: number };
        const target =
          typeof body.path === 'string' && body.path.trim()
            ? path.resolve(body.path.trim())
            : session.state.activePdf;
        if (!target) {
          res.status(400).json({ error: 'No PDF is active.' });
          return;
        }
        const allowed = new Set([
          ...[...session.state.pdfs, ...session.knownDocuments].filter((p) => /\.pdf$/i.test(p)),
          ...session.attachments.map((a) => a.path),
        ]);
        if (!allowed.has(target)) {
          res.status(400).json({ error: 'Refusing to open a path that is not a known PDF of this session.' });
          return;
        }
        const page = Number.isInteger(body.page) && (body.page as number) >= 1 ? (body.page as number) : undefined;
        const { viewer } = await openPdfExternally(target, page, viewerDeps ?? {});
        res.json({ ok: true, viewer: describeViewer(viewer), path: target, page: page ?? null });
      }),
    );

    /** Jump to a page of the active PDF in the external viewer. */
    app.post(
      '/api/session/:id/jump',
      wrap(async (req, res) => {
        const session = getSession(req.params['id']);
        const active = session.state.activePdf;
        if (!active) {
          res.status(400).json({ error: 'No PDF is active.' });
          return;
        }
        const page = Number((req.body ?? {}).page);
        if (!Number.isInteger(page) || page < 1) {
          res.status(400).json({ error: 'page must be a positive integer.' });
          return;
        }
        const { viewer } = await openPdfExternally(active, page, viewerDeps ?? {});
        res.json({ ok: true, viewer: describeViewer(viewer), page });
      }),
    );
  };
}
