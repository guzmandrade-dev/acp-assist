'use strict';

// The conversation itself: the applied-edit feedback line under each
// reply, the streaming message reader, send (with the save-consent
// gate), connect, and reconnect.

import {
  APP,
  CONFIG,
  LIVE_RENDER_MS,
  state,
  chat,
  cmdEl,
  docEl,
  input,
  reconnectBtn,
  statusEl,
} from './state.js';
import { api, parseAgentCommand, saveSettings } from './api.js';
import { addMessage, addSystemMessage, renderConversation, showEmpty, hideEmpty } from './messages.js';
import { renderAssistantText } from './markdown.js';
import {
  maybeSetBusyFromError,
  setBusy,
  setStatusText,
  updateComposerState,
  withbridgeBusy,
  refreshStatus,
} from './status.js';
import { showTyping, hideTyping, scheduleTypingResume, pushThought, resetThoughts, setTypingHint } from './typing.js';
import { scrollToBottomIfNear } from './messages.js';
import {
  HAS_SAVE_CONSENT,
  maybeShowDocIntro,
  requestSaveConsent,
  setDocInfo,
} from './save-consent.js';
import { updateDocSelector, refreshDocuments, refreshSelection, switchDocument } from './documents.js';
import { closeEventChannel, openEventChannel } from './events.js';
import { renderChips } from './attachments.js';

/**
 * The feedback line under an assistant reply: what was applied where
 * ("Inserted after [p5] · Undo edit"), an error, or the stopped note.
 */
export function renderFeedback(msgDiv, { applied, target, target2, address, module, cancelled, error, tagNote }) {
  const feedback = document.createElement('div');
  let prefix = '';
  let undoLabel = 'Undo edit';
  let showUndo = false;
  const slides = module === 'impress' || module === 'draw';

  if (error) {
    feedback.className = 'feedback error';
    prefix = `Not applied: ${error}`;
  } else if (cancelled) {
    feedback.className = 'feedback stopped';
    prefix = 'Stopped before applying';
  } else if (applied === 'none') {
    feedback.className = 'feedback none';
    prefix = 'Replied in chat — document unchanged';
  } else if (applied) {
    feedback.className = 'feedback applied';
    showUndo = true;
    switch (applied) {
      case 'insert':
        prefix = `Inserted at the cursor in ${APP}`;
        break;
      case 'insert-top':
        prefix = 'Inserted at the top of the document';
        undoLabel = 'Undo edit (×2)';
        break;
      case 'insert-after':
        prefix = slides
          ? (target === 0
              ? 'Inserted a new slide at the very start of the deck'
              : `Inserted a new slide after s${target ?? '?'} in ${APP}`)
          : `Inserted after [p${target ?? '?'}] in ${APP}`;
        break;
      case 'insert-before':
        prefix = `Inserted before [p${target ?? '?'}] in ${APP}`;
        break;
      case 'rewrite':
        prefix = slides
          ? `Replaced the selected frame in ${APP}`
          : `Replaced the selection in ${APP}`;
        break;
      case 'rewrite-slide':
        prefix = `Replaced slide s${target ?? '?'} in ${APP}`;
        break;
      case 'write-cells':
        prefix = `Wrote cells at ${address ?? 'the selection'} in ${APP}`;
        break;
      case 'insert-rows':
        prefix = `Inserted a row above ${address ?? 'the selection'} in ${APP}`;
        break;
      case 'insert-cols':
        prefix = `Inserted a column left of ${address ?? 'the selection'} in ${APP}`;
        break;
      case 'rewrite-at':
        prefix = `Replaced [p${target ?? '?'}] in ${APP}`;
        break;
      case 'delete-at':
        prefix = `Deleted [p${target ?? '.'}] from ${APP}`;
        break;
      case 'merge':
        prefix = `Merged [p${target ?? '?'}] with [p${target2 ?? '?'}] in ${APP}`;
        break;
      case 'move':
        prefix = `Moved [p${target ?? '?'}] to after [p${target2 ?? '?'}] in ${APP}`;
        break;
      default:
        prefix = `Applied ${applied}`;
    }
  } else {
    feedback.className = 'feedback none';
    prefix = 'Replied in chat — document unchanged';
  }

  // The server auto-corrects near-miss action tags (typos like
  // "[AACTION:") so the edit still applies; tell the user it happened.
  if (tagNote) {
    prefix += ` — action tag auto-corrected from “${tagNote}”`;
  }

  feedback.appendChild(document.createTextNode(prefix));
  if (showUndo) {
    feedback.appendChild(document.createTextNode(' · '));
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = undoLabel;
    btn.addEventListener('click', async () => {
      if (!state.sessionId || state.busy) return;
      try {
        await withbridgeBusy(api(`/api/session/${state.sessionId}/undo`, { method: 'POST' }));
        addSystemMessage(`Undo sent to ${APP}`);
      } catch (e) {
        addSystemMessage(`Undo failed: ${e.message}`, true);
      }
    });
    feedback.appendChild(btn);
  }
  msgDiv.appendChild(feedback);
}

