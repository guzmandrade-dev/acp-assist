import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Threads on Windows, forks elsewhere. The forks pool intermittently lost
    // a worker to a native abort (0xC0000409 on Windows, SIGABRT on Linux) —
    // root-caused to double fd closes (uv_fs_close), fixed 2026-11-26; but the
    // threads pool on Linux hangs at worker teardown after the pipe-mock suite
    // (transport child / FIFO handles keep the thread alive), so Linux keeps
    // forks, which vitest can force-kill per file.
    pool: process.platform === 'win32' ? 'threads' : 'forks',
  },
});
