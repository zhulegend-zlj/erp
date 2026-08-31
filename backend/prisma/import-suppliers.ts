// 供应商资料入库：读两份对照表 + 从 590 份采购单文件名反推简称
// 老板口径 2026-08-31：立明胶袋合并进立明（抬头取智锐恒）；抬头全称映射到 ERP 抬头（智锐恒/锦名诚）
// 用法：cd backend && npx tsx prisma/import-suppliers.ts
import ExcelJS from 'exceljs'
import XLSX from 'xlsx'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../src/db'

const clean = (v: unknown) => String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

// 1) 从 590 份采购单文件名反推（TO 全称 → 简称），只读表头块
const root = 'D:/AI/采购/extracted/2026年采购单'
const toSuffix = new Map<string, Map<string, number>>() // TO → {suffix: count}
const allFiles: string[] = []
function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.toLowerCase().endsWith('.xls')) allFiles.push(p)
  }
}
walk(root)
let read = 0
for (const f of allFiles) {
  const base = f.split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.xlsx?$/i, '')
  const suffix = noExt.split('-').pop()?.trim() ?? ''
  if (!suffix) continue
  try {
    const wb = XLSX.read(readFileSync(f), { type: 'buffer', codepage: 936 })
    const ws = wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]!]!
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
    const get = (r: number) => (rows[r] ?? []).map((c) => clean(c))
    let to = ''
    for (let r = 0; r < Math.min(rows.length, 8); r++) {
      const hit = get(r).find((c) => /^TO[：:]/.test(c))
      if (hit) { to = hit.replace(/^TO[：:]\s*/, ''); break }
    }
    if (!to) continue
    const m = toSuffix.get(to) ?? new Map<string, number>()
    m.set(suffix, (m.get(suffix) ?? 0) + 1)
    toSuffix.set(to, m)
    read++
  } catch { /* 跳过损坏文件 */ }
}
console.log('扫描采购单 ' + read + ' 份，TO 全称 ' + toSuffix.size + ' 个')

function shortNameFor(to: string): string {
  const m = toSuffix.get(to)
  if (!m) return ''
  let best = ''
  let bestN = 0
  for (const [s, n] of m) if (n > bestN) { best = s; bestN = n }
  return best
}

// 2) 现金文件：sheet 名 = 简称
const CASH_FILES = ['D:/AI/采购/锋胜+耐丝+Bollhoff+JLH+立明+BASF+守金+胶带.xls', 'D:/AI/采购/孚诺+利发+克鲁勃+钢珠+胶水+轴承.xlsx']
const cashShort = new Map<string, string>() // TO → 简称
for (const f of CASH_FILES) {
  if (!existsSync(f)) continue
  const wb = XLSX.read(readFileSync(f), { type: 'buffer', codepage: 936 })
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn]!, { header: 1, raw: true, defval: '' })
    const get = (r: number) => (rows[r] ?? []).map((c) => clean(c))
    for (let r = 0; r < Math.min(rows.length, 8); r++) {
      const hit = get(r).find((c) => /^TO[：:]/.test(c))
      if (hit) {
        const to = hit.replace(/^TO[：:]\s*/, '')
        cashShort.set(to, sn.replace(/\s*\d*$/, '').trim())
        break
      }
    }
  }
}

// 3) 读两份对照表
interface SupRow { name: string; contact: string; phone: string; fax: string; email: string; terms: string; header: string; tax: string }
const rows: SupRow[] = []
async function readSheet(file: string) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  for (const ws of wb.worksheets) {
    ws.eachRow((row, i) => {
      if (i === 1) return
      const g = (c: number) => String(row.getCell(c).value ?? '').trim()
      const name = g(1)
      if (!name) return
      rows.push({ name, contact: g(2), phone: g(3), fax: g(4), email: g(5), terms: g(6), header: g(7), tax: g(8) })
    })
  }
}
await readSheet('D:/AI/采购/供应商资料对照表-预览.xlsx')
await readSheet('D:/AI/采购/现金供应商对照表-预览.xlsx')
console.log('对照表供应商 ' + rows.length + ' 家')

// 4) 合并立明胶袋→立明
const merged = new Map<string, SupRow>()
for (const r of rows) {
  if (r.name === '立明胶袋') continue // 并入立明（老板口径）
  const key = r.name
  if (key === '立明') { r.header = '东莞市智锐恒电子有限公司'; r.terms = r.terms || '对帐后付款' }
  merged.set(key, r)
}
const headerMap: Record<string, string> = {
  '东莞市智锐恒电子有限公司': '智锐恒',
  '东莞市锦名诚电子有限公司': '锦名诚',
}

// 5) 写库
let created = 0, updated = 0
const noShort: string[] = []
for (const [name, r] of merged) {
  const short = shortNameFor(name) || cashShort.get(name) || ''
  if (!short) noShort.push(name)
  const data = {
    name,
    shortName: short || null,
    contactPerson: r.contact || null,
    phone: r.phone || null,
    fax: r.fax || null,
    email: r.email || null,
    defaultPaymentTerms: r.terms || null,
    defaultHeaderName: headerMap[r.header] ?? null,
    taxPoint: r.tax && /^\d/.test(r.tax) ? Number(r.tax) : null,
  }
  const exist = await prisma.supplier.findFirst({ where: { name } })
  if (exist) { await prisma.supplier.update({ where: { id: exist.id }, data }); updated++ }
  else { await prisma.supplier.create({ data }); created++ }
}
console.log('新建 ' + created + '，更新 ' + updated)
if (noShort.length) console.log('未反推出简称的：' + noShort.join('、'))
console.log('供应商总数：' + await prisma.supplier.count())
process.exit(0)
