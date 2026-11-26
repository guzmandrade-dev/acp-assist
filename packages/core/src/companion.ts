/**
 * The unified companion server: ONE server in core owning the session
 * core owning the session lifecycle, the shared routes, and the
 * multi-action message loop. Each app injects a `CompanionBackend` that
 * carries its document-source specifics (bridge vs pipe, module adapters
 * vs paste choreographies); the app vocabularies become backend methods.
 *
 * The SSE frame protocol ({"text"}, {"thought"}, {"tool"}, {"applied"},
 * {"appliedStep"}, {"stopped"}, {"done"}, {"cancelled"}, {"error"},
 * {"tagNote"}), the
 * MAX_ACTIONS_PER_MESSAGE multi-action orchestration, cancel handling,
 * the conversation store + history replay, and the idle-session GC (B2)
 * are IDENTICAL across the apps and live here once.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {
  AcpClient,
  createAgentSettings,
  createConversationStore,
  createLogError,
  createWrap,
  hashContextBlock,
  listConversations,
  listKnownDocuments,
  loadHistory,
  promoteConversation,
  registerAttachmentRoutes,
  registerSessionRoutes,
  sseFail,
  startSse,
  createApiAuthGuard,
  generateApiToken,
  effectiveMaxActionsPerMessage,
  buildReviewZip,
  formatPageList,
  formatReviewForHistory,
  generateBatchedReview,
  getPageText,
  loadPdfDocumentVersioned,
  parsePageRange,
  renderPdfPageImages,
  REVIEW_IMAGE_RENDER,
  REVIEW_TIMEOUT_MS,
  MAX_REVIEW_IMAGE_PAGES,
  type AgentRunner,
  type AgentSettings,
  type Attachment,
  type ConversationStore,
  type HistoryReplayOptions,
  type Review,
  type Turn,
  type TurnMeta,
  type VersionedPdfDocument,
  type WrapFn,
} from './index.js';
import { createPanelBootScript, createPanelIndexHandler, panelPublicDir, type PanelConfig } from '@acp-assist/panel';

/**
 * Per-session bookkeeping owned by the core server. The backend's own
 * per-session data (pipe client, clipboard, bridge, ...) lives in
 * `state` and is opaque to the core.
 */
export interface CompanionSession<TState = unknown> {
  id: string;
  agent: AgentRunner;
  state: TState;
  /** Conversation history per document key. */
  conversations: Map<string, Turn[]>;
  /** Per key: leading persisted turns the fresh agent process has NOT seen. */
  historyHandoff: Map<string, number>;
  /** All document keys seen during this session (for the selector). */
  knownDocuments: Set<string>;
  /** Set when the client asks to stop the current generation. */
  cancelRequested: boolean;
  /** Files waiting to be included with the next message. */
  attachments: Attachment[];
  /** Last request/SSE-frame time; drives the idle-session GC. */
  lastActive: number;
  /**
   * Hash of the context block (see CompanionBackend.contextBlock) last sent
   * to the agent in this session. When a step-1 prompt's block hashes to
   * the same value, the block is omitted (BuildPromptOptions.contextOmitted)
   * and the agent is told to refer to the earlier copy — the ACP session
   * retains it, so re-sending identical bytes every message only inflates
   * context and latency. Cleared when the agent compacts its context (a
   * sharp drop in usage `used`) and on new sessions, forcing a re-send.
   */
  sentContextHash?: string;
  /** Last usage_update `used` value; watches for agent-side compaction. */
  lastUsageUsed?: number;
  /**
   * Ensure (eagerly load persisted history for) a conversation key. The
   * backends call this from their active-document refresh bookkeeping —
   * the conversation map must hold the loaded turns BEFORE sessionInfo
   * reports them.
   */
  ensureConversation: (key: string) => Promise<Turn[]>;
  /**
   * Move a conversation between keys (LyX save-as: the unsaved placeholder
   * buffer got a real path). Moves the in-memory turns, the handoff
   * counter, and the persisted history file; never clobbers an existing
   * target conversation.
   */
  migrateConversation: (fromKey: string, toKey: string) => Promise<void>;
}

/** What the backend's parsed action must at least carry. */
export interface ParsedActionBase {
  action: string;
  target?: number | null;
  tagNote?: string | null;
}

/** Result of one applied (or failed) document action. */
export interface AppliedResult {
  ok: boolean;
  /** Error text sent as an {"error"} frame when !ok. */
  error?: string;
  /** Compact entry for the continuation prompt's "Edits already applied". */
  description: string;
  /** The action's ACTUAL target when the choreography adjusted it. */
  target?: number | null;
  /** LyX merge/move second target. */
  target2?: number | null;
}

/** One step's backend data (document read, context, selection, adapter). */
export interface StepData<TApp = unknown> {
  data: TApp;
}

/** readStep outcome: a mid-message refusal, or the step's data. */
export type ReadStepResult<TApp = unknown> =
  | { blocked: { status: number; body: unknown } }
  | { blocked?: undefined } & StepData<TApp>;

export type FrameKind = 'afterParse' | 'none' | 'applied' | 'appliedStep';

