/**
 * Image helpers for the writer insert-image action: sniff pixel dimensions
 * from PNG/GIF/JPEG bytes (no decoder dependency) and data-URI conversion.
 * Shared by the LibreOffice and ONLYOFFICE apps so both companions resolve
 * `image:` sources the same way (OO needs EMU sizes for CreateImage, LO
 * needs 1/100 mm and a file:// URL for GraphicURL).
 */

/** Decode a data: URI into { mime, bytes }. Null when malformed. */
export function parseDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  try {
    if (m[2]) {
      const bin = atob(m[3] ?? '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3] ?? '')) };
  } catch {
    return null;
  }
}

/** Encode bytes as a data: URI. */
export function toDataUri(mime: string, bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Sniff pixel dimensions from PNG/GIF/JPEG bytes. Null when unknown. */
export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  // PNG: 8-byte signature, then IHDR width/height big-endian at offset 16
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const w = ((bytes[16] ?? 0) << 24) | ((bytes[17] ?? 0) << 16) | ((bytes[18] ?? 0) << 8) | (bytes[19] ?? 0);
    const h = ((bytes[20] ?? 0) << 24) | ((bytes[21] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[23] ?? 0);
    if (w > 0 && h > 0) return { width: w >>> 0, height: h >>> 0 };
    return null;
  }
  // GIF: logical screen descriptor, little-endian at offset 6
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const w = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
    const h = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }
  // JPEG: scan markers for SOF0..SOF15 (0xFFC0-0xFFCF except C4/C8/CC)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
        const w = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
        if (w > 0 && h > 0) return { width: w, height: h };
        return null;
      }
      const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      i += 2 + len;
    }
  }
  return null;
}

/** Parse a `width:`/`height:` block value into centimeters. Supports
 * "10cm", "4in"/"4"" (inches), "300px" (at 96 dpi). Null when invalid. */
export function sizeToCm(raw: string): number | null {
  const m = /^\s*([\d.]+)\s*(cm|in|inch|"|px)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'cm').toLowerCase();
  if (unit === 'cm') return n;
  if (unit === 'in' || unit === 'inch' || unit === '"') return n * 2.54;
  if (unit === 'px') return (n / 96) * 2.54;
  return null;
}

/** Default display size in cm for an image: natural size at 96 dpi, capped
 * to maxWidthCm; falls back to a 10 cm square when dimensions are unknown. */
export function defaultImageSizeCm(
  bytes: Uint8Array | null,
  maxWidthCm = 16,
): { widthCm: number; heightCm: number } {
  const px = bytes ? sniffImageSize(bytes) : null;
  if (!px) return { widthCm: 10, heightCm: 10 };
  const wCm = (px.width / 96) * 2.54;
  const hCm = (px.height / 96) * 2.54;
  if (wCm <= maxWidthCm) return { widthCm: wCm, heightCm: hCm };
  const scale = maxWidthCm / wCm;
  return { widthCm: maxWidthCm, heightCm: hCm * scale };
}
