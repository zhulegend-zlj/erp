// 销售流程测试资料：1 客户 + 1 成品 + 10 零件（BOM）+ 2 供应商，价格随机 ≤100 元
// 幂等：按 SKU/名称查重，存在则更新价格与供应商，不存在则新建。TEST 前缀与真实资料隔离。
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function randPrice(): number {
  // [1.00, 100.00]，保留 2 位小数
  const v = 1 + Math.random() * 99
  return Math.round(v * 100) / 100
}

async function upsertByName<T>(model: T, name: string, data: Record<string, unknown>) {
  const anyModel = model as unknown as {
    findFirst: (a: { where: { name: string } }) => Promise<{ id: number } | null>
    create: (a: { data: Record<string, unknown> }) => Promise<{ id: number }>
  }
  const existing = await anyModel.findFirst({ where: { name } })
  if (existing) return existing
  return anyModel.create({ data })
}

async function main() {
  const customer = await upsertByName(prisma.customer, 'TEST测试客户', {
    name: 'TEST测试客户',
    country: 'China',
    contact: 'TEST联系人',
    address: 'TEST ADDRESS 1, TEST CITY, CHINA',
    vatNo: 'TEST-VAT-001',
    eori: 'TEST-EORI-001',
    notifyParty: 'TEST NOTIFY PARTY\nATTN: RECEIVING',
  })
  console.log('客户：', customer.id, 'TEST测试客户')

  const supplierA = await upsertByName(prisma.supplier, 'TEST供应商A', { name: 'TEST供应商A', contact: 'TEST-A' })
  const supplierB = await upsertByName(prisma.supplier, 'TEST供应商B', { name: 'TEST供应商B', contact: 'TEST-B' })
  console.log('供应商：', supplierA.id, 'TEST供应商A /', supplierB.id, 'TEST供应商B')

  const product = await prisma.product.upsert({
    where: { sku: 'TEST-P100' },
    update: { name: 'TEST测试成品', nameEn: 'TEST SAMPLE PRODUCT', unit: '件', hsCode: '9504 50 0000' },
    create: { sku: 'TEST-P100', name: 'TEST测试成品', nameEn: 'TEST SAMPLE PRODUCT', unit: '件', hsCode: '9504 50 0000' },
  })
  console.log('成品：', product.id, product.sku, product.name)

  const rows: Array<{ sku: string; name: string; supplierId: number; supplier: string; price: number }> = []
  for (let i = 1; i <= 10; i++) {
    const sku = 'TEST-' + String(100 + i)
    const name = 'TEST测试零件' + String(i).padStart(2, '0')
    const supplierId = i <= 5 ? supplierA.id : supplierB.id
    const price = randPrice()
    const part = await prisma.part.upsert({
      where: { sku },
      update: { name, nameEn: 'TEST PART ' + String(i).padStart(2, '0'), unit: '个', supplierId, price },
      create: { sku, name, nameEn: 'TEST PART ' + String(i).padStart(2, '0'), unit: '个', supplierId, price },
    })
    rows.push({ sku, name, supplierId, supplier: i <= 5 ? 'TEST供应商A' : 'TEST供应商B', price })
  }

  // BOM：TEST-P100 = 10 个零件，每件用量 1（幂等：先清该成品 BOM 再重建）
  await prisma.bom.deleteMany({ where: { productId: product.id } })
  const parts = await prisma.part.findMany({ where: { sku: { startsWith: 'TEST-1' } } })
  await prisma.bom.createMany({
    data: parts.map((p) => ({ productId: product.id, partId: p.id, qty: 1 })),
  })

  console.log('')
  console.log('===== 结果：10 个零件（价格随机 ≤100 元，分挂两家供应商）=====')
  console.log('SKU          | 名称            | 供应商        | 价格(元)')
  for (const r of rows.sort((a, b) => a.sku.localeCompare(b.sku))) {
    console.log(r.sku.padEnd(13) + '| ' + r.name.padEnd(16) + '| ' + r.supplier.padEnd(14) + '| ' + r.price.toFixed(2))
  }
  const bomCount = await prisma.bom.count({ where: { productId: product.id } })
  console.log('')
  console.log('BOM 行数：', bomCount, '（成品', product.sku, '）')
  console.log('客户：TEST测试客户（地址/VAT/EORI/通知方已带测试值，可走出货单证全流程）')
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
