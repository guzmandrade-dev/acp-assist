/**
 * One place for the app's magic timings (they were scattered
 * as inline literals before: 240s prompts, 8s pipe, 500ms deaf probe,
 * 150/600ms write-only graces, poll caps).
 */

export const TIMINGS = {
  /** Agent prompt budget; a stuck agent surfaces an error instead of hanging. */
  promptTimeoutMs: 240_000,
  /** One LFUN round-trip before "No reply from LyX". */
  pipeTimeoutMs: 8_000,
  /** start()'s probe window deciding pipe vs. write-only mode. */
  deafProbeMs: 500,
  /**
   * Write-only mode: blind-command grace (file ops use 4x, see graceFor).
   * LyX dispatches pipe commands on its GUI thread and each one triggers a
   * view update; a tight burst can leave the GUI thread busy for ~2s, which
   * Windows shows as a transient "not responding" grey-out when the LyX
   * window is activated right after a run (live-reported 2026-11-08).
   * 300ms spreads the burst enough to avoid it.
   */
  writeOnlyGraceMs: 300,
  /** Wait for the x-lyx payload to appear after a copy LFUN. */
  clipboardPayloadPollMs: 500,
  /** Wait for the switched document to become active. */
  documentSwitchPollMs: 2_000,
  /** pollUntil() cadence. */
  pollIntervalMs: 25,
} as const;