/**
 * Stream one message: POST to the SSE endpoint, parse the {"text"},
 * {"thought"}, {"tool"}, {"applied"}, and {"appliedStep"} frames, and render
 * the reply live. Returns the turn outcome for the caller.
 */
export async function streamMessage(message) {
  let { div, textDiv } = addMessage('assistant', '');
  const ctrl = new AbortController();
  state.currentAbort = ctrl;
  setBusy(true);
  state.generationStart = Date.now();
  state.agentStart = 0;
  showTyping();
  resetThoughts();

  let res;
  try {
    // The response headers arrive only after the server has finished reading
    // the document context from the editor (save + outline + selection), so this
    // fetch window is exactly the "talking to the editor" phase — and its end
    // is when the agent gets prompted (state.agentStart drives the hint label).
    res = await withbridgeBusy(
      fetch(`/api/session/${state.sessionId}/message/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {}),
        },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      }),
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      // The user pressed Stop before the stream even started (the fetch
      // was still waiting for response headers). Give the turn its
      // "Stopped before applying" feedback instead of a silent bubble.
      hideTyping();
      state.generationStart = 0;
      textDiv.innerHTML = '<p>(no response)</p>';
      renderFeedback(div, {
        applied: null, target: null, target2: null, address: null,
        module: null, cancelled: true, error: null,
      });
      setBusy(false);
      return { full: '', applied: null, cancelled: true, error: null };
    }
    maybeSetBusyFromError(e);
    hideTyping();
    state.generationStart = 0;
    setBusy(false);
    throw e;
  }

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `${res.status} ${res.statusText}`);
    // Machine-readable save-consent refusal (LyX; see send()).
    err.code = body.code;
    err.documentPath = body.documentPath;
    maybeSetBusyFromError(err);
    hideTyping();
    state.generationStart = 0;
    setBusy(false);
    throw err;
  }

  // Headers received: the editor round-trip is done and the agent prompt is
  // on its way — from here on the elapsed time is agent time.
  state.agentStart = Date.now();
  setTypingHint();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let applied = null;
  let target = null;
  let target2 = null;
  let address = null;
  let module = null;
  let tagNote = null;
  let cancelled = false;
  let error = null;
  let stopReason = null;
  let started = false;
  const usedTools = [];
  let toolLine = null;
  let usageEl = null;
  // Multi-action runs: close one assistant bubble per applied edit and
  // start a fresh bubble for the next agent step in the same request.
  const streamSteps = [];

  const setToolLine = (text) => {
    if (!toolLine) {
      toolLine = document.createElement('div');
      toolLine.className = 'tools';
      div.appendChild(toolLine);
    }
    toolLine.textContent = text;
  };

  // Context-window usage (ACP usage_update frames, forwarded as {"usage"}):
  // a small muted line under the bubble, e.g. "context 87.2k / 200k · $0.01".
  // Agents that never report usage simply never create the line.
  const fmtTokens = (n) =>
    typeof n === 'number' && n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
  const setUsageLine = (u) => {
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.className = 'usage';
      div.appendChild(usageEl);
    }
    let text = `context ${fmtTokens(u.used)} / ${fmtTokens(u.size)} tokens`;
    if (u.cost && typeof u.cost.amount === 'number') {
      text += ` · ${u.cost.amount} ${u.cost.currency}`;
    }
    usageEl.textContent = text;
  };

  // Throttled live render (see LIVE_RENDER_MS): one full fence-aware
  // render per burst of chunks instead of one per chunk.
  let liveRenderTimer = null;
  const cancelLiveRender = () => {
    if (liveRenderTimer !== null) {
      clearTimeout(liveRenderTimer);
      liveRenderTimer = null;
    }
  };
  const renderLive = () => {
    liveRenderTimer = null;
    div._rawText = full; // for the copy/quote actions
    textDiv.innerHTML = renderAssistantText(full, applied);
    scrollToBottomIfNear();
    scheduleTypingResume();
  };
  const scheduleLiveRender = () => {
    if (liveRenderTimer === null) {
      liveRenderTimer = setTimeout(renderLive, LIVE_RENDER_MS);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith('data: ')) continue;
        let payload;
        try {
          payload = JSON.parse(frame.slice(6));
        } catch {
          continue;
        }
        if (payload.error) {
          error = payload.error;
          maybeSetBusyFromError({ message: error });
        } else if (payload.thought) {
          // Streamed reasoning (agent_thought_chunk): a live one-line tail
          // in the typing indicator — shown until the reply text starts.
          pushThought(String(payload.thought));
          if (!started) showTyping();
        } else if (payload.text) {
          full += payload.text;
          started = true;
          hideTyping();
          scheduleLiveRender();
        } else if (payload.tool) {
          const t = payload.tool;
          if (t.status === 'completed') {
            if (!usedTools.includes(t.title)) usedTools.push(t.title);
            setToolLine(`Used ${usedTools.join(', ')}`);
          } else {
            setToolLine(`Using ${t.title}…`);
          }
          hideTyping();
          scheduleTypingResume();
          scrollToBottomIfNear();
        } else if (payload.usage) {
          // usage_update snapshot: context fill (and cost when reported).
          setUsageLine(payload.usage);
        } else if (payload.applied) {
          applied = payload.applied;
          target = payload.target ?? null;
          target2 = payload.target2 ?? null;
          address = payload.address ?? null;
          module = payload.module ?? null;
          tagNote = payload.tagNote ?? null;
          div._applied = applied; // quote strips the ```writer block like the render does
        } else if (payload.appliedStep) {
          // Boundary between two edits of one multi-action run: close the
          // current bubble (with its feedback) and start a fresh one below
          // for the next agent step (whose thinking starts from scratch).
          cancelLiveRender();
          resetThoughts();
          div._rawText = full;
          div._applied = applied;
          textDiv.innerHTML =
            renderAssistantText(full, applied) || (started ? '' : '<p>(no response)</p>');
          renderFeedback(div, { applied, target, target2, address, module, cancelled, error, tagNote });
          streamSteps.push({ div, textDiv, text: full, applied, target, target2, address, module, error, cancelled, tagNote });
          const next = addMessage('assistant', '');
          div = next.div;
          textDiv = next.textDiv;
          toolLine = null;
          usageEl = null;
          usedTools.length = 0;
          applied = null;
          target = null;
          target2 = null;
          address = null;
          module = null;
          tagNote = null;
          error = null;
          cancelled = false;
          full = '';
          started = false;
        } else if (payload.tagNote) {
          // LyX server shape: the near-miss tag note arrives as its own
          // frame; LO attaches it to the applied/none frames. Handle both.
          tagNote = payload.tagNote;
        } else if (payload.action === 'none') {
          applied = 'none';
          tagNote = payload.tagNote ?? null;
        } else if (payload.cancelled) {
          cancelled = true;
        } else if (payload.stopped) {
          stopReason = payload.stopped;
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // The user pressed Stop: the fetch was aborted client-side. Fall
      // through to the final render so the turn gets its "Stopped before
      // applying" feedback instead of a silent empty bubble.
      cancelLiveRender();
      cancelled = true;
    } else {
      cancelLiveRender();
      if (started) {
        // Show everything streamed so far: the throttled render may be
        // up to LIVE_RENDER_MS behind.
        div._rawText = full;
        textDiv.innerHTML = renderAssistantText(full, applied);
      }
      maybeSetBusyFromError(e);
      hideTyping();
      state.generationStart = 0;
      setBusy(false);
      throw e;
    }
  }

  hideTyping();
  state.generationStart = 0;
  cancelLiveRender();
  if (toolLine) {
    if (usedTools.length > 0) setToolLine(`Used ${usedTools.join(', ')}`);
    else toolLine.remove();
  }
  div._rawText = full; // final raw text for the copy/quote actions
  div._applied = applied;
  textDiv.innerHTML = renderAssistantText(full, applied) || (started ? '' : '<p>(no response)</p>');
  // The final bubble of a multi-action run is usually the agent's summary
  // continuation (its [ACTION: none] step — the {action: none} frame sets
  // applied = 'none', which is truthy): the run-level note below
  // ("Finished after N edit(s)") is the accurate outcome, and a per-bubble
  // "document unchanged" here would contradict the edits applied in the
  // earlier bubbles.
  const summaryContinuation =
    streamSteps.length > 0 && (applied === null || applied === 'none')
    && !cancelled && !error && !tagNote;
  if (!summaryContinuation) {
    renderFeedback(div, { applied, target, target2, address, module, cancelled, error, tagNote });
  }
  if (stopReason) {
    const appliedCount = streamSteps.filter((s) => s.applied && s.applied !== 'none').length + (applied && applied !== 'none' ? 1 : 0);
    const note = document.createElement('div');
    note.className = 'feedback none';
    const labels = {
      done: null,
      none: appliedCount > 0
        ? `Finished after ${appliedCount} edit${appliedCount === 1 ? '' : 's'}`
        : null,
      cancelled: `Stopped by user after ${appliedCount} edit${appliedCount === 1 ? '' : 's'}`,
      error: `Stopped because an edit failed (${appliedCount} earlier edit${appliedCount === 1 ? '' : 's'} applied)`,
      limit: `Stopped after the safety limit of ${appliedCount} edit${appliedCount === 1 ? '' : 's'} — send "continue" for more`,
    };
    // 'none'/'done' carry no run note for a plain chat reply — the
    // per-bubble "document unchanged" label already says it.
    const text =
      stopReason === 'none' || stopReason === 'done'
        ? labels.none
        : labels[stopReason] ?? `Stopped (${stopReason})`;
    if (text) {
      note.textContent = text;
      div.appendChild(note);
    }
  }
  scrollToBottomIfNear();
  setBusy(false);
  return { full, applied, cancelled, error };
}

/**
 * Send a message: the save-consent gate, the user bubble, the stream,
 * and the post-send refreshes.
 */
export async function send() {
  if (state.busy || !state.sessionId || state.bridgeBusy || state.consentResolver) return;
  const message = input.value.trim();
  if (!message) return;
  // The start-working modal (edit notice + conversation picker) runs at
  // connect / document-select time, not here. Non-VCS documents still hit
  // the server-side consent gate (409) on the first save — handled in the
  // catch below.
  input.value = '';
  // Snapshot the pending attachments for this turn BEFORE the stream
  // consumes them — the user bubble shows what was attached.
  const attachmentNames = state.pendingAttachments.map((a) => a.name);
  addMessage('user', message, { attachments: attachmentNames });
  try {
    await streamMessage(message);
    // Attachments were consumed by this message.
    state.pendingAttachments.length = 0;
    renderChips();
  } catch (e) {
    if (e.name === 'AbortError') {
      /* user stop — no extra message */
    } else if (HAS_SAVE_CONSENT && e.code === 'save-consent-required') {
      // Server-side gate (the client's VCS state was stale): ask now and
      // retry the same message once after acceptance.
      const docPath = e.documentPath ?? state.activeDocPath;
      if (docPath && (await requestSaveConsent(docPath))) {
        try {
          await streamMessage(message);
          state.pendingAttachments.length = 0;
          renderChips();
        } catch (e2) {
          if (e2.name !== 'AbortError') addSystemMessage(`error: ${e2.message}`, true);
        }
      } else {
        addSystemMessage('Not sent: saving was not accepted.', true);
      }
    } else {
      addSystemMessage(`error: ${e.message}`, true);
    }
  } finally {
    // The three refreshes are independent — run them in parallel instead
    // of serially after every message.
    await Promise.allSettled([refreshStatus(), refreshDocuments(), refreshSelection()]);
  }
}

/** Create the session and render its initial state. */
export async function connect() {
  // One (re)connect at a time: the boot connect and a reconnect fired by the
  // file dropdown (see app.js) must not race two /api/session POSTs.
  if (state.connecting) return;
  state.connecting = true;
  try {
    await doConnect();
  } finally {
    state.connecting = false;
  }
}

async function doConnect() {
  await refreshStatus();
  saveSettings();
  const { command, args } = parseAgentCommand(cmdEl.value);
  const cmd = command || 'vibe-acp';
  const info = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ agent: { command: cmd, args } }),
  });
  state.sessionId = info.sessionId;
  state.chatDocKey = info.documentPath ?? '(unsaved)';
  setDocInfo(info.documentPath, info.versionControlled);
  // PDF mode has no unsaved-document concept — the label says how to open one.
  const emptyDocLabel = CONFIG.pdfMode
    ? '(no PDF open — attach one with +)'
    : '(unsaved document)';
  docEl.textContent = info.documentPath ?? emptyDocLabel;
  docEl.title = info.documentPath ?? '';
  updateDocSelector(info.documentPath, info.documents ?? []);
  const turns = info.conversation ?? [];
  renderConversation(turns);
  if (turns.length === 0) {
    // Fresh conversation: show the quiet empty state, not a chat message.
    showEmpty();
  } else {
    addMessage(
      'assistant',
      info.outline
        ? `Connected. Cursor ${CONFIG.cursorTerm ?? 'style'}: ${info.layout}. The agent decides itself whether to reply or write into the document.`
        : CONFIG.pdfMode
          ? 'Connected. Attach a PDF with + (or pick a previous one in the dropdown above), then ask — or press Review… for the structured report.'
          : `Connected to ${APP} (document unsaved — outline unavailable).`,
    );
    hideEmpty();
  }
  updateComposerState();
  openEventChannel();
  // The start-working modal (edit notice + VCS status + previous-conversation
  // picker) appears here — once the connection and document are selected,
  // once per document per panel session. The choice is applied in place
  // (no reconnect), so composer text and pending attachments survive.
  const intro = await maybeShowDocIntro();
  if (intro?.accepted) await applyDocIntroChoice(intro.choice);
}

