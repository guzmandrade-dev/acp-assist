/**
 * Express API + session orchestration for the ONLYOFFICE ACP companion.
 *
 * Same architecture as the LibreOffice app: one session = one editor
 * connection + one ACP agent; every read and write goes through the
 * in-editor plugin bridge (bridge-plugin/), which is deliberately dumb.
 * The transport direction is inverted from LO (AGENTS.md rule 1): the
 * plugin connects OUT to this companion, so the PluginBridge hosts the
 * plugin-facing endpoints on THIS app instead of discovering them.
 *
 * v1 scope: Writer documents (the plugin detects the editor type and
 * the backend blocks non-Writer documents with a clear message); one
 * active document per session (conversation keyed UNSAVED — the plugin
 * sandbox cannot read the file path).
 *
 * The session lifecycle, shared routes, and the multi-action message
 * loop live in core `createCompanionServer`; this file is the app's
 * `CompanionBackend`.
 */

import express from 'express';
import {
  actionTagNote,
  buildAttachmentBlock,
  createAttachmentExtractor,
  createLogError,
  createParseActionTag,
  createWrap,
  createCompanionServer,
  MAX_ACTIONS_PER_MESSAGE,
  UNSAVED_KEY,
  formatHistoryReplay as coreFormatHistoryReplay,
  type AppliedResult,
  type CompanionBackend,
  type CompanionSession,
  type ReadStepResult,
  type AgentSettings,
  type AgentRunner,
  type Attachment,
  type Turn,
  type TurnMeta,
} from '@acp-assist/core';
import { panelPublicDir, type PanelConfig } from '@acp-assist/panel';
import { PluginBridge, BridgeError, type WriterDocument } from './bridge/plugin-bridge.js';
import { writerAdapter, type WriterOutcome } from './modules/writer.js';
import { extractContentBlock, parseContentBlock } from './modules/markdown.js';
import { TIMINGS } from './timings.js';

export type {
  AgentSettings,
  Turn,
  TurnMeta,
  AgentRunner,
  Attachment,
} from '@acp-assist/core';

export interface ServerOptions {
  /** The SHARED panel package's public dir (defaults to panelPublicDir()). */
  publicDir?: string;
  /** Per-app asset overrides served BEFORE the shared panel dir. */
  assetsDir?: string;
  /** Panel config injected into the served index.html. */
  panelConfig: PanelConfig;
  historyDir?: string;
  attachmentsDir?: string;
  logDir?: string;
  settingsDir?: string;
  /** API bearer token. Generated at boot when absent. */
  apiToken?: string;
  /** Idle-session GC; see createCompanionServer. */
  sessionIdleMs?: number;
  /** Test hook: inject a fake plugin bridge instead of the real one. */
  pluginBridge?: PluginBridge;
}

/** One step's data: ONE plugin `context` read serves the whole step. */
interface OoStepData {
  doc: WriterDocument;
  styles?: (string | null)[];
  contextText: string;
  selection: { hasSelection: boolean; text: string | null };
}

export function createServer(options: ServerOptions & {
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
}) {
  const bridge = options.pluginBridge ?? new PluginBridge();
  const app = createCompanionServer({
    panelConfig: options.panelConfig,
    publicDir: options.publicDir ?? panelPublicDir(),
    assetsDir: options.assetsDir,
    historyDir: options.historyDir,
    attachmentsDir: options.attachmentsDir,
    logDir: options.logDir,
    settingsDir: options.settingsDir,
    apiToken: options.apiToken,
    sessionIdleMs: options.sessionIdleMs,
    extractText: extractAttachmentText,
    backend: createOoBackend(bridge, options),
    agentFactory: options.agentFactory,
    // The plugin's long-poll endpoints sit BEFORE the auth guard: the
    // in-editor plugin is a file:// iframe with no secret delivery
    // channel, so it cannot hold the bearer token (v1 trade-off; the
    // server binds 127.0.0.1 only — see the core option's comment).
    preAuthRoutes: (expressApp) => bridge.register(expressApp),
  });
  return app;
}

