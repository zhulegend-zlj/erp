import { PrismaClient } from '@prisma/client'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyStockChange } from '../src/domain/inventory'

const prisma = new PrismaClient()
const uploadDir = resolve(process.cwd(), 'uploads')

function ensureSvg(filename: string, label: string, bg = '#eef3ff'): string {
  mkdirSync(uploadDir, { recursive: true })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="100%" height="100%" rx="16" fill="${bg}"/><text x="50%" y="50%" font-size="28" text-anchor="middle" dominant-baseline="middle" fill="#333">${label}</text></svg>`
  writeFileSync(resolve(uploadDir, filename), svg, 'utf8')
  return '/uploads/' + filename
}

async function ensureSupplier(name: string, contact: string) {
  const existing = await prisma.supplier.findFirst({ where: { name } })
  if (existing) return existing
  return prisma.supplier.create({ data: { name, contact } })
}

async function main() {
  // 1. 供应商
  const supplierNames = ['广祺', '铭亚', '金菱', '马卡金']
  const suppliers: Record<string, number> = {}
  for (const name of supplierNames) {
    const s = await ensureSupplier(name, name + '联系人')
    suppliers[name] = s.id
  }

  // 2. 零件（每个成品 6 个，共 18 个）
  const partDefs = [
    // v3
    ['v3-01', 'v3轴', 'M4', '广祺'],
    ['v3-02', 'v3底板', '黑色', '铭亚'],
    ['v3-03', 'v3面盖', '黑色有Logo', '金菱'],
    ['v3-04', 'v3中缸', '黑色', '马卡金'],
    ['v3-05', 'v3密封圈', '硅胶', '广祺'],
    ['v3-06', 'v3螺丝', 'M3*8', '铭亚'],
    // v3i
    ['v3i-01', 'v3i轴', 'M4', '广祺'],
    ['v3i-02', 'v3i底板', '黑色', '铭亚'],
    ['v3i-03', 'v3i面盖', '黑色有Logo', '金菱'],
    ['v3i-04', 'v3i中缸', '黑色', '马卡金'],
    ['v3i-05', 'v3i密封圈', '硅胶', '广祺'],
    ['v3i-06', 'v3i螺丝', 'M3*8', '铭亚'],
    // css
    ['css-01', 'css轴', 'M5', '广祺'],
    ['css-02', 'css底板', '黑色', '铭亚'],
    ['css-03', 'css面盖', '黑色有Logo', '金菱'],
    ['css-04', 'css中缸', '黑色', '马卡金'],
    ['css-05', 'css密封圈', '硅胶', '广祺'],
    ['css-06', 'css螺丝', 'M4*10', '铭亚'],
  ] as const

  const partIds: Record<string, number> = {}
  for (const [sku, name, spec, supplierName] of partDefs) {
    const existing = await prisma.part.findUnique({ where: { sku } })
    const part = existing ?? await prisma.part.create({
      data: {
        sku,
        name,
        spec,
        supplierId: suppliers[supplierName],
        imageUrl: ensureSvg(sku + '.svg', name),
      },
    })
    partIds[sku] = part.id
  }

  // 3. 成品
  const productDefs = [
    ['001', 'v3', '/uploads/v3-product.jpg'],
    ['002', 'v3i', ensureSvg('v3i-product.svg', 'v3i', '#fff3e0')],
    ['003', 'css', ensureSvg('css-product.svg', 'css', '#e8f5e9')],
  ] as const
  const productIds: Record<string, number> = {}
  for (const [sku, name, imageUrl] of productDefs) {
    const p = await prisma.product.upsert({
      where: { sku },
      update: { name, imageUrl },
      create: { sku, name, imageUrl },
    })
    productIds[sku] = p.id
  }

  // 4. BOM
  const boms: Record<string, string[]> = {
    '001': ['v3-01', 'v3-02', 'v3-03', 'v3-04', 'v3-05', 'v3-06'],
    '002': ['v3i-01', 'v3i-02', 'v3i-03', 'v3i-04', 'v3i-05', 'v3i-06'],
    '003': ['css-01', 'css-02', 'css-03', 'css-04', 'css-05', 'css-06'],
  }
  for (const [productSku, partSkus] of Object.entries(boms)) {
    for (const partSku of partSkus) {
      await prisma.bom.upsert({
        where: { productId_partId: { productId: productIds[productSku], partId: partIds[partSku] } },
        update: { qty: 1 },
        create: { productId: productIds[productSku], partId: partIds[partSku], qty: 1 },
      })
    }
  }

  // 5. 客户
  const customer =
    (await prisma.customer.findFirst({ where: { name: '海外客户A' } })) ??
    (await prisma.customer.create({
      data: { name: '海外客户A', country: 'USA', contact: 'Tom' },
    }))

  // 6. 销售订单（每个成品一单；已存在则跳过）
  const orderDefs = [
    { orderNo: 'DEMO-V3', productSku: '001', qty: 10, status: 'ready' },
    { orderNo: 'DEMO-V3I', productSku: '002', qty: 8, status: 'in_production' },
    { orderNo: 'DEMO-CSS', productSku: '003', qty: 12, status: 'shipped' },
  ] as const

  for (const od of orderDefs) {
    const existingOrder = await prisma.salesOrder.findUnique({ where: { orderNo: od.orderNo } })
    if (existingOrder) continue

    await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.create({
        data: {
          orderNo: od.orderNo,
          customerId: customer.id,
          deliveryDate: new Date('2026-09-30'),
          status: od.status,
          items: {
            create: {
              productId: productIds[od.productSku],
              qty: od.qty,
              unitPrice: 100,
            },
          },
        },
      })

      // 先给零件/成品备库存，再做领料/入库/出货，让流水有数据
      const partSkus = boms[od.productSku]
      for (const partSku of partSkus) {
        await applyStockChange(tx, 'part', partIds[partSku], od.qty * 2, 'receipt', order.id, order.id)
      }
      await applyStockChange(tx, 'product', productIds[od.productSku], od.qty, 'production', order.id, order.id)

      // 领料出库：部分零件按需求出库
      for (const partSku of partSkus) {
        const issued = od.qty
        await tx.issue.create({
          data: { salesOrderId: order.id, partId: partIds[partSku], qty: issued, issuedBy: '张组长' },
        })
        await applyStockChange(tx, 'part', partIds[partSku], -issued, 'issue', order.id, order.id)
      }

      // 出货：shipped 订单再扣成品库存
      if (od.status === 'shipped') {
        const shipment = await tx.shipment.create({ data: { salesOrderId: order.id } })
        await applyStockChange(tx, 'product', productIds[od.productSku], -od.qty, 'shipment', shipment.id, order.id)
      }
    })
  }

  console.log('演示数据已注入：3 个成品 / 18 个零件 / 3 张销售订单')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
