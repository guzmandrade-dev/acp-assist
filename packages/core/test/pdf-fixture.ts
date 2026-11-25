/**
 * Test helper: build a small valid PDF whose pages carry the given text.
 * A page string may contain `\n` — each line becomes its own text line on
 * the page (one Tj at a decreasing y), so multi-line pages extract fully
 * instead of being clipped at the page's right edge.
 */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentIds = pages.map((text) => {
    const lines = text.split('\n');
    const stream = lines
      .map((line, i) => `BT /F1 18 Tf 72 ${720 - 18 * i} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`)
      .join('\n');
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const pageIds = contentIds.map((cid) =>
    add(
      `<< /Type /Page /Parent PAGES 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${cid} 0 R >>`,
    ),
  );
  const pagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  for (const pid of pageIds) {
    objects[pid - 1] = (objects[pid - 1] ?? '').replace('PAGES 0 R', `${pagesId} 0 R`);
  }
  const catId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
