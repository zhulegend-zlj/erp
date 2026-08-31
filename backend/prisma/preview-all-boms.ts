// 成品bom数据 文件夹全量预览：读全部工程 BOM → 拟定 SKU/共用映射 → 生成汇总对照表 xlsx + 说明 md 供老板核对
// 用法：cd backend && npx tsx prisma/preview-all-boms.ts
// 规则（与 CSP_V3/CSP_V3I/CSS_SQ/P_APM 口径一致）：
//   1) 官方料号照抄（BBUH-/P1806-/P1703-/P1903-/P1927-/DD-/ESTP-/SUP-/47_/48_/49-/912A/14581A 等）
//   2) 螺丝/螺母/垫片/卡簧 按「规格+类型」拟定 SKU（M3x10-平头 等，与库内已有共用）
//   3) 表内无料号杂项 按产品前缀 001 起编
//   4) 与库内已有零件同 SKU → 共用；同批次内多产品同料号 → 首个新建、其余共用
//   5) 用量取数字部分（1 Set→1、1/20→1、6 变更数量→6），原表文本进备注
//   6) 同产品内同 SKU 多行 → 合并用量
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../src/db'

const DIR = 'D:/AI/工程/成品bom数据'
const OUT_XLSX = process.env.OUT_XLSX ?? 'D:/AI/工程/成品BOM-汇总对照表-20260831.xlsx'
const OUT_MD = process.env.OUT_MD ?? 'D:/AI/工程/成品BOM-导入说明-20260831.md'

interface ProductCfg {
  file: string
  skipReason?: string // 跳过（库内已有/重复文件）
  dupOf?: string // 与哪个文件重复
  productSku?: string
  productName?: string
  productNameEn?: string
  miscPrefix?: string
  specialSkus?: Record<number, string> // 序号→拟定SKU（人工规则）
  shared?: Record<number, string> // 序号→库内已有SKU
}

