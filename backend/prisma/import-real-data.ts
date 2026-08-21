import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const prisma = new PrismaClient()
const uploadDir = resolve(process.cwd(), 'uploads')
const FILES_DIR = 'C:\\Users\\zhulianghong\\xwechat_files\\wxid_cfbx0uckwvyn22_cf17\\msg\\file\\2026-08'

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function hashKey(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10)
}

function ensureSvg(filename: string, label: string, bg = '#eef3ff'): string {
  mkdirSync(uploadDir, { recursive: true })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="100%" height="100%" rx="16" fill="${bg}"/><text x="50%" y="50%" font-size="26" text-anchor="middle" dominant-baseline="middle" fill="#333">${label}</text></svg>`
  writeFileSync(resolve(uploadDir, filename), svg, 'utf8')
  return '/uploads/' + filename
}

async function ensureSupplier(name: string) {
  const clean = String(name ?? '').trim()
  if (!clean) return null
  const existing = await prisma.supplier.findFirst({ where: { name: clean } })
  if (existing) return existing
  return prisma.supplier.create({ data: { name: clean } })
}

function parseMaterial(raw: unknown): { sku: string; name: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { sku: '', name: '' }
  const parts = s.split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean)
  if (parts.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[0])) {
    return { sku: parts[0], name: parts.slice(1).join(' ') }
  }
  return { sku: '', name: s.replace(/\s+/g, ' ') }
}

async function ensurePart(
  rawSku: string,
  name: string,
  spec: unknown,
  supplierName: string
) {
  const cleanName = String(name ?? '').trim() || '未命名物料'
  const cleanSpec = String(spec ?? '').trim()
  const supplier = await ensureSupplier(supplierName)
  const sku = rawSku || 'MISC-' + hashKey(cleanName + '|' + cleanSpec + '|' + (supplier?.name ?? ''))
  const safeSku = slug(sku) || 'part-' + hashKey(sku)
  const imageUrl = ensureSvg(safeSku + '.svg', cleanName)
  return prisma.part.upsert({
    where: { sku },
    update: { name: cleanName, spec: cleanSpec || null, supplierId: supplier?.id ?? null },
    create: {
      sku,
      name: cleanName,
      spec: cleanSpec || null,
      supplierId: supplier?.id ?? null,
      imageUrl,
    },
  })
}

async function ensureProduct(sku: string, name: string) {
  const imageUrl = ensureSvg('product-' + slug(sku) + '.svg', name, '#fff3e0')
  return prisma.product.upsert({
    where: { sku },
    update: { name },
    create: { sku, name, imageUrl },
  })
}

function readSheet(fileName: string, sheetName: string): unknown[][] {
  const buf = readFileSync(resolve(FILES_DIR, fileName))
  const wb = XLSX.read(buf, { type: 'buffer' })
  const ws = wb.Sheets[sheetName]
  if (!ws) return []
  return XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
}

const PRODUCTS = [
  {
    sku: 'CSS-SQ',
    name: '挂档器',
    file: '2026年7月22日始挂档器(SQ)物料入出库表.xlsx',
    sheets: ['订单269777物料计算', '订单269776物料计算'],
  },
  {
    sku: 'CSP-V3',
    name: '脚踏板 V3',
    file: '2026年7月22日始脚踏板物料入出库表.xlsx',
    sheets: ['订单269018(V3)物料计算', '订单269174(V3)物料计算'],
  },
  {
    sku: 'CSP-V3I',
    name: 'V3I',
    file: '2026年7月22日始脚踏板物料入出库表.xlsx',
    sheets: ['订单269021(V3I)物料计算'],
  },
] as const

async function importBoms() {
  for (const prod of PRODUCTS) {
    const product = await ensureProduct(prod.sku, prod.name)
    for (const sheet of prod.sheets) {
      const rows = readSheet(prod.file, sheet)
      for (let i = 3; i < rows.length; i++) {
        const row = rows[i]
        if (!row || !row[1]) continue
        const usage = Number(row[5])
        if (!Number.isFinite(usage) || usage <= 0) continue
        const mat = parseMaterial(row[1])
        if (!mat.name) continue
        const supplierName = String(row[3] ?? '').trim()
        const part = await ensurePart(mat.sku, mat.name, row[4], supplierName)
        await prisma.bom.upsert({
          where: { productId_partId: { productId: product.id, partId: part.id } },
          update: { qty: usage },
          create: { productId: product.id, partId: part.id, qty: usage },
        })
      }
    }
  }
}

async function importLoosePartsFromInventory() {
  const inventoryDefs = [
    { file: '2026.8月份挂档器物料表.xlsx', sheet: '库存表' },
    { file: '2026.8月份杂项（螺丝等未编号）物料表.xlsx', sheet: '库存表' },
    { file: '2026.8月份脚板物料表.xlsx', sheet: '库存表' },
  ]
  for (const def of inventoryDefs) {
    const rows = readSheet(def.file, def.sheet)
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i]
      if (!row || !row[0]) continue
      const mat = parseMaterial(row[0])
      if (!mat.name) continue
      const supplierName = String(row[1] ?? '').trim()
      await ensurePart(mat.sku, mat.name, row[2], supplierName)
    }
  }
}

async function importReturnSheetParts() {
  const file = '物料退补货表.xlsx'
  const buf = readFileSync(resolve(FILES_DIR, file))
  const wb = XLSX.read(buf, { type: 'buffer' })
  for (const sheet of wb.SheetNames) {
    if (sheet.startsWith('杂项')) continue
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 }) as unknown[][]
    const supplierName = sheet.replace(/（.*$/, '').trim()
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i]
      if (!row || !row[0]) continue
      const mat = parseMaterial(row[0])
      if (!mat.name) continue
      await ensurePart(mat.sku, mat.name, row[1], supplierName)
    }
  }
}

async function main() {
  console.log('开始导入真实基础资料...')
  await importBoms()
  await importLoosePartsFromInventory()
  await importReturnSheetParts()
  const [productCount, partCount, supplierCount, bomCount] = await Promise.all([
    prisma.product.count(),
    prisma.part.count(),
    prisma.supplier.count(),
    prisma.bom.count(),
  ])
  console.log('导入完成：成品=' + productCount + ' 零件=' + partCount + ' 供应商=' + supplierCount + ' BOM=' + bomCount)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
