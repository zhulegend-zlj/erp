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
        zrhDeliveryDate: new Date('2026-10-01'),
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
    // 用量口径：partA 在两个成品用量不同（2/1）→ usageText 明细；partB 只在一个成品 → 整数 5
    expect(a.usage).toBeNull()
    expect(a.usageText).toBe('F7-1×2、F7-2×1')
    expect(b.usage).toBe(5)
    expect(b.usageText).toBeUndefined()
  })

  it('用量/台不再出现小数：零件只在订单内一个成品时显示 BOM 整数用量', async () => {
    const partX = await prisma.part.create({ data: { sku: 'P8-X', name: '单成品零件' } })
    const pa = await prisma.product.create({ data: { sku: 'F8-A', name: '成品A' } })
    const pb = await prisma.product.create({ data: { sku: 'F8-B', name: '成品B' } })
    const pc = await prisma.product.create({ data: { sku: 'F8-C', name: '成品C' } })
    // partX 只在成品A 的 BOM 里用量 1；B/C 不含该零件
    await prisma.bom.createMany({
      data: [
        { productId: pa.id, partId: partX.id, qty: 1 },
        { productId: pb.id, partId: (await prisma.part.create({ data: { sku: 'P8-Y', name: 'B用零件' } })).id, qty: 1 },
      ],
    })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-REQ-8',
        customerId: customer.id,
        zrhDeliveryDate: new Date('2026-10-01'),
        status: 'confirmed',
        items: {
          create: [
            { productId: pa.id, qty: 1, unitPrice: 10 },
            { productId: pb.id, qty: 1, unitPrice: 20 },
            { productId: pc.id, qty: 1, unitPrice: 30 },
          ],
        },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'GET', url: `/api/purchasing/requirements?orderId=${order.id}`, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const row = (res.json() as Array<{ partId: number; usage: number | null; usageText?: string; requiredQty: number }>).find(
      (r) => r.partId === partX.id,
    )
    // 旧逻辑会算出 1/3 = 0.3333…；新口径 = BOM 整数 1
    expect(row).toMatchObject({ requiredQty: 1, usage: 1 })
    expect(row?.usageText).toBeUndefined()
    expect(Number.isInteger(row?.usage)).toBe(true)
  })

  it('自购（无销售订单）采购单自动生成 PO 单号', async () => {
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

  it('草稿订单不能生成采购单：提示销售未确认，可提醒销售；确认后可正常生成', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户D' } })
    const supplier = await prisma.supplier.create({ data: { name: '供应商D' } })
    const part = await prisma.part.create({ data: { sku: 'P-D', name: '零件D', supplierId: supplier.id } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'PO-DRAFT-1', customerId: customer.id, customerPoNo: 'PO-DRAFT-1', status: 'draft' },
    })
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    const sales = await loginCookie(app, 'sales')
    // 待采购列表应包含草稿订单（采购可见）
    const pending = await app.inject({
      method: 'GET', url: '/api/orders?pendingPurchase=true', headers: { cookie: purchase },
    })
    expect(pending.statusCode).toBe(200)
    expect((pending.json() as Array<{ id: number }>).some((o) => o.id === order.id)).toBe(true)

    // 草稿订单生成采购单 → 400 销售还未确认
    const blocked = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchase },
      payload: { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] },
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error).toContain('销售还未确认')

    // 采购一键提醒销售确认
    const remind = await app.inject({
      method: 'PATCH', url: '/api/orders/' + order.id + '/remind-confirm', headers: { cookie: purchase },
    })
    expect(remind.statusCode).toBe(200)
    const reminded = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(reminded?.confirmReminderAt).not.toBeNull()
    expect(reminded?.confirmReminderBy).toBe('purchase') // 测试账号 name=role，生产环境为中文名

    // 订单列表带出催办标记（销售可见）
    const listForSales = await app.inject({
      method: 'GET', url: '/api/orders', headers: { cookie: sales },
    })
    const row = (listForSales.json() as Array<{ id: number; confirmReminderAt?: string | null }>).find((o) => o.id === order.id)
    expect(row?.confirmReminderAt).toBeTruthy()

    // 销售确认订单 → 催办标记清空
    const confirm = await app.inject({
      method: 'PATCH', url: '/api/orders/' + order.id + '/status', headers: { cookie: sales },
      payload: { status: 'confirmed' },
    })
    expect(confirm.statusCode).toBe(200)
    const afterConfirm = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(afterConfirm?.status).toBe('confirmed')
    expect(afterConfirm?.confirmReminderAt).toBeNull()

    // 确认后采购可以正常生成采购单
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchase },
      payload: { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toBe('PO-DRAFT-1-Z001')
  })

  it('挂销售订单的采购单号 = 订单PO号 + -Z001/-Z002 递增', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户Z' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: '265440545874390', customerId: customer.id, customerPoNo: '265440545874390', zrhDeliveryDate: new Date('2026-09-30'), status: 'confirmed' },
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商Z' } })
    const part = await prisma.part.create({ data: { sku: 'P-Z', name: '零件Z', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const payload = { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] }
    const r1 = await app.inject({ method: 'POST', url: '/api/purchase-orders', headers: { cookie }, payload })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().orderNo).toBe('265440545874390-Z001')
    const r2 = await app.inject({ method: 'POST', url: '/api/purchase-orders', headers: { cookie }, payload })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().orderNo).toBe('265440545874390-Z002')
  })

  it('批量生成：同一订单按供应商分组自动排 Z001/Z002', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户B' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'PO-BATCH-9', customerId: customer.id, customerPoNo: 'PO-BATCH-9', zrhDeliveryDate: new Date('2026-09-30'), status: 'confirmed' },
    })
    const s1 = await prisma.supplier.create({ data: { name: '供应商Z1' } })
    const s2 = await prisma.supplier.create({ data: { name: '供应商Z2' } })
    const p1 = await prisma.part.create({ data: { sku: 'P-Z1', name: '零件Z1', supplierId: s1.id } })
    const p2 = await prisma.part.create({ data: { sku: 'P-Z2', name: '零件Z2', supplierId: s2.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: {
        salesOrderId: order.id,
        items: [
          { partId: p1.id, qty: 10, unitPrice: 1 },
          { partId: p2.id, qty: 20, unitPrice: 2 },
        ]
      }
    })
    expect(res.statusCode).toBe(200)
    const orders = res.json()
    expect(orders).toHaveLength(2)
    expect(orders.map((o: any) => o.orderNo).sort()).toEqual(['PO-BATCH-9-Z001', 'PO-BATCH-9-Z002'])
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
