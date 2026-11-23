'use strict';

// The "start working on this document" modal (LyX save-consent is the
// non-VCS special case of it).
//
// The server saves the live document to disk on every message. The modal
// tells the user that plainly ("we are going to edit this document starting
// right now"), states whether the document is under version control (the
// "no version control" pill in the status bar stays as the persistent
// indicator), and — when the document has previous conversations — lets
// the user pick one or start a new one. For documents outside version
// control the server additionally refuses the message (409
// save-consent-required) until the user accepts, once per document per
// session. Inert consent-wise when CONFIG.hasSaveConsent is false
// (LibreOffice never writes the file — its edits are tracked changes in
// the live buffer).

import {
  CONFIG,
  state,
  vcsWarnEl,
  consentBackdrop,
  consentPathEl,
  consentVcsEl,
  consentSessionsEl,
  consentSessionListEl,
  consentHintEl,
  consentAcceptBtn,
  consentCancelBtn,
} from './state.js';

import { api } from './api.js';

export const HAS_SAVE_CONSENT = Boolean(CONFIG.hasSaveConsent) && Boolean(consentBackdrop);

/** Track the active document + its VCS status; toggle the warning badge.
 *  The active path is tracked even without save-consent (PDF mode uses it
 *  as "the active PDF"); only the VCS warning is gated on HAS_SAVE_CONSENT. */
export function setDocInfo(docPath, versionControlled) {
  state.activeDocPath = docPath || null;
  if (!HAS_SAVE_CONSENT) return;
  state.docVersionControlled = versionControlled ?? null;
  if (vcsWarnEl) vcsWarnEl.hidden = !(state.activeDocPath && state.docVersionControlled === false);
}

// --- the modal ---------------------------------------------------------------

/** Radio choice values with a special meaning (real files are file names). */
const CHOICE_CURRENT = '__current__';
const CHOICE_NEW = '__new__';

function fmtWhen(ts) {
  if (!ts) return 'unknown date';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'unknown date' : d.toLocaleString();
}

function renderSessionChoices(conversations) {
  if (!consentSessionListEl) return;
  consentSessionListEl.innerHTML = '';
  const current = conversations.find((c) => c.active && c.turnCount > 0);
  const previous = conversations.filter((c) => !c.active);

  const mk = (value, checked, label, tooltip) => {
    const row = document.createElement('label');
    row.className = 'session-choice';
    if (tooltip) row.title = tooltip; // full first request on hover
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'session-choice';
    radio.value = value;
    radio.checked = checked;
    const text = document.createElement('small');
    text.textContent = label;
    row.appendChild(radio);
    row.appendChild(text);
    consentSessionListEl.appendChild(row);
  };

  if (current) {
    mk(CHOICE_CURRENT, true, `Continue the current conversation (${current.turnCount} turns)`);
  }
  for (const c of previous) {
    const label = `${fmtWhen(c.lastTimestamp)} — ${c.turnCount} turns — “${c.preview || '…'}”`;
    // The row label ellipsizes visually; the tooltip carries the full text.
    mk(c.file, !current, label, c.preview || label);
  }
  mk(CHOICE_NEW, !current, 'Start a new conversation');
}

function selectedChoice() {
  const checked = consentSessionListEl?.querySelector('input[name="session-choice"]:checked');
  return checked ? String(checked.value) : CHOICE_CURRENT;
}

/**
 * Show the consolidated start-working modal; resolves
 * { accepted, choice } where choice is '__current__', '__new__', or an
 * archived conversation file name.
 */
