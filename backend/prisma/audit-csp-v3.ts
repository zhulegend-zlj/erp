// CSP_V3 导入数据与源表格逐行核对脚本（只读，不改库）。
// 用法：cd backend && npx tsx --env-file=.env prisma/audit-csp-v3.ts
// 对比口径与 import-csp-v3.ts 完全一致：clean() 归一化、SKU 规则、供应商跳过规则、用量累加。
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3清单_物料明细.xlsx'
const PRODUCT_SKU = 'CSP-V3'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

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
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!], { header: 1, raw: true }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  const errors: string[] = []
  const warnings: string[] = []
  let checked = 0
  const bomExpected = new Map<string, number>()
  let csp13Seq = 0
  let mSeq = 0
  let screwCount = 0
  const skuUsed = new Map<string, number>()

  const vendorExpected: string[] = []
  const seqValues: string[] = []

  for (const raw of data) {
    const seq = clean(raw[0])
    seqValues.push(seq)
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
    if (!name) continue

    const isFastener = /螺丝|螺母|垫片|机米/.test(name)
    let sku = ''
    if (/^CSP-013$/i.test(id)) {
      csp13Seq++
      sku = 'CSP-013-' + csp13Seq
    } else if (/^CSP-/.test(id)) {
      sku = id
    } else if (isFastener) {
      sku = screwSku(name, dims)
      screwCount++
    } else if (id === '' || id === '-') {
      mSeq++
      sku = 'CSP-' + (200 + mSeq)
    } else {
      sku = id
    }
    sku = sku.trim()
    const base = sku
    const n = skuUsed.get(base) ?? 0
    skuUsed.set(base, n + 1)
    if (n > 0) {
      sku = base + '-' + (n + 1)
      warnings.push('序号' + seq + ' SKU 与前面重复，已按规则加后缀：' + sku)
    }

    const vendorName = vendorRaw && vendorRaw !== '0' && !vendorRaw.includes('自己打印') && !vendorRaw.includes('改为自购')
      ? vendorRaw.split('/')[0]!.trim()
      : ''
    if (vendorRaw && !vendorName) warnings.push('序号' + seq + '「' + name + '」供应商值「' + vendorRaw.replace(/\s+/g, ' ') + '」按规则跳过（非真实供应商）')
    if (vendorName) vendorExpected.push(sku + '→' + vendorName)

    bomExpected.set(sku, (bomExpected.get(sku) ?? 0) + amount)
    checked++

    const part = await prisma.part.findUnique({ where: { sku } })
    if (!part) {
      errors.push('序号' + seq + ' SKU ' + sku + ' 库里不存在！')
      continue
    }
    const cmp = (label: string, expected: string | null, actual: string | null) => {
      const e = expected || null
      const a = actual || null
      if (e !== a) errors.push('序号' + seq + ' ' + sku + ' ' + label + ' 不一致：表格=' + JSON.stringify(e) + ' 库=' + JSON.stringify(a))
    }
    cmp('中文名称', name.slice(0, 80), part.name)
    cmp('英文品名', nameEn || null, part.nameEn)
    cmp('重量', weight || null, part.weight)
    cmp('版本', revision || null, part.revision)
    cmp('材质', material || null, part.material)
    cmp('尺寸规格', dims || null, part.dimensions)
    cmp('表面处理', finish || null, part.finish)
    cmp('图号', artId || null, part.artId)
    cmp('模具', tooling || null, part.tooling)
    const moqExpected = moqRaw === '' || moqRaw === null || moqRaw === undefined ? null : Number(moqRaw)
    if (moqExpected !== part.moq) errors.push('序号' + seq + ' ' + sku + ' MOQ 不一致：表格=' + moqExpected + ' 库=' + part.moq)
    if (part.unit !== '个') errors.push('序号' + seq + ' ' + sku + ' 单位应为 个，库=' + part.unit)
    if (vendorName) {
      const sup = part.supplierId ? await prisma.supplier.findUnique({ where: { id: part.supplierId } }) : null
      if (!sup || sup.name !== vendorName) errors.push('序号' + seq + ' ' + sku + ' 供应商不一致：表格=' + vendorName + ' 库=' + (sup?.name ?? '(无)'))
    } else if (part.supplierId) {
      errors.push('序号' + seq + ' ' + sku + ' 表格无供应商但库里有 supplierId=' + part.supplierId)
    }
  }

  // BOM 用量核对
  const boms = await prisma.bom.findMany({ where: { product: { sku: PRODUCT_SKU } }, include: { part: { select: { sku: true } } } })
  const bomActual = new Map<string, number>()
  for (const b of boms) bomActual.set(b.part.sku, b.qty)
  for (const [sku, qty] of bomExpected) {
    const a = bomActual.get(sku)
    if (a !== qty) errors.push('BOM 用量不一致：' + sku + ' 表格=' + qty + ' 库=' + (a ?? '(无BOM行)'))
    bomActual.delete(sku)
  }
  for (const [sku, qty] of bomActual) errors.push('库里多出 BOM 行：' + sku + ' 用量=' + qty)

  // 数量与全局一致性
  const [partsTotal, bomsTotal, suppliersTotal, links] = await Promise.all([
    prisma.part.count(),
    prisma.bom.count({ where: { product: { sku: PRODUCT_SKU } } }),
    prisma.supplier.count(),
    prisma.part.count({ where: { supplierId: { not: null } } }),
  ])
  const orphans = await prisma.part.count({ where: { boms: { none: {} } } })
  const imgCount = await prisma.part.count({ where: { imageUrl: { not: null } } })
  console.log('=== 全局 ===')
  console.log('表格数据行：', data.length, '；比对行数：', checked)
  console.log('库内零件总数：', partsTotal, '；该成品 BOM 行数：', bomsTotal, '；供应商数：', suppliersTotal, '；挂供应商零件数：', links)
  console.log('无任何 BOM 的零件：', orphans, '；有图片零件：', imgCount)
  console.log('SKU 分类：CSP-013 变体', csp13Seq, '；螺丝规格+类型', screwCount, '；自命名 CSP-2xx', mSeq)

  // 表内序号完整性
  const seqNums = seqValues.map((s) => Number(s)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
  const seqSet = new Set(seqNums)
  const missing: number[] = []
  for (let i = 1; i <= Math.max(...seqNums); i++) if (!seqSet.has(i)) missing.push(i)
  const dupSeq = seqNums.filter((v, i) => seqNums.indexOf(v) !== i)
  if (missing.length) warnings.push('表内序号列缺失：' + missing.join(', '))
  if (dupSeq.length) warnings.push('表内序号列重复：' + [...new Set(dupSeq)].join(', '))

  console.log('\n=== 差异（errors）===')
  if (errors.length === 0) console.log('（无）')
  else for (const e of errors) console.log(' ✗', e)
  console.log('\n=== 提醒（表格本身的口径/特殊值，非导入错误）===')
  for (const w of warnings) console.log(' •', w)
  console.log('\n结论：', errors.length === 0 ? '数据与表格完全一致 ✓' : '发现 ' + errors.length + ' 处不一致 ✗')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