/** Extra step-1 prompt inputs from the core message loop. */
export interface BuildPromptOptions {
  /**
   * True when the step's big context block (CompanionBackend.contextBlock)
   * is byte-identical to the one sent earlier in this session: embed a
   * short "unchanged — refer to it above" note (contextOmittedNote)
   * instead of the full block.
   */
  contextOmitted?: boolean;
}

export interface FrameContext<TOutcome extends ParsedActionBase = ParsedActionBase> {
  kind: FrameKind;
  outcome: TOutcome;
  /** Only for 'applied' / 'appliedStep'. */
  applied?: AppliedResult;
  /** The step's data (app-typed; the backend casts). */
  stepData: unknown;
  step: number;
}

/**
 * The per-app backend contract (informed by the LO app's ModuleAdapter):
 * everything document-source specific the unified server needs. App
 * vocabularies (writer/calc/impress, lyx insert/merge/move) become
 * parseAction/applyAction implementations.
 */
export interface CompanionBackend<
  TState = unknown,
  TOutcome extends ParsedActionBase = ParsedActionBase,
> {
  /** ACP identity for the default agent client (test factories bypass it). */
  acp: { appName: string; writerName: string };
  /** Error → HTTP status (transport errors → 503). */
  mapStatus: (err: unknown) => number;
  /** Prompt timeout budget (per-app timings). */
  promptTimeoutMs: number;

  // --- per-session lifecycle -------------------------------------------------
  /**
   * Create (and start) the app's per-session state: the LyX pipe client
   * (with write-only fallbacks), the healing bridge, the clipboard adapter.
   * `session.id` / `session.knownDocuments` are already populated — LyX's
   * write-only fallbacks capture the known-documents set by reference.
   */
  createSessionState(session: { id: string; knownDocuments: Set<string> }): Promise<TState>;
  /** Per-session teardown (pipe bye / bridge cleanup) before agent stop. */
  teardownSession?(state: TState): void;
  /** Conversation key for the active document (UNSAVED_KEY when none). */
  conversationKey(session: CompanionSession<TState>): string;
  /** History replay rendering (block pattern + target suffix). */
  replayOptions: HistoryReplayOptions;

  // --- status / documents ----------------------------------------------------
  /** GET /api/status body (e.g. { bridgeAvailable } / { lyxPipeAvailable }). */
  statusSummary(): Promise<Record<string, unknown>>;
  /** GET /api/session/:id/documents body (refreshes the active document). */
  documents(session: CompanionSession<TState>): Promise<Record<string, unknown>>;
  /** POST documents/switch body; `path` is validated by the route. */
  switchDocument(session: CompanionSession<TState>, path: string): Promise<Record<string, unknown>>;

  // --- selection / undo / info -------------------------------------------------
  /** GET selection body. */
  selection(session: CompanionSession<TState>): Promise<unknown>;
  /** POST undo body. */
  undo(session: CompanionSession<TState>): Promise<unknown>;
  /** GET session body (`outline` only for first-connect / ?outline=1). */
  sessionInfo(session: CompanionSession<TState>, opts: { outline?: boolean }): Promise<unknown>;

  // --- the message loop ---------------------------------------------------------
  /**
   * Read everything ONE step needs: refresh the active document, run any
   * message gate (LyX save-consent → `blocked`), sync the document (LyX
   * save), snapshot the clipboard (B4), and build context + selection.
   * Called once per step; the returned data is opaque to the core.
   */
  readStep(session: CompanionSession<TState>, step: number): Promise<ReadStepResult>;
  /**
   * The big re-sendable context block of a step (editors: the outline
   * `contextText`; PDF mode: the page-marked full text), or null when the
   * backend has nothing worth deduplicating. The core loop hashes it per
   * step; when a step-1 block matches the hash last sent in this session
   * (and the agent has not compacted since), the block is omitted from the
   * prompt via BuildPromptOptions.contextOmitted. Continuation steps
   * (step > 1) always get the fresh block — addresses shift after edits.
   */
  contextBlock?(stepData: unknown): string | null;
  /** The step-1 prompt. `maxActions` = the effective edits-per-message limit. */
  buildAutoPrompt(
    session: CompanionSession<TState>,
    stepData: unknown,
    message: string,
    attachments: Attachment[],
    historyPrefix: string,
    maxActions: number,
    opts?: BuildPromptOptions,
  ): Promise<string>;
  /** Continuation prompts for steps > 1 (fresh context after each edit). */
  buildContinuationPrompt(
    session: CompanionSession<TState>,
    stepData: unknown,
    originalMessage: string,
    completed: string[],
    maxActions: number,
  ): Promise<string>;
  /** Parse one reply against the app's action vocabulary. */
  parseAction(session: CompanionSession<TState>, reply: string, stepData: unknown): TOutcome;
  /**
   * LyX-only markup step: validate the ```lyx markup and, when it has
   * problems, prompt the agent once with a corrective retry. Returns the
   * reply to record (the retried one when a retry ran).
   */
  retryReply?(
    session: CompanionSession<TState>,
    outcome: TOutcome,
    reply: string,
    send: (obj: unknown) => void,
    step: number,
  ): Promise<string>;
  /** Apply one parsed action. Throw or return {ok:false} on failure. */
  applyAction(
    session: CompanionSession<TState>,
    outcome: TOutcome,
    stepData: unknown,
    step: number,
  ): Promise<AppliedResult>;
  /**
   * App-shaped SSE frames. `null`/undefined = no frame. afterParse: LyX
   * tagNote. none: [ACTION: none]. applied: the edit landed (LO includes
   * module/address/tagNote; LyX the adjusted target/target2).
   * appliedStep: between edits.
   */
  frame?(
    session: CompanionSession<TState>,
    ctx: FrameContext<TOutcome>,
  ): Record<string, unknown> | null | undefined;
  /** TurnMeta extras (LO: module/address; LyX: target2). `stepData` is
   *  absent on the error path, where the meta omits step-scoped fields. */
  metaExtras?(
    session: CompanionSession<TState>,
    outcome: TOutcome,
    stepData?: unknown,
  ): Record<string, unknown>;
  /**
   * End-of-run hook (LyX B4: restore the user's clipboard text; no-op
   * until the backend saved something). Called on success and — once a
   * turn was recorded — from the error path.
   */
  afterRun?(session: CompanionSession<TState>): Promise<void>;
  /**
   * Server-push watcher (the LO bridge's /events long-poll). The core
   * starts it once
   * per session and forwards every pushed frame to the panel over the
   * GET /api/session/:id/events SSE channel. Return the stop function;
   * it is called on session teardown (reconnect + idle GC). Apps without
   * push events (LyX: pipe polling) omit it.
   */
  watchEvents?(
    session: CompanionSession<TState>,
    push: (frame: Record<string, unknown>) => void,
  ): () => void;
}

