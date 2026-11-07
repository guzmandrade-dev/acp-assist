/**
 * One-click install of the bridge .oxt into the user's office suite —
 * LibreOffice by default, or the suite configured via the agent setting
 * `officePath` (Collabora Office, Apache OpenOffice, …; all UNO-based).
 * (AGENTS.md rule 6: `unopkg add` fails if the extension is already
 * installed, so remove first — a failed remove of a not-yet-installed
 * extension is fine). Runs unopkg against the user's REAL profile: the
 * route only calls this after the user clicked a confirm dialog.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE_EXT_ID = 'org.libreofficeacp.bridge';

export interface InstallStep {
  command: string;
  ok: boolean;
  output: string;
}

export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
  message: string;
}

/** Office suites the bridge .oxt can be installed into (all UNO-based). */
export type OfficeVendor = 'libreoffice' | 'collabora' | 'openoffice';

export interface OfficeTarget {
  vendor: OfficeVendor;
  /** Install root (the directory containing `program/`). */
  root: string;
  /** `<root>/program/unopkg[.exe]`. */
  unopkg: string;
}

const UNOPKG_NAME = process.platform === 'win32' ? 'unopkg.exe' : 'unopkg';

/**
 * Detect the suite vendor from `<root>/program/versionrc` (or
 * `version.ini` on Windows), falling back to the install dir name.
 * LibreOffice is the default: every LO derivative that does not identify
 * itself is treated as LibreOffice.
 */
export function detectOfficeVendor(root: string): OfficeVendor {
  for (const name of ['versionrc', 'version.ini']) {
    try {
      const txt = fs.readFileSync(path.join(root, 'program', name), 'utf8').toLowerCase();
      if (txt.includes('collabora')) return 'collabora';
      if (txt.includes('openoffice')) return 'openoffice';
      if (txt.includes('libreoffice')) return 'libreoffice';
    } catch {
      /* no version file — try the next */
    }
  }
  const base = path.basename(root).toLowerCase();
  if (base.includes('collabora')) return 'collabora';
  if (base.includes('openoffice') || base === 'aoo') return 'openoffice';
  return 'libreoffice';
}

/**
 * Resolve a configured office path into an install target. Accepts the
 * install root, the `program/` dir, or the unopkg binary itself.
 * Returns null when no unopkg exists under the given path.
 */
export function resolveOfficeTarget(configured: string): OfficeTarget | null {
  let root = configured.trim();
  if (!root) return null;
  const base = path.basename(root).toLowerCase();
  if (base === 'unopkg' || base === 'unopkg.exe' || base === 'unopkg.com') {
    root = path.dirname(path.dirname(root));
  } else if (base === 'program') {
    root = path.dirname(root);
  }
  const unopkg = path.join(root, 'program', UNOPKG_NAME);
  try {
    if (!fs.existsSync(unopkg)) return null;
  } catch {
    return null;
  }
  return { vendor: detectOfficeVendor(root), root, unopkg };
}

/**
 * The per-user profile ROOT for a vendor: the directory whose versioned
 * children each hold a `user/` dir (e.g. `%APPDATA%\LibreOffice\4\user`,
 * `%APPDATA%\OpenOffice\4\user`). Best-known conventions per platform;
 * non-standard layouts can always be pinned with LO_USER_PROFILE.
 */
export function officeProfileRoot(vendor: OfficeVendor): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    if (vendor === 'collabora') return path.join(appdata, 'Collabora');
    if (vendor === 'openoffice') return path.join(appdata, 'OpenOffice');
    return path.join(appdata, 'LibreOffice');
  }
  if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    if (vendor === 'collabora') return path.join(sup, 'Collabora');
    if (vendor === 'openoffice') return path.join(sup, 'OpenOffice');
    return path.join(sup, 'LibreOffice');
  }
  const cfg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  if (vendor === 'collabora') return path.join(cfg, 'collabora');
  if (vendor === 'openoffice') return path.join(cfg, 'openoffice');
  return path.join(cfg, 'libreoffice');
}