const CFG: ProductCfg[] = [
  { file: 'CS-MPM-BOM清单出货Endor.xlsx', productSku: 'CS-MPM', productName: 'CS-MPM 拨片组件（单独出货 Endor）', productNameEn: 'CS-MPM', miscPrefix: 'CSMPM-' },
  { file: 'CSP_V3I清单-螺丝物料表.xlsx', skipReason: '已入库：CSP_V3I BOM 146 行即由本表导入（螺丝/电缆/标签/泡棉等零件均已在库内），本次跳过' },
  { file: 'CSP_V3_BPK清单-物料清单.xlsx', productSku: 'CSP_V3_BPK', productName: 'CSP V3 BPK 套装', productNameEn: 'CSP_V3_BPK', miscPrefix: 'BPK-' },
  { file: 'CSP_V3清单_物料明细.xlsx', skipReason: 'CSP_V3 成品已入库（零件 CSP-xxx 已在库内），本次跳过' },
  { file: 'CSS_CKK碳纤球头包装_BOM.xlsx', productSku: 'CSS_CKK', productName: 'CSS CKK 碳纤球头包装', productNameEn: 'CSS CKK', miscPrefix: 'CKK-' },
  { file: 'CSS_SQ黑色+USB清单-物料明细.xlsx', skipReason: 'CSS_SQ 成品已入库（零件 CSS-xxx 已在库内），本次跳过' },
  { file: 'CS_TC小夹子-物料清单.xlsx', productSku: 'CS_TC', productName: 'CS TC 工作台小夹子', productNameEn: 'CS_TC', miscPrefix: 'CSTC-' },
  { file: 'CS_USB出货PI-物料清单.xlsx', productSku: 'CS_USB', productName: 'CS USB（出货 PI）', productNameEn: 'CS_USB', miscPrefix: 'CSUSB-' },
  { file: 'P1703离合器组件BOM-2024.xlsx', productSku: 'P1703', productName: 'P1703 离合器组件', productNameEn: 'P1703 CLUTCH', miscPrefix: 'P1703-' },
  { file: 'P1903E_CSL-BOM_正常生产_20241025.xlsx', productSku: 'P1903E', productName: 'P1903E CSL 脚踏板', productNameEn: 'P1903E CSL', miscPrefix: 'P1903E-' },
  { file: 'P1927-DAPM双电子开关BOM出货国内.xlsx', productSku: 'P1927-DAPM', productName: 'P1927 DAPM 双电子开关', productNameEn: 'P1927 DAPM', miscPrefix: 'P1927-' },
  { file: 'PMB-DD支架-RFQ-BOM-2024.xlsx', productSku: 'PMB-DD', productName: 'PMB DD 支架（RFQ）', productNameEn: 'PMB DD BRACKET', miscPrefix: 'PMBDD-' },
  {
    file: 'P_APM出货Endor_BOM_20241015.xlsx', productSku: 'P_APM', productName: 'P APM 耳朵拨片', productNameEn: 'P APM', miscPrefix: 'PAPM-',
    specialSkus: { 21: '6x0.7-卡簧', 22: 'M3-垫片', 23: 'M3x12-杯头', 24: 'M3x7-平头', 37: 'M3x7-平头', 38: 'M3x12-平头', 39: 'M5x14-杯头防松蓝胶' },
    shared: { 41: 'CSP-217', 50: 'CSP-322', 53: '49-002769', 55: 'CSS-116' },
  },
  { file: 'P_APM出货Endor_BOM清单.xlsx', dupOf: 'P_APM出货Endor_BOM_20241015.xlsx' },
  { file: 'RM-CS MPM RFCL-BOM清单-最新版.xlsx', productSku: 'RM-CS-MPM-RFCL', productName: 'RM-CS MPM 不锁碳纤板（单独出货）', productNameEn: 'RM-CS MPM RFCL', miscPrefix: 'RMMPM-' },
  { file: 'RM-CS-MPM-BOM清单JLD.xlsx', productSku: 'RM-CS-MPM-JLD', productName: 'RM-CS MPM（JLD 出货）', productNameEn: 'RM-CS MPM JLD', miscPrefix: 'RMMPM-' },
  { file: 'RM-P APM BLK 黑色磁铁JLD-BOM.xlsx', productSku: 'RM-P-APM-BLK', productName: 'RM-P APM 黑色磁铁（JLD）', productNameEn: 'RM-P APM BLK', miscPrefix: 'RPAPM-' },
  { file: 'RM-P APM 出货JLD-BOM.xlsx', productSku: 'RM-P-APM', productName: 'RM-P APM（出货 JLD）', productNameEn: 'RM-P APM', miscPrefix: 'RPAPM-' },
  { file: 'RM-P APM出货JLD-组装BOM.xlsx', dupOf: 'RM-P APM 出货JLD-BOM.xlsx' },
]

const clean = (v: unknown) => String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

// —— 表头自动检测 ——
const COL_KEYS: Array<{ key: string; re: RegExp }> = [
  { key: 'seq', re: /序号|Item-No/i },
  { key: 'id', re: /料号|Part\s*ID/i },
  { key: 'label', re: /Label|标签/i },
  { key: 'en', re: /Part name \(EN\)|英文品名/i },
  { key: 'cn', re: /中文名称|Part Name （CN）|Part Name \(CN\)/i },
  { key: 'weight', re: /Weight|重量/i },
  { key: 'rev', re: /Revision|版本/i },
  { key: 'material', re: /Material|材质/i },
  { key: 'dims', re: /Dimension|尺寸/i },
  { key: 'finish', re: /Finish|表面处理/i },
  { key: 'amount', re: /Amout|用量/i },
  { key: 'drawings', re: /Drawing|图档/i },
  { key: 'tooling', re: /tooling|模具/i },
  { key: 'moq', re: /MOQ|起订量/i },
  { key: 'price', re: /price|价格/i },
  { key: 'useAt', re: /用在何处/i },
  { key: 'process', re: /manufacturing|生产工艺/i },
  { key: 'art', re: /Art\.ID|图号/i },
  { key: 'vendor', re: /Vendorid|供应商/i },
  { key: 'comment', re: /Comment|备注/i },
]

interface SrcRow {
  seq: number
  id: string
  label: string
  en: string
  cn: string
  weight: string
  rev: string
  material: string
  dims: string
  finish: string
  amountRaw: string
  useAt: string
  art: string
  vendor: string
  comment: string
  extraIds: string[]
}

