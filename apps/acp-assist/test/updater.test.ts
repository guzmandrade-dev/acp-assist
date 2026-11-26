/**
 * Tests for the pure updater logic (updater-core.ts): version
 * normalization/comparison, per-platform asset picking, and the check
 * result built from a GitHub `releases/latest` payload. The Electron
 * wiring (updater.ts) is a thin shell over these.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCheckResult,
  compareVersions,
  normalizeVersion,
  pickAsset,
  type GhRelease,
} from '../src/electron/updater-core.js';

describe('normalizeVersion', () => {
  it('strips the leading v and prerelease suffix', () => {
    expect(normalizeVersion('v1.16.0')).toBe('1.16.0');
    expect(normalizeVersion('1.16.0')).toBe('1.16.0');
    expect(normalizeVersion('V2.0.0-beta.1')).toBe('2.0.0');
  });
});

describe('compareVersions', () => {
  it('compares dotted numeric versions', () => {
    expect(compareVersions('1.16.0', '1.15.9')).toBe(1);
    expect(compareVersions('1.15.9', '1.16.0')).toBe(-1);
    expect(compareVersions('1.16.0', '1.16.0')).toBe(0);
    expect(compareVersions('v1.16.0', '1.16.0')).toBe(0);
    expect(compareVersions('1.16', '1.16.0')).toBe(0);
    expect(compareVersions('1.16.0', '1.16.1')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });
});

const ASSETS = [
  { name: 'ACP Assist Setup 1.17.0.exe', browser_download_url: 'https://x/setup.exe', size: 100 },
  { name: 'ACP Assist 1.17.0.exe', browser_download_url: 'https://x/portable.exe', size: 90 },
  { name: 'ACP Assist-1.17.0.dmg', browser_download_url: 'https://x/app.dmg', size: 200 },
  { name: 'ACP Assist-1.17.0-mac.zip', browser_download_url: 'https://x/app.zip', size: 180 },
  { name: 'ACP Assist-1.17.0.AppImage', browser_download_url: 'https://x/app.AppImage', size: 300 },
  { name: 'acp-bridge.oxt', browser_download_url: 'https://x/bridge.oxt', size: 10 },
];

describe('pickAsset', () => {
  it('prefers the nsis setup exe on Windows over the portable exe', () => {
    const a = pickAsset(ASSETS, 'win32');
    expect(a?.name).toBe('ACP Assist Setup 1.17.0.exe');
  });
  it('prefers the dmg on macOS, falling back to the zip', () => {
    expect(pickAsset(ASSETS, 'darwin')?.name).toBe('ACP Assist-1.17.0.dmg');
    const noDmg = ASSETS.filter((a) => !a.name.endsWith('.dmg'));
    expect(pickAsset(noDmg, 'darwin')?.name).toBe('ACP Assist-1.17.0-mac.zip');
  });
  it('returns null on Linux (link to the releases page instead)', () => {
    expect(pickAsset(ASSETS, 'linux')).toBeNull();
  });
  it('ignores non-installer assets like the bridge oxt/plugin', () => {
    const only = [ASSETS[5]!];
    expect(pickAsset(only, 'win32')).toBeNull();
    expect(pickAsset(only, 'darwin')).toBeNull();
  });
});

describe('buildCheckResult', () => {
  const release: GhRelease = {
    tag_name: 'v1.17.0',
    html_url: 'https://github.com/guzmandrade-dev/acp-assist/releases/tag/v1.17.0',
    assets: ASSETS,
  };

  it('flags an update and picks the Windows asset', () => {
    const r = buildCheckResult('1.16.0', release, 'win32');
    expect(r.updateAvailable).toBe(true);
    expect(r.latest).toBe('1.17.0');
    expect(r.asset?.name).toBe('ACP Assist Setup 1.17.0.exe');
    expect(r.assetSkipReason).toBeNull();
    expect(r.releaseUrl).toContain('/tag/v1.17.0');
  });

  it('flags an update on Linux but skips the download (releases page)', () => {
    const r = buildCheckResult('1.16.0', release, 'linux');
    expect(r.updateAvailable).toBe(true);
    expect(r.asset).toBeNull();
    expect(r.assetSkipReason).toBe('linux');
  });

  it('reports up-to-date when the release is not newer', () => {
    const r = buildCheckResult('1.17.0', release, 'win32');
    expect(r.updateAvailable).toBe(false);
    expect(r.asset).toBeNull();
    expect(r.latest).toBe('1.17.0');
  });

  it('handles no published release (drafts are invisible to the API)', () => {
    const r = buildCheckResult('1.16.0', null, 'win32');
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBeNull();
    expect(r.assetSkipReason).toBe('no-release');
  });

  it('marks no-match when a newer release has no asset for the platform', () => {
    const r = buildCheckResult('1.16.0', { ...release, assets: [ASSETS[5]!] }, 'darwin');
    expect(r.updateAvailable).toBe(true);
    expect(r.assetSkipReason).toBe('no-match');
  });
});
