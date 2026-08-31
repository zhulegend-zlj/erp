// 从 590 份采购单提取价格：每（供应商+零件）取最新一张单的单价，写 Part.price / priceInclTax / supplierId
// 用法：cd backend && npx tsx prisma/import-po-prices.ts
import XLSX from 'xlsx'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../src/db'

const clean = (v: unknown) => String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
const root = 'D:/AI/采购/extracted/2026年采购单'
const files: string[] = []
function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.toLowerCase().endsWith('.xls')) files.push(p)
  }
}
walk(root)
console.log('文件数 ' + files.length)

interface PriceRec { supplierTo: string; sku: string; date: string; priceIncl: number | null; priceExcl: number | null }
const recs: PriceRec[] = []
let parsed = 0
for (const f of files) {
  const base = f.split(/[\\/]/).pop() ?? ''
  const suffix = base.replace(/\.xlsx?$/i, '').split('-').pop()?.trim() ?? ''
  try {
    const wb = XLSX.read(readFileSync(f), { type: 'buffer', codepage: 936 })
    const ws = wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]!]!
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
    const get = (r: number) => (rows[r] ?? []).map((c) => clean(c))
    let to = ''
    let date = ''
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const line = get(r)
      const toHit = line.find((c) => /^TO[：:]/.test(c))
      if (toHit && !to) to = toHit.replace(/^TO[：:]\s*/, '')
      const dHit = line.find((c) => /^(下单日期|采购日期|日期)[：:]/.test(c))
      if (dHit && !date) date = dHit.replace(/^(下单日期|采购日期|日期)[：:]\s*/, '')
      if (line.some((c) => /(序号|Item-No|产品编号|品名)/.test(c)) && line.some((c) => /(料号|Part\s*ID|产品编号)/.test(c))) {
        // 表头行：定位列
        const colIdx = (re: RegExp) => line.findIndex((c) => re.test(c))
        const cSku = colIdx(/(料号|Part\s*ID|产品编号)/)
        const cQty = colIdx(/(数量|采购数量|用量)/)
        const cIncl = colIdx(/单价\(含税\)|含税单价/)
        const cExcl = colIdx(/不含税/)
        const cPrice = colIdx(/单价/)
        if (cSku < 0) break
        for (let i = r + 1; i < rows.length; i++) {
          const row = rows[i] ?? []
          const sku = clean(row[cSku])
          if (!sku || /^(合计|总价|备注|\d+\.\d+)/.test(sku)) continue
          const qty = Number(clean(row[cQty] ?? '0').replace(/[^\d].*$/, '') || 0)
          if (qty <= 0) continue
          const num = (v: unknown) => { const n = Number(clean(v)); return Number.isFinite(n) && n > 0 ? n : null }
          const priceIncl = cIncl >= 0 ? num(row[cIncl]) : null
          const priceExcl = cExcl >= 0 ? num(row[cExcl]) : cIncl < 0 && cPrice >= 0 ? num(row[cPrice]) : null
          if (priceIncl == null && priceExcl == null) continue
          recs.push({ supplierTo: to, sku, date, priceIncl, priceExcl })
        }
        parsed++
        break
      }
    }
  } catch { /* 跳过 */ }
}
console.log('解析文件 ' + parsed + '，价格记录 ' + recs.length)

// 供应商映射：TO 全称 → supplierId（合并立明胶袋→立明）
const sups = await prisma.supplier.findMany({ select: { id: true, name: true, shortName: true } })
const byName = new Map(sups.map((s) => [s.name, s.id]))
const byShort = new Map<string, number>()
for (const s of sups) if (s.shortName) byShort.set(s.shortName, s.id)
function supplierId(to: string, suffix: string): number | null {
  if (byName.has(to)) return byName.get(to)!
  const short = byShort.get(suffix)
  if (short) return short
  return null
}

// 每（供应商+sku）取日期最新的
const latest = new Map<string, PriceRec>()
for (const r of recs) {
  const key = r.supplierTo + '|' + r.sku
  const old = latest.get(key)
  if (!old || r.date > old.date) latest.set(key, r)
}
console.log('去重后（供应商+零件）' + latest.size + ' 条')

let updatedPrice = 0, linkedSupplier = 0, notFound = 0, noSupplier = 0
const notFoundSample: string[] = []
for (const [key, r] of latest) {
  const sid = supplierId(r.supplierTo, '')
  if (!sid) { noSupplier++; continue }
  const part = await prisma.part.findUnique({ where: { sku: r.sku } })
  if (!part) { notFound++; if (notFoundSample.length < 15) notFoundSample.push(r.sku + '（' + r.supplierTo + '）'); continue }
  let price = r.priceExcl
  if (price == null && r.priceIncl != null) {
    const sup = await prisma.supplier.findUnique({ where: { id: sid } })
    const tax = sup?.taxPoint?.toNumber() ?? 13
    price = Math.round((r.priceIncl / (1 + tax / 100)) * 10000) / 10000
  }
  await prisma.part.update({
    where: { id: part.id },
    data: {
      price: price ?? part.price,
      priceInclTax: r.priceIncl ?? part.priceInclTax,
      ...(part.supplierId == null ? { supplierId: sid } : {}),
    },
  })
  updatedPrice++
  if (part.supplierId == null) linkedSupplier++
}
console.log('已更新价格 ' + updatedPrice + ' 个零件，新挂供应商 ' + linkedSupplier)
console.log('SKU 未找到 ' + notFound + '（示例：' + notFoundSample.join('、') + '）')
console.log('TO 未匹配供应商 ' + noSupplier)
process.exit(0)