function parseFile(file: string): SrcRow[] {
  const wb = XLSX.readFile(join(DIR, file))
  const ws = wb.Sheets[wb.SheetNames[0]!]!
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
  // 找表头行
  let headerIdx = -1
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const joined = (rows[i] ?? []).map(clean).join(' ')
    if (/Item-No|序号/.test(joined)) { headerIdx = i; break }
  }
  if (headerIdx < 0) return []
  const header = (rows[headerIdx] ?? []).map(clean)
  const colMap = new Map<string, number>()
  for (const { key, re } of COL_KEYS) {
    if (colMap.has(key)) continue
    const idx = header.findIndex((h) => re.test(h))
    if (idx >= 0) colMap.set(key, idx)
  }
  const g = (key: string, r: unknown[]) => (colMap.has(key) ? clean(r[colMap.get(key)!]) : '')
  const out: SrcRow[] = []
  let lastSeq = 0
  for (const r of rows.slice(headerIdx + 1)) {
    const seqRaw = g('seq', r)
    const seq = Number(seqRaw)
    const id = g('id', r)
    const en = g('en', r)
    const cn = g('cn', r)
    const dims = g('dims', r)
    if (Number.isInteger(seq) && seq > 0) {
      lastSeq = seq
      out.push({
        seq, id, label: g('label', r), en, cn, weight: g('weight', r), rev: g('rev', r),
        material: g('material', r), dims, finish: g('finish', r),
        amountRaw: g('amount', r), useAt: g('useAt', r), art: g('art', r),
        vendor: g('vendor', r), comment: g('comment', r), extraIds: [],
      })
    } else if (id || en || cn || dims) {
      // 原表无序号的行（螺丝表缺号行、尾部包装件）：按独立物料处理，序号按上一行+1 编
      lastSeq += 1
      out.push({
        seq: lastSeq, id, label: g('label', r), en, cn, weight: g('weight', r), rev: g('rev', r),
        material: g('material', r), dims, finish: g('finish', r),
        amountRaw: g('amount', r), useAt: g('useAt', r), art: g('art', r),
        vendor: g('vendor', r), comment: g('comment', r), extraIds: ['原表无序号'],
      })
    }
  }
  return out
}

// —— 标准件 SKU 拟定 ——
function proposeStandardSku(r: SrcRow): string | null {
  const text = [r.cn, r.en, r.dims, r.id].join(' ')
  const size = text.match(/M\s*(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)/)
  const mOnly = text.match(/M\s*(\d+(?:\.\d+)?)/)
  const isScrew = /螺丝|screw|Screw|SCREW/i.test(text)
  const isNut = /螺母|nut|Nut|NUT/i.test(text)
  const isWasher = /垫片|washer|Washer/i.test(text)
  const isCirclip = /卡簧|Circlip|circlip/i.test(text)
  if (isCirclip) {
    const c = (r.dims || r.en || r.cn).match(/(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)/)
    if (c) return c[1] + 'x' + c[2] + '-卡簧'
    return null
  }
  if (isNut && mOnly) {
    if (/焊接/.test(r.cn)) return 'M' + mOnly[1] + '-焊接螺母'
    if (/盖型/.test(r.cn)) return 'M' + mOnly[1] + '-盖型螺母'
    return 'M' + mOnly[1] + '-螺母'
  }
  if (isWasher && mOnly) {
    if (/大平/.test(r.cn)) return 'M' + mOnly[1] + '-大平垫'
    return 'M' + mOnly[1] + '-垫片'
  }
  if (isScrew && size) {
    const type =
      /梅花|Torx|torx/i.test(text) ? '梅花'
      : /自攻|self.?tapping/i.test(text) ? '自攻'
      : /机米/i.test(text) ? '机米'
      : /十字|phillips|Phillips/i.test(text) ? '十字'
      : /直纹/.test(text) ? '杯头直纹'
      : /杯头|cap head|Cap head/i.test(text) ? '杯头'
      : /半圆头/i.test(text) ? '半圆头'
      : /扁头/i.test(text) ? '扁头'
      : /盘头|pan head/i.test(text) ? '盘头'
      : /平头|沉头内六角|countersunk|CSK|csk/i.test(text) ? '平头'
      : '螺丝'
    return 'M' + size[1] + 'x' + size[2] + '-' + type
  }
  return null
}

