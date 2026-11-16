/**
 * Opening a PDF in the user's own viewer. We deliberately do NOT hook a
 * specific PDF application (Okular's D-Bus is Linux-only, SumatraPDF is
 * Windows-only, Acrobat/Foxit need Pro/commercial SDKs). Instead:
 *
 * - When SumatraPDF is detected on Windows (env override ACP_PDF_VIEWER,
 *   common install paths, or PATH), open/jump through it: `-reuse-instance`
 *   plus `-page <N>` navigates the already-running instance too — the
 *   TextMaker-style "jump to the cited page" experience.
 * - Otherwise fall back to the OS default viewer (`start` / `open` /
 *   `xdg-open`), which just opens the file (no page jump).
 */

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ExternalViewer =
  | { kind: 'sumatra'; exe: string }
  | { kind: 'default' };

/** Injectable seams so tests can run without a real SumatraPDF/OS. */
export interface ViewerDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  existsSync?: (p: string) => boolean;
  /** PATH lookup, e.g. `where SumatraPDF` on Windows. Returns the exe path or null. */
  whichSync?: (cmd: string) => string | null;
  spawnFn?: typeof spawn;
}

/** Env var that forces a specific PDF viewer executable. */
export const VIEWER_ENV_VAR = 'ACP_PDF_VIEWER';

/** Candidate install locations for SumatraPDF on Windows. */
function sumatraCandidates(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'] ?? path.join(env['USERPROFILE'] ?? 'C:\\Users\\user', 'AppData', 'Local');
  candidates.push(
    path.join(pf, 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(pf86, 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(localAppData, 'Programs', 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(localAppData, 'SumatraPDF', 'SumatraPDF.exe'),
  );
  return candidates;
}

/** Locate SumatraPDF.exe; null when unavailable (non-Windows, not installed). */
export function findSumatraPdf(deps: ViewerDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const whichSync = deps.whichSync ?? ((cmd) => {
    try {
      const out = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
      const first = (out.stdout ?? '').split(/\r?\n/)[0]?.trim();
      return out.status === 0 && first ? first : null;
    } catch {
      return null;
    }
  });
  const override = env[VIEWER_ENV_VAR];
  if (override && existsSync(override)) return override;
  for (const candidate of sumatraCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return whichSync('SumatraPDF') ?? whichSync('SumatraPDF.exe');
}

let cachedViewer: ExternalViewer | null = null;

/** Detect which external viewer to use (cached for real, un-injected calls). */
export function detectExternalViewer(deps?: ViewerDeps): ExternalViewer {
  if (!deps) {
    cachedViewer ??= detectExternalViewer({});
    return cachedViewer;
  }
  const exe = findSumatraPdf(deps);
  return exe ? { kind: 'sumatra', exe } : { kind: 'default' };
}

export function describeViewer(viewer: ExternalViewer): string {
  return viewer.kind === 'sumatra' ? 'SumatraPDF' : 'system default viewer';
}

/** The exact command that opens `pdfPath` (optionally at `page`) in the viewer. */
export function buildViewerCommand(
  viewer: ExternalViewer,
  pdfPath: string,
  page?: number,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[]; options: SpawnOptions } {
  if (viewer.kind === 'sumatra') {
    // -reuse-instance routes the navigation to the already-running
    // instance; -page <N> jumps to the page in it.
    return {
      cmd: viewer.exe,
      args: ['-reuse-instance', ...(page && page >= 1 ? ['-page', String(page)] : []), pdfPath],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    };
  }
  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '""', pdfPath], options: { detached: true, stdio: 'ignore', windowsHide: true } };
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [pdfPath], options: { detached: true, stdio: 'ignore' } };
  }
  return { cmd: 'xdg-open', args: [pdfPath], options: { detached: true, stdio: 'ignore' } };
}

/**
 * Open `pdfPath` in the external viewer, jumping to `page` when the
 * viewer supports it (SumatraPDF). Never throws for a missing viewer —
 * detection already fell back to the OS default.
 */
export async function openPdfExternally(
  pdfPath: string,
  page?: number,
  deps: ViewerDeps = {},
): Promise<{ viewer: ExternalViewer }> {
  const viewer = detectExternalViewer(deps);
  const { cmd, args, options } = buildViewerCommand(viewer, pdfPath, page, deps.platform ?? process.platform);
  const spawnFn = deps.spawnFn ?? spawn;
  const child = spawnFn(cmd, args, options);
  child.unref?.();
  return { viewer };
}
