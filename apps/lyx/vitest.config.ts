import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Threads pool everywhere for this app: the forks pool intermittently
    // loses a worker to a native abort at startup — 0xC0000409
    // (STATUS_STACK_BUFFER_OVERRUN) on Windows, SIGABRT on Linux — while a
    // pipe-mock file is starting (seen on CI 2026-11-26; on Windows the
    // wedged worker looked like a multi-hour hang). Threads ran clean in
    // repeated local loops (10/10 single-file, 5/5 full suite). No fork
    // isolation is lost: the mock LyX servers are real spawned processes
    // (PowerShell named pipes on Windows, FIFOs elsewhere).
    pool: 'threads',
  },
});