export interface CompanionServerOptions<TState = unknown> {
  /** Panel config injected into the served index.html. */
  panelConfig: PanelConfig;
  /** The SHARED panel public dir (defaults to panelPublicDir()). */
  publicDir?: string;
  /** Per-app assets served BEFORE the shared panel dir (e.g. logo.svg). */
  assetsDir?: string;
  historyDir?: string;
  attachmentsDir?: string;
  logDir?: string;
  settingsDir?: string;
  /** API bearer token; generated at boot when absent. */
  apiToken?: string;
  /**
   * Idle-session GC: sessions with no activity for this long
   * are torn down (agent process + backend session state included) — an
   * F5 or crash-reload of the panel otherwise orphans them forever.
   * Default 30 minutes; the sweep interval is idleMs/10.
   */
  sessionIdleMs?: number;
  /** Attachment text extraction (the app's formats + env override). */
  extractText: (filePath: string, name: string) => Promise<string | null>;
  backend: CompanionBackend<TState>;
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /**
   * App-only routes (e.g. LyX save-consent), registered with the same
   * wrap and session lookup the core routes use.
   */
  extraRoutes?: (app: express.Express, ctx: {
    wrap: WrapFn;
    getSession: (id: string | string[] | undefined) => CompanionSession<TState>;
  }) => void;
  /**
   * Routes registered BEFORE the API auth guard (after the statics).
   * For endpoints whose clients cannot hold the bearer token — the
   * ONLYOFFICE in-editor plugin (a file:// iframe with no secret
   * delivery channel) connects OUT to /bridge/* long-polls. The server
   * binds 127.0.0.1 only; keep such routes strictly localhost-facing
   * and document why the guard must not apply.
   */
  preAuthRoutes?: (app: express.Express) => void;
}

