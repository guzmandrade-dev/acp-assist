'use strict';

// Shared panel state: the injected config, the DOM element references,
// and the mutable session/UI state both companion apps' panels run on.
// The `state` object exists so the modules under public/ can share
// mutable values without cycles of live bindings.

// --- panel config ------------------------------------------------------------
// Injected same-origin into index.html together with the API token (see
// @acp-assist/panel). Everything app-specific hangs off this object; the
// files below are shared verbatim by both companion apps.
//   appName:        'LyX' | 'LibreOffice' — user-facing strings
//   appTitle:       window/empty-state title
//   fenceRe:        fenced content-block language(s) the agent writes
//   statusKey:      /api/status field reporting the editor connection
//   statusMissing:  status line text when the editor is unreachable
//   cursorTerm:     'layout' (LyX) | 'style' (LibreOffice)
//   hasSaveConsent: LyX-only save-consent modal + VCS warning
//   hasInstallFlow: LO-only one-click bridge installer
//   composerRefreshSelection: refresh the selection on composer
//                   interaction (LO: yes; LyX: NO — the selection read
//                   clobbers the user's clipboard)
export const CONFIG = window.__ACP_PANEL_CONFIG__ ?? {};
export const APP = CONFIG.appName ?? 'LibreOffice';
export const FENCE_RE = CONFIG.fenceRe ?? '(?:writer|calc|impress)';
// An UNCLOSED app fence (agent truncated the closing ```) still matches
// through end-of-text, so the block renders/strips instead of leaking a
// literal "```writer" line into the bubble.
export const FENCE_STRIP_SRC = '```' + FENCE_RE + '\\s*\\n[\\s\\S]*?(?:```\\s*|$)';
export const FENCE_BLOCK_SRC = '```' + FENCE_RE + '\\s*\\n([\\s\\S]*?)(?:```|$)';

/**
 * Live-render throttle for streamed replies: re-rendering the WHOLE
 * accumulated reply on every {"text"} chunk is O(n²) over the stream, so
 * chunks coalesce into one full markdown render at most this often. Turn
 * boundaries (appliedStep / done) always render immediately and cancel
 * any pending throttled render. Indistinguishable from per-chunk
 * rendering in practice — chunks arrive faster than the eye can follow.
 */
export const LIVE_RENDER_MS = 100;

// --- DOM elements -------------------------------------------------------------

export const chat = document.getElementById('chat');
export const statusEl = document.getElementById('status');
export const statusText = document.getElementById('status-text');
export const docEl = document.getElementById('doc');
export const selectionEl = document.getElementById('selection');
export const docSelect = document.getElementById('doc-select');
export const appSelect = document.getElementById('app-select');
export const editorSpinner = document.getElementById('bridge-spinner');
export const bridgeBusyText = document.getElementById('bridge-busy-text');
export const input = document.getElementById('input');
export const sendBtn = document.getElementById('send');
export const stopBtn = document.getElementById('stop');
export const undoBtn = document.getElementById('undo');
export const pinBtn = document.getElementById('pin');
export const reconnectBtn = document.getElementById('reconnect');
export const installBtn = document.getElementById('install-btn');
export const cmdEl = document.getElementById('agent-cmd');
export const showFullHistoryEl = document.getElementById('show-full-history');
export const maxActionsEl = document.getElementById('max-actions');
export const autoContinueEl = document.getElementById('auto-continue');
export const keepAwakeEl = document.getElementById('keep-awake');
export const keepAwakeRow = document.getElementById('keep-awake-row');
export const attachBtn = document.getElementById('attach');
export const newSessionBtn = document.getElementById('new-session');
export const fileInput = document.getElementById('file-input');
export const chipsEl = document.getElementById('chips');
export const reviewBtn = document.getElementById('review');
export const openViewerBtn = document.getElementById('open-viewer');
export const reviewBackdrop = document.getElementById('review-backdrop');
export const reviewTargetRow = document.getElementById('review-target-row');
export const reviewTarget = document.getElementById('review-target');
export const reviewPathRow = document.getElementById('review-path-row');
export const reviewPath = document.getElementById('review-path');
export const reviewPages = document.getElementById('review-pages');
export const reviewImages = document.getElementById('review-images');
export const reviewHistory = document.getElementById('review-history');
export const reviewRun = document.getElementById('review-run');
export const reviewCancel = document.getElementById('review-cancel');
export const vcsWarnEl = document.getElementById('vcs-warn');
export const consentBackdrop = document.getElementById('save-consent-backdrop');
export const consentPathEl = document.getElementById('save-consent-path');
export const consentVcsEl = document.getElementById('save-consent-vcs');
export const consentSessionsEl = document.getElementById('save-consent-sessions');
export const consentSessionListEl = document.getElementById('save-consent-session-list');
export const consentHintEl = document.getElementById('save-consent-hint');
export const consentAcceptBtn = document.getElementById('save-consent-accept');
export const consentCancelBtn = document.getElementById('save-consent-cancel');
export const scrollTicks = document.getElementById('scroll-ticks');

