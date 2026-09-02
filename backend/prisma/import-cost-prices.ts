
import XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// load .env for pg_dump
const envTxt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envTxt.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const p = new PrismaClient();
const parts = await p.part.findMany({ select: { id: true, sku: true, name: true, price: true, priceInclTax: true, supplierId: true } });
const sups = await p.supplier.findMany({ select: { id: true, name: true, shortName: true } });
const supName = new Map(sups.map(s => [s.id, s.name]));
const norm = (s: string) => String(s ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
const partBySku = new Map<string, any>();
for (const x of parts) partBySku.set(norm(x.sku), x);

const XLSX_PATH = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/产品成本单价(更新含税价).xlsx';
const wb = XLSX.readFile(XLSX_PATH);
const SHEETS = ['APM', 'V3', 'V3I', 'SQ', 'PHUB', 'USB', 'BPK'];

// supplier code anchors (sku -> col8 code), majority vote
const ANCHOR = new Map<string, string>();
const A: [string, string][] = [
  ['BBUH-10329','CX'],['BBUH-11757','CX'],['BBUH-10330','CX'],['BBUH-10590','CX'],['BBUH-8230','CX'],['P1806-11178','CX'],
  ['CSP-027','LZ'],['CSP-209','LZ'],['CSP-210','LZ'],
  ['CSP-011','MKJ'],['CSP-018','MKJ'],['CSP-019','MKJ'],['CSP-020','MKJ'],['CSP-021','MKJ'],['CSP-022','MKJ'],['CSP-023','MKJ'],['CSP-024','MKJ'],['CSP-028','MKJ'],['CSP-029','MKJ'],['CSP-038','MKJ'],['CSP-043','MKJ'],['CSP-044','MKJ'],['CSP-045','MKJ'],['CSP-070','MKJ'],['CSP-099','MKJ'],['CSP-103','MKJ'],['CSP-105','MKJ'],['CSP-121','MKJ'],['CSP-127','MKJ'],['CSP-128','MKJ'],
  ['CSP-005','MY'],['CSP-006','MY'],['CSP-010','MY'],['CSP-066','MY'],['CSP-067','MY'],['CSP-068','MY'],['CSP-117d','MY'],
  ['BBUH-8411','GJ'],['BBUH-8460','GJ'],['CSP-071','GJ'],['CSP-072','GJ'],['CSP-033','GJ'],['CSP-040','GJ'],['CSP-116','GJ'],['CSS-037','GJ'],['CSS-045','GJ'],['CSS-049','GJ'],
  ['CSP-003','XJ'],['CSP-012','XJ'],['CSP-014','XJ'],['CSP-016','XJ'],['CSP-031','XJ'],['CSP-039','XJ'],['CSP-042','XJ'],['CSP-063','XJ'],['CSP-065','XJ'],['CSP-089','XJ'],['CSP-091','XJ'],['CSP-092','XJ'],['CSP-094','XJ'],['CSP-109','XJ'],['CSP-119','XJ'],['CSP-125','XJ'],['CSS-036','XJ'],['CSS-059','XJ'],['CSS-071','XJ'],
  ['CSP-015','GQ'],['CSP-025','GQ'],['CSP-059','GQ'],['CSP-095','GQ'],['CSP-096','GQ'],['CSP-097','GQ'],['CSP-098','GQ'],['CSP-101','GQ'],['CSP-102','GQ'],['CSP-104','GQ'],['CSP-106','GQ'],['CSP-107','GQ'],['CSP-115','GQ'],['CSS-001','GQ'],['CSS-018','GQ'],['CSS-020','GQ'],['CSS-051','GQ'],['CSS-079','GQ'],
  ['CSP-009','JA'],['CSS-013','JA'],['CSS-066','JA'],
  ['CSP-058','YH'],['CSP-100','YH'],
  ['CSP-049','YQ'],['CSP-057','YQ'],['CSP-093','YQ'],
  ['CSP-051','WS'],
  ['CSP-046','XHD'],['CSP-048','XHD'],['CSP-114','XHD'],
  ['CSP-073','JB'],['CSP-032-3','JB'],
  ['CSP-060','BASF'],
  ['CSP-204','XZY'],
  ['BBUH-10495','HF'],
  ['CSP-207','JF'],['CSP-208','JF'],
  ['CSP-216-V3','YC'],['CSP-216-v3i','YC'],['BPK-009','YC'],
  ['CSS-050','SJ'],['CSS-060','SJ'],
  ['48_016690','XH'],['48_016016','XH'],['47_008450','XH'],['47_008898','XH'],['49-002769','XH'],['CSP-310','XH'],['CSP-311','XH'],['CSP-312','XH'],['CSP-313','XH'],
];
for (const [s, c] of A) ANCHOR.set(s, c);
const codeVotes = new Map<string, Map<number, number>>();
for (const x of parts) {
  if (!x.supplierId) continue;
  const code = ANCHOR.get(norm(x.sku));
  if (!code) continue;
  if (!codeVotes.has(code)) codeVotes.set(code, new Map());
  const m = codeVotes.get(code)!;
  m.set(x.supplierId, (m.get(x.supplierId) || 0) + 1);
}
const codeMap = new Map<string, { supId: number | null, conf: string }>();
for (const [code, m] of codeVotes) {
  const [supId] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  codeMap.set(code, { supId, conf: '锚定' });
}
const GUESS: Record<string, number> = { XY: 168, HN: 192, ZB: 153, KX: 198, SB: 184, FS: 202, CZX: 166, LM: 203, SY: 195, ZF: 188 };
for (const [code, supId] of Object.entries(GUESS)) if (!codeMap.has(code)) codeMap.set(code, { supId, conf: '猜测' });
const skuOfCode = (code: string) => codeMap.get(code) || { supId: null, conf: '未知代码' };

type Row = { sheet: string; r: number; no: string; code2: string; skuRaw: string; name: string; qty: string; price: number | null; priceIncl: number | null; code8: string; tax: string; note: string };
const rows: Row[] = [];
for (const sheet of SHEETS) {
  const ws = wb.Sheets[sheet];
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  for (let i = 2; i < data.length; i++) {
    const r = data[i];
    if (!r || r.length < 6) continue;
    const price = typeof r[5] === 'number' ? r[5] : null;
    const priceIncl = typeof r[9] === 'number' ? r[9] : null;
    if (price == null && priceIncl == null) continue;
    const skuRaw = norm(r[2]), name = norm(r[3]), no = String(r[0] ?? '').trim();
    if (no === '合计' || (no === '' && skuRaw === '' && name === '')) continue; // 合计行
    rows.push({ sheet, r: i + 1, no, code2: String(r[1] ?? '').trim(), skuRaw, name, qty: String(r[4] ?? ''), price, priceIncl, code8: String(r[7] ?? '').trim(), tax: String(r[8] ?? '').trim(), note: String(r[11] ?? '').trim() });
  }
}

type Match = { kind: 'ok', sku: string } | { kind: 'multi', skus: string[], why: string } | { kind: 'none', why: string };
const has = (s: string) => partBySku.has(norm(s));
const get = (s: string) => partBySku.get(norm(s));

function stdSku(combined: string): string | null {
  let suffix: string | null = null;
  if (/盘头十字槽自攻|盘头自攻/.test(combined)) suffix = '盘头自攻';
  else if (/自攻/.test(combined)) suffix = '自攻';
  else if (/防松蓝胶|点蓝胶/.test(combined)) suffix = '杯头防松蓝胶';
  else if (/沉头内六角/.test(combined)) suffix = '平头';
  else if (/杯头内六角/.test(combined)) suffix = '杯头';
  else if (/圆头内六角|扁头内六角|半圆头内六角/.test(combined)) suffix = '半圆头';
  else if (/机米螺丝/.test(combined)) suffix = '机米';
  else if (/平头十字槽|十字沉头|十字/.test(combined)) suffix = '十字';
  else if (/盖帽螺母|盖型螺母/.test(combined)) suffix = '盖型螺母';
  else if (/六角螺母|平面螺母/.test(combined)) suffix = '螺母';
  else if (/平面垫片/.test(combined)) suffix = '垫片';
  if (!suffix) return null;
  const m1 = combined.match(/M\s*([0-9]+(?:\.[0-9]+)?)\s*[xX*×＊]\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m1) {
    const spec = 'M' + m1[1] + 'x' + m1[2];
    if (suffix === '杯头防松蓝胶' && m1[1] === '5' && m1[2] === '14') return 'M5x14-杯头防松蓝胶';
    if ((suffix === '螺母' || suffix === '垫片' || suffix === '盖型螺母')) {
      const s2 = spec.replace(/x[0-9.]+$/, '') + '-' + suffix;
      if (has(s2)) return s2;
    }
    const cand = spec + '-' + suffix;
    if (has(cand)) return cand;
    return null;
  }
  if (suffix === '螺母' || suffix === '垫片' || suffix === '盖型螺母') {
    const m2 = combined.match(/M([0-9]+(?:\.[0-9]+)?)/);
    if (m2) {
      const cand = 'M' + m2[1] + '-' + suffix;
      if (has(cand)) return cand;
    }
  }
  return null;
}

function resolve(row: Row): Match {
  const { sheet, skuRaw: raw, name } = row;
  const combined = raw + ' ' + name;
  const comNoFinish = combined.replace(/镀黑镍|镀白镍|黑镍|白镍|镀黑锌|镀白锌|无字/g, ' ').replace(/\s+/g, ' ').trim();

  // magnets with color suffix BEFORE exact match
  if (/^BBUH-10495/.test(raw)) {
    if (/真金|金色/.test(name)) return { kind: 'ok', sku: 'BBUH-10495-金' };
    if (/黑镍/.test(name)) return { kind: 'ok', sku: 'BBUH-10495' };
    return { kind: 'none', why: 'BBUH-10495磁铁未识别颜色' };
  }
  if (/^P1806-11577/.test(raw)) {
    if (/真金|金色/.test(name)) return { kind: 'ok', sku: 'P1806-11577-金' };
    if (/黑镍/.test(name)) return { kind: 'ok', sku: 'P1806-11577-黑' };
  }
  if (/^P1806-10589/.test(raw)) return { kind: 'ok', sku: 'P1806-10589-金' };
  if (/^P1806-11189/.test(raw)) return { kind: 'ok', sku: 'P1806-11189-金' };

  // PHUB: only shared parts
  if (sheet === 'PHUB') {
    if (/干燥剂/.test(combined)) return { kind: 'ok', sku: 'CSP-217' };
    if (/产品安全手册/.test(combined)) return { kind: 'ok', sku: '49-002769' };
    if (/点蓝胶|防松蓝胶/.test(combined)) { const s = stdSku(combined); if (s) return { kind: 'ok', sku: s }; }
    return { kind: 'none', why: 'P_HUB_QR2产品未导入ERP' };
  }

  if (has(raw)) return { kind: 'ok', sku: norm(raw) };

  if (/^CSP-013/.test(raw) && /L=/.test(name)) {
    const m = name.match(/L=\s*([0-9.]+)/);
    if (m) { const sku = 'CSP-013-' + m[1]; if (has(sku)) return { kind: 'ok', sku }; return { kind: 'none', why: 'CSP-013 L=' + m[1] + ' 无对应SKU' }; }
    return { kind: 'none', why: 'CSP-013 无长度信息' };
  }
  if (raw.startsWith('CSP-005')) return { kind: 'ok', sku: raw.includes('灰') ? 'CSP-005-深灰' : 'CSP-005' };
  if (raw.startsWith('CSP-068')) return { kind: 'ok', sku: 'CSP-068' };
  if (raw.startsWith('CSP-066')) return { kind: 'ok', sku: 'CSP-066' };
  if (raw.startsWith('CSP-067')) return { kind: 'ok', sku: 'CSP-067' };
  if (raw.startsWith('CSP-117d')) return { kind: 'ok', sku: 'CSP-117d' };
  if (raw.startsWith('CSP-033')) return { kind: 'ok', sku: (sheet === 'V3I' && /灰/.test(name)) ? 'CSP-033-灰色' : 'CSP-033' };
  if (raw.startsWith('CSP-040')) return { kind: 'ok', sku: 'CSP-040' };
  if (raw.startsWith('CSP-071')) return { kind: 'ok', sku: 'CSP-071' };
  if (raw.startsWith('CSP-072')) return { kind: 'ok', sku: 'CSP-072' };
  if (raw.startsWith('CSP-128')) return { kind: 'ok', sku: 'CSP-128' };
  if (raw.startsWith('CSP-127')) return { kind: 'ok', sku: 'CSP-127' };
  if (raw.startsWith('CSP-032小圈')) return { kind: 'ok', sku: sheet === 'V3I' ? 'CSP-032' : 'CSP-032-3' };
  if (raw.startsWith('CSP-073')) return { kind: 'ok', sku: 'CSP-073' };
  if (raw.startsWith('CSP-117大圈')) return { kind: 'ok', sku: 'CSP-117' };
  if (raw.startsWith('CSP-017')) return { kind: 'ok', sku: sheet === 'V3I' ? 'CSP-017-v3i' : 'CSP-017' };
  if (/套筒/.test(combined) && /PA66|PA 66/.test(combined)) return { kind: 'ok', sku: 'CSP-032-2' };
  if (raw === 'V3I电子主板' && name.includes('CSP-027')) return { kind: 'ok', sku: 'CSP-027' };
  if (/离合电子/.test(raw) || /离合电子/.test(name)) return { kind: 'ok', sku: sheet === 'V3I' ? 'CSP-302' : 'CSP-205' };
  if (/油门电子/.test(raw) || /油门电子/.test(name)) return { kind: 'ok', sku: sheet === 'V3I' ? 'CSP-301' : 'CSP-206' };
  if (/水晶头/.test(combined)) {
    if (/数据线/.test(combined)) return { kind: 'ok', sku: 'CSS-110' };
    if (/一端/.test(combined)) return { kind: 'ok', sku: 'CSS-112' };
    if (/两端/.test(combined)) return { kind: 'ok', sku: 'CSS-111' };
    return { kind: 'ok', sku: 'CSP-210' };
  }
  if (/USB cable/i.test(raw)) return { kind: 'ok', sku: 'CSP-209' };
  if (raw === 'VR电子') return { kind: 'ok', sku: 'xzzx' };
  if (raw === '滚动电子') return { kind: 'ok', sku: 'CSS-HMC-V3' };
  if (raw === '开关电子') return { kind: 'ok', sku: 'CSS-108' };
  if (raw === '输出电子') return { kind: 'ok', sku: 'CSS-109' };
  if (raw === '4PIN排线') return { kind: 'ok', sku: 'CSS-107' };
  if (/^CSS-058/.test(raw)) return { kind: 'ok', sku: 'CSS-058' };
  if (/^CSS-064/.test(raw)) return { kind: 'ok', sku: 'CSS-064' };
  if (/^CSS-015/.test(raw)) return { kind: 'ok', sku: 'CSS-015' };
  if (/^CSS-016/.test(raw)) return { kind: 'ok', sku: 'CSS-016' };
  if (/^CSS-078/.test(raw)) return { kind: 'ok', sku: 'CSS-078' };
  if (/^CSS-061/.test(raw)) return { kind: 'ok', sku: 'CSS-061' };
  if (/^CSS-070/.test(raw)) return { kind: 'ok', sku: 'CSS-070' };
  if (/^CSS-085/.test(raw)) return { kind: 'ok', sku: 'CSS-085' };
  if (/^CSS-059/.test(raw)) return { kind: 'ok', sku: 'CSS-059' };
  if (/^CSS-071/.test(raw)) return { kind: 'ok', sku: 'CSS-071' };
  if (/^CSS-036/.test(raw)) return { kind: 'ok', sku: 'CSS-036' };
  if (/^CSS-053/.test(raw)) return { kind: 'ok', sku: 'CSS-053' };
  if (raw === '插销3*8') return { kind: 'ok', sku: 'CSS-102' };
  if (raw === '插销4*12') return { kind: 'ok', sku: 'CSS-101' };
  if (raw === '传感器' || /90kg/.test(name)) return { kind: 'ok', sku: 'CSP-204' };
  if (/F5\s*\*\s*4|强磁镀锌/.test(combined)) return { kind: 'ok', sku: 'CSP-058' };
  if (/PU泡棉/.test(combined)) {
    if (/MH24-65/.test(combined)) return { kind: 'ok', sku: 'BPK-005' };
    if (/13\.5/.test(combined)) return { kind: 'ok', sku: 'CSP-060' };
    if (/Ø8|Stab/.test(combined)) return { kind: 'ok', sku: 'CSS-062' };
  }
  if (/杯头螺丝/.test(raw) && /M6\s*\*\s*10/.test(combined)) return { kind: 'ok', sku: 'M6x10-杯头直纹' };
  if (raw === 'F Logo') return { kind: 'ok', sku: 'F LOGO' };
  if (/USB PCBA/.test(raw)) return { kind: 'ok', sku: 'CSUSB-001' };
  if (/USB塑胶盒子/.test(raw)) return { kind: 'multi', skus: ['CSUSB-002', 'CSUSB-003'], why: '上盖+下盖组合价' };
  if (/十字沉头自攻/.test(raw)) return { kind: 'ok', sku: 'M2.6x10-自攻' };
  if (/PE Bag|包装袋/.test(raw)) return { kind: 'ok', sku: 'CSS-114' };
  if (/磁铁/.test(combined)) {
    if (/3x10|Ø3/.test(combined)) return { kind: 'ok', sku: 'CSS-095' };
    if (/4\*5|Ø4/.test(combined)) return { kind: 'ok', sku: 'CSS-104' };
  }
  if (/刹车马达/.test(combined)) {
    if (/830/.test(combined)) return { kind: 'ok', sku: 'CSP-304' };
    if (/320/.test(combined)) return { kind: 'ok', sku: 'CSP-207' };
    if (/650/.test(combined)) return { kind: 'none', why: '650mm刹车马达线无对应ERP零件' };
  }
  if (/油门马达/.test(combined)) {
    if (/550/.test(combined)) return { kind: 'ok', sku: 'CSP-305' };
    if (/370/.test(combined)) return { kind: 'ok', sku: 'CSP-208' };
    if (/350/.test(combined)) return { kind: 'none', why: '350mm油门马达线无对应ERP零件' };
  }
  if (/接地线/.test(combined)) return { kind: 'multi', skus: ['CSP-306', 'CSP-307', 'CSP-308'], why: '接地线一个价格对应3个零件' };
  if (/减震器/.test(raw) && /主体/.test(name)) return { kind: 'ok', sku: 'CSP-309' };
  if (/自卷式编织管/.test(raw)) return { kind: 'ok', sku: 'CSP-316' };
  if (/^CSP-113/.test(raw)) return { kind: 'ok', sku: 'CSP-113' };
  if (/干燥剂/.test(combined)) return { kind: 'ok', sku: 'CSP-217' };
  if (/白镍无字/.test(combined)) {
    if (/M6\s*\*\s*16/.test(combined)) return { kind: 'ok', sku: 'M6x16-平头-白镍' };
    if (/M6\s*\*\s*28\.5/.test(combined)) return { kind: 'ok', sku: 'M6x28-平头' };
  }

  const PACK: Record<string, string> = {
    'CSP_V3彩盒': '48_016690', 'CSP_V3内卡': 'CSP-211', 'CSP V3珍珠棉': 'CSP-216-V3', 'CSP V3外箱': 'CSP-213',
    'CSP_V3产品标签': '47_008898', 'CSP_V3油瓶标签': 'Lithium Grease', '产品安全手册': '49-002769',
    'FANATEC贴纸': 'CSP-219',
    'CSP_V3i彩盒': '48_016016', 'CSP_V3i外箱': '48-016017', 'V3I黑色珍珠棉': 'CSP-216-v3i', 'CSP_V3i两个色贴纸': '47_008450',
    'CSP_V3i小白盒': 'CSP-314', '塑料提手': 'CSP-310', '提手卡片': 'CSP-311', '两边卡片': 'CSP-312', '底部卡片': 'CSP-313',
    'SQ+USB套装彩盒': '48_016015', 'CSS SQ黑色贴纸': '47_008449', 'SQ珍珠棉': 'CSS-113', 'SQ外箱': '48-016132',
    'APM彩盒': '48_016019_AC', 'APM牛皮盒': '48-016020', 'APM外箱': '48-016141', 'APM透明圆形贴50mm': 'PAPM-009',
    'Made In China圆形标签': 'PAPM-011', '磁铁大圆贴纸': 'PAPM-001', '磁铁小圆贴纸': 'PAPM-002',
    'L型球头扳手4mm': 'PAPM-004', 'L型球头扳手2mm': 'PAPM-005', '防锈油纸': 'PAPM-006', '吊牌棉绳': 'CSS-116',
    '扎线带': 'CSP-322', '防氧化剂': 'PAPM-010', '乐泰638 绿胶': 'PAPM-019', '乐泰7649 处理剂': 'PAPM-020',
    '产品吊牌标签': '47_008523', '彩盒序列号标签': 'PAPM-012', '牛皮盒序列号标签': 'PAPM-012', '牛皮盒封口标签': 'PAPM-013',
    '大外箱主标签': 'PAPM-014', '大外箱序列号标签': 'PAPM-015', '大外箱EAN标签': 'PAPM-016',
    '22.6 Kg超重双人黄标签': 'PAPM-017', '15Kg超重红标签': 'PAPM-018',
    'V3_BPK牛皮盒': 'BPK-010', 'V3_BPK彩盒': 'BPK-008', 'V3_BPK透明圆形贴纸': 'BPK-006', '油瓶标签': 'Lithium Grease',
    'V3BPK珍珠棉': 'BPK-009', 'V3BPK外箱': 'BPK-011', 'V3BPK组装治具': 'BPK-007', 'MH24-65': 'BPK-005',
    '彩盒EAN序列号标签': 'CSP-317', '外箱EAN序列号标签': 'CSP-317', '外箱主标签': 'CSP-221', '彩盒、外箱序列号标签': 'CSP-220',
    '无纺布袋': 'CSP-212', '透明脚垫': 'CSP-202', '防锈纸1': 'CSP-318', '防锈纸2': 'CSP-319', 'L型扳手': 'CSP-315',
  };
  for (const [key, val] of Object.entries(PACK)) {
    if (raw === key || name === key) return { kind: 'ok', sku: val };
  }
  if (/V3_BPK牛皮盒/.test(raw)) return { kind: 'ok', sku: 'BPK-010' };
  if (/V3_BPK彩盒/.test(raw)) return { kind: 'ok', sku: 'BPK-008' };
  if (/V3_BPK透明圆形贴纸/.test(raw)) return { kind: 'ok', sku: 'BPK-006' };
  if (/V3BPK珍珠棉/.test(raw)) return { kind: 'ok', sku: 'BPK-009' };
  if (/V3BPK外箱/.test(raw)) return { kind: 'ok', sku: 'BPK-011' };
  if (/V3BPK组装治具/.test(raw)) return { kind: 'ok', sku: 'BPK-007' };
  if (/MH24-65/.test(raw)) return { kind: 'ok', sku: 'BPK-005' };
  if (/Eladur/.test(raw)) {
    const mm = name.match(/100|42/); const ss = name.match(/13\*20|12\*20/);
    if (mm && ss) return { kind: 'ok', sku: 'BPK-00' + ((mm[0] === '100' ? 0 : 2) + (ss[0] === '13*20' ? 1 : 2)) };
  }
  if (/Made In China贴纸/.test(raw)) return { kind: 'ok', sku: 'PAPM-011' };
  if (/彩盒序号标签/.test(raw) || /牛皮盒序号标签/.test(raw)) return { kind: 'ok', sku: 'BPK-012' };
  if (/牛皮盒封口标签/.test(raw)) return { kind: 'ok', sku: 'BPK-013' };
  if (/大外箱主标签/.test(raw)) return { kind: 'ok', sku: 'BPK-014' };
  if (/大外箱序列号标签/.test(raw)) return { kind: 'ok', sku: 'BPK-015' };
  if (/大外箱EAN标签/.test(raw)) return { kind: 'ok', sku: 'BPK-016' };
  if (/锂基油/.test(combined)) return { kind: 'none', why: '锂基油无独立零件' };
  if (/APM EVA珍珠棉/.test(raw)) return { kind: 'multi', skus: ['P1806-12338', 'P1806-12356', 'PAPM-007'], why: '中盖+上盖+底座三件一套' };
  if (/3M胶贴纸/.test(raw)) {
    if (/直角/.test(name)) return { kind: 'ok', sku: sheet === 'V3I' ? 'CSP-321' : 'CSP-201' };
    if (/圆角/.test(name)) return { kind: 'ok', sku: 'CSP-321' };
  }
  if (/双面气泡袋|PE袋/.test(raw)) return { kind: 'none', why: '气泡袋/PE袋无ERP零件' };
  if (/传感器加工费/.test(raw)) return { kind: 'none', why: '加工费无零件' };
  if (/说明书/.test(raw) && sheet === 'V3') return { kind: 'none', why: 'V3 BOM无说明书零件' };
  if (/USB吸塑盒|USB新彩卡|USB新外箱|USB外箱平卡/.test(raw)) return { kind: 'none', why: 'CS_USB BOM无此零件（仅CSUSB-004运输盒）' };
  if (/V3BPK平卡/.test(raw)) return { kind: 'none', why: 'BPK BOM无平卡零件' };

  // APM ESTP specials (on combined without finish words)
  const APM_SPECIAL: Record<string, string> = {
    '沉头内六角螺丝 M3*12': 'ESTP-11186',
    '沉头内六角螺丝 M3*7': 'ESTP-9096',
    '杯头内六角螺丝 M3*12': 'ESTP-7776',
    '平面垫片 M3*6*1.0': 'ESTP-3167',
    '杯头内六角螺丝 M5*14 /点蓝胶': 'M5x14-杯头防松蓝胶',
  };
  if (sheet === 'APM') {
    const stripLuoSi = comNoFinish.replace(/螺丝/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [key, val] of Object.entries(APM_SPECIAL)) {
      if (stripLuoSi === key.replace(/螺丝/g, ' ').replace(/\s+/g, ' ').trim()) return { kind: 'ok', sku: val };
    }
  }

  const std = stdSku(combined);
  if (std) return { kind: 'ok', sku: std };

  return { kind: 'none', why: '未匹配' };
}

type Out = { sheet: string; r: number; no: string; skuRaw: string; name: string; qty: string; price: number | null; priceIncl: number | null; code8: string; tax: string; sku: string; partName: string; oldPrice: number | null; oldPriceIncl: number | null; oldSup: string; newSup: string; supConf: string };
const okList: Out[] = [], multiList: any[] = [], noneList: any[] = [];
for (const row of rows) {
  const m = resolve(row);
  const supInfo = row.code8 ? skuOfCode(row.code8) : { supId: null, conf: '' };
  const base = { sheet: row.sheet, r: row.r, no: row.no, skuRaw: row.skuRaw, name: row.name, qty: row.qty, price: row.price, priceIncl: row.priceIncl, code8: row.code8, tax: row.tax };
  if (m.kind === 'ok') {
    const pt = get(m.sku);
    if (!pt) { noneList.push({ ...base, sku: m.sku, why: 'SKU不存在' }); continue; }
    okList.push({ ...base, sku: pt.sku, partName: pt.name, oldPrice: pt.price == null ? null : Number(pt.price), oldPriceIncl: pt.priceInclTax == null ? null : Number(pt.priceInclTax), oldSup: pt.supplierId ? (supName.get(pt.supplierId) || String(pt.supplierId)) : '', newSup: supInfo.supId ? (supName.get(supInfo.supId) || '') : '', supConf: supInfo.conf });
  } else if (m.kind === 'multi') multiList.push({ ...base, skus: m.skus, why: m.why, supConf: supInfo.conf });
  else noneList.push({ ...base, sku: '', why: m.why });
}

// dedupe by sku: conflict only if 不含税 differs
const bySku = new Map<string, Out[]>();
for (const o of okList) { if (!bySku.has(o.sku)) bySku.set(o.sku, []); bySku.get(o.sku)!.push(o); }
const conflicts: Out[] = [], finalOk: Out[] = [];
for (const [sku, list] of bySku) {
  const prices = [...new Set(list.map(x => x.price))].filter((x): x is number => x != null);
  if (prices.length > 1) { conflicts.push(...list); continue; }
  // keep the most precise 含税
  list.sort((a, b) => decPlaces(b.priceIncl) - decPlaces(a.priceIncl));
  finalOk.push(list[0]);
}
function decPlaces(n: number | null) { if (n == null) return -1; const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }

// ================= apply (boss approved: overwrite + recommended conflict/combo resolutions) =================
// 备份
const backupPath = 'D:/AI/erp-backups/erp-before-costprice-20260901.dump';
const PGBIN = 'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe';
const bk = spawnSync(PGBIN, ['-Fc', '-d', process.env.DATABASE_URL || '', '-f', backupPath], { shell: false, encoding: 'utf8' });
if (bk.status !== 0) { console.error('pg_dump FAILED:', bk.stderr); process.exit(1); }
console.log('backup ok:', backupPath);

// 老板批准：冲突跳过行
const SKIP = new Set(['V3:3', 'V3:11', 'SQ:73', 'SQ:71', 'V3I:121']);
const KEEP_SKUS = new Set(['CSP-027', 'CSP-003', 'M4x10-杯头', 'M4x10-平头', 'CSP-321']);
for (const c of conflicts) {
  const key = c.sheet + ':' + c.r;
  if (!SKIP.has(key) && !KEEP_SKUS.has(c.sku)) { console.error('未处理的冲突:', key, c.sku, c.price); process.exit(1); }
}
const keptRows: any[] = conflicts.filter(c => KEEP_SKUS.has(c.sku) && !SKIP.has(c.sheet + ':' + c.r));

// 组合价（老板批准拆法）
const COMBOS: { sku: string; price: number; incl: number; code: string }[] = [
  { sku: 'CSP-306', price: 2.54, incl: 2.7178, code: 'LZ' },
  { sku: 'CSP-307', price: 2.54, incl: 2.7178, code: 'LZ' },
  { sku: 'CSP-308', price: 2.54, incl: 2.7178, code: 'LZ' },
  { sku: 'CSUSB-002', price: 0.325, incl: 0.3575, code: 'XJ' },
  { sku: 'CSUSB-003', price: 0.325, incl: 0.3575, code: 'XJ' },
  { sku: 'P1806-12338', price: 7.1, incl: 7.739, code: 'YC' },
];

type ApplyRow = { sku: string; price: number | null; incl: number | null; code: string };
const applyRows = new Map<string, ApplyRow>();
const put = (sku: string, price: number | null, incl: number | null, code: string) => {
  const old = applyRows.get(sku);
  if (old) {
    if (price != null && old.price != null && Math.abs(price - old.price) > 0.0001) { console.error('同SKU价格冲突:', sku, old.price, price); process.exit(1); }
    applyRows.set(sku, { sku, price: price ?? old.price, incl: incl ?? old.incl, code: code || old.code });
  } else {
    applyRows.set(sku, { sku, price, incl, code });
  }
};
for (const o of finalOk) put(o.sku, o.price, o.priceIncl, o.code8);
for (const o of keptRows) put(o.sku, o.price, o.priceIncl, o.code8);
for (const c of COMBOS) put(c.sku, c.price, c.incl, c.code);
console.log('待更新零件数:', applyRows.size);

let changed = 0, inclFilled = 0, inclChanged = 0, supFilled = 0, noop = 0;
await p.$transaction(async (tx) => {
  for (const [sku, r] of applyRows) {
    const pt = partBySku.get(norm(sku));
    if (!pt) { console.error('零件不存在:', sku); process.exit(1); }
    const data: any = {};
    if (r.price != null && (pt.price == null || Math.abs(Number(pt.price) - r.price) > 0.0001)) { data.price = r.price; }
    if (r.incl != null && (pt.priceInclTax == null || Math.abs(Number(pt.priceInclTax) - r.incl) > 0.0001)) { data.priceInclTax = r.incl; }
    const sup = r.code ? skuOfCode(r.code) : null;
    if (pt.supplierId == null && sup && sup.supId) data.supplierId = sup.supId;
    if (Object.keys(data).length === 0) { noop++; continue; }
    await tx.part.updateMany({ where: { sku: pt.sku }, data });
    if (data.price != null) changed++;
    if (data.priceInclTax != null) { if (pt.priceInclTax == null) inclFilled++; else inclChanged++; }
    if (data.supplierId != null) supFilled++;
  }
});
console.log('已更新零件:', applyRows.size - noop);
console.log('  不含税价变化:', changed);
console.log('  含税价补空:', inclFilled, ' 含税价变化:', inclChanged);
console.log('  供应商补空:', supFilled);
console.log('  无变化(跳过):', noop);

// ---- verify samples ----
const VERIFY = ['CSP-015','CSP-009','CSP-025','CSP-027','CSP-003','CSP-321','M4x10-杯头','M4x10-平头','CSP-306','CSP-307','CSP-308','CSUSB-002','CSUSB-003','P1806-12338','BBUH-10495-金','P1806-11577-金','CSP-013-130','M3x13-杯头','CSP-209','CSP-207','CSP-309','48_016690','CSP-216-V3','Lithium Grease'];
for (const sku of VERIFY) {
  const pt = await p.part.findFirst({ where: { sku } });
  console.log(sku + ' | ' + (pt?.name || '') + ' | ' + (pt?.price ?? '-') + ' | ' + (pt?.priceInclTax ?? '-') + ' | ' + (pt?.supplierId ? supName.get(pt.supplierId) : ''));
}
const total = await p.part.count();
const priced = await p.part.count({ where: { OR: [{ price: { not: null } }, { priceInclTax: { not: null } }] } });
console.log('零件总数:', total, ' 有价格:', priced);

const md = '# 产品成本单价导入说明 - 20260901\n\n来源文件：《产品成本单价(更新含税价).xlsx》（9 sheet：APM/V3/V3I/SQ/PHUB/USB/BPK）\n\n- 口径：按老板确认，全部覆盖更新 不含税(price)+含税(priceInclTax)；供应商仅填空（supplierId 为 null 才填）。\n- 匹配：物料编号→ERP SKU（CSP-013按L=拆分、磁铁按颜色拆分、标准件按规格+类型、包装件按BOM定位）。\n- 更新零件数：' + (applyRows.size - noop) + '；不含税变化 ' + changed + '；含税补空 ' + inclFilled + '；供应商补空 ' + supFilled + '。\n- 冲突处理（老板批准）：CSP-027 取 127.06(V3I)；CSP-003 取 3.5（V3 表 79 视为笔误）；M4x10-杯头 0.07；M4x10-平头 0.07；CSP-321 取 0.2。\n- 组合价拆分：接地线 2.54×3（CSP-306/307/308）；USB塑胶盒 0.65→上盖/下盖各 0.325；APM珍珠棉 7.1→仅 P1806-12338。\n- 供应商代码：25 个解码（18 锚定 + 猜测 SY上元/ZB智宝/HN海能/KX科昌/SB顺博/FS锋胜/CZX彩智翔/XY鑫圆/LM立明/ZF中发）；KM(公式桨板供应商) 未解码留空。\n- 未导入（无对应零件，见预览表《无对应零件》sheet）：PHUB 整表（产品未入库）、气泡袋×3、传感器加工费×2、V3I 650/350mm 马达线、USB吸塑盒/彩卡/外箱/平卡、V3说明书、BPK平卡。\n- 备份：D:/AI/erp-backups/erp-before-costprice-20260901.dump\n';
fs.writeFileSync('D:/AI/采购/产品成本单价导入说明-20260901.md', md);
console.log('说明文件已生成');
await p.$disconnect();