export function createCompanionServer<TState>(
  options: CompanionServerOptions<TState>,
): express.Express {
  const backend = options.backend;
  const app = express();
  // API auth: random bearer token + loopback Host check; the
  // panel gets the token same-origin via the served index.html. Static
  // assets sit BEFORE the guard (not sensitive), all /api routes after.
  const apiToken = options.apiToken ?? generateApiToken();
  app.locals.apiToken = apiToken;
  const publicDir = options.publicDir ?? panelPublicDir();
  app.use(express.json({ limit: '5mb' }));
  app.get('/', createPanelIndexHandler(publicDir, { token: apiToken, config: options.panelConfig }));
  // CSP-safe boot script (external same-origin): carries the token +
  // panel config to the page.
  app.get('/panel-boot.js', createPanelBootScript({ token: apiToken, config: options.panelConfig }));
  if (options.assetsDir) {
    app.use(express.static(options.assetsDir, { maxAge: 0, etag: false, lastModified: false }));
  }
  app.use(express.static(publicDir, { maxAge: 0, etag: false, lastModified: false }));
  // App routes that live BEFORE the auth guard (see the option comment).
  options.preAuthRoutes?.(app);
  app.use(createApiAuthGuard(apiToken));

  const sessions = new Map<string, CompanionSession<TState>>();
  /** Push-event watchers per session id (stopped on teardown). */
  const eventWatchers = new Map<string, () => void>();
  /**
   * Panel subscribers of the per-session push channel. `end` closes the
   * SSE response so a torn-down session's panel reconnects and discovers
   * the session is gone (an open channel would otherwise sit unread until
   * the panel's next interaction).
   */
  interface EventSubscriber {
    send: (frame: unknown) => void;
    end: () => void;
  }
  const eventListeners = new Map<string, Set<EventSubscriber>>();
  const logError = createLogError(options.logDir);
  const wrap: WrapFn = createWrap({ logError, mapStatus: backend.mapStatus });

  /** Backend teardown + event-watcher stop, shared by DELETE and GC. */
  function teardownSession(session: CompanionSession<TState>): void {
    backend.teardownSession?.(session.state);
    eventWatchers.get(session.id)?.();
    eventWatchers.delete(session.id);
    // Close the panel's push channels so their fetch-stream loops
    // reconnect (and see the session is gone) instead of dangling open.
    for (const sub of eventListeners.get(session.id) ?? []) {
      try {
        sub.end();
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
    eventListeners.delete(session.id);
  }

  // Idle-session GC: F5 / crash-reload of the panel orphans the
  // running agent process + backend session state (only an explicit
  // Reconnect tears the old session down). Track per-request activity and
  // sweep idle sessions.
  const sessionIdleMs = options.sessionIdleMs ?? 30 * 60_000;
  app.use((req, _res, next) => {
    const m = /^\/api\/session\/([^/]+)/.exec(req.path);
    const session = m ? sessions.get(m[1] ?? '') : undefined;
    if (session) session.lastActive = Date.now();
    next();
  });
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActive < sessionIdleMs) continue;
      sessions.delete(id);
      try {
        teardownSession(session);
      } catch {
        /* best-effort */
      }
      session.agent.stop();
      logError('[gc] idle session torn down', new Error(`session ${id} idle > ${sessionIdleMs}ms`));
    }
  }, Math.max(1_000, Math.round(sessionIdleMs / 10)));
  sweeper.unref();

  function param(id: string | string[] | undefined): string {
    return Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
  }

  function getSession(id: string | string[] | undefined): CompanionSession<TState> {
    const session = sessions.get(param(id));
    if (!session) throw new Error('Unknown session');
    return session;
  }

  // --- status --------------------------------------------------------------

  app.get('/api/status', wrap(async (_req, res) => {
    res.json(await backend.statusSummary());
  }));

  // --- agent settings --------------------------------------------------------

  const agentSettings = createAgentSettings(options.settingsDir);
  agentSettings.register(app, wrap);

  // --- session ---------------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      // Defaults < persisted settings < explicit request body.
      const persisted = await agentSettings.read();
      const requested = req.body?.agent as Partial<AgentSettings> | undefined;
      const settings: AgentSettings = {
        command: requested?.command ?? persisted.command ?? 'vibe-acp',
        args: requested?.args ?? persisted.args ?? [],
        env: requested?.env ?? persisted.env ?? {},
      };
      const agent: AgentRunner = options.agentFactory
        ? options.agentFactory(settings)
        : new AcpClient({ ...settings, ...backend.acp });

      const id = randomUUID();
      const knownDocuments = new Set<string>();
      const state = await backend.createSessionState({ id, knownDocuments });
      await agent.start();

      const session: CompanionSession<TState> = {
        id,
        agent,
        state,
        conversations: new Map(),
        historyHandoff: new Map(),
        knownDocuments,
        cancelRequested: false,
        attachments: [],
        lastActive: Date.now(),
        ensureConversation: (docKey) => storeFor(session).ensure(docKey),
        migrateConversation: (fromKey, toKey) => storeFor(session).migrate(fromKey, toKey),
      };
      sessions.set(id, session);
      await agent.createSession(id);

      // Server-push watcher (the LO bridge /events
      // long-poll). Frames go to the panel's /events SSE channel.
      if (backend.watchEvents) {
        eventWatchers.set(
          id,
          backend.watchEvents(session, (frame) => {
            const listeners = eventListeners.get(id);
            if (!listeners) return;
            for (const sub of [...listeners]) {
              try {
                sub.send(frame);
              } catch {
                /* a dead subscriber must not break the others */
              }
            }
          }),
        );
      }

      // Seed the document selector with paths from previous sessions (LyX's
      // pipe has no "list buffers" LFUN; LO tracks urls as it goes).
      if (options.historyDir) {
        for (const docPath of await listKnownDocuments(options.historyDir)) {
          session.knownDocuments.add(docPath);
        }
      }

      // First connect: the panel shows an outline-aware welcome message.
      res.json(await backend.sessionInfo(session, { outline: true }));
    }),
  );

  registerSessionRoutes(app, wrap, {
    getSession,
    sessions,
    sessionInfo: (session, opts) => backend.sessionInfo(session, opts),
    teardown: teardownSession,
  });

  // --- attachments -------------------------------------------------------------

  registerAttachmentRoutes(app, wrap, {
    attachmentsDir: options.attachmentsDir,
    getSession,
    extractText: options.extractText,
  });

  // --- documents ----------------------------------------------------------------

  app.get(
    '/api/session/:id/documents',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await backend.documents(session));
    }),
  );

  app.post(
    '/api/session/:id/documents/switch',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const target = req.body?.path as string | undefined;
      if (!target) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      res.json(await backend.switchDocument(session, target));
    }),
  );

  // --- conversation history (per document key) ----------------------------------
  //
  // A document can have several persisted conversations: the active one
  // (<hash>.json) plus archived ones (<hash>.<stamp>.json). The panel's
  // start-working modal lists them and can start a new one or switch back.

  /** List every persisted conversation of the session's current document key. */
  app.get(
    '/api/session/:id/conversations',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const key = backend.conversationKey(session);
      const conversations = options.historyDir
        ? await listConversations(options.historyDir, key)
        : [];
      res.json({ key, conversations });
    }),
  );

  /**
   * Start a NEW conversation for the current key: archive the active history
   * file (nothing is deleted — it stays listed as a previous session) and
   * drop the in-memory turns + replay handoff. The panel pairs this with a
   * reconnect so the agent process also starts fresh.
   */
  app.post(
    '/api/session/:id/conversation/reset',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const key = backend.conversationKey(session);
      const archived = await storeFor(session).reset(key);
      res.json({ ok: true, key, archived });
    }),
  );

  /**
   * Switch the current key to a previously archived conversation: the chosen
   * file is promoted to the active name (the current active is archived)
   * and the in-memory state is dropped, so the next ensure() reloads the
   * chosen history. The panel pairs this with a reconnect.
   */
  app.post(
    '/api/session/:id/conversation/switch',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      if (!options.historyDir) throw new Error('History is not configured.');
      const key = backend.conversationKey(session);
      const file = (req.body?.file as string | undefined)?.trim();
      if (!file) {
        res.status(400).json({ error: 'file is required' });
        return;
      }
      await promoteConversation(options.historyDir, key, file);
      const store = storeFor(session);
      await store.flush(key);
      session.conversations.delete(key);
      session.historyHandoff.delete(key);
      const turns = await loadHistory(options.historyDir, key);
      // Re-seed in-memory state + the replay handoff, so the next message
      // replays the switched-in history into the agent (same as a fresh
      // session loading it at ensure()).
      session.conversations.set(key, turns);
      session.historyHandoff.set(key, turns.length);
      res.json({ ok: true, key, conversation: turns });
    }),
  );

  // --- selection ----------------------------------------------------------------

  app.get(
    '/api/session/:id/selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await backend.selection(session));
    }),
  );

  // --- server-push event channel ---------------------------------------------

  /**
   * SSE channel the panel subscribes to: every frame the backend's
   * watchEvents pushes (e.g. {refresh: true} when the bridge reports a
   * selection change or an edit) is forwarded here live. This replaces
   * the panel's typing-debounce/focus refresh heuristics for apps with
   * push events, and makes bridge recovery natural: when the
   * bridge comes back, events flow again and the panel refreshes itself.
   */
  app.get('/api/session/:id/events', (req, res) => {
    const session = sessions.get(param(req.params['id']));
    if (!session) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    const send = startSse(res);
    let listeners = eventListeners.get(session.id);
    if (!listeners) {
      listeners = new Set();
      eventListeners.set(session.id, listeners);
    }
    const sub: EventSubscriber = { send, end: () => res.end() };
    listeners.add(sub);
    session.lastActive = Date.now();
    send({ connected: true });
    req.on('close', () => {
      listeners?.delete(sub);
    });
  });

  // --- message (unified; the agent infers the action) ------------------------------

  /**
   * Streaming message: one input for everything. The agent decides the
   * intent and ends its reply with an action tag (the backend's
   * vocabulary). After a document action is applied, the app re-reads the
   * document and prompts the agent again for the next edit (multi-action
   * loop), up to the effective max-actions-per-message limit (user setting
   * clamped, default MAX_ACTIONS_PER_MESSAGE).
   *
   * SSE frames: {"text": ...} chunks, {"thought": ...} reasoning chunks
   * (agent_thought_chunk — a liveness signal, shown as a one-line tail in
   * the panel's typing indicator), {"tool": ...} agent tool activity,
   * {"usage": {used, size, cost}} context-window snapshots (usage_update,
   * agents that support it only), {"applied": action, ...} per applied
   * edit, {"appliedStep": n},
   * {"stopped": reason}, {"done": true}. Errors: {"error": ...},
   * {"cancelled": true}.
   */
  app.post('/api/session/:id/message/stream', async (req, res) => {
    const maybeSession = sessions.get(param(req.params['id']));
    if (!maybeSession) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    const session: CompanionSession<TState> = maybeSession;
    const message = (req.body?.message as string | undefined)?.trim();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Tracked across the handler so the catch block can persist the error
    // as turn metadata when the failure happens after the turn was recorded.
    let turnRecorded = false;
    let lastOutcome: ParsedActionBase | null = null;

    try {
      const read1 = await backend.readStep(session, 1);
      if (read1.blocked) {
        // App-level message gate (LyX save-consent): refused before the
        // stream starts, the client can remedy and retry.
        res.status(read1.blocked.status).json(read1.blocked.body);
        return;
      }
      const stepData1 = read1.data;
      const rawSend = startSse(res);
      // SSE frames keep the session's activity clock fresh (idle GC, B2).
      const send = (obj: unknown) => {
        session.lastActive = Date.now();
        rawSend(obj);
      };
      session.cancelRequested = false;

      // Attachments are consumed by this message (chat-app semantics).
      const attachments = session.attachments;
      session.attachments = [];

      const key = backend.conversationKey(session);
      const historyPrefix = storeFor(session).buildHistoryPrefix(key);
      // Effective edits-per-message limit for this run: auto-continue raises
      // it to the hard cap; otherwise the user setting (clamped), else the
      // default.
      const maxActions = effectiveMaxActionsPerMessage(await agentSettings.read());
      // Once-per-version context dedup: when this step's big context block
      // is byte-identical to the one last sent in this session (and no
      // history replay needs a fresh agent to see it), omit it — the ACP
      // session already carries it, and re-sending identical bytes every
      // message only inflates context and latency.
      const block1 = backend.contextBlock?.(stepData1) ?? null;
      const hash1 = block1 === null ? null : hashContextBlock(block1);
      const omitContext = hash1 !== null && session.sentContextHash === hash1 && !historyPrefix;
      const initialPrompt = await backend.buildAutoPrompt(
        session,
        stepData1,
        message,
        attachments,
        historyPrefix,
        maxActions,
        { contextOmitted: omitContext },
      );
      if (hash1 !== null) session.sentContextHash = hash1;
      // The replayed (pre-restart) turns are in this prompt now, so the
      // agent knows them; only turns recorded from here on are new to it.
      if (historyPrefix) {
        session.historyHandoff.delete(key);
      }

      const completed: string[] = [];
      let step = 0;
      let stepData = stepData1;
      let stoppedReason: 'done' | 'none' | 'cancelled' | 'error' | 'limit' = 'done';

      while (step < maxActions) {
        step += 1;
        if (session.cancelRequested) {
          send({ cancelled: true });
          stoppedReason = 'cancelled';
          break;
        }
        let prompt: string;
        if (step === 1) {
          prompt = initialPrompt;
        } else {
          const fresh = await backend.readStep(session, step);
          if (fresh.blocked) {
            throw new Error('Message refused mid-run.');
          }
          stepData = fresh.data;
          // Continuation prompts always carry the FRESH block (addresses
          // shift after each applied edit), but remember its hash so the
          // NEXT message can omit the block when nothing changed since.
          const blockN = backend.contextBlock?.(stepData) ?? null;
          if (blockN !== null) session.sentContextHash = hashContextBlock(blockN);
          prompt = await backend.buildContinuationPrompt(session, stepData, message, completed, maxActions);
        }

        // --- prompt once, parse the action, apply it --------------------
        let reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }], {
          onChunk: (chunk) => send({ text: chunk, ...(step > 1 ? { step } : {}) }),
          onThought: (chunk) => send({ thought: chunk, ...(step > 1 ? { step } : {}) }),
          onToolCall: (tool) => send({ tool }),
          // usage_update: context fill (used/size) + optional cost, only
          // when the agent reports it — the panel hides the line otherwise.
          onUsage: (usage) => {
            send({ usage });
            // Compaction backstop for the once-per-version dedup: a sharp
            // drop in context fill means the agent compacted its session
            // and may have dropped the outline/full text we now omit —
            // force a re-send on the next message.
            if (session.lastUsageUsed !== undefined && usage.used < session.lastUsageUsed * 0.7) {
              session.sentContextHash = undefined;
            }
            session.lastUsageUsed = usage.used;
          },
          timeoutMs: backend.promptTimeoutMs,
        });
        let outcome = backend.parseAction(session, reply, stepData);
        // LyX-only markup step: validate the markup, retry once with a
        // corrective prompt (the hook decides; returns the final reply).
        if (backend.retryReply) {
          const retried = await backend.retryReply(session, outcome, reply, send, step);
          if (retried !== reply) {
            reply = retried;
            outcome = backend.parseAction(session, reply, stepData);
          }
        }

        if (step === 1) {
          await storeFor(session).recordTurn(message, reply, attachments.map((a) => a.name));
        } else {
          await storeFor(session).recordActionStep(reply, step);
        }
        turnRecorded = true;
        lastOutcome = outcome;

        const extras = backend.metaExtras?.(session, outcome, stepData) ?? {};
        const noteMeta = async (result: 'applied' | 'error' | 'cancelled', error?: string) => {
          await storeFor(session).recordTurnMeta({
            action: outcome.action,
            target: outcome.target ?? null,
            ...extras,
            result,
            ...(error ? { error } : {}),
            ...(step > 1 ? { step } : {}),
          } as TurnMeta);
        };

        const afterParse = backend.frame?.(session, { kind: 'afterParse', outcome, stepData, step });
        if (afterParse) send(afterParse);

        if (session.cancelRequested) {
          send({ cancelled: true, ...(step > 1 ? { step } : {}) });
          await noteMeta('cancelled');
          stoppedReason = 'cancelled';
          break;
        }
        if (outcome.action === 'none' || outcome.action === 'continue') {
          // `continue` is accepted for forward-compatibility; the loop
          // drives continuations itself, so the tag means "nothing to do".
          const noneFrame = backend.frame?.(session, { kind: 'none', outcome, stepData, step });
          send(noneFrame ?? { action: 'none', ...(step > 1 ? { step } : {}) });
          await noteMeta('applied');
          stoppedReason = 'none';
          break;
        }

        let applied: AppliedResult;
        try {
          applied = await backend.applyAction(session, outcome, stepData, step);
        } catch (e) {
          applied = { ok: false, error: e instanceof Error ? e.message : String(e), description: '' };
        }
        if (!applied.ok) {
          const error = applied.error ?? 'The document action could not be applied.';
          send({ error, ...(step > 1 ? { step } : {}) });
          await noteMeta('error', error);
          stoppedReason = 'error';
          break;
        }

        const appliedFrame = backend.frame?.(session, {
          kind: 'applied',
          outcome,
          applied,
          stepData,
          step,
        });
        if (appliedFrame) send(appliedFrame);
        await noteMeta('applied');
        completed.push(applied.description);
        const appliedStepFrame = backend.frame?.(session, {
          kind: 'appliedStep',
          outcome,
          applied,
          stepData,
          step,
        });
        if (appliedStepFrame) send(appliedStepFrame);
      }

      if (step >= maxActions && stoppedReason === 'done') {
        stoppedReason = 'limit';
        send({
          text: `\nStopped after ${maxActions} document edits (safety limit). Send "continue" to apply more edits.`,
        });
      }
      send({ stopped: stoppedReason, appliedCount: completed.length });
      send({ done: true });
      // History writes are debounced in the shared store; flush before the
      // stream closes so a completed run is always on disk when the UI
      // sees `done`.
      await storeFor(session).flush().catch(() => {
        /* never break the stream */
      });
      await backend.afterRun?.(session).catch(() => {
        /* best-effort */
      });
      res.end();
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err);
      logError('[api] message/stream', err);
      if (!res.headersSent) {
        res.status(backend.mapStatus(err)).json({ error: message2 });
      } else {
        sseFail(res, err);
      }
      // Persist the failure on the recorded turn so it survives a restart.
      if (turnRecorded && lastOutcome) {
        const extras = backend.metaExtras?.(session, lastOutcome) ?? {};
        await storeFor(session)
          .recordTurnMeta({
            action: lastOutcome.action,
            target: lastOutcome.target ?? null,
            ...extras,
            result: lastOutcome.action === 'none' ? 'applied' : 'error',
            error: message2,
          } as TurnMeta)
          .catch(() => {
            /* logging must never break the request path */
          });
        await storeFor(session).flush().catch(() => {
          /* logging must never break the request path */
        });
      }
      // End-of-run hook even when the run failed before the first turn
      // was recorded: the backend saved its pre-run state in readStep(1)
      // BEFORE the first agent prompt (e.g. the LyX clipboard text),
      // so a step-1 agent failure must still restore it. afterRun is a
      // no-op until the backend saved something.
      await backend.afterRun?.(session).catch(() => {
        /* best-effort */
      });
    }
  });

  // --- structured review (the Visual Research Pal report loop) ----------------

  /** Per-session PDF cache, keyed by absolute path, version-checked (mtime/size) on every access. */
  const pdfCache = new WeakMap<CompanionSession<TState>, Map<string, VersionedPdfDocument>>();
  /** Last review per session — served as a ZIP by the download route. */
  const lastReview = new WeakMap<
    CompanionSession<TState>,
    { review: Review; sourceName: string; pages: number[] }
  >();

  /**
   * Streaming structured review of a PDF. Page-aware text (cached per
   * session and file) plus optional page images and the current
   * conversation go to the agent with the report prompt; the reply is
   * validated against the review schema (one conversion retry on prose)
   * and streamed back as {"log"}, {"thought"}, {"text"}, {"tool"}, then
   * {"review", "files"}, {"done"}. The review is recorded as a
   * conversation turn, so the next review or chat builds on it.
   *
   * Body: { attachmentId? | path?, pages?, includeImages?, includeHistory?, prompt? }.
   * The target defaults to the active document when it is a PDF.
   */
  app.post('/api/session/:id/review', async (req, res) => {
    const maybeSession = sessions.get(param(req.params['id']));
    if (!maybeSession) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    const session: CompanionSession<TState> = maybeSession;
    const body = (req.body ?? {}) as {
      attachmentId?: string;
      path?: string;
      pages?: string;
      includeImages?: boolean;
      includeHistory?: boolean;
      prompt?: string;
    };
    // Assigned once the SSE stream starts; the catch block uses it to
    // turn an agent abort (Stop button) into a {"cancelled"} frame.
    let send: ((obj: unknown) => void) | null = null;
    try {
      // --- resolve the PDF target ---------------------------------------------
      let pdfPath: string | null = null;
      let sourceName = '';
      if (typeof body.attachmentId === 'string' && body.attachmentId) {
        const att = session.attachments.find((a) => a.id === body.attachmentId);
        if (!att) {
          res.status(400).json({ error: 'Unknown attachmentId — attach the PDF first.' });
          return;
        }
        if (!/\.pdf$/i.test(att.name)) {
          res.status(400).json({ error: `Attachment "${att.name}" is not a PDF.` });
          return;
        }
        pdfPath = att.path;
        sourceName = att.name;
      } else if (typeof body.path === 'string' && body.path.trim()) {
        pdfPath = path.resolve(body.path.trim());
        if (!/\.pdf$/i.test(pdfPath)) {
          res.status(400).json({ error: 'path must point to a .pdf file.' });
          return;
        }
        await fs.access(pdfPath).catch(() => {
          throw new Error(`No such file: ${pdfPath}`);
        });
        sourceName = path.basename(pdfPath);
      } else {
        const info = (await backend.sessionInfo(session, {})) as { documentPath?: unknown };
        const docPath = typeof info?.documentPath === 'string' ? info.documentPath : '';
        if (docPath && /\.pdf$/i.test(docPath)) {
          pdfPath = docPath;
          sourceName = path.basename(docPath);
        } else {
          res.status(400).json({
            error:
              'No PDF to review: attach a PDF (attachmentId), pass a path, or open a PDF in the editor.',
          });
          return;
        }
      }

      // --- page-aware text (cached per session + file, version-checked) ----------
      let cache = pdfCache.get(session);
      if (!cache) {
        cache = new Map();
        pdfCache.set(session, cache);
      }
      // Version-checked load: a re-exported PDF (new mtime/size) is re-parsed,
      // so the review never reasons about stale text.
      const doc = await loadPdfDocumentVersioned(cache, pdfPath);
      const pages = parsePageRange(doc.totalPages, typeof body.pages === 'string' ? body.pages : undefined);

      // --- conversation history (the critical loop) -----------------------------
      let history = '';
      if (body.includeHistory !== false) {
        const key = backend.conversationKey(session);
        const turns = session.conversations.get(key) ?? [];
        history = turns
          .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
          .join('\n\n');
      }

      // --- optional page images for visual grounding (rendered per batch) --------
      const includeImages = body.includeImages === true;
      const imagesForBatch = async (batchPages: number[]): Promise<{ data: string; mimeType: string }[]> => {
        if (!includeImages) return [];
        const rendered = await renderPdfPageImages(pdfPath, batchPages.slice(0, MAX_REVIEW_IMAGE_PAGES), {
          ...REVIEW_IMAGE_RENDER,
        });
        return rendered.map((img) => ({ data: img.base64, mimeType: img.mimeType }));
      };

      const rawSend = startSse(res);
      send = (obj: unknown) => {
        session.lastActive = Date.now();
        rawSend(obj);
      };
      const sendLog = (message: string) => send?.({ log: message });
      session.cancelRequested = false;

      sendLog(`Reviewing ${sourceName} — ${doc.totalPages} pages, reviewing ${formatPageList(pages)}.`);
      if (session.cancelRequested) {
        send({ cancelled: true });
        send({ done: true });
        res.end();
        return;
      }

      // Large reviews are batched internally (char budget per batch, run
      // sequentially in this same ACP session so cross-batch findings stay
      // visible to the agent), then merged in one consolidation pass — the
      // user never picks ranges and no single prompt hits the text cap.
      const { review } = await generateBatchedReview(
        session.agent,
        session.id,
        {
          sourceName,
          totalPages: doc.totalPages,
          pages,
          pageText: (p) => `--- Page ${p} ---\n${getPageText(doc, p)}`,
          history,
          prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined,
          batchImages: imagesForBatch,
        },
        {
          onChunk: (chunk) => send?.({ text: chunk }),
          onThought: (chunk) => send?.({ thought: chunk }),
          onToolCall: (tool) => send?.({ tool }),
          onLog: sendLog,
          timeoutMs: Math.max(backend.promptTimeoutMs, REVIEW_TIMEOUT_MS),
        },
      );

      // Record the exchange so the next review/chat builds on it.
      const userText = `Generate a structured review of ${sourceName} (pages ${formatPageList(pages)})`;
      await storeFor(session).recordTurn(userText, formatReviewForHistory(review), [sourceName]);
      await storeFor(session).recordTurnMeta({ action: 'review', result: 'applied' } as TurnMeta);

      // The report is not written into the app's data dir — the panel
      // downloads it as a ZIP (report.html + report.json) from the route
      // below, so the user chooses where it lives.
      lastReview.set(session, { review, sourceName, pages });
      send({ review, download: true });
      send({ done: true });
      await storeFor(session).flush().catch(() => {
        /* never break the stream */
      });
      res.end();
    } catch (err) {
      logError('[api] review', err);
      const message2 = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(backend.mapStatus(err)).json({ error: message2 });
      } else if (session.cancelRequested) {
        res.write(`data: ${JSON.stringify({ cancelled: true })}\n\n`);
        res.write('data: {"done":true}\n\n');
        res.end();
      } else {
        sseFail(res, err);
      }
    }
  });

  /**
   * Download the session's last structured review as a ZIP archive
   * containing a flat report.html (inline styles, no images/scripts) and
   * report.json. 404 until the first review completes.
   */
  app.get(
    '/api/session/:id/review/download',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const last = lastReview.get(session);
      if (!last) {
        res.status(404).json({ error: 'No review has been generated in this session yet.' });
        return;
      }
      const meta = {
        sourceName: last.sourceName,
        pages: formatPageList(last.pages),
        generatedAt: new Date().toISOString(),
      };
      const zip = await buildReviewZip(last.review, meta);
      const slug =
        last.sourceName.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'review';
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="review-${slug}.zip"`);
      res.setHeader('content-length', String(zip.length));
      res.end(zip);
    }),
  );

  // --- undo --------------------------------------------------------------------

  app.post(
    '/api/session/:id/undo',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await backend.undo(session));
    }),
  );

  // --- conversation store --------------------------------------------------------

  const storeBySession = new WeakMap<CompanionSession<TState>, ConversationStore>();
  function storeFor(session: CompanionSession<TState>) {
    let store = storeBySession.get(session);
    if (!store) {
      store = createConversationStore({
        historyDir: options.historyDir,
        logError,
        conversations: session.conversations,
        historyHandoff: session.historyHandoff,
        keyOf: () => backend.conversationKey(session),
        replayOptions: backend.replayOptions,
      });
      storeBySession.set(session, store);
    }
    return store;
  }

  options.extraRoutes?.(app, { wrap, getSession });

  return app;
}
