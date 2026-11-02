/**
 * Package the bridge plugin: zip the bridge-plugin folder and rename
 * the archive to .plugin (the ONLYOFFICE Plugin Manager's install
 * format). Output: apps/onlyoffice/acp-bridge.plugin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'bridge-plugin');
const out = path.join(here, '..', 'acp-bridge.plugin');
const tmp = out + '.tmp.zip';

if (fs.existsSync(tmp)) fs.rmSync(tmp);
if (fs.existsSync(out)) fs.rmSync(out);

// Windows: PowerShell Compress-Archive (no archiver dependency).
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path "${path.join(src, '*')}" -DestinationPath "${tmp}" -Force`],
  { stdio: 'inherit' },
);
fs.renameSync(tmp, out);
console.log(`packaged ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);