/** The ONLYOFFICE backend: plugin bridge + the writer adapter. */
function createOoBackend(
  bridge: PluginBridge,
  options: ServerOptions,
): CompanionBackend<Record<string, never>, WriterOutcome> {
  const logError = createLogError(options.logDir);
  void logError; // reserved for future app-level error logging

  return {
    acp: { appName: 'onlyoffice-acp-assist', writerName: 'ONLYOFFICE' },
    mapStatus: (err) => (err instanceof BridgeError ? 503 : 500),
    promptTimeoutMs: TIMINGS.promptTimeoutMs,
    replayOptions: OO_REPLAY_OPTIONS,

    async createSessionState() {
      return {};
    },

    conversationKey() {
      // v1: one active document; the plugin sandbox cannot read the
      // file path, so history lives under the shared UNSAVED key.
      return UNSAVED_KEY;
    },

    async statusSummary() {
      return { bridgeAvailable: bridge.isConnected() };
    },

    async documents() {
      return { active: UNSAVED_KEY, documents: [] };
    },

    async switchDocument() {
      // v1: a single document per session; switching is a no-op.
      return { active: UNSAVED_KEY, documents: [] };
    },

    async selection() {
      const sel = await bridge.op<{ selectionType: string; selectedText: string }>('selection');
      const text = sel.selectedText.trim() ? sel.selectedText.replace(/\r+/g, '') : null;
      const words = text ? text.trim().split(/\s+/).length : 0;
      return {
        hasSelection: sel.selectionType === 'text' && text !== null,
        text,
        stats: [words],
      };
    },

    async undo() {
      try {
        const r = await bridge.op<{ undone?: boolean; reason?: string; error?: string }>('undo');
        if (r.undone) return { ok: true };
        // The plugin's undo probe failed (no API route in this editor
        // version): degrade to the always-works manual hint.
        return {
          ok: false,
          reason: 'Undo is not available — use Ctrl+Z in ONLYOFFICE (each edit is one undo step).',
        };
      } catch (e) {
        return {
          ok: false,
          reason:
            e instanceof BridgeError && !bridge.isConnected()
              ? 'editor not connected'
              : 'Undo is not available — use Ctrl+Z in ONLYOFFICE (each edit is one undo step).',
        };
      }
    },

    async sessionInfo(session, opts) {
      let outline = '';
      if (opts.outline && bridge.isConnected()) {
        try {
          const doc = await bridge.op<WriterDocument>('context');
          if (doc.editor === 'word') {
            outline = doc.texts
              .map((text, i) => `[p${i + 1}] ${text}`)
              .join('\n');
          }
        } catch {
          /* plugin between polls; report what we have */
        }
      }
      const conversation: Turn[] = session.conversations.get(UNSAVED_KEY) ?? [];
      return {
        sessionId: session.id,
        documentPath: UNSAVED_KEY,
        documents: [],
        layout: null,
        outline,
        conversation,
      };
    },

    async readStep(_session): Promise<ReadStepResult<OoStepData>> {
      const doc = await bridge.op<WriterDocument>('context');
      if (doc.editor !== 'word') {
        return {
          blocked: {
            status: 400,
            body: {
              error:
                `This version supports ONLY Writer documents; the active editor ` +
                `is "${doc.editor}". Please open a text document.`,
            },
          },
        };
      }
      const sel = doc.selection;
      const selection = {
        hasSelection: sel.selectionType === 'text' && sel.selectedText.trim().length > 0,
        text: sel.selectedText.trim() ? sel.selectedText.replace(/\r+/g, '') : null,
      };
      return {
        data: {
          doc,
          styles: doc.styles,
          contextText: writerAdapter.buildContextBlock(doc, doc.styles),
          selection,
        },
      };
    },

    async buildAutoPrompt(_session, stepData, message, attachments, historyPrefix) {
      const s = stepData as OoStepData;
      return buildAutoPrompt(s.contextText, s.selection, message, attachments, historyPrefix);
    },

    async buildContinuationPrompt(_session, stepData, originalMessage, completed) {
      const s = stepData as OoStepData;
      return buildContinuationPrompt(s.contextText, s.selection, originalMessage, completed);
    },

    parseAction(_session, reply): WriterOutcome {
      return parseAction(reply);
    },

    async applyAction(_session, outcome, stepData): Promise<AppliedResult> {
      const s = stepData as OoStepData;
      const description = await writerAdapter.applyAction(bridge, s.doc, s.selection.hasSelection, outcome);
      return { ok: true, description, target: outcome.target };
    },

    frame(_session, ctx) {
      const outcome = ctx.outcome;
      const step = ctx.step;
      const stepField = step > 1 ? { step } : {};
      switch (ctx.kind) {
        case 'none':
          return {
            action: 'none',
            ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}),
            ...stepField,
          };
        case 'applied':
          return {
            applied: outcome.action,
            target: outcome.target,
            module: 'writer',
            ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}),
            ...stepField,
          };
        case 'appliedStep':
          return {
            appliedStep: step,
            action: outcome.action,
            target: ctx.applied?.target ?? outcome.target,
          };
        default:
          return null;
      }
    },

    metaExtras(_session, outcome) {
      return { module: 'writer' };
    },

    watchEvents(_session, push) {
      return bridge.onEvent(push);
    },
  };
}

