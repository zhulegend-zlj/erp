
import XLSX from 'xlsx';
import fs from 'node:fs';
const dir = 'D:/AI/采购/extracted/2026年采购单/2026.07(V3+SQ+BPK+USB)/V3   5276套269174';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xls'));
for (const f of files) {
  const wb = XLSX.readFile(dir + '/' + f, { type: 'buffer', codepage: 936 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const found: Record<string, string> = {};
  let payment = '';
  for (const r of rows) {
    for (const c of r) {
      const s = String(c).trim();
      if (s.startsWith('TO:') && !found.to) found.to = s.slice(3).trim();
      if (s.startsWith('ATTN:') && !found.attn) found.attn = s.slice(5).trim();
      if (s.startsWith('TEL:') && !found.tel) found.tel = s.slice(4).trim();
      if (s.startsWith('FAX:') && !found.fax) found.fax = s.slice(4).trim();
      if (s.startsWith('E-mail:') && !found.email) found.email = s.slice(7).trim();
      if (s.startsWith('付款方式') && !payment) { const m = s.match(/付款方式[：:]\s*(.+)/); if (m) payment = m[1].trim(); }
    }
  }
  const sn = f.replace(/\.xls$/, '').split('-').pop()!.trim();
  console.log(sn + ' | TO=' + (found.to || '⛔无') + ' | ATTN=' + (found.attn || '-') + ' | TEL=' + (found.tel || '-') + ' | FAX=' + (found.fax || '-') + ' | EMAIL=' + (found.email || '-') + ' | 付款=' + (payment || '月结'));
}
