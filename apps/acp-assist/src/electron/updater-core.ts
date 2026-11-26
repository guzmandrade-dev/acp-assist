/**
 * Pure update-check logic for the unified app's "download the release
 * asset" updater — no Electron imports here so vitest can run it in
 * plain Node. The Electron wiring (IPC, fetch, download) lives in
 * updater.ts and calls these helpers.
 *
 * Design: the CI release job publishes the packaged builds as assets on
 * a GitHub release (tag vX.Y.Z). The app asks the GitHub API for the
 * latest release, compares semver with its own version, and picks the
 * asset matching the current platform. Windows/macOS download the
 * installer (nsis .exe / .dmg) and hand it to the OS; Linux has no
 * safe auto-install (AppImage/deb need root or manual steps), so there
 * the app just opens the GitHub releases page.
 *
 * NOTE: the public `releases/latest` endpoint only sees PUBLISHED
 * releases — drafts (the CI default) are invisible to it. Auto-update
 * therefore requires the release to be flipped to published.
 */

/** GitHub repo that hosts the release builds (owner/name). */
export const REPO = 'guzmandrade-dev/acp-assist';

export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateCheckResult {
  /** The running app's version. */
  current: string;
  /** Latest published release tag, version-normalized (no leading v). Null when none. */
  latest: string | null;
  /** True when latest > current. */
  updateAvailable: boolean;
  /** Web page of the latest release (always set when latest != null). */
  releaseUrl: string | null;
  /**
   * The asset to download for this platform, or null on Linux (and when
   * no matching asset exists) — then the releases page is the action.
   */
  asset: ReleaseAsset | null;
  /** Why no asset: 'linux' (link-only by design) | 'no-match' | 'no-release'. */
  assetSkipReason: 'linux' | 'no-match' | 'no-release' | null;
}

/** Shape of the GitHub `releases/latest` response we care about. */
export interface GhRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string; size: number }[];
}

/** Strip a leading 'v'/'V' and any prerelease suffix for comparison. */
export function normalizeVersion(tag: string): string {
  const v = tag.trim().replace(/^[vV]/, '');
  return v.split('-')[0] ?? v;
}

/**
 * Compare two dotted numeric versions: -1 when a < b, 0 when equal,
 * 1 when a > b. Non-numeric parts compare as strings; missing segments
 * count as 0 ('1.16' == '1.16.0').
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.');
  const pb = normalizeVersion(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? '0';
    const nb = pb[i] ?? '0';
    const xa = Number.parseInt(na, 10);
    const xb = Number.parseInt(nb, 10);
    if (Number.isNaN(xa) || Number.isNaN(xb)) {
      const cmp = na.localeCompare(nb);
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Pick the release asset to download for the current platform.
 * win32: the nsis installer (an .exe whose name contains 'setup') over
 *        the portable .exe. darwin: the .dmg (fallback: the zip).
 * linux: null — Linux installs are manual (link to the releases page).
 */
export function pickAsset(
  assets: { name: string; browser_download_url: string; size: number }[],
  platform: NodeJS.Platform,
): ReleaseAsset | null {
  const lower = assets.map((a) => ({ ...a, lname: a.name.toLowerCase() }));
  if (platform === 'win32') {
    const exe = lower.filter((a) => a.lname.endsWith('.exe'));
    const setup = exe.find((a) => a.lname.includes('setup')) ?? exe[0];
    return setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size } : null;
  }
  if (platform === 'darwin') {
    const dmg = lower.find((a) => a.lname.endsWith('.dmg')) ?? lower.find((a) => a.lname.endsWith('.zip'));
    return dmg ? { name: dmg.name, url: dmg.browser_download_url, size: dmg.size } : null;
  }
  // linux and anything else: no download, link to the releases page.
  return null;
}

/** Build the check result from a fetched GitHub release. */
export function buildCheckResult(
  current: string,
  release: GhRelease | null,
  platform: NodeJS.Platform,
): UpdateCheckResult {
  if (!release) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      asset: null,
      assetSkipReason: 'no-release',
    };
  }
  const latest = normalizeVersion(release.tag_name);
  const updateAvailable = compareVersions(latest, current) > 0;
  const assets = release.assets ?? [];
  const asset = updateAvailable ? pickAsset(assets, platform) : null;
  return {
    current,
    latest,
    updateAvailable,
    releaseUrl: release.html_url || `${RELEASES_PAGE}/tag/${release.tag_name}`,
    asset,
    assetSkipReason: !updateAvailable ? null : asset ? null : platform === 'linux' ? 'linux' : 'no-match',
  };
}

/** Fetch the latest published release from the GitHub API (main process). */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<GhRelease | null> {
  const res = await fetchImpl(LATEST_RELEASE_API, {
    headers: {
      accept: 'application/vnd.github+json',
      // The GitHub API rejects requests without a User-Agent.
      'user-agent': 'acp-assist-updater',
    },
  });
  // 404 = no published release yet (drafts are invisible to this endpoint).
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub releases API: ${res.status} ${res.statusText}`);
  return (await res.json()) as GhRelease;
}