// 常见物料按中文名自动共用（跨产品通用件）
const NAME_SHARED: Array<{ re: RegExp; sku: string }> = [
  { re: /棉绳/, sku: 'CSS-116' },
  { re: /干燥剂/, sku: 'CSP-217' },
  { re: /扎线带/, sku: 'CSP-322' },
  { re: /产品安全手册/, sku: '49-002769' },
]

const OFFICIAL_RE = /^(BBUH|P1806|P1703|P1903|P1927|DD|ESTP|SUP|CSP|CSS|CS|PAPM|RMMPM|RPAPM)[-_]|^(47_|48_|49-)|^\d{2,}[A-Za-z]+/
function isOfficialId(id: string): boolean {
  if (!id) return false
  if (/^(ISO|DIN|EN|GB\b)/i.test(id)) return false
  return /^[A-Za-z0-9_][A-Za-z0-9_\-.]*$/.test(id)
}

// —— 主流程 ——
const dbParts = await prisma.part.findMany({ select: { sku: true } })
const dbSkuSet = new Set(dbParts.map((p) => p.sku))
const globalIdSku = new Map<string, string>() // 表内料号 → 拟定SKU（跨产品共用）
const miscCounters = new Map<string, number>()

interface OutRow {
  productSku: string
  seq: number
  id: string
  label: string
  sku: string
  action: '新建' | '共用'
  sharedFrom: string
  cn: string
  en: string
  weight: string
  rev: string
  material: string
  dims: string
  finish: string
  amountRaw: string
  amount: number
  art: string
  useAt: string
  vendor: string
  note: string
}

const allSheets: Array<{ name: string; rows: OutRow[] }> = []
const summary: Array<Record<string, string | number>> = []
const skipNotes: string[] = []

function buildProduct(cfg: ProductCfg, file: string): OutRow[] {
  const rows = parseFile(file)
  const out: OutRow[] = []
  const localSkuQty = new Map<string, { idx: number; qty: number }>()
  for (const r of rows) {
    if (!r.id && !r.en && !r.cn && !r.dims && !r.material && !r.finish) continue
    const amountNum = Number(((r.amountRaw || '').replace(/[^\d].*$/, '').split('/')[0] ?? ''))
    let sku = ''
    let action: OutRow['action'] = '新建'
    let sharedFrom = ''
    const note: string[] = []
    if (r.extraIds.length > 0) note.push('另标料号: ' + r.extraIds.join('、'))
    const idFirst = r.id.split(' ')[0] ?? ''
    const stdSku = proposeStandardSku(r)
    if (cfg.specialSkus?.[r.seq]) { sku = cfg.specialSkus[r.seq]!; note.push('标准件按规格命名') }
    else if (cfg.shared?.[r.seq]) { action = '共用'; sku = cfg.shared[r.seq]!; sharedFrom = '库内已有' }
    else if (stdSku && /^(ISO|DIN|ESTP)/i.test(idFirst)) { sku = stdSku; note.push('ISO/DIN/ESTP 标准件按规格命名') }
    else if (idFirst && isOfficialId(idFirst)) {
      sku = idFirst
      if (r.id.includes('料号变更')) note.push('原表标「料号变更」')
    }
    else if (stdSku) { sku = stdSku; note.push('标准件按规格命名') }
    if (!sku) {
      const nameShared = NAME_SHARED.find((n) => n.re.test(r.cn))
      if (nameShared) { sku = nameShared.sku; note.push('常见物料按名称共用') }
    }
    if (!sku) {
      const prefix = cfg.miscPrefix ?? 'MISC-'
      const n = (miscCounters.get(prefix) ?? 0) + 1
      miscCounters.set(prefix, n)
      sku = prefix + String(n).padStart(3, '0')
      note.push('表内无料号，内部编号')
    }
    // 库内已有 → 共用
    if (dbSkuSet.has(sku)) { action = '共用'; sharedFrom = '库内已有' }
    else {
      const firstProduct = globalIdSku.get(sku)
      if (firstProduct && firstProduct !== cfg.productSku) {
        action = '共用'
        sharedFrom = '同批 ' + firstProduct
      } else {
        globalIdSku.set(sku, cfg.productSku ?? file)
        if (r.id) globalIdSku.set(r.id.split(' ')[0]!, sku)
      }
    }
    if (!Number.isFinite(amountNum)) note.push('用量原表: ' + (r.amountRaw || '-'))
    if (r.comment) note.push('表内备注: ' + r.comment)
    // 同产品同 SKU 合并用量
    const exist = localSkuQty.get(sku)
    if (exist) {
      out[exist.idx]!.amount += Number.isFinite(amountNum) ? amountNum : 0
      out[exist.idx]!.note = (out[exist.idx]!.note ? out[exist.idx]!.note + '；' : '') + '与序号' + r.seq + '合并'
      out[exist.idx]!.amountRaw = out[exist.idx]!.amountRaw + '+' + (r.amountRaw || '')
      continue
    }
    const o: OutRow = {
      productSku: cfg.productSku ?? '', seq: r.seq, id: r.id, label: r.label, sku, action, sharedFrom,
      cn: r.cn, en: r.en, weight: r.weight.replace(/g$/i, '').trim(), rev: r.rev,
      material: r.material, dims: r.dims, finish: r.finish, amountRaw: r.amountRaw,
      amount: Number.isFinite(amountNum) ? amountNum : 0, art: r.art, useAt: r.useAt, vendor: r.vendor,
      note: note.join('；'),
    }
    out.push(o)
    localSkuQty.set(sku, { idx: out.length - 1, qty: o.amount })
  }
  return out
}

