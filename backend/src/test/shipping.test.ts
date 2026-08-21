import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('shipping', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('出货后成品库存减少，可追加运输节点', async () => {
    const product = await prisma.product.create({ data: { sku: 'F300', name: '成品B' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: 'C1' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S1',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'ready',
        items: { create: { productId: product.id, qty: 100, unitPrice: 5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().salesOrderId).toBe(order.id)
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } }
    })
    expect(stock?.qtyOnHand).toBe(0)

    const updatedOrder = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(updatedOrder?.status).toBe('shipped')

    const ledger = await prisma.inventoryLedger.findFirst({
      where: { itemType: 'product', itemId: product.id, refType: 'shipment', refId: res.json().id }
    })
    expect(ledger).toMatchObject({ delta: -100, balance: 0 })

    const leg = await app.inject({
      method: 'POST',
      url: '/api/shipments/' + res.json().id + '/legs',
      headers: { cookie },
      payload: { node: '装柜' }
    })
    expect(leg.statusCode).toBe(200)
    expect(leg.json()).toMatchObject({ shipmentId: res.json().id, node: '装柜' })
  })

  it('成品库存不足返回 400 中文，且事务回滚', async () => {
    const product = await prisma.product.create({ data: { sku: 'F301', name: '成品C' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 10 } })
    const customer = await prisma.customer.create({ data: { name: 'C2' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S2',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'ready',
        items: { create: { productId: product.id, qty: 20, unitPrice: 5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('库存不足')
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } }
    })
    expect(stock?.qtyOnHand).toBe(10)
    const updatedOrder = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(updatedOrder?.status).toBe('ready')
    const shipmentCount = await prisma.shipment.count({ where: { salesOrderId: order.id } })
    expect(shipmentCount).toBe(0)
  })

  it('同一订单重复出货返回 400，库存与出货单数量不变', async () => {
    const product = await prisma.product.create({ data: { sku: 'F300', name: '成品B' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: 'C1' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S1',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'ready',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const first = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(first.statusCode).toBe(200)
    const stockAfterFirst = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } }
    })
    expect(stockAfterFirst?.qtyOnHand).toBe(90)

    const second = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(second.statusCode).toBe(400)
    expect(second.json().error).toContain('订单已出货')

    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } }
    })
    expect(stock?.qtyOnHand).toBe(90)
    const count = await prisma.shipment.count({ where: { salesOrderId: order.id } })
    expect(count).toBe(1)
  })

  it('GET /api/shipments?orderId= 返回含 legs（按 at 倒序）的出货单列表', async () => {
    const product = await prisma.product.create({ data: { sku: 'F302', name: '成品D' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 10 } })
    const customer = await prisma.customer.create({ data: { name: 'C1' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S3',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'ready',
        items: { create: { productId: product.id, qty: 1, unitPrice: 5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const shipment = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(shipment.statusCode).toBe(200)
    const shipmentId = shipment.json().id

    await app.inject({
      method: 'POST',
      url: '/api/shipments/' + shipmentId + '/legs',
      headers: { cookie },
      payload: { node: '备货', at: '2026-09-01T08:00:00.000Z' }
    })
    await app.inject({
      method: 'POST',
      url: '/api/shipments/' + shipmentId + '/legs',
      headers: { cookie },
      payload: { node: '开船', at: '2026-09-05T08:00:00.000Z', note: '预计 30 天' }
    })

    const list = await app.inject({
      method: 'GET',
      url: '/api/shipments?orderId=' + order.id,
      headers: { cookie }
    })
    expect(list.statusCode).toBe(200)
    const rows = list.json()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(shipmentId)
    expect(rows[0].legs.map((l: any) => l.node)).toEqual(['开船', '备货'])
    expect(rows[0].legs[0].note).toBe('预计 30 天')
  })

  it('GET /api/shipments 不传 orderId 返回全部出货单', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({ method: 'GET', url: '/api/shipments', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('订单未到待出货状态不能出货（400）', async () => {
    const product = await prisma.product.create({ data: { sku: 'F303', name: '成品DRAFT' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: 'C3' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S-DRAFT',
        customerId: customer.id,
        deliveryDate: new Date(),
        items: { create: { productId: product.id, qty: 1, unitPrice: 5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('待出货')
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } }
    })
    expect(stock?.qtyOnHand).toBe(100)
  })

  it('非 sales 角色无权出货与追加运输节点（403）', async () => {
    const app = buildApp()
    const warehouse = await loginCookie(app, 'warehouse')
    const post = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie: warehouse },
      payload: { salesOrderId: 1 }
    })
    expect(post.statusCode).toBe(403)
    const leg = await app.inject({
      method: 'POST',
      url: '/api/shipments/1/legs',
      headers: { cookie: warehouse },
      payload: { node: '装柜' }
    })
    expect(leg.statusCode).toBe(403)
  })

  it('salesOrderId 非正整数或 node 为空返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const badOrder = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: 0 }
    })
    expect(badOrder.statusCode).toBe(400)

    const product = await prisma.product.create({ data: { sku: 'F300', name: '成品B' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: 'C1' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-S1',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'ready',
        items: { create: { productId: product.id, qty: 100, unitPrice: 5 } }
      }
    })
    const shipment = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id }
    })
    const badLeg = await app.inject({
      method: 'POST',
      url: '/api/shipments/' + shipment.json().id + '/legs',
      headers: { cookie },
      payload: { node: '' }
    })
    expect(badLeg.statusCode).toBe(400)
  })
})