export function notConnectedError() {
  return new BridgeError(
    'ONLYOFFICE editor not connected. Open the ACP Assist Bridge plugin from ' +
      'the editor\u2019s Plugins tab (it must stay open while you chat).',
  );
}

// --- action parsing -----------------------------------------------------------

/** Writer grammar: [ACTION: name] or [ACTION: name pN] + ```writer block. */
const parseTag = createParseActionTag({
  actions: 'delete-at|rewrite-at|insert-after|insert-top|rewrite|insert|none|continue',
  targetPattern: '(?:\\s+p(\\d+))?',
});

export function parseAction(reply: string): WriterOutcome {
  const tag = parseTag(reply);
  const action = tag.action as WriterOutcome['action'];
  const target = tag.target !== null ? Number.parseInt(tag.target, 10) : null;
  const contentActions: string[] = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply) : null;
  return {
    action,
    target,
    block: needsContent ? (rawBlock !== null ? parseContentBlock(rawBlock) : null) : null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${target !== null ? ` p${target}` : ''}]`),
  };
}

// --- prompt building ------------------------------------------------------------

const CHAT_KNOWLEDGE = [
  'ADDRESSING AND EDITS',
  '- Edits are applied to the LIVE document. ONLYOFFICE Writer has no',
  '  change tracking: each edit is a single undo step the user can revert',
  '  with Ctrl+Z in the editor.',
  '- Content for actions goes in ONE fenced content block: ```writer.',
].join('\n');

export function buildAutoPrompt(
  contextText: string,
  selection: { hasSelection: boolean; text: string | null },
  message: string,
  attachments: Attachment[] = [],
  historyPrefix = '',
): string {
  const parts: string[] = [
    'You are assisting an author writing a document in ONLYOFFICE. Your ' +
      'reply is shown in a chat panel, and you can also write content ' +
      'directly into the live ONLYOFFICE document.',
    '',
    writerAdapter.buildActionInstructions(),
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection && selection.text) {
    parts.push(
      '',
      'Current selection (the user may ask you to rewrite it):',
      '```text',
      selection.text,
      '```',
    );
  }
  if (historyPrefix) parts.push(historyPrefix);
  parts.push('', 'User message:', message);
  parts.push(...buildAttachmentBlock(attachments));
  return parts.join('\n');
}

export function buildContinuationPrompt(
  contextText: string,
  selection: { hasSelection: boolean; text: string | null },
  originalMessage: string,
  completed: string[],
): string {
  const parts = [
    'You are continuing the SAME user request after one edit was applied ' +
      'to the live ONLYOFFICE document. The document context below is ' +
      'FRESH: paragraph addresses ([pN]) may have shifted because of the edit.',
    '',
    'Original user request:', originalMessage,
    '',
    'Edits already applied (do not repeat them):',
    ...completed.map((entry) => `- ${entry}`),
    '',
    'If the request needs MORE edits, END your reply with exactly one ' +
      'document action tag from the action list on its own last line, and ' +
      'include the content block when the action needs content.',
    'If the request is now complete, reply in prose only and end with [ACTION: none].',
    'If you are not sure whether more edits remain, ask one short question ' +
      'with [ACTION: none] instead of guessing.',
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      'edits per user message; if that limit is reached it stops and tells ' +
      'the user, who can ask you to continue in a follow-up message.',
    '',
    writerAdapter.buildActionInstructions(),
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection && selection.text) {
    parts.push(
      '',
      'Current selection (the user may ask you to rewrite it):',
      '```text',
      selection.text,
      '```',
    );
  }
  return parts.join('\n');
}

/** Replay rendering shared by the history wrapper and the conversation store. */
export const OO_REPLAY_OPTIONS = {
  blockPattern: /```writer[\s\S]*?```/g,
  describeTarget: (m: TurnMeta) => (m.target ? ` p${m.target}` : ''),
};

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  return coreFormatHistoryReplay(turns, unseen, OO_REPLAY_OPTIONS);
}

// --- attachments -----------------------------------------------------------------

/** Extensions the app can read as text directly (no converter needed). */
const extractAttachmentText = createAttachmentExtractor({
  extensions: [
    'txt', 'md', 'markdown', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'json',
    'xml', 'bib', 'log', 'htm', 'html', 'yaml', 'yml', 'py', 'js', 'ts',
  ],
  envVar: 'OO_MARKITDOWN',
});