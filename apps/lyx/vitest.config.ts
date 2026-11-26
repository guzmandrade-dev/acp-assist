import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default forks pool crashes intermittently on Windows with exit code
    // 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) during worker startup — observed
    // 2026-11-26 while chasing a CI hang (run 45824045623). The threads pool
    // ran 10/10 clean locally. Nothing here relies on fork isolation: the mock
    // LyX servers are real spawned processes (PowerShell named pipes / FIFOs),
    // not in-process fakes.
    pool: process.platform === 'win32' ? 'threads' : 'forks',
  },
});
