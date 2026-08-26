import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

const DAY = 86_400_000

describe('finance', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('订单成本 = 零件采购成本 + 其他费用；账期为出货+60天', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户-FIN' } })
    const product = await prisma.product.create({ data: { sku: 'F-FIN', name: '成品C' } })
    const part = await prisma.part.create({ data: { sku: 'P-FIN', name: '零件' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 2 } })
    const supplier = await prisma.supplier.create({ data: { name: '供应商-FIN' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-FIN',
        customerId: customer.id,
        zrhDeliveryDate: new Date(),
        otherCost: 100,
        items: { create: { productId: product.id, qty: 10, unitPrice: 20 } }
      }
    })
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-FIN',
        supplierId: supplier.id,
        salesOrderId: order.id,
        items: { create: { partId: part.id, qty: 20, unitPrice: 1.5 } }
      }
    })
    await prisma.shipment.create({ data: { salesOrderId: order.id, shippedAt: new Date('2026-08-20T00:00:00Z') } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/orders/' + order.id + '/summary',
      headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cost).toBe(130) // 20*1.5 + 100
    expect(res.json().dueDate).toBe('2026-10-19')
  })

  it('客户收款后 summary 反映 totalReceived 与 profit', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户-FIN2' } })
    const product = await prisma.product.create({ data: { sku: 'F-FIN2', name: '成品D' } })
    const part = await prisma.part.create({ data: { sku: 'P-FIN2', name: '零件2' } })
    const supplier = await prisma.supplier.create({ data: { name: '供应商-FIN2' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-FIN2',
        customerId: customer.id,
        zrhDeliveryDate: new Date(),
        otherCost: 0,
        items: { create: { productId: product.id, qty: 1, unitPrice: 100 } }
      }
    })
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-FIN2',
        supplierId: supplier.id,
        salesOrderId: order.id,
        items: { create: { partId: part.id, qty: 2, unitPrice: 10 } }
      }
    })

    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const pay = await app.inject({
      method: 'POST',
      url: '/api/customer-payments',
      headers: { cookie },
      payload: { customerId: customer.id, salesOrderId: order.id, amount: 200 }
    })
    expect(pay.statusCode).toBe(200)

    const record = await prisma.customerPayment.findFirst({ where: { salesOrderId: order.id } })
    expect(record?.amount.toNumber()).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/orders/' + order.id + '/summary',
      headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cost).toBe(20)
    expect(res.json().totalReceived).toBe(200)
    expect(res.json().profit).toBe(180)
  })

  it('供应商付款创建记录（含可选 paidAt）', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-FIN' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({
      method: 'POST',
      url: '/api/supplier-payments',
      headers: { cookie },
      payload: { supplierId: supplier.id, amount: 500, paidAt: '2026-08-01T00:00:00Z' }
    })
    expect(res.statusCode).toBe(200)

    const record = await prisma.supplierPayment.findFirst({ where: { supplierId: supplier.id } })
    expect(record?.amount.toNumber()).toBe(500)
    expect(record?.paidAt.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('供应商付款/汇总/账期清单仅 finance/boss 可访问', async () => {
    const app = buildApp()
    const warehouse = await loginCookie(app, 'warehouse')
    const post = await app.inject({
      method: 'POST',
      url: '/api/supplier-payments',
      headers: { cookie: warehouse },
      payload: { supplierId: 1, amount: 1 }
    })
    expect(post.statusCode).toBe(403)

    const summary = await app.inject({
      method: 'GET',
      url: '/api/finance/orders/1/summary',
      headers: { cookie: warehouse }
    })
    expect(summary.statusCode).toBe(403)

    const dueWarehouse = await app.inject({
      method: 'GET',
      url: '/api/finance/due?days=60',
      headers: { cookie: warehouse }
    })
    expect(dueWarehouse.statusCode).toBe(403)

    const boss = await loginCookie(app, 'boss')
    const bossSummary = await app.inject({
      method: 'GET',
      url: '/api/finance/orders/1/summary',
      headers: { cookie: boss }
    })
    expect(bossSummary.statusCode).toBe(404)

    const bossDue = await app.inject({
      method: 'GET',
      url: '/api/finance/due?days=60',
      headers: { cookie: boss }
    })
    expect(bossDue.statusCode).toBe(200)
  })

  it('账期清单返回未来 days 天内到期应收/应付', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户-FIN' } })
    const product = await prisma.product.create({ data: { sku: 'F-FIN', name: '成品C' } })
    const part = await prisma.part.create({ data: { sku: 'P-FIN', name: '零件' } })
    const supplier = await prisma.supplier.create({ data: { name: '供应商-FIN' } })

    // 应收：出货+60 天落在未来窗口内（shippedAt = now-58d => due = now+2d）
    const orderIn = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-FIN',
        customerId: customer.id,
        zrhDeliveryDate: new Date(),
        items: { create: { productId: product.id, qty: 3, unitPrice: 40 } }
      }
    })
    await prisma.shipment.create({
      data: { salesOrderId: orderIn.id, shippedAt: new Date(Date.now() - 58 * DAY) }
    })

    // 应收：已过期，不应出现
    const orderPast = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-FIN2',
        customerId: customer.id,
        zrhDeliveryDate: new Date(),
        items: { create: { productId: product.id, qty: 1, unitPrice: 9 } }
      }
    })
    await prisma.shipment.create({
      data: { salesOrderId: orderPast.id, shippedAt: new Date(Date.now() - 100 * DAY) }
    })

    // 应付：采购单创建+30 天落在未来窗口内（createdAt = now-28d => due = now+2d）
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-FIN',
        supplierId: supplier.id,
        salesOrderId: orderIn.id,
        createdAt: new Date(Date.now() - 28 * DAY),
        items: { create: { partId: part.id, qty: 5, unitPrice: 10 } }
      }
    })
    // 应付：已过期，不应出现
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-FIN2',
        supplierId: supplier.id,
        salesOrderId: orderPast.id,
        createdAt: new Date(Date.now() - 31 * DAY),
        items: { create: { partId: part.id, qty: 1, unitPrice: 7 } }
      }
    })

    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({
      method: 'GET',
      url: '/api/finance/due?days=60',
      headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // 只校验本次种子数据是否被正确归类，避免其它测试文件遗留数据影响精确数量
    const receivableNos = body.receivable.map((r: any) => r.orderNo)
    expect(receivableNos).toContain('SO-FIN')
    expect(receivableNos).not.toContain('SO-FIN2')
    const inReceivable = body.receivable.find((r: any) => r.orderNo === 'SO-FIN')
    expect(inReceivable).toMatchObject({ customerName: '客户-FIN', amount: 120 })
    expect(inReceivable.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const payableNos = body.payable.map((p: any) => p.orderNo)
    expect(payableNos).toContain('PO-FIN')
    expect(payableNos).not.toContain('PO-FIN2')
    const inPayable = body.payable.find((p: any) => p.orderNo === 'PO-FIN')
    expect(inPayable).toMatchObject({ supplierName: '供应商-FIN', orderNo: 'PO-FIN', amount: 50 })
  })

  it('付款金额非正数、ID 非法或日期非法返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')

    const badAmount = await app.inject({
      method: 'POST',
      url: '/api/customer-payments',
      headers: { cookie },
      payload: { customerId: 1, amount: 0 }
    })
    expect(badAmount.statusCode).toBe(400)

    const badSupplierId = await app.inject({
      method: 'POST',
      url: '/api/supplier-payments',
      headers: { cookie },
      payload: { supplierId: 0, amount: 10 }
    })
    expect(badSupplierId.statusCode).toBe(400)

    const badDate = await app.inject({
      method: 'POST',
      url: '/api/customer-payments',
      headers: { cookie },
      payload: { customerId: 1, amount: 10, receivedAt: 'not-a-date' }
    })
    expect(badDate.statusCode).toBe(400)

    const badDays = await app.inject({
      method: 'GET',
      url: '/api/finance/due?days=abc',
      headers: { cookie }
    })
    expect(badDays.statusCode).toBe(400)
  })
})
