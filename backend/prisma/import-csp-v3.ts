// 从工程提供的 CSP_V3 清单 Excel 批量导入：成品 + 零件 + BOM。
// 命名规则（最终版，老板确认）：
// - 官方料号照抄（CSP-xxx / F LOGO / Lithium Grease / 49-002769 等）；
// - CSP-013 七个长度变体 → CSP-013-1 ~ CSP-013-7（按表顺序，长度写在名称里）；
// - 螺丝/螺母/垫片/机米等标准件 → 规格+类型（跨机种同规格同料号，如 M3x13-杯头、M6-垫片）；
// - 其余无料号杂项 → CSP-201、CSP-202…（按表顺序）。
// 表格列逐列落库：英文品名/重量/版本/材质/尺寸规格/表面处理/图号 存独立字段；
// Description-EN、用在何处、生产工艺 三列不导入（数据库字段暂存不使用）。
// 导入方式：先清空该成品的 BOM 与其专属零件（无其他 BOM/业务引用的零件），再按表重新导入；
// 供应商按名称复用，不删除。可重复执行（幂等）。
// 每次导入生成对照表：D:/AI/erp-backups/CSP-V3-SKU对照表.xlsx
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

// 螺丝/标准件料号：规格+类型（跨机种同规格同料号，如 M3x13-杯头、M6-垫片）
function screwSku(name: string, dims: string): string {
  const fromName = name.match(/M\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?/i)?.[0]
  const raw = (fromName || dims).replace(/\s+/g, '').replace(/\*/g, 'x')
  const m = raw.match(/M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?/i)
  const size = m ? 'M' + m[1] + (m[2] ? 'x' + m[2] : '') : raw
  if (name.includes('直纹') && name.includes('杯头')) return size + '-杯头直纹'
  if (name.includes('杯头')) return size + '-杯头'
  if (name.includes('扁头')) return size + '-扁头'
  if (name.includes('十字')) return size + '-十字'
  if (name.includes('沉头')) return size + '-沉头'
  if (name.includes('平头')) return size + '-平头'
  if (name.includes('半圆头')) return size + '-半圆头'
  if (name.includes('机米')) return size + '-机米'
  if (name.includes('盖型螺母')) return size + '-盖型螺母'
  if (name.includes('螺母')) return size + '-螺母'
  if (name.includes('垫片')) return size + '-垫片'
  return name
}

