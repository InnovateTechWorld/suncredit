// A small PDF writer for the retirement certificate. Plain text, three built-in fonts, one page.
// It replaces a PDF library so the same code runs on Node and on Cloudflare Workers.
const W = 595, Hh = 842;
const ascii = (s) => String(s).replace(/CO₂/g, 'CO2').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e\xb7]/g, '?');
const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\xb7/g, '\\267');
const wrap = (text, max) => { const out = []; let line = ''; for (const w of String(text).split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out; };

export function certificatePdf({ code, issuedText, registryRef, tonnes, credits }) {
  const ops = [];
  const text = (font, size, x, y, s, rgb = '0.11 0.16 0.13') => ops.push(`BT /${font} ${size} Tf ${rgb} rg ${x} ${Hh - y} Td (${esc(s)}) Tj ET`);
  ops.push('0.18 0.29 0.23 RG 1 w 28 28 539 786 re S');
  text('F2', 11, 56, 80, 'SUNCREDIT  ·  NIGERIA SOLAR CARBON REGISTRY');
  text('F2', 30, 56, 130, 'Certificate of retirement');
  let y = 172;
  for (const l of wrap(`This certifies that ${tonnes} tonne${tonnes > 1 ? 's' : ''} of CO2 avoided by solar systems replacing diesel generators and grid power in Nigeria have been permanently retired.`, 78)) { text('F1', 12, 56, y, l, '0.27 0.34 0.29'); y += 17; }
  y += 18;
  text('F2', 11, 56, y, `Certificate   ${code}`); y += 18;
  text('F1', 11, 56, y, `Issued   ${issuedText}`); y += 16;
  text('F1', 11, 56, y, `Registry reference   ${registryRef || '-'}`); y += 30;
  text('F2', 11, 56, y, 'Retired serial numbers'); y += 18;
  for (const c of credits.slice(0, 40)) { text('F3', 10, 56, y, `${c.serial}   ${c.origin_month}   ${c.region}`); y += 14; }
  if (credits.length > 40) text('F3', 10, 56, y, `... and ${credits.length - 40} more`);
  text('F1', 10, 56, 800, 'Verify any serial at /verify/<serial>. No personal data is published.', '0.27 0.34 0.29');

  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hh}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 255); // every character is Latin-1, so one byte each
}
