// P_APM（Endor 耳朵拨片）导入预览：读 BOM 表 → 拟定 SKU/共用映射 → 生成对照表 xlsx + 说明 md 供老板核对
// 用法：cd backend && npx tsx prisma/preview-p-apm.ts
// 规则（与 CSP_V3/CSP_V3I/CSS_SQ 口径一致）：
//   1) 官方料号照抄（BBUH-/P1806-/48_/47_/49-）；P1806-xxxxx\nSUP-9928 取第一行，SUP-9928 记备注
//   2) 螺丝/垫片/卡簧 按「规格+类型」拟定 SKU（与 V3/V3I/CSS 同口径，同规格将来可共用）
//   3) 表内无料号的杂项 PAPM-001 起编
//   4) 与库内已有零件自动共用：49-002769 产品安全手册 / CSP-217 干燥剂 / CSP-322 扎线带 / CSS-116 棉绳(黑色)
//   5) ESTP-9096 在 24/37 行出现两次（4+8）合并为一行用量 12
//   6) 用量取数字部分（1 Set→1、1/30→1、3/20→3），原表文本保留在备注
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { mkdirSync, writeFileSync } from 'node:fs'

const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/P_APM出货Endor_BOM_20241015.xlsx'
const OUT_XLSX = 'D:/AI/erp-backups/P_APM-SKU对照表-20260827.xlsx'
const OUT_MD = 'D:/AI/erp-backups/P_APM-导入说明-20260827.md'
const PRODUCT_SKU = 'P_APM'
const PRODUCT_NAME = 'P APM 耳朵拨片'

const clean = (v: unknown) => String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

// 行号(序号) → 处理决定
const SHARED: Record<number, string> = { 41: 'CSP-217', 50: 'CSP-322', 53: '49-002769', 55: 'CSS-116' } // 共用已有零件
const SPEC_SKU: Record<number, string> = {
  21: '6x0.7-卡簧', 22: 'M3-垫片', 23: 'M3x12-杯头', 24: 'M3x7-平头',
  37: 'M3x7-平头', 38: 'M3x12-平头', 39: 'M5x14-杯头防松蓝胶',
} // 螺丝/垫片/卡簧：规格+类型
const MERGED_INTO: Record<number, number> = { 37: 24 }

const wb = XLSX.readFile(FILE)
const ws = wb.Sheets['P_APM 出货Endor']
const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })

interface Row {
  seq: number; official: string; en: string; cn: string; weight: string; revision: string
  material: string; dims: string; finish: string; amountRaw: string; artId: string; useAt: string
  sku: string; action: '新建' | '共用'; sharedFrom: string; amount: number; note: string
}

const out: Row[] = []
let miscSeq = 0
for (const r of rows.slice(3)) {
  const seq = Number(r[0])
  if (!Number.isInteger(seq) || seq <= 0) continue
  const officialRaw = clean(r[1])
  const official = officialRaw.split(' ')[0] ?? ''
  // 跳过空模板行（有序号但名称/料号全空）
  if (!official && !clean(r[4]) && !clean(r[5])) continue
  const amountRaw = clean(r[11])
  const amountNum = Number((amountRaw.replace(/\D.*$/, '').split('/')[0] ?? ''))
  let sku = ''
  let action: Row['action'] = '新建'
  let sharedFrom = ''
  const note: string[] = []
  if (MERGED_INTO[seq]) { action = '共用'; sku = ''; sharedFrom = '并入序号 ' + MERGED_INTO[seq] }
  else if (SHARED[seq]) { action = '共用'; sku = SHARED[seq]; sharedFrom = '库内已有' }
  else if (SPEC_SKU[seq]) { sku = SPEC_SKU[seq]; note.push('螺丝/垫片/卡簧按规格命名') }
  else if (official) { sku = official; if (officialRaw.includes('SUP-9928')) note.push('SUP-9928：客户组件号') }
  else { miscSeq += 1; sku = 'PAPM-' + String(miscSeq).padStart(3, '0'); note.push('表内无料号，内部编号') }
  if (!Number.isFinite(amountNum)) note.push('用量原表: ' + (amountRaw || '-'))
  const weightRaw = clean(r[6]).replace(/g$/i, '').trim()
  out.push({
    seq, official, en: clean(r[4]), cn: clean(r[5]), weight: weightRaw, revision: clean(r[7]),
    material: clean(r[8]), dims: clean(r[9]), finish: clean(r[10]).replace(/\n/g, ' '),
    amountRaw, artId: clean(r[18]), useAt: clean(r[16]),
    sku, action, sharedFrom, amount: Number.isFinite(amountNum) ? amountNum : 0, note: note.join('；'),
  })
}