/**
 * Whether the target office bundles its own Python (the bridge is a
 * Python UNO component; Apache OpenOffice on Windows does not).
 */
export function officeHasBundledPython(target: OfficeTarget): boolean {
  const names = process.platform === 'win32' ? ['python.exe', 'python'] : ['python', 'python.bin'];
  return names.some((n) => {
    try {
      return fs.existsSync(path.join(target.root, 'program', n));
    } catch {
      return false;
    }
  });
}

/**
 * Locate unopkg: a configured officePath (agent setting `officePath`)
 * wins, then LO_UNOPKG, then the standard LibreOffice install dirs.
 */
export function findUnopkg(officePath?: string | null): string | null {
  if (officePath) {
    const target = resolveOfficeTarget(officePath);
    if (target) return target.unopkg;
    // configured path invalid — fall through to auto-detection; the
    // preflight route reports which unopkg was actually used
  }
  const candidates: string[] = [];
  if (process.env.LO_UNOPKG) candidates.push(process.env.LO_UNOPKG);
  if (process.platform === 'win32') {
    const root = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    candidates.push(
      path.join(root, 'LibreOffice', 'program', 'unopkg.exe'),
      'C:\\Program Files (x86)\\LibreOffice\\program\\unopkg.exe',
    );
  } else {
    candidates.push('/usr/bin/unopkg', '/usr/local/bin/unopkg',
      '/Applications/LibreOffice.app/Contents/MacOS/unopkg');
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return null;
}

/** Best-effort check for a running LibreOffice (unopkg wants it closed). */
export async function sofficeRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    const out = await run(['tasklist', '/FI', 'IMAGENAME eq soffice.bin', '/FO', 'CSV', '/NH'], 15_000);
    return /soffice\.bin/i.test(out.output);
  }
  try {
    await run(['pgrep', '-x', 'soffice.bin'], 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the office user profile directory (the `user/` dir inside the
 * versioned profile root). Returns null when no profile exists yet.
 * LO_USER_PROFILE env override wins (tests, custom installs); a
 * configured officePath picks the profile root of that suite's vendor
 * (LibreOffice / Collabora / OpenOffice) before the LibreOffice default.
 */
export function findLoUserProfile(officePath?: string | null): string | null {
  if (process.env.LO_USER_PROFILE) return process.env.LO_USER_PROFILE;
  const roots: string[] = [];
  if (officePath) {
    const target = resolveOfficeTarget(officePath);
    if (target) roots.push(officeProfileRoot(target.vendor));
  }
  roots.push(officeProfileRoot('libreoffice'));
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        const userDir = path.join(root, entry, 'user');
        if (fs.statSync(userDir).isDirectory()) return userDir;
      }
    } catch {
      /* profile root not present — try next */
    }
  }
  return null;
}

/**
 * Delete LibreOffice's extension package state under
 * `<profile>/user/uno_packages/`: the `cache/` directory (package-registry
 * backend DBs + unpacked oxt copies) AND the `uno_packages.pmap` package
 * map. Two reasons:
 *
 * 1. `unopkg remove` cleans the backend DBs but NOT the pmap or the
 *    unpacked cache dirs — a following `unopkg add` then fails with
 *    VersionException "Extension has already been added" because the
 *    pmap still names the identifier (verified live 2026-10-21).
 * 2. LibreOffice builds `cache/` on first launch and does NOT rebuild
 *    it when unopkg adds an extension later — the configuration
 *    PackageRegistryBackend (backenddb.xml) keeps pointing at the old
 *    set of .xcu layers, so the sidebar deck/panel/factory
 *    registrations never reach the runtime config. Deleting the cache
 *    forces the next LibreOffice start to re-read every extension's
 *    .xcu files from scratch.
 *
 * Only safe when LibreOffice is not running (the installer route
 * enforces that with a 409).
 */
