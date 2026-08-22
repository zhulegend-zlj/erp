// 从工程提供的 CSP_V3 清单 Excel 批量导入：成品 + 零件 + BOM。
// 命名规则（方案 1，老板确认）：
// - 官方料号照抄（CSP-xxx / F LOGO / Lithium Grease / 49-002769 等）；
// - CSP-013 七个长度变体 → CSP-013-1 ~ CSP-013-7（按表顺序，长度写在名称里）；
// - 螺丝/螺母/垫片/机米等标准件 → CSP-S01、CSP-S02…（按表顺序）；
// - 其余无料号杂项 → CSP-M01、CSP-M02…（按表顺序）。
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


async function main() {
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]!]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  const skuUsed = new Map<string, number>()
  const assumptions: string[] = []
  const mapping: unknown[][] = [['表内序号', '原表料号', '新SKU', '零件名称', '用量']]
  let csp13Seq = 0
  let sSeq = 0
  let mSeq = 0

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

    // 料号处理（方案 1：官方料号照抄优先；CSP-013 变体 -1~-7；无官方号的螺丝 CSP-Sxx；杂项 CSP-Mxx）
    const isFastener = /螺丝|螺母|垫片|机米/.test(name)
    let sku = ''
    if (/^CSP-013$/i.test(id)) {
      csp13Seq++
      sku = 'CSP-013-' + csp13Seq
    } else if (/^CSP-/.test(id)) {
      // 官方 CSP 料号照抄（即使名称含螺丝/螺母，如 CSP-005）
      sku = id
    } else if (isFastener) {
      sSeq++
      sku = 'CSP-S' + String(sSeq).padStart(2, '0')
    } else if (id === '' || id === '-') {
      mSeq++
      sku = 'CSP-M' + String(mSeq).padStart(2, '0')
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
    mapping.push([clean(raw[0]), id || '-', sku, name, amount])
  }

  console.log('--- 导入完成 ---')
  console.log('新增零件：', partCount, '，BOM 行：', bomCount)
  console.log('CSP-013 变体：', csp13Seq, '个；标准件 CSP-S：', sSeq, '个；杂项 CSP-M：', mSeq, '个')
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
