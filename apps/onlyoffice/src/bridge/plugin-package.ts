/**
 * Read metadata from a bundled .plugin package (a plain zip renamed) —
 * without a zip dependency: scan the end-of-central-directory record,
 * walk the central directory to `config.json`, then inflate that one
 * entry. Used to tell the user which bridge plugin version the app ships
 * (the "Download bridge" flow compares it with the connected plugin's
 * hello version).
 */

import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** The `version` field of a .plugin package's config.json; null when the
 * file is missing, not a zip, or has no readable config.json. */
export async function readPluginVersion(pluginPath: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(pluginPath);
  } catch {
    return null;
  }
  return readPluginVersionFromBuffer(buf);
}

export function readPluginVersionFromBuffer(buf: Buffer): string | null {
  // EOCD: scan the last 64 KiB for the signature (comment may follow it).
  const from = Math.max(0, buf.length - 0x10000 - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === 'config.json') return inflateEntry(buf, localOff, method, compSize);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function inflateEntry(buf: Buffer, localOff: number, method: number, compSize: number): string | null {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) return null;
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);
  try {
    const raw = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw.toString('utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}
