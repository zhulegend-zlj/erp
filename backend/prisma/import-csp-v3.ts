// 从工程提供的 CSP_V3 清单 Excel 批量导入：成品 + 零件 + BOM。
// 命名规则（老板确认）：
// - 结构件：沿用表内料号（CSP-xxx）；CSP-013 七个长度变体拆为 CSP-013-<长度>；
// - 标准螺丝：ISO 标准号 + 规格（如表内 ISO 4762 M3 x 13 先例）；
// - 其余无料号杂项：中文名称[-规格]（工程后续可改，改名自动同步目录）。
// 用法：cd backend && npx tsx --env-file=.env prisma/import-csp-v3.ts
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3清单_物料明细.xlsx'

const PRODUCT_SKU = 'CSP-V3'
const PRODUCT_NAME = 'CSP V3 挂档器'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

function screwIso(name: string, spec: string): string | null {
  // 尺寸优先取名称里的规格（如「M8 x 16 平头内六角螺丝」），名称没有才用规格列
  const fromName = name.match(/M\d+(?:\s*x\s*\d+(?:\.\d+)?)?/i)?.[0]
  const size = fromName || spec
  const s = size.replace(/\s+/g, ' ').replace(/x/g, ' x ').replace(/\s+/g, ' ').trim()
  if (name.includes('直纹') && name.includes('杯头')) return 'ISO 4762 ' + s + ' 直纹'
  if (name.includes('杯头')) return 'ISO 4762 ' + s
  if (name.includes('平头') && name.includes('内六角')) return 'ISO 10642 ' + s
  if (name.includes('扁头') && name.includes('内六角')) return 'ISO 10642 ' + s + ' 扁头'
  if (name.includes('沉头') && name.includes('内六角')) return 'ISO 10642 ' + s
  if (name.includes('半圆头')) return 'ISO 7380 ' + s
  if (name.includes('十字')) return 'ISO 7046 ' + s
  if (name.includes('机米')) return 'ISO 4026 ' + s
  if (name.includes('螺母')) return 'ISO 4032 ' + s
  if (name.includes('垫片')) return 'ISO 7093 ' + s
  return null
}

async function main() {
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]!]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  const skuUsed = new Map<string, number>()
  const assumptions: string[] = []
  let isoCount = 0

  // 成品
  const existingProduct = await prisma.product.findUnique({ where: { sku: PRODUCT_SKU } })
  const product =
    existingProduct ??
    (await prisma.product.create({ data: { sku: PRODUCT_SKU, name: PRODUCT_NAME, unit: '件' } }))
  console.log('成品：', product.sku, product.name, existingProduct ? '（已存在，复用）' : '（新建）')

  let partCount = 0
  let bomCount = 0
  for (const raw of data) {
    const id = clean(raw[1])
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const material = clean(raw[8])
    const dims = clean(raw[9])
    const finish = clean(raw[10])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    const tooling = clean(raw[13])

    if (!name) {
      assumptions.push('跳过无名称行 序号' + clean(raw[0]))
      continue
    }
    if (amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '') {
      assumptions.push('序号' + clean(raw[0]) + '「' + name + '」用量为空，按 1 处理')
    }

    // 料号处理
    let sku = id
    if (id === '' || id === '-') {
      const isoSku = screwIso(name, dims)
      if (isoSku) {
        sku = isoSku
        isoCount++
      } else {
        const shortSpec = dims ? '-' + dims.replace(/[\/\\:?"<>|]/g, '').slice(0, 30) : ''
        sku = name + shortSpec
      }
    } else if (id === 'CSP-013') {
      const m = name.match(/\*(\d+(?:\.\d+)?)\s*$/)
      if (m) {
        sku = 'CSP-013-' + m[1]
      } else {
        assumptions.push('CSP-013 行无法提取长度：' + name)
      }
    }
    sku = sku.trim()
    // 去重兜底
    const base = sku
    const n = skuUsed.get(base) ?? 0
    skuUsed.set(base, n + 1)
    if (n > 0) {
      sku = base + '-' + (n + 1)
      assumptions.push('SKU 重复，自动加后缀：' + base + ' → ' + sku + '（名称：' + name + '）')
    }

    const spec = [material, dims, finish].filter(Boolean).join('｜')
    const existingPart = await prisma.part.findUnique({ where: { sku } })
    const part =
      existingPart ??
      (await prisma.part.create({
        data: {
          sku,
          name: name.slice(0, 80),
          unit: '个',
          spec: spec.slice(0, 200) || null,
          tooling: tooling || null,
        },
      }))
    if (!existingPart) partCount++

    const existingBom = await prisma.bom.findUnique({
      where: { productId_partId: { productId: product.id, partId: part.id } },
    })
    if (!existingBom) {
      await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: amount } })
      bomCount++
    }
  }

  console.log('--- 导入完成 ---')
  console.log('新增零件：', partCount, '，BOM 行：', bomCount)
  console.log('ISO 标准件命名：', isoCount, '个')
  const [parts, boms] = await Promise.all([prisma.part.count(), prisma.bom.count({ where: { productId: product.id } })])
  console.log('当前库内零件总数：', parts, '，该成品 BOM 行数：', boms)
  console.log('--- 需老板/工程复核的假设 ---')
  for (const a of assumptions) console.log(' *', a)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
