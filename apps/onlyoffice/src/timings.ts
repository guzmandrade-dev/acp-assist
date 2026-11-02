/**
 * ONLYOFFICE app timings (see the LibreOffice app's TIMINGS for the
 * pattern; the plugin bridge adds long-poll and op timeouts).
 */

export const TIMINGS = {
  /** Agent prompt budget; a stuck agent surfaces an error instead of hanging. */
  promptTimeoutMs: 240_000,
  /** Wait for a plugin op result (context reads, edits, undo probe). */
  opTimeoutMs: 30_000,
  /** The plugin's /bridge/next long-poll window the server honors. */
  pluginPollWaitSec: 20,
  /** A plugin that has not polled for this long is considered gone. */
  pluginStaleMs: 30_000,
  pollIntervalMs: 50,
} as const;