for (const cfg of CFG) {
  if (cfg.skipReason) {
    skipNotes.push(cfg.file + ' → ' + cfg.skipReason)
    summary.push({ 文件: cfg.file, 成品: '—', 处理: cfg.skipReason })
    continue
  }
  if (cfg.dupOf) {
    const a = parseFile(cfg.dupOf)
    const b = parseFile(cfg.file)
    const same = a.length === b.length && a.every((r, i) => r.id === b[i]!.id && r.cn === b[i]!.cn && r.amountRaw === b[i]!.amountRaw)
    if (same) {
      skipNotes.push(cfg.file + ' → 与 ' + cfg.dupOf + ' 内容一致，跳过')
      summary.push({ 文件: cfg.file, 成品: cfg.dupOf, 处理: '与 ' + cfg.dupOf + ' 重复，已跳过' })
      continue
    }
  }
  const out = buildProduct(cfg, cfg.file)
  const newCount = out.filter((o) => o.action === '新建').length
  const sharedDb = out.filter((o) => o.action === '共用' && o.sharedFrom === '库内已有').length
  const sharedBatch = out.filter((o) => o.action === '共用' && o.sharedFrom.startsWith('同批')).length
  allSheets.push({ name: (cfg.productSku ?? cfg.file).slice(0, 31), rows: out })
  summary.push({
    文件: cfg.file, 成品: cfg.productSku ?? '', 成品名称: cfg.productName ?? '',
    明细行数: out.length, 新建零件: newCount, 共用库内: sharedDb, 同批共用: sharedBatch,
    处理: '待核对',
  })
  console.log(cfg.productSku + ' | 行 ' + out.length + ' | 新建 ' + newCount + ' | 共用库内 ' + sharedDb + ' | 同批共用 ' + sharedBatch)
}

// —— 输出 xlsx ——
const wb = new ExcelJS.Workbook()
const sumSheet = wb.addWorksheet('汇总')
sumSheet.columns = [
  { header: '文件', key: '文件', width: 40 }, { header: '成品SKU', key: '成品', width: 16 },
  { header: '成品名称', key: '成品名称', width: 30 }, { header: '明细行数', key: '明细行数', width: 10 },
  { header: '新建零件', key: '新建零件', width: 10 }, { header: '共用库内', key: '共用库内', width: 10 },
  { header: '同批共用', key: '同批共用', width: 10 }, { header: '处理', key: '处理', width: 50 },
]
for (const s of summary) sumSheet.addRow(s)
sumSheet.getRow(1).font = { bold: true }
sumSheet.views = [{ state: 'frozen', ySplit: 1 }]