/**
 * Apply the conversation choice made in the start-working modal
 * ('__new__' or an archived file name; '__current__' is a no-op). NO
 * reconnect: at connect time the agent process is still fresh, and a
 * document switch mid-session re-keys the conversation anyway — so pending
 * attachments and the composer text survive untouched. The server archives
 * the active conversation (nothing is deleted) and re-seeds the replay
 * handoff for a switched-in history.
 */
export async function applyDocIntroChoice(choice) {
  if (!choice || choice === '__current__' || !state.sessionId) return;
  try {
    if (choice === '__new__') {
      await api(`/api/session/${state.sessionId}/conversation/reset`, { method: 'POST' });
      chat.innerHTML = '';
      showEmpty();
    } else {
      const r = await api(`/api/session/${state.sessionId}/conversation/switch`, {
        method: 'POST',
        body: JSON.stringify({ file: choice }),
      });
      renderConversation(r.conversation ?? []);
      if ((r.conversation ?? []).length === 0) showEmpty();
      else hideEmpty();
    }
  } catch (e) {
    addSystemMessage(`error: ${e.message}`, true);
  }
}

/** Tear down the current session (agent process included) and start a new one. */
export async function reconnect() {
  if (state.busy || state.connecting) return;
  state.connecting = true;
  reconnectBtn.disabled = true;
  try {
    if (state.sessionId) {
      try {
        await api(`/api/session/${state.sessionId}`, { method: 'DELETE' });
      } catch {
        /* session already gone */
      }
      closeEventChannel();
      state.sessionId = null;
    }
    chat.innerHTML = '';
    state.pendingAttachments.length = 0;
    renderChips();
    showEmpty();
    await doConnect();
    // A document picked from the dropdown while this reconnect was tearing
    // the old session down was parked by the change handler — apply it now
    // that the fresh session has re-read the editor's document list.
    if (state.pendingDocSwitch) {
      const path = state.pendingDocSwitch;
      state.pendingDocSwitch = null;
      await switchDocument(path);
    }
  } catch (e) {
    maybeSetBusyFromError(e);
    if (!state.bridgeBusy) {
      setStatusText(`failed to connect: ${e.message}`);
      statusEl.className = 'status bad';
    }
    const details = document.querySelector('.agent-settings');
    if (details && typeof details.open === 'boolean') details.open = true;
  } finally {
    state.connecting = false;
    reconnectBtn.disabled = false;
  }
}