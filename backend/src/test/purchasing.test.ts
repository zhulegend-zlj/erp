import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('purchasing', () => {
  beforeEach(async () => {
    await resetDb()
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
    const part = await prisma.part.create({ data: { sku: 'P100', name: '螺丝', supplierId: supplier.id } })
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

  it('GET /api/purchase-orders 返回含供应商与金额的采购单列表', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-LIST' } })
    const part = await prisma.part.create({ data: { sku: 'P-LIST', name: '螺丝LIST' } })
    const po = await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-LIST',
        supplierId: supplier.id,
        items: { create: { partId: part.id, qty: 10, unitPrice: 2.5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({ method: 'GET', url: '/api/purchase-orders', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const row = rows.find((r: any) => r.id === po.id)
    expect(row).toMatchObject({
      id: po.id,
      orderNo: 'PO-LIST',
      supplierId: supplier.id,
      supplierName: '供应商-LIST',
      totalAmount: 25,
      paidAmount: 0,
      outstanding: 25,
    })
    expect(row.items).toHaveLength(1)
    expect(row.items[0]).toMatchObject({ partId: part.id, sku: 'P-LIST', name: '螺丝LIST', qty: 10, unitPrice: 2.5 })
  })

  it('需求计算仅 purchase/boss 可访问（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'GET', url: '/api/purchasing/requirements?orderId=1', headers: { cookie }
    })
    expect(res.statusCode).toBe(403)
  })

  it('批量生成采购单按零件供应商自动分组', async () => {
    const s1 = await prisma.supplier.create({ data: { name: '供应商-B1' } })
    const s2 = await prisma.supplier.create({ data: { name: '供应商-B2' } })
    const p1 = await prisma.part.create({ data: { sku: 'P-B1', name: '零件B1', supplierId: s1.id } })
    const p2 = await prisma.part.create({ data: { sku: 'P-B2', name: '零件B2', supplierId: s2.id } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: {
        items: [
          { partId: p1.id, qty: 10, unitPrice: 1 },
          { partId: p2.id, qty: 20, unitPrice: 2 },
        ]
      }
    })
    expect(res.statusCode).toBe(200)
    const orders = res.json()
    expect(orders).toHaveLength(2)
    expect(orders.map((o: any) => o.supplierId).sort()).toEqual([s1.id, s2.id].sort())
  })

  it('零件未设置供应商时批量生成返回 400', async () => {
    const part = await prisma.part.create({ data: { sku: 'P-B3', name: '零件B3' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: { items: [{ partId: part.id, qty: 1, unitPrice: 1 }] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('未设置供应商')
  })
})
