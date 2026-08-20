import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('inventory', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('领料出库减少库存，记录领料人', async () => {
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 50 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-ISS-1', customerId: customer.id, deliveryDate: new Date('2026-09-30') }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 30 }] }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(20)

    const issue = await prisma.issue.findFirst({ where: { partId: part.id } })
    expect(issue).toMatchObject({ salesOrderId: order.id, partId: part.id, qty: 30, issuedBy: '张组长' })

    const ledger = await prisma.inventoryLedger.findFirst({
      where: { itemType: 'part', itemId: part.id, refType: 'issue', refId: issue!.id }
    })
    expect(ledger).toMatchObject({ delta: -30, balance: 20 })
  })

  it('库存不足返回 400', async () => {
    const part = await prisma.part.create({ data: { sku: 'P8-B', name: '螺丝' } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 5 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-ISS-2', customerId: customer.id, deliveryDate: new Date('2026-09-30') }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 10 }] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('库存不足')
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(5)
  })

  it('成品入库增加库存', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-1', name: '成品柜' } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-PROD-1', customerId: customer.id, deliveryDate: new Date('2026-09-30') }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/production-entries', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 20 }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: product.id } } })
    expect(stock?.qtyOnHand).toBe(20)
    const entry = await prisma.productionEntry.findFirst({ where: { productId: product.id } })
    expect(entry).toMatchObject({ salesOrderId: order.id, productId: product.id, qty: 20 })
  })

  it('库存列表返回 itemType/itemId/名称/qtyOnHand', async () => {
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    const product = await prisma.product.create({ data: { sku: 'F8-1', name: '成品柜' } })
    await prisma.stock.createMany({
      data: [
        { itemType: 'part', itemId: part.id, qtyOnHand: 20 },
        { itemType: 'product', itemId: product.id, qtyOnHand: 8 }
      ]
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({ method: 'GET', url: '/api/stock', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const partRow = rows.find((r: any) => r.itemType === 'part' && r.itemId === part.id)
    const productRow = rows.find((r: any) => r.itemType === 'product' && r.itemId === product.id)
    expect(partRow).toMatchObject({ itemType: 'part', itemId: part.id, name: '木板', qtyOnHand: 20 })
    expect(productRow).toMatchObject({ itemType: 'product', itemId: product.id, name: '成品柜', qtyOnHand: 8 })
  })

  it('出入库流水按时间倒序返回', async () => {
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-ISS-1', customerId: customer.id, deliveryDate: new Date('2026-09-30') }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const first = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 10 }] }
    })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 5 }] }
    })
    expect(second.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET', url: `/api/stock/ledger?itemType=part&itemId=${part.id}`, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const ledger = res.json()
    expect(ledger.length).toBeGreaterThanOrEqual(2)
    expect(ledger[0].delta).toBe(-5)
    expect(ledger[1].delta).toBe(-10)
  })

  it('非 warehouse 无权领料（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: 1, issuedBy: '张组长', items: [{ partId: 1, qty: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })
})