function showDocModal(docPath, conversations) {
  return new Promise((resolve) => {
    if (consentPathEl) consentPathEl.textContent = docPath ?? '(unsaved document)';

    // Version-control line: informational; the pill in the status bar keeps
    // showing the non-VCS state persistently.
    if (consentVcsEl) {
      if (state.docVersionControlled === true) {
        consentVcsEl.textContent =
          'This document is under version control (Git) — earlier states are recoverable from Git history.';
      } else if (state.docVersionControlled === false) {
        consentVcsEl.textContent =
          'This document is NOT in a version-controlled folder (no Git): saving overwrites the file, and a bad edit has no history to recover from. Keeping it in a Git repository (or making manual backups) is strongly recommended.';
      } else {
        consentVcsEl.textContent = 'Version-control status unknown for this document.';
      }
    }

    // Previous conversations, when any are persisted for this document.
    const list = Array.isArray(conversations) ? conversations : [];
    if (consentSessionsEl) consentSessionsEl.hidden = list.length === 0;
    if (list.length > 0) renderSessionChoices(list);

    if (consentHintEl) {
      consentHintEl.textContent =
        state.docVersionControlled === false
          ? 'Do you accept that this session may save changes to the file? (Asked once per document and session.)'
          : 'Shown once per document and session.';
    }
    if (consentAcceptBtn) {
      consentAcceptBtn.textContent = state.docVersionControlled === false ? 'Accept and start' : 'Start';
    }

    if (consentBackdrop) consentBackdrop.hidden = false;
    consentAcceptBtn?.focus();
    state.consentResolver = (accepted) => {
      if (consentBackdrop) consentBackdrop.hidden = true;
      state.consentResolver = null;
      resolve(accepted ? { accepted: true, choice: selectedChoice() } : { accepted: false, choice: null });
    };
  });
}

consentAcceptBtn?.addEventListener('click', () => state.consentResolver?.(true));
consentCancelBtn?.addEventListener('click', () => state.consentResolver?.(false));
consentBackdrop?.addEventListener('mousedown', (e) => {
  if (e.target === consentBackdrop) state.consentResolver?.(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.consentResolver) state.consentResolver(false);
});

/** POST the save-consent acceptance for a path on the CURRENT session. */
async function postSaveConsent(docPath) {
  try {
    await api(`/api/session/${state.sessionId}/save-consent`, {
      method: 'POST',
      body: JSON.stringify({ path: docPath }),
    });
  } catch {
    /* stale session: the server re-asks via the stream's 409 */
  }
}

/** Ask + register consent for a document path; false when declined. */
export async function requestSaveConsent(docPath) {
  const result = await showDocModal(docPath, []);
  if (!result.accepted) return false;
  state.saveConsentPaths.add(docPath);
  await postSaveConsent(docPath);
  return true;
}

/**
 * Show the consolidated start-working modal (edit notice + VCS status +
 * previous-conversation picker) once per document key per panel session —
 * at connect time and whenever the active document changes, NOT on send.
 * Returns null when the modal was already shown for this document, else
 * { accepted, choice } where `choice` is '__current__', '__new__', or an
 * archived conversation file name. The CALLER applies the choice (see
 * applyDocIntroChoice in conversation.js). Non-VCS documents also register
 * save consent here; the server re-asks via 409 when state was stale.
 */
export async function maybeShowDocIntro() {
  const key = state.chatDocKey ?? state.activeDocPath ?? '(unsaved)';
  if (state.docIntroDone.has(key)) return null;
  state.docIntroDone.add(key);
  if (!consentBackdrop) return { accepted: true, choice: CHOICE_CURRENT };
  let conversations = [];
  if (state.sessionId) {
    try {
      const r = await api(`/api/session/${state.sessionId}/conversations`);
      if (Array.isArray(r.conversations)) conversations = r.conversations;
    } catch {
      /* the list is best-effort — the modal works without it */
    }
  }
  const result = await showDocModal(state.activeDocPath, conversations);
  if (!result.accepted) return { accepted: false, choice: CHOICE_CURRENT };
  if (
    HAS_SAVE_CONSENT &&
    state.activeDocPath &&
    state.docVersionControlled === false &&
    !state.saveConsentPaths.has(state.activeDocPath)
  ) {
    state.saveConsentPaths.add(state.activeDocPath);
    await postSaveConsent(state.activeDocPath);
  }
  return result;
}
