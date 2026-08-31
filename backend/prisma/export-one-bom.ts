// 单个成品导出对照表：从汇总对照表按 SKU 抽一页，生成单文件 xlsx + 说明 md 供老板核对
// 用法：cd backend && PRODUCT=P_APM npx tsx prisma/export-one-bom.ts
import ExcelJS from 'exceljs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { prisma } from '../src/db'

const PRODUCT = process.env.PRODUCT ?? ''
const SRC = process.env.SRC ?? 'D:/AI/工程/成品BOM-汇总对照表-20260831-v3.xlsx'
const SOURCE_FILE = process.env.SOURCE_FILE ?? '工程/成品bom数据'
const OUT_DIR = 'D:/AI/工程'
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(SRC)
const ws = wb.getWorksheet(PRODUCT)
if (!ws) { console.log('未找到 sheet: ' + PRODUCT); process.exit(1) }

// 原样复制该 sheet 到新工作簿
const out = new ExcelJS.Workbook()
const nws = out.addWorksheet(PRODUCT)
nws.columns = ws.columns.map((c) => ({ header: String(c.header ?? ''), key: c.key, width: c.width ?? 12 })) as never
ws.eachRow((row, i) => {
  if (i === 1) return
  const vals: unknown[] = []
  ws.columns.forEach((_, c) => vals.push(row.getCell(c + 1).value))
  nws.addRow(vals)
})
nws.getRow(1).font = { bold: true }
nws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
nws.views = [{ state: 'frozen', ySplit: 1 }]
nws.autoFilter = { from: 'A1', to: 'T1' }
mkdirSync(OUT_DIR, { recursive: true })
const outXlsx = OUT_DIR + '/' + PRODUCT + '-SKU对照表-20260831.xlsx'
await out.xlsx.writeFile(outXlsx)

// 统计
let total = 0, newCount = 0, sharedDb = 0, sharedBatch = 0
const sharedDbSkus: string[] = []
const batchSkus: string[] = []
const notes: string[] = []
ws.eachRow((row, i) => {
  if (i === 1) return
  const sku = String(row.getCell(4).value ?? '')
  if (!sku) return
  total++
  const action = String(row.getCell(5).value ?? '')
  const sharedFrom = String(row.getCell(6).value ?? '')
  const note = String(row.getCell(19).value ?? '')
  const cn = String(row.getCell(7).value ?? '')
  if (action === '共用' && sharedFrom === '库内已有') { sharedDb++; sharedDbSkus.push(sku + '(' + cn + ')') }
  else if (action === '共用' && sharedFrom.startsWith('同批')) { sharedBatch++; batchSkus.push(sku + '(' + cn + ')') }
  else newCount++
  if (note) notes.push('序号 ' + row.getCell(1).value + '：' + note)
})

// 库内零件 SKU 集合（用于说明）
const dbParts = await prisma.part.findMany({ select: { sku: true } })
const dbSet = new Set(dbParts.map((p) => p.sku))

const md: string[] = []
md.push('# ' + PRODUCT + ' 导入对照表 — 请老板核对')
md.push('')
md.push('- 对照表：' + outXlsx + '（逐行核对，SKU 可直接改）')
md.push('- 数据来源：' + SOURCE_FILE)
md.push('- 统计：' + total + ' 行明细 → 新建零件 ' + newCount + '，共用库内已有 ' + sharedDb + '，同批其他成品已出现 ' + sharedBatch)
if (sharedDbSkus.length) md.push('- 共用库内已有：' + sharedDbSkus.join('、'))
if (batchSkus.length) md.push('- 同批共用（先录本成品则这些行由本成品创建）：' + batchSkus.join('、'))
md.push('')
md.push('## 编号规则')
md.push('- 官方料号照抄（BBUH- / P1806- / ESTP- / SUP- / 47_ / 48_ / 49- 等）')
md.push('- 螺丝/螺母/垫片/卡簧按「规格+类型」（M3x7-平头、M3-垫片、6x0.7-卡簧…），与库内已有同规格自动共用')
md.push('- 表内无料号杂项 PAPM-001 起编')
md.push('- 用量取数字部分（1 Set→1、1/30→1），原表文本见备注')
md.push('- 同产品同 SKU 多行自动合并用量')
md.push('')
if (notes.length) { md.push('## 特殊处理（已在备注列标注）'); for (const n of notes) md.push('- ' + n); md.push('') }
md.push('## 确认点')
md.push('1. 成品 SKU/名称是否可用')
md.push('2. 杂项内部编号前缀（PAPM-）可否')
md.push('3. 标准件共用口径：同规格同类型即共用（不分表面处理颜色），可否')
md.push('4. 磁铁/离合片同名料号按颜色加后缀（BBUH-10495-金/-黑），可否')
md.push('5. 用量取数字部分（1 Set→1、1/30→1、3/20→3），原表文本留备注，可否')
md.push('')
md.push('核对后回复「导入」，我按对照表写入 ERP（成品 ' + PRODUCT + ' + 新建零件 + BOM，共用行不重复建）。')
const outMd = OUT_DIR + '/' + PRODUCT + '-导入说明-20260831.md'
writeFileSync(outMd, md.join('\n'))
console.log('已写 ' + outXlsx)
console.log('已写 ' + outMd)
console.log(md.slice(0, 8).join('\n'))
process.exit(0)
