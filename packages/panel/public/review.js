'use strict';

// Structured PDF review (the Visual Research Pal report loop, minus its
// viewer): the Review… button opens a small dialog (target PDF, page
// range, options); the run streams POST /api/session/:id/review and
// renders the validated review as a card in the chat. Progress arrives
// as {"log"} frames; the agent's raw text is only shown when the run
// fails, so a malformed reply is debuggable.

import {
  CONFIG,
  state,
  chat,
  reviewBtn,
  reviewBackdrop,
  reviewTarget,
  reviewTargetRow,
  reviewPathRow,
  reviewPath,
  reviewPages,
  reviewImages,
  reviewHistory,
  reviewRun,
  reviewCancel,
  setKeepAwake,
} from './state.js';
import { api } from './api.js';
import { addMessage, addSystemMessage, scrollToBottomIfNear } from './messages.js';
import { maybeSetBusyFromError, setBusy } from './status.js';
import { showTyping, hideTyping, pushThought, resetThoughts, setTypingHint } from './typing.js';

/** PDF-review mode: the active PDF is the only review target. */
const PDF_MODE = Boolean(CONFIG.pdfMode);

function isPdfName(name) {
  return /\.pdf$/i.test(name ?? '');
}

/** Fill the target select: pending PDF attachments, the active document
 *  when it is a PDF, and a free-form path option. In PDF mode the target
 *  is always the active PDF, so the picker collapses to a single entry. */
