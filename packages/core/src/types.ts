/**
 * Shared types for the ACP companion apps (LyX ACP Assist, LibreOffice
 * ACP Assist). Kept as a superset: TurnMeta carries every app's optional
 * fields (target, target2, address, module) so persisted histories from
 * either app type-check against it.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface AgentSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Optional office-suite install target (LibreOffice app only): path to
   * the target office installation root (the dir containing `program/`),
   * to `program/` itself, or directly to its `unopkg` binary. Lets the
   * bridge .oxt install into a LibreOffice derivative such as Collabora
   * Office or into Apache OpenOffice instead of LibreOffice. Empty or
   * absent = auto-detect the standard LibreOffice locations.
   */
  officePath?: string;
  /**
   * Panel UI preference (persisted alongside the agent command because the
   * companion's port is random per launch, so the panel cannot use
   * localStorage): when false, the chat hides the fenced content blocks
   * (the ```lyx / ```writer payload about to be pasted) in assistant
   * replies and renders a placeholder instead. Absent = true (full
   * operation log shown). The recorded history keeps the full text either
   * way — the setting only affects rendering.
   */
  showFullHistory?: boolean;
  /**
   * Max document edits the multi-action loop applies per user message
   * before stopping and asking for "continue" (default
   * MAX_ACTIONS_PER_MESSAGE = 10). Persisted server-side like the agent
   * command; clamped to [1, 50] on read/write.
   */
  maxActionsPerMessage?: number;
  /**
   * Panel preference: when true, the multi-action loop's edits-per-message
   * limit is raised to the hard cap (MAX_ACTIONS_PER_MESSAGE_LIMIT = 50)
   * instead of stopping at the configured limit to ask for "continue"
   * — the agent keeps working unattended. Token-heavy on long documents
   * (every extra step is a full agent turn over the whole context), so
   * default false and the hard cap still applies.
   */
  autoContinueEdits?: boolean;
  /**
   * Panel preference (Electron shell only): while a message/review run is
   * in flight, hold a power-save blocker so the computer does not sleep
   * mid-run (long documents, multi-edit batches). The panel calls
   * window.electron.keepAwake(true/false) around each run; in standalone
   * browser mode the API is absent and the setting does nothing.
   * Default false.
   */
  keepAwakeWhileBusy?: boolean;
}

/**
 * Context-window usage reported by the agent mid-turn (ACP
 * `usage_update`). Agents that do not report usage never produce it;
 * the panel simply shows nothing then.
 */
export interface UsageInfo {
  /** Tokens currently in context. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
  /** Cumulative session cost, when the agent reports one. */
  cost: { amount: number; currency: string } | null;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Names of files the user attached to this turn (user turns only). */
  attachments?: string[];
  /**
   * Outcome of the action the assistant proposed in this turn, recorded
   * after the action was applied (or failed). Absent on older histories
   * and on turns before this feature existed.
   */
  meta?: TurnMeta;
}

/** How the action a turn proposed was resolved against the document. */
export interface TurnMeta {
  /** The action tag the agent emitted, e.g. "insert", "move", "none". */
  action: string;
  /** Paragraph address for addressed actions ([pN]). */
  target?: number | null;
  /** Destination address for move/merge ([pM]). Writer (LyX) only. */
  target2?: number | null;
  /** Calc: A1 anchor address, when the tag carried one. */
  address?: string | null;
  /** Active bridge module (writer/calc/impress/draw) for UI labels. */
  module?: string | null;
  /** "applied" when the action landed in the document, "error" otherwise. */
  result: 'applied' | 'error' | 'cancelled';
  /** The error message when result is "error". */
  error?: string;
  /** Which edit of a multi-action run this turn is (1-based). */
  step?: number;
}

/** Minimal agent surface the server needs (AcpClient satisfies this). */
export interface AgentRunner {
  start(): Promise<void>;
  stop(): void;
  createSession(sessionId: string): Promise<void>;
  cancel(sessionId: string): void;
  prompt(
    sessionId: string,
    content: ContentBlock[],
    options?: {
      onChunk?: (chunk: string) => void;
      /** Reasoning chunks (agent_thought_chunk), streamed like text. */
      onThought?: (chunk: string) => void;
      onToolCall?: (tool: { title: string; status: string; kind: string }) => void;
      /** Context-window usage snapshots (ACP usage_update), when supported. */
      onUsage?: (usage: UsageInfo) => void;
      timeoutMs?: number;
    },
  ): Promise<string>;
}

/** A file the user attached to the next message. */
export interface Attachment {
  id: string;
  name: string;
  /** Absolute path of the stored file (agents with file tools can read it). */
  path: string;
  /** Extracted markdown/plain text, when conversion succeeded. */
  text: string | null;
}