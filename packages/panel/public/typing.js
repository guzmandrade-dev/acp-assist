'use strict';

// The typing indicator: three animated dots, an elapsed-time hint line, and
// — when the agent streams reasoning (ACP agent_thought_chunk, forwarded as
// {"thought"} SSE frames) — a live one-line tail of that thinking, so even
// the first seconds of a turn read as "working" instead of silence.

import { state, chat } from './state.js';
import { scrollToBottomIfNear } from './messages.js';

function ensureTypingIndicator() {
  if (!state.typingIndicator) {
    const t = document.createElement('div');
    t.className = 'typing';
    // Animated three-dot scale-pulse: a visible "the agent is still
    // working" signal during long generations (the text alone pulses
    // subtly).
    t.innerHTML =
      '<span class="sr-only">Agent is thinking</span>' +
      '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>';
    state.typingIndicator = t;
  }
  return state.typingIndicator;
}

/**
 * The indicator gets a hint line with an elapsed-time readout
 * ("Thinking… 1m 43s"). The clock measures the whole turn
 * (set at stream start, cleared when the turn ends), not just the
 * current indicator stint — tool activity pauses and resumes the
 * indicator without resetting it. The label says which phase the turn
 * is in: until the stream fetch resolves, the server is still doing
 * the editor round-trip ("Reading the document…"); once the agent is
 * prompted (state.agentStart), the label is "Thinking…" / "Still
 * working…" — so a long clock is attributable to the editor or the
 * agent, not lumped together.
 */
function formatElapsed(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, '0')}s`;
}

function typingHintText() {
  const now = Date.now();
  const elapsed = state.generationStart ? now - state.generationStart : 0;
  let text;
  if (!state.agentStart) {
    text = 'Reading the document…';
  } else {
    text = now - state.agentStart < 60_000 ? 'Thinking…' : 'Still working…';
  }
  return `${text} ${formatElapsed(elapsed)}`;
}

/** Refresh the hint line now (also called when the turn's phase flips). */
export function setTypingHint() {
  if (!state.typingIndicator || !state.generationStart) return;
  let hintEl = state.typingIndicator.querySelector('.typing-hint');
  if (!hintEl) {
    hintEl = document.createElement('span');
    hintEl.className = 'typing-hint';
    state.typingIndicator.appendChild(hintEl);
  }
  hintEl.textContent = typingHintText();
}

export function showTyping() {
  const t = ensureTypingIndicator();
  if (!t.parentElement) chat.appendChild(t);
  t.hidden = false;
  setTypingHint();
  if (!state.typingTimer) {
    state.typingTimer = setInterval(() => {
      if (state.typingIndicator && !state.typingIndicator.hidden) setTypingHint();
    }, 1000);
  }
  scrollToBottomIfNear();
}

export function hideTyping() {
  if (state.typingIndicator) state.typingIndicator.hidden = true;
  if (state.typingTimer) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  if (state.typingResumeTimer) {
    clearTimeout(state.typingResumeTimer);
    state.typingResumeTimer = null;
  }
}

export function scheduleTypingResume() {
  if (state.typingResumeTimer) clearTimeout(state.typingResumeTimer);
  state.typingResumeTimer = setTimeout(() => {
    if (state.busy) showTyping();
  }, 1000);
}

// --- streaming thought line --------------------------------------------------
// Agents that expose reasoning send agent_thought_chunk updates; the server
// forwards them as {"thought"} frames. Only a tail is rendered — the last
// non-empty line, truncated — because the full text scrolls far too fast
// to read and is not meant to be read; it is a liveness signal.
const THOUGHT_BUF_MAX = 8000; // chars of thought kept (tail is all we show)
const THOUGHT_LINE_MAX = 140; // chars rendered per line
let thoughtBuf = '';

/** Drop the accumulated thought (called when a new turn/agent step starts). */
export function resetThoughts() {
  thoughtBuf = '';
  state.typingIndicator?.querySelector('.typing-thought')?.remove();
}

function thoughtSnippet() {
  const lines = thoughtBuf.split('\n');
  let line = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) {
      line = l;
      break;
    }
  }
  if (line.length > THOUGHT_LINE_MAX) line = '…' + line.slice(-(THOUGHT_LINE_MAX - 1));
  return line;
}

/**
 * Accumulate one streamed thought chunk and update the indicator's thought
 * line. Cheap enough to run per chunk (a textContent write, no re-render).
 */
export function pushThought(chunk) {
  thoughtBuf += chunk;
  if (thoughtBuf.length > THOUGHT_BUF_MAX) thoughtBuf = thoughtBuf.slice(-THOUGHT_BUF_MAX);
  const snippet = thoughtSnippet();
  if (!snippet) return;
  const t = ensureTypingIndicator();
  let line = t.querySelector('.typing-thought');
  if (!line) {
    line = document.createElement('span');
    line.className = 'typing-thought';
    // The sr-only "Agent is thinking" already announces the state; the
    // streaming tail is visual-only and would spam a screen reader.
    line.setAttribute('aria-hidden', 'true');
    t.appendChild(line);
  }
  line.textContent = snippet;
  scrollToBottomIfNear();
}