function populateTargets() {
  if (PDF_MODE) {
    reviewTarget.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = 'active';
    opt.textContent = state.activeDocPath ?? 'the active PDF';
    reviewTarget.appendChild(opt);
    reviewTarget.value = 'active';
    reviewTarget.disabled = true;
    if (reviewTargetRow) reviewTargetRow.hidden = true;
    reviewPathRow.hidden = true;
    return;
  }
  reviewTarget.disabled = false;
  if (reviewTargetRow) reviewTargetRow.hidden = false;
  reviewTarget.innerHTML = '';
  const pdfAttachments = state.pendingAttachments.filter((a) => isPdfName(a.name));
  for (const att of pdfAttachments) {
    const opt = document.createElement('option');
    opt.value = `att:${att.id}`;
    opt.textContent = `${att.name} (attached)`;
    reviewTarget.appendChild(opt);
  }
  if (isPdfName(state.activeDocPath ?? '')) {
    const opt = document.createElement('option');
    opt.value = 'active';
    opt.textContent = `active document: ${state.activeDocPath}`;
    reviewTarget.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'path';
  custom.textContent = 'path on disk…';
  reviewTarget.appendChild(custom);
  if (pdfAttachments.length > 0) reviewTarget.value = `att:${pdfAttachments[0].id}`;
  else if (isPdfName(state.activeDocPath ?? '')) reviewTarget.value = 'active';
  else reviewTarget.value = 'path';
  reviewPathRow.hidden = reviewTarget.value !== 'path';
}

function openModal() {
  populateTargets();
  reviewBackdrop.hidden = false;
}

function closeModal() {
  reviewBackdrop.hidden = true;
}

reviewBtn.addEventListener('click', () => {
  if (!state.sessionId || state.busy) return;
  openModal();
});
reviewCancel.addEventListener('click', closeModal);
reviewBackdrop.addEventListener('click', (e) => {
  if (e.target === reviewBackdrop) closeModal();
});
reviewTarget.addEventListener('change', () => {
  reviewPathRow.hidden = reviewTarget.value !== 'path';
});

/** One suggestion card: id, severity + confidence badges, page/location
 *  meta, rationale, action, rebuttal question. */
function renderSuggestion(suggestion, index) {
  const item = document.createElement('div');
  item.className = 'suggestion';

  const head = document.createElement('div');
  head.className = 'suggestion-head';
  const id = document.createElement('strong');
  id.textContent = `${index + 1}. ${suggestion.id}`;
  const sev = document.createElement('span');
  sev.className = `sev sev-${suggestion.severity}`;
  sev.textContent = suggestion.severity;
  const conf = document.createElement('span');
  conf.className = 'conf';
  conf.textContent = `${Math.round(suggestion.confidence * 100)}%`;
  head.append(id, sev, conf);

  const meta = document.createElement('div');
  meta.className = 'suggestion-meta';
  meta.appendChild(document.createTextNode('Page '));
  // In PDF mode the page number jumps to that page in the external viewer.
  const pageBtn = document.createElement('button');
  pageBtn.className = 'jump-page';
  pageBtn.type = 'button';
  pageBtn.dataset.page = String(suggestion.page);
  pageBtn.textContent = String(suggestion.page);
  pageBtn.title = 'Open this page in the system PDF viewer';
  meta.appendChild(pageBtn);
  meta.appendChild(
    document.createTextNode(` · ${suggestion.locationHint} · ${suggestion.targetType}`),
  );

  const rationale = document.createElement('p');
  rationale.className = 'suggestion-rationale';
  rationale.textContent = suggestion.rationale;

  const action = document.createElement('p');
  action.className = 'suggestion-action';
  action.textContent = suggestion.action;

  item.append(head, meta, rationale, action);
  if (suggestion.rebuttalQuestion) {
    const rebuttal = document.createElement('p');
    rebuttal.className = 'suggestion-rebuttal';
    rebuttal.textContent = `Rebuttal question: ${suggestion.rebuttalQuestion}`;
    item.appendChild(rebuttal);
  }
  return item;
}

/** Download the session's last review as a ZIP (report.html + report.json). */
async function downloadReviewZip() {
  const res = await fetch(`/api/session/${state.sessionId}/review/download`, {
    headers: {
      ...(window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = match?.[1] ?? 'review.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** The review card appended under the streamed log lines. */
function renderReviewCard(container, review) {
  const card = document.createElement('div');
  card.className = 'review-card';

  const title = document.createElement('div');
  title.className = 'review-title';
  title.textContent = `Review: ${review.title}`;
  const summary = document.createElement('p');
  summary.className = 'review-summary';
  summary.textContent = review.summary;
  card.append(title, summary);

  const list = document.createElement('div');
  list.className = 'review-suggestions';
  if (review.suggestions.length === 0) {
    const none = document.createElement('p');
    none.className = 'review-summary';
    none.textContent = 'No suggestions — the agent found no issues in the reviewed pages.';
    list.appendChild(none);
  }
  review.suggestions.forEach((s, i) => list.appendChild(renderSuggestion(s, i)));
  card.appendChild(list);

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'review-download';
  download.textContent = 'Download report (.zip)';
  download.title = 'report.html (flat, self-contained) + report.json';
  download.addEventListener('click', async () => {
    download.disabled = true;
    try {
      await downloadReviewZip();
    } catch (e) {
      addSystemMessage(`download failed: ${e.message}`, true);
    } finally {
      download.disabled = false;
    }
  });
  card.appendChild(download);

  container.appendChild(card);
  scrollToBottomIfNear();
}

async function runReview() {
  if (!state.sessionId || state.busy) return;
  const target = reviewTarget.value;
  const pages = reviewPages.value.trim();
  const body = {
    pages: pages || undefined,
    includeImages: reviewImages.checked,
    includeHistory: reviewHistory.checked,
  };
  let label = '';
  if (target === 'path') {
    const p = reviewPath.value.trim();
    if (!p) {
      addSystemMessage('Enter a PDF path first.', true);
      return;
    }
    body.path = p;
    label = p;
  } else if (target === 'active') {
    const p = state.activeDocPath ?? '';
    // In PDF mode show just the file name, not the full path.
    label = PDF_MODE && p ? p.split(/[\\/]/).pop() ?? p : p || 'the active document';
  } else if (target.startsWith('att:')) {
    body.attachmentId = target.slice(4);
    const att = state.pendingAttachments.find((a) => a.id === body.attachmentId);
    label = att?.name ?? 'the attached PDF';
  }
  closeModal();

  addMessage(
    'user',
    `Generate a structured review of ${label}${pages ? ` (pages ${pages})` : ''}`,
  );
  const { textDiv } = addMessage('assistant', '');
  const logDiv = document.createElement('div');
  logDiv.className = 'review-log';
  textDiv.appendChild(logDiv);
  const log = (line) => {
    const div = document.createElement('div');
    div.textContent = line;
    logDiv.appendChild(div);
    scrollToBottomIfNear();
  };

  setBusy(true);
  state.generationStart = Date.now();
  state.agentStart = 0;
  await setKeepAwake(true); // long reviews must not die to the OS sleep timer
  showTyping();
  resetThoughts();
  let streamed = '';
  try {
    const res = await fetch(`/api/session/${state.sessionId}/review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
    }

    // Headers received: PDF text extraction is done and the agent prompt is
    // on its way (the review route starts the SSE stream only after that).
    state.agentStart = Date.now();
    setTypingHint();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
        if (payload.log) {
          log(String(payload.log));
        } else if (payload.thought) {
          // Streamed reasoning: live one-line tail in the typing indicator.
          pushThought(String(payload.thought));
          showTyping();
        } else if (payload.text) {
          streamed += String(payload.text);
        } else if (payload.tool) {
          const t = payload.tool;
          log(t.status === 'completed' ? `Used ${t.title}` : `Using ${t.title}…`);
        } else if (payload.review) {
          hideTyping();
          renderReviewCard(textDiv, payload.review);
        } else if (payload.cancelled) {
          log('Stopped.');
        } else if (payload.error) {
          log(`Error: ${payload.error}`);
          if (streamed) {
            const raw = document.createElement('pre');
            raw.className = 'review-raw';
            raw.textContent = streamed.slice(0, 2000);
            textDiv.appendChild(raw);
          }
        }
      }
    }
  } catch (e) {
    hideTyping();
    maybeSetBusyFromError(e);
    addSystemMessage(`review failed: ${e.message}`, true);
  } finally {
    hideTyping();
    state.generationStart = 0;
    setBusy(false);
    await setKeepAwake(false);
  }
}

reviewRun.addEventListener('click', () => {
  runReview().catch((e) => addSystemMessage(`review failed: ${e.message}`, true));
});

/** Clicking a suggestion's page number jumps to that page in the viewer. */
chat.addEventListener('click', async (e) => {
  if (!PDF_MODE || !state.sessionId || state.busy) return;
  const btn = e.target instanceof Element ? e.target.closest('.jump-page') : null;
  if (!btn || !(btn instanceof HTMLElement)) return;
  const page = Number(btn.dataset.page);
  if (!Number.isInteger(page) || page < 1) return;
  try {
    const r = await api(`/api/session/${state.sessionId}/jump`, {
      method: 'POST',
      body: JSON.stringify({ page }),
    });
    addSystemMessage(`Opened page ${page} in ${r.viewer ?? 'the viewer'}`);
  } catch (err) {
    addSystemMessage(`jump failed: ${err.message}`, true);
  }
});
