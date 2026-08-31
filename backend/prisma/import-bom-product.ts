// 按「汇总对照表」导入单个成品：成品 + 新建零件 + BOM（共用零件不重复建）
// 用法：cd backend && PRODUCT='P_APM-ENDOR金' PRODUCT_NAME='P APM 拨片（Endor 出货·金色磁铁）' PRODUCT_EN='P APM' npx tsx prisma/import-bom-product.ts
// 幂等：成品按 SKU 复用；该成品旧 BOM 先清空再按表重建；零件 SKU 已存在则复用不覆盖字段。
import ExcelJS from 'exceljs'
import { prisma } from '../src/db'

const PRODUCT = process.env.PRODUCT ?? ''
const PRODUCT_NAME = process.env.PRODUCT_NAME ?? PRODUCT
const PRODUCT_EN = process.env.PRODUCT_EN ?? ''
const SRC = process.env.SRC ?? 'D:/AI/工程/成品BOM-汇总对照表-20260831-v3.xlsx'
if (!PRODUCT) { console.log('缺少 PRODUCT 环境变量'); process.exit(1) }

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(SRC)
const ws = wb.getWorksheet(PRODUCT)
if (!ws) { console.log('对照表里找不到 sheet: ' + PRODUCT); process.exit(1) }

const clean = (v: unknown) => String(v ?? '').trim()
interface Row { seq: string; sku: string; cn: string; en: string; weight: string; rev: string; material: string; dims: string; finish: string; amount: number; vendor: string }
const rows: Row[] = []
ws.eachRow((row, i) => {
  if (i === 1) return
  const sku = clean(row.getCell(4).value)
  const amount = Number(row.getCell(15).value ?? 0)
  if (!sku) return
  rows.push({
    seq: clean(row.getCell(1).value), sku,
    cn: clean(row.getCell(7).value), en: clean(row.getCell(8).value),
    weight: clean(row.getCell(9).value), rev: clean(row.getCell(10).value),
    material: clean(row.getCell(11).value), dims: clean(row.getCell(12).value),
    finish: clean(row.getCell(13).value), amount: Number.isFinite(amount) ? amount : 0,
    vendor: clean(row.getCell(18).value),
  })
})
console.log('对照表行数：' + rows.length)

// 供应商按名称精确匹配，匹配不到先留空
const sups = await prisma.supplier.findMany({ select: { id: true, name: true } })
const supMap = new Map(sups.map((s) => [s.name, s.id]))

// 成品：复用或新建
let product = await prisma.product.findUnique({ where: { sku: PRODUCT } })
if (!product) {
  product = await prisma.product.create({ data: { sku: PRODUCT, name: PRODUCT_NAME, nameEn: PRODUCT_EN || null, unit: '件' } })
  console.log('新建成品：' + product.sku + '「' + product.name + '」')
} else {
  await prisma.product.update({ where: { id: product.id }, data: { name: PRODUCT_NAME } })
  console.log('复用成品：' + product.sku)
}

// 该成品旧 BOM 清空（幂等重导）
const oldBoms = await prisma.bom.deleteMany({ where: { productId: product.id } })
console.log('清空旧 BOM ' + oldBoms.count + ' 行')

let createdParts = 0, reusedParts = 0, bomCount = 0
const skipped: string[] = []
for (const r of rows) {
  let part = await prisma.part.findUnique({ where: { sku: r.sku } })
  if (!part) {
    part = await prisma.part.create({
      data: {
        sku: r.sku,
        name: r.cn || r.en || r.sku,
        nameEn: r.en || null,
        weight: r.weight || null,
        revision: r.rev || null,
        material: r.material || null,
        dimensions: r.dims || null,
        finish: r.finish || null,
        unit: '个',
        supplierId: supMap.get(r.vendor) ?? null,
      },
    })
    createdParts++
  } else {
    reusedParts++
  }
  if (r.amount <= 0) {
    skipped.push(r.sku + '（用量0）')
    continue
  }
  await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: r.amount } })
  bomCount++
}

console.log('零件：新建 ' + createdParts + '，复用已有 ' + reusedParts)
console.log('BOM 行：' + bomCount)
if (skipped.length) console.log('用量为0跳过BOM：' + skipped.join('、'))
const check = await prisma.bom.count({ where: { productId: product.id } })
console.log('核验：' + PRODUCT + ' BOM 行数 = ' + check)
process.exit(0)