for (const sh of allSheets) {
  const ws = wb.addWorksheet(sh.name)
  ws.columns = [
    { header: '序号', key: 'seq', width: 6 }, { header: '表内料号', key: 'id', width: 16 },
    { header: '标签码', key: 'label', width: 10 }, { header: '拟定SKU', key: 'sku', width: 20 },
    { header: '处理', key: 'action', width: 8 }, { header: '共用自', key: 'sharedFrom', width: 16 },
    { header: '中文名称', key: 'cn', width: 26 }, { header: '英文品名', key: 'en', width: 34 },
    { header: '重量(g)', key: 'weight', width: 9 }, { header: '版本', key: 'rev', width: 8 },
    { header: '材质', key: 'material', width: 18 }, { header: '尺寸规格', key: 'dims', width: 16 },
    { header: '表面处理', key: 'finish', width: 20 }, { header: '用量(原表)', key: 'amountRaw', width: 12 },
    { header: '用量(拟定)', key: 'amount', width: 10 }, { header: '图号', key: 'art', width: 12 },
    { header: '用在何处', key: 'useAt', width: 20 }, { header: '供应商', key: 'vendor', width: 14 },
    { header: '备注', key: 'note', width: 34 },
  ]
  for (const o of sh.rows) ws.addRow(o)
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: 'A1', to: 'T1' }
}
mkdirSync('D:/AI/工程', { recursive: true })
await wb.xlsx.writeFile(OUT_XLSX)
console.log('已写 ' + OUT_XLSX)

const md: string[] = []
md.push('# 成品 BOM 数据导入方案 — 请老板核对')
md.push('')
md.push('数据来源：工程/成品bom数据 文件夹（19 个文件，本次处理 ' + allSheets.length + ' 个成品/补充表）')
md.push('对照表：D:/AI/工程/成品BOM-汇总对照表-20260831.xlsx（汇总页 + 每成品一页）')
md.push('')
md.push('## 拟定成品清单')
for (const s of summary) {
  if (s.处理 === '待核对') md.push('- ' + s.文件 + ' → 成品 ' + s.成品 + '「' + s.成品名称 + '」（明细 ' + s.明细行数 + ' 行，新建零件 ' + s.新建零件 + '，共用 ' + Number(s.共用库内) + '+' + Number(s.同批共用) + '）')
  else md.push('- ' + s.文件 + ' → ' + s.处理)
}
md.push('')
md.push('## 编号规则（与 CSP_V3/V3I/CSS_SQ/P_APM 同口径）')
md.push('- 官方料号照抄：BBUH- / P1806- / P1703- / P1903- / P1927- / DD- / ESTP- / SUP- / 47_ / 48_ / 49- / 912A2A / 14581A 等')
md.push('- 螺丝/螺母/垫片/卡簧 按「规格+类型」：M3x10-平头、M4-螺母、M6-垫片、6x0.7-卡簧（与库内已有自动共用）')
md.push('- 表内无料号杂项：按产品前缀 001 起编（CSMPM- / BPK- / CKK- / CSTC- / CSUSB- / PAPM- / RMMPM- / RPAPM-…）')
md.push('- 同产品内同 SKU 多行自动合并用量；跨产品同料号自动共用（第一个出现的产品新建）')
md.push('- 用量取数字部分（1 Set→1、1/20→1、6 变更数量→6），原表文本进备注')
md.push('')
md.push('## 跳过文件')
for (const n of skipNotes) md.push('- ' + n)
md.push('')
md.push('## 需老板确认的点')
md.push('1. 新成品 SKU/名称按上表拟定是否可用（尤其 RM-CS-MPM 两个变体、RM-P APM 两个变体的区分命名）')
md.push('2. 杂项内部编号前缀（CSMPM-/BPK-/CKK-/CSTC-/CSUSB-/RMMPM-/RPAPM-）可否')
md.push('3. 标准件共用口径：同规格同类型即共用（不分表面处理颜色），可否')
md.push('4. P_APM 上次 5 个确认点一并在此确认（成品名、PAPM- 前缀、M5x14-杯头防松蓝胶、两行 M3x7 合并、1/30→1）')
md.push('5. 供应商列仅 13 家已入库，多数工程供应商（晨鑫/富友/广铭/生旺…）不在库内——本次导入先不挂供应商，待供应商资料批量导入后再统一挂，可否')
md.push('6. 图档（3 个 2D PDF 压缩包）与零件图片本次不挂，后续单独补挂，可否')
md.push('')
md.push('老板确认后执行：cd backend && npx tsx prisma/import-all-boms.ts（届时再写导入脚本，幂等，先备份）')
await import('node:fs').then((fs) => fs.writeFileSync(OUT_MD, md.join('\n')))
console.log('已写 ' + OUT_MD)
process.exit(0)