export function clearPackageCache(userProfile: string): boolean {
  const unoDir = path.join(userProfile, 'uno_packages');
  let ok = true;
  try {
    fs.rmSync(path.join(unoDir, 'cache'), { recursive: true, force: true });
    ok = ok && !fs.existsSync(path.join(unoDir, 'cache'));
  } catch {
    ok = false;
  }
  try {
    fs.rmSync(path.join(unoDir, 'uno_packages.pmap'), { force: true });
  } catch {
    /* pmap may not exist — that's fine */
  }
  return ok;
}

/** Test hook: override unopkg runner (installBridge reads it per call). */
export let runUnopkgForTesting: ((cmd: string[], timeoutMs: number) => Promise<RunResult>) | null = null;
export function setRunUnopkgForTesting(fn: ((cmd: string[], timeoutMs: number) => Promise<RunResult>) | null): void {
  runUnopkgForTesting = fn;
}

/**
 * Remove-then-add (rule 6). A failing remove of an absent extension is OK.
 * `officePath` (the agent setting of the same name) selects which suite's
 * user profile gets its package cache cleared.
 */
export async function installBridge(unopkgPath: string, oxtPath: string, officePath?: string | null): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  const quoted = (s: string) => (s.includes(' ') ? `"${s}"` : s);
  const doRun = runUnopkgForTesting ?? run;
  const remove = await doRun([unopkgPath, 'remove', BRIDGE_EXT_ID], 120_000);
  steps.push({
    command: `unopkg remove ${BRIDGE_EXT_ID}`,
    ok: true, // absence of the extension is the normal first-run case
    output: remove.output.trim(),
  });
  // unopkg remove cleans the backend DBs but NOT the package map
  // (uno_packages/uno_packages.pmap) nor the unpacked cache dirs
  // (uno_packages/cache/uno_packages/lu*.tmp*). The next `unopkg add`
  // then fails with VersionException "Extension has already been added"
  // because the pmap still names our identifier (verified live
  // 2026-10-21: install removed the old extension but add refused,
  // leaving the profile with NO extension). Wipe both so add starts
  // from a truly clean slate. Also clears the package-registry cache
  // so the next LibreOffice launch re-reads the extension's .xcu
  // config layers (without this the sidebar deck renders empty).
  let cacheCleared = false;
  const profile = getLoUserProfile(officePath);
  if (profile) {
    cacheCleared = clearPackageCache(profile);
    steps.push({
      command: `clear package cache + map (${path.join('uno_packages', 'cache')}, uno_packages.pmap)`,
      ok: true,
      output: cacheCleared ? 'removed' : 'nothing to remove',
    });
  }
  const add = await doRun([unopkgPath, 'add', oxtPath], 120_000);
  steps.push({
    command: `unopkg add ${quoted(path.basename(oxtPath))}`,
    ok: add.ok,
    output: add.output.trim(),
  });
  if (!add.ok) {
    return {
      ok: false,
      steps,
      message: `unopkg add failed (exit ${add.code}): ${add.output.trim().slice(0, 400)}`,
    };
  }
  return {
    ok: true,
    steps,
    message:
      'Extension installed. Restart LibreOffice, then use menu ACP Assist > Start bridge.' +
      (cacheCleared ? ' (Package cache cleared so the sidebar deck registers cleanly.)' : ''),
  };
}

/** Test hook: override the profile lookup (installBridge reads it per call). */
let loUserProfileOverride: string | null | undefined;
export function setLoUserProfileForTesting(profile: string | null): void {
  loUserProfileOverride = profile;
}
function getLoUserProfile(officePath?: string | null): string | null {
  if (loUserProfileOverride !== undefined) return loUserProfileOverride;
  return findLoUserProfile(officePath);
}

interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
}

function run(cmd: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd[0]!, cmd.slice(1), { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out });
    });
  });
}
