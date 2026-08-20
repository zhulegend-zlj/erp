import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie } from './helpers'
import { prisma } from '../db'

const SUPPLIERS = ['供应商X', '供应商Y']
const PART_SKUS = ['P100', 'P7-A', 'P7-B']
const PRODUCT_SKUS = ['F7-1', 'F7-2']
const CUSTOMERS = ['客户7']

describe('purchasing', () => {
  beforeEach(async () => {
    // 保证重复运行（含全量测试）时固定 SKU/名称不触发唯一约束
    const parts = await prisma.part.findMany({ where: { sku: { in: PART_SKUS } }, select: { id: true } })
    const partIds = parts.map((p) => p.id)
    if (partIds.length > 0) {
      await prisma.receipt.deleteMany({ where: { partId: { in: partIds } } })
      await prisma.purchaseOrderItem.deleteMany({ where: { partId: { in: partIds } } })
      await prisma.issue.deleteMany({ where: { partId: { in: partIds } } })
      await prisma.stock.deleteMany({ where: { itemType: 'part', itemId: { in: partIds } } })
      await prisma.inventoryLedger.deleteMany({ where: { itemType: 'part', itemId: { in: partIds } } })
    }
    const products = await prisma.product.findMany({ where: { sku: { in: PRODUCT_SKUS } }, select: { id: true } })
    const productIds = products.map((p) => p.id)
    if (productIds.length > 0) {
      await prisma.bom.deleteMany({ where: { productId: { in: productIds } } })
      await prisma.salesOrderItem.deleteMany({ where: { productId: { in: productIds } } })
    }
    await prisma.purchaseOrder.deleteMany({ where: { supplier: { name: { in: SUPPLIERS } } } })
    await prisma.salesOrder.deleteMany({ where: { customer: { name: { in: CUSTOMERS } } } })
    await prisma.customer.deleteMany({ where: { name: { in: CUSTOMERS } } })
    await prisma.part.deleteMany({ where: { sku: { in: PART_SKUS } } })
    await prisma.product.deleteMany({ where: { sku: { in: PRODUCT_SKUS } } })
    await prisma.supplier.deleteMany({ where: { name: { in: SUPPLIERS } } })
  })

  it('收货后零件库存增加', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const part = await prisma.part.create({ data: { sku: 'P100', name: '螺丝' } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'PO-1', supplierId: supplier.id, items: { create: { partId: part.id, qty: 100, unitPrice: 0.5 } } }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 100 }] }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(100)
  })

  it('需求计算跨订单明细累加同一零件并扣减库存得出缺口', async () => {
    const partA = await prisma.part.create({ data: { sku: 'P7-A', name: '螺丝A' } })
    const partB = await prisma.part.create({ data: { sku: 'P7-B', name: '螺丝B' } })
    const p1 = await prisma.product.create({ data: { sku: 'F7-1', name: '成品1' } })
    const p2 = await prisma.product.create({ data: { sku: 'F7-2', name: '成品2' } })
    await prisma.bom.createMany({
      data: [
        { productId: p1.id, partId: partA.id, qty: 2 },
        { productId: p2.id, partId: partA.id, qty: 1 },
        { productId: p2.id, partId: partB.id, qty: 5 }
      ]
    })
    const customer = await prisma.customer.create({ data: { name: '客户7' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-REQ-7',
        customerId: customer.id,
        deliveryDate: new Date('2026-10-01'),
        status: 'confirmed',
        items: {
          create: [
            { productId: p1.id, qty: 3, unitPrice: 10 },
            { productId: p2.id, qty: 4, unitPrice: 20 }
          ]
        }
      }
    })
    await prisma.stock.create({ data: { itemType: 'part', itemId: partA.id, qtyOnHand: 3 } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'GET', url: `/api/purchasing/requirements?orderId=${order.id}`, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const a = rows.find((r: any) => r.partId === partA.id)
    const b = rows.find((r: any) => r.partId === partB.id)
    expect(a).toMatchObject({ partId: partA.id, partName: '螺丝A', requiredQty: 10, onHand: 3, gapQty: 7 })
    expect(b).toMatchObject({ partId: partB.id, partName: '螺丝B', requiredQty: 20, onHand: 0, gapQty: 20 })
  })

  it('purchase 可创建采购单，自动生成 PO 单号', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const part = await prisma.part.create({ data: { sku: 'P100', name: '螺丝' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, items: [{ partId: part.id, qty: 100, unitPrice: 0.5 }] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toMatch(/^PO-\d{8}-\d{3}$/)
    expect(res.json().items).toHaveLength(1)
  })

  it('创建采购单 items 为空返回 400', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, items: [] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('warehouse 无权创建采购单（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: 1, items: [{ partId: 1, qty: 1, unitPrice: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })

  it('非 warehouse 无权收货（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { purchaseOrderId: 1, items: [{ partId: 1, qty: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })

  it('需求计算仅 purchase/boss 可访问（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'GET', url: '/api/purchasing/requirements?orderId=1', headers: { cookie }
    })
    expect(res.statusCode).toBe(403)
  })
})