async function main() {
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]!]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  const product =
    (await prisma.product.findUnique({ where: { sku: PRODUCT_SKU } })) ??
    (await prisma.product.create({ data: { sku: PRODUCT_SKU, name: PRODUCT_NAME, unit: '件' } }))

  // —— 清空该成品旧数据（按老板确认的口径：清空 CSP-V3 零件和 BOM 后全新导入）——
  const oldBoms = await prisma.bom.findMany({ where: { productId: product.id } })
  await prisma.bom.deleteMany({ where: { productId: product.id } })
  let deletedParts = 0
  let keptParts: string[] = []
  for (const b of oldBoms) {
    const part = await prisma.part.findUnique({ where: { id: b.partId } })
    if (!part) continue
    const [otherBoms, purchaseItems, receipts, issues, rr] = await Promise.all([
      prisma.bom.count({ where: { partId: part.id } }),
      prisma.purchaseOrderItem.count({ where: { partId: part.id } }),
      prisma.receipt.count({ where: { partId: part.id } }),
      prisma.issue.count({ where: { partId: part.id } }),
      prisma.returnReplenish.count({ where: { partId: part.id } }),
    ])
    if (otherBoms + purchaseItems + receipts + issues + rr === 0) {
      await prisma.part.delete({ where: { id: part.id } })
      deletedParts++
    } else {
      keptParts.push(part.sku)
    }
  }
  console.log('已清空旧 BOM：', oldBoms.length, '行；删除无引用零件：', deletedParts, '个')
  if (keptParts.length) console.log('保留仍被引用零件：', keptParts.join(', '))

  const skuUsed = new Map<string, number>()
  const assumptions: string[] = []
  const mapping: unknown[][] = [['表内序号', '原表料号', '新SKU', '零件名称', '用量', '供应商']]
  let csp13Seq = 0
  let mSeq = 0
  let screwCount = 0
  const bomQty = new Map<number, number>()

  let partCount = 0
  let bomCount = 0
  for (const raw of data) {
    const id = clean(raw[1])
    const nameEn = clean(raw[4])
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const weight = clean(raw[6])
    const revision = clean(raw[7])
    const material = clean(raw[8])
    const dims = clean(raw[9])
    const finish = clean(raw[10])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    const tooling = clean(raw[13])
    const moqRaw = raw[14]
    const artId = clean(raw[18])
    const vendorRaw = clean(raw[19])

    if (!name) {
      assumptions.push('跳过无名称行 序号' + clean(raw[0]))
      continue
    }
    if (amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '') {
      assumptions.push('序号' + clean(raw[0]) + '「' + name + '」用量为空，按 1 处理')
    }

    // 料号处理（最终版：官方料号照抄优先；CSP-013 变体 -1~-7；无官方号的螺丝规格+类型；杂项 CSP-2xx）
    const isFastener = /螺丝|螺母|垫片|机米/.test(name)
    let sku = ''
    if (/^CSP-013$/i.test(id)) {
      csp13Seq++
      sku = 'CSP-013-' + csp13Seq
    } else if (/^CSP-/.test(id)) {
      // 官方 CSP 料号照抄（即使名称含螺丝/螺母，如 CSP-005）
      sku = id
    } else if (isFastener) {
      // 螺丝：规格+类型（跨机种同规格同料号）
      sku = screwSku(name, dims)
      screwCount++
    } else if (id === '' || id === '-') {
      mSeq++
      sku = 'CSP-' + (200 + mSeq)
    } else {
      // 官方料号照抄（CSP-xxx / F LOGO / Lithium Grease / 49-002769 等）
      sku = id
    }
    sku = sku.trim()
    // 去重兜底（理论上不会触发）
    const base = sku
    const n = skuUsed.get(base) ?? 0
    skuUsed.set(base, n + 1)
    if (n > 0) {
      sku = base + '-' + (n + 1)
      assumptions.push('SKU 重复，自动加后缀：' + base + ' → ' + sku + '（名称：' + name + '）')
    }

    const spec = [material, dims, finish].filter(Boolean).join('｜')
    // 供应商（表内 Vendorid 列）：像名字的建/挂供应商，'0'、'自己打印'、'改为自购' 等非供应商值跳过
    const vendorName = vendorRaw && vendorRaw !== '0' && !vendorRaw.includes('自己打印') && !vendorRaw.includes('改为自购')
      ? vendorRaw.split('/')[0]!.trim()
      : ''
    let supplierId: number | null = null
    if (vendorName) {
      const existingSupplier = await prisma.supplier.findFirst({ where: { name: vendorName } })
      supplierId =
        existingSupplier?.id ??
        (await prisma.supplier.create({ data: { name: vendorName } })).id
    }
    const existingPart = await prisma.part.findUnique({ where: { sku } })
    const partData = {
      sku,
      name: name.slice(0, 80),
      nameEn: nameEn || null,
      unit: '个',
      spec: spec.slice(0, 200) || null,
      weight: weight || null,
      revision: revision || null,
      material: material || null,
      dimensions: dims || null,
      finish: finish || null,
      artId: artId || null,
      tooling: tooling || null,
      moq: moqRaw === '' || moqRaw === null || moqRaw === undefined ? null : Number(moqRaw),
      supplierId,
    }
    let part = existingPart
    if (!existingPart) {
      part = await prisma.part.create({ data: partData })
      partCount++
    } else {
      await prisma.part.update({ where: { id: existingPart.id }, data: partData })
    }

    // 同一 SKU 出现多行时用量累加（如跨机种共用螺丝）
    bomQty.set(part.id, (bomQty.get(part.id) ?? 0) + amount)
    mapping.push([clean(raw[0]), id || '-', sku, name, amount, vendorRaw])
  }

  for (const [partId, qty] of bomQty.entries()) {
    const existingBom = await prisma.bom.findUnique({
      where: { productId_partId: { productId: product.id, partId } },
    })
    if (existingBom) {
      await prisma.bom.update({ where: { id: existingBom.id }, data: { qty } })
    } else {
      await prisma.bom.create({ data: { productId: product.id, partId, qty } })
    }
    bomCount++
  }

  console.log('--- 导入完成 ---')
  console.log('新增零件：', partCount, '，BOM 行：', bomCount)
  console.log('CSP-013 变体：', csp13Seq, '个；螺丝（规格+类型命名）：', screwCount, '个；自命名 CSP-2xx：', mSeq, '个')
  const [parts, boms] = await Promise.all([prisma.part.count(), prisma.bom.count({ where: { productId: product.id } })])
  console.log('当前库内零件总数：', parts, '，该成品 BOM 行数：', boms)
  console.log('--- 需老板/工程复核的假设 ---')
  for (const a of assumptions) console.log(' *', a)
  // 导出对照表供工程核对
  const outFile = 'D:/AI/erp-backups/CSP-V3-SKU对照表.xlsx'
  const outWs = XLSX.utils.aoa_to_sheet(mapping)
  outWs['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 14 }, { wch: 40 }, { wch: 6 }]
  const wbOut = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wbOut, outWs, '对照表')
  XLSX.writeFile(wbOut, outFile)
  console.log('对照表已导出：', outFile)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