export const appVersionRow = document.getElementById('app-version-row');

export const appVersionEl = document.getElementById('app-version');

export const checkUpdateBtn = document.getElementById('check-update');

export const updateStatusEl = document.getElementById('update-status');

export const updateActionBtn = document.getElementById('update-action');

// The "talking to the editor" label is per-app (panel config): the
// shared HTML ships a placeholder, the boot config overrides it.
if (bridgeBusyText && CONFIG.busyText) bridgeBusyText.textContent = CONFIG.busyText;

// --- mutable shared state -------------------------------------------------

export const state = {
  /** Active session id (null until the first connect succeeds). */
  sessionId: null,
  /** A generation is streaming (composer locked, Stop visible). */
  busy: false,
  /** The editor is blocked (e.g. a modal dialog is open). */
  bridgeBusy: false,
  /** The editor connection reported by /api/status. */
  bridgeAvailable: false,
  /** AbortController of the running stream. */
  currentAbort: null,
  /** A connect/reconnect is in flight — one session POST at a time. */
  connecting: false,
  /**
   * Document picked from the file dropdown while a reconnect fired by that
   * same click was tearing the old session down; applied to the new session
   * once connect() has re-read the editor's document list.
   */
  pendingDocSwitch: null,
  /** The typing-indicator element (lazily created). */
  typingIndicator: null,
  /** When the current turn started (0 = no turn). */
  generationStart: 0,
  /**
   * When the agent was actually prompted in the current turn (0 = still in
   * the pre-prompt phase). The stream fetch resolves only after the server
   * finished the editor round-trip (save + document read), so the gap
   * generationStart → agentStart is "talking to the editor", not agent
   * time. The typing hint uses this to label the phase.
   */
  agentStart: 0,
  typingTimer: null,
  typingResumeTimer: null,
  /** Document path whose conversation is currently rendered in the chat. */
  chatDocKey: null,
  /** The empty-state element (recreated on demand). */
  emptyEl: document.getElementById('empty'),
  /** Auto-follow: pin the chat to the bottom unless the user scrolled up. */
  followChat: true,
  /** User-message elements currently shown as scroll ticks. */
  tickMsgs: [],
  /** Save-consent state (server-enforced; mirrored here to warn early). */
  activeDocPath: null,
  /** null = unknown/unsaved; otherwise whether the active doc is in a VCS. */
  docVersionControlled: null,
  /** Document paths the user already accepted this session (client mirror). */
  saveConsentPaths: new Set(),
  /** Resolver of the open save-consent modal, null while closed. */
  consentResolver: null,
  /**
   * Document keys whose "start working" modal was already shown (and
   * resolved) in this panel session — the modal appears once per document.
   */
  docIntroDone: new Set(),
  /** One-click bridge install in flight. */
  installBusy: false,
  /** Open "talking to the editor" requests (counter-based indicator). */
  bridgeRequestCount: 0,
  /** AbortController of the server-push event channel. */
  eventStreamController: null,
  eventRefreshTimer: null,
  editorContextRefreshTimer: null,
  /** Floating-on-top pin state. */
  followMode: false,
  /** Attachment ids waiting to be sent with the next message. */
  pendingAttachments: [],
  /**
   * Show the full operation log: assistant replies render their fenced
   * content blocks (the payload about to be pasted) in full. When false
   * the blocks render as a placeholder. Persisted server-side via
   * /api/settings/agent (showFullHistory); default true.
   */
  showFullHistory: true,
  /**
   * Hold a power-save blocker in the desktop shell while a run is in
   * flight (Electron only; no-op in the standalone browser host).
   * Persisted server-side via /api/settings/agent (keepAwakeWhileBusy);
   * default false.
   */
  keepAwakeWhileBusy: false,
  /**
   * Auto-continue past the edits-per-message limit up to the hard cap (50)
   * instead of stopping to ask for "continue". Persisted server-side via
   * /api/settings/agent (autoContinueEdits); default false.
   */
  autoContinueEdits: false,
};

/**
 * Ask the desktop shell to keep the computer awake (on) or release it
 * (off). No-op unless the persisted keepAwakeWhileBusy setting is on and
 * the Electron preload exposed window.electron.keepAwake.
 */
export async function setKeepAwake(on) {
  if (!state.keepAwakeWhileBusy) return;
  const fn = window.electron?.keepAwake;
  if (!fn) return;
  try {
    await fn(on);
  } catch {
    /* best-effort — never break a run over power management */
  }
}