const newParts = out.filter((o) => o.action === '新建')
const shared = out.filter((o) => o.action === '共用' && o.sharedFrom === '库内已有')
const merged = out.filter((o) => o.action === '共用' && o.sharedFrom.startsWith('并入'))

console.log('行数:', out.length, '| 新建零件:', newParts.length, '| 共用已有:', shared.length, '| 并入同行:', merged.length)

const wb2 = new ExcelJS.Workbook()
const sheet = wb2.addWorksheet('P_APM SKU对照表')
sheet.columns = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '表内料号', key: 'official', width: 16 },
  { header: '拟定SKU', key: 'sku', width: 18 },
  { header: '处理', key: 'action', width: 8 },
  { header: '共用自', key: 'sharedFrom', width: 14 },
  { header: '中文名称', key: 'cn', width: 24 },
  { header: '英文品名', key: 'en', width: 32 },
  { header: '重量(g)', key: 'weight', width: 9 },
  { header: '版本', key: 'revision', width: 8 },
  { header: '材质', key: 'material', width: 16 },
  { header: '尺寸规格', key: 'dims', width: 14 },
  { header: '表面处理', key: 'finish', width: 16 },
  { header: '用量(原表)', key: 'amountRaw', width: 10 },
  { header: '用量(拟定)', key: 'amount', width: 10 },
  { header: '图号', key: 'artId', width: 12 },
  { header: '用在何处', key: 'useAt', width: 16 },
  { header: '备注', key: 'note', width: 28 },
]
for (const o of out) sheet.addRow(o)
sheet.getRow(1).font = { bold: true }
sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
sheet.views = [{ state: 'frozen', ySplit: 1 }]
mkdirSync('D:/AI/erp-backups', { recursive: true })
await wb2.xlsx.writeFile(OUT_XLSX)

const md = [
  '# P_APM（Endor 耳朵拨片）导入方案 — 请老板核对',
  '',
  '- 成品：SKU P_APM，名称「P APM 耳朵拨片」，英文名 P APM（Endor 出货计划表口径）',
  '- 数据来源：P_APM出货Endor_BOM_20241015.xlsx（64 行明细）',
  '- 拟定结果：新建零件 ' + newParts.length + ' 个；共用库内已有 ' + shared.length + ' 个（49-002769 产品安全手册、CSP-217 干燥剂、CSP-322 扎线带、CSS-116 棉绳(黑色)）；ESTP-9096 两行(4+8)合并为一行用量 12',
  '- 编号规则：BBUH-/P1806-/48_/47_ 官方料号照抄；螺丝/垫片/卡簧按「规格+类型」（M3x7-平头 等，与 V3/V3I/CSS 同口径）；表内无料号杂项 PAPM-001 起编',
  '- 用量：取数字部分（1 Set→1、1/30→1、3/20→3），原表文本见对照表备注',
  '- 图片/图档：BOM 表内无内嵌图片，也未收到 P_APM 的 2D/图片资料 → 本次不挂图，收到资料后再补挂',
  '',
  '### 需老板确认的点',
  '1. 成品名称/SKU 用「P_APM / P APM 耳朵拨片」是否可以（后续出到不同地方加/减零件的变体怎么命名，请一起定，如 P_APM-XX？）',
  '2. 杂项内部编号前缀用 PAPM- 可否？',
  '3. M5x14 防松蓝色点胶螺丝拟定 SKU M5x14-杯头防松蓝胶 可否？',
  '4. 表内两行 M3x7 平头内六角（4 个 + 8 个）合并为一行用量 12，可否？',
  '5. 1/30、3/20 这类每箱用量按 1、3 记，原文本留备注，可否？',
  '',
  '对照表文件：D:/AI/erp-backups/P_APM-SKU对照表-20260827.xlsx（逐行核对）',
  '老板确认后执行：cd backend && npx tsx prisma/import-p-apm.ts（届时再写导入脚本，幂等）',
  '',
].join('\n')
writeFileSync(OUT_MD, md, 'utf8')
console.log('已生成:', OUT_XLSX)
console.log('已生成:', OUT_MD)
