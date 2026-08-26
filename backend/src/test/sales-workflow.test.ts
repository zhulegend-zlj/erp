import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

async function seedOrder(orderNo: string, poNo: string, qty: number, price: number, status = 'confirmed') {
  const product = await prisma.product.create({ data: { sku: 'SKU-' + orderNo, name: '成品' + orderNo, nameEn: 'PRODUCT ' + orderNo } })
  const customer = await prisma.customer.create({ data: { name: 'CUSTOMER-' + orderNo, defaultPaymentTerms: 'NET 60' } })
  const order = await prisma.salesOrder.create({
    data: {
      orderNo,
      customerId: customer.id,
      customerPoNo: poNo,
      customerDeliveryDate: new Date('2026-09-30'),
      zrhDeliveryDate: new Date('2026-09-20'),
      status,
      items: { create: { productId: product.id, qty, unitPrice: price } },
    },
  })
  return { product, customer, order }
}

describe('sales workflow（订单字段/排程/部分出货/权限/提醒）', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('新建订单必填客户PO号/客户交期/ZRH交期，缺一返回 400', async () => {
    const app = buildApp()
    const customer = await prisma.customer.create({ data: { name: 'C1' } })
    const product = await prisma.product.create({ data: { sku: 'F1', name: '成品1' } })
    const cookie = await loginCookie(app, 'sales')
    const base = {
      customerId: customer.id,
      customerPoNo: 'PO-1',
      items: [{ productId: product.id, qty: 10, unitPrice: 5, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-20' }]
    }

    const ok = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: base })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().customerPoNo).toBe('PO-1')
    expect(ok.json().items[0].zrhDeliveryDate).toBeDefined()
    expect(ok.json().orderDate).toBeDefined()

    const noPo = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: { ...base, customerPoNo: '' } })
    expect(noPo.statusCode).toBe(400)
    expect(noPo.json().error).toContain('PO号')

    const noNeed = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { ...base, items: [{ ...base.items[0], customerDeliveryDate: undefined }] },
    })
    expect(noNeed.statusCode).toBe(400)
    expect(noNeed.json().error).toContain('客户交期')

    const noZrh = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { ...base, items: [{ ...base.items[0], zrhDeliveryDate: undefined }] },
    })
    expect(noZrh.statusCode).toBe(400)
    expect(noZrh.json().error).toContain('ZRH')
  })

  it('采购提醒：pendingPurchase=true 返回 草稿/已确认 且无采购单的订单（老板口径：草稿也可采购）', async () => {
    const app = buildApp()
    const { order } = await seedOrder('SO-P1', 'PO-P1', 10, 5)
    await seedOrder('SO-P2', 'PO-P2', 20, 5, 'draft')
    const cookie = await loginCookie(app, 'purchase')

    const pending = await app.inject({ method: 'GET', url: '/api/orders?pendingPurchase=true', headers: { cookie } })
    expect(pending.statusCode).toBe(200)
    const rows = pending.json() as Array<{ orderNo: string }>
    expect(rows.map((r) => r.orderNo).sort()).toEqual(['SO-P1', 'SO-P2'])

    // 生成采购单后从提醒中消失（草稿订单仍未生成采购单，保留在提醒里）
    const supplier = await prisma.supplier.create({ data: { name: 'S1' } })
    await prisma.purchaseOrder.create({ data: { orderNo: 'PO-SUP-1', supplierId: supplier.id, salesOrderId: order.id } })
    const pending2 = await app.inject({ method: 'GET', url: '/api/orders?pendingPurchase=true', headers: { cookie } })
    expect((pending2.json() as Array<{ orderNo: string }>).map((r) => r.orderNo)).toEqual(['SO-P2'])
  })

  it('到货仓：销售可增改删，仓库只读，被排程使用的不能删', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const warehouse = await loginCookie(app, 'warehouse')

    const create = await app.inject({ method: 'POST', url: '/api/hubs', headers: { cookie: sales }, payload: { name: 'VPC-MEL.' } })
    expect(create.statusCode).toBe(200)
    const hubId = create.json().id

    const noCreate = await app.inject({ method: 'POST', url: '/api/hubs', headers: { cookie: warehouse }, payload: { name: 'X' } })
    expect(noCreate.statusCode).toBe(403)

    const { product, order } = await seedOrder('SO-H1', 'PO-H1', 10, 5)
    await app.inject({
      method: 'POST', url: '/api/schedules', headers: { cookie: sales },
      payload: { salesOrderId: order.id, productId: product.id, qty: 10, hubId, needByDate: '2026-09-30', promisedDate: '2026-09-20' },
    })
    const del = await app.inject({ method: 'DELETE', url: '/api/hubs/' + hubId, headers: { cookie: sales } })
    expect(del.statusCode).toBe(400)
    expect(del.json().error).toContain('排程')

    const put = await app.inject({ method: 'PUT', url: '/api/hubs/' + hubId, headers: { cookie: sales }, payload: { name: 'VPC-MEL2.' } })
    expect(put.statusCode).toBe(200)
  })

  it('排程：销售建行（不超过订单剩余）、仓库标记已备好、销售可取消', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const warehouse = await loginCookie(app, 'warehouse')
    const { product, order } = await seedOrder('SO-S1', 'PO-S1', 10, 5)
    const hub = await prisma.shipToHub.create({ data: { name: 'VPC-MEL.' } })

    const ok = await app.inject({
      method: 'POST', url: '/api/schedules', headers: { cookie: sales },
      payload: { salesOrderId: order.id, productId: product.id, qty: 6, hubId: hub.id, needByDate: '2026-09-30', promisedDate: '2026-09-20', note: '第一票' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('pending')

    const over = await app.inject({
      method: 'POST', url: '/api/schedules', headers: { cookie: sales },
      payload: { salesOrderId: order.id, productId: product.id, qty: 5, hubId: hub.id, needByDate: '2026-09-30', promisedDate: '2026-09-20' },
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toContain('超过订单剩余')

    const pick = await app.inject({ method: 'PATCH', url: '/api/schedules/' + ok.json().id, headers: { cookie: warehouse }, payload: { status: 'picked' } })
    expect(pick.statusCode).toBe(200)
    expect(pick.json().status).toBe('picked')

    const cancel = await app.inject({ method: 'PATCH', url: '/api/schedules/' + ok.json().id, headers: { cookie: sales }, payload: { status: 'cancelled' } })
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json().status).toBe('cancelled')
  })

  it('排程出货：跨订单同仓拼一票、部分出货、出满自动已出货、排程扣减', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const a = await seedOrder('SO-A1', 'PO-A1', 100, 10)
    const b = await seedOrder('SO-B1', 'PO-B1', 50, 20)
    await prisma.stock.createMany({
      data: [
        { itemType: 'product', itemId: a.product.id, qtyOnHand: 200 },
        { itemType: 'product', itemId: b.product.id, qtyOnHand: 100 },
      ],
    })
    const hub = await prisma.shipToHub.create({ data: { name: 'VPC-MEL.' } })
    const mk = (salesOrderId: number, productId: number, qty: number) =>
      app.inject({
        method: 'POST', url: '/api/schedules', headers: { cookie: sales },
        payload: { salesOrderId, productId, qty, hubId: hub.id, needByDate: '2026-09-30', promisedDate: '2026-09-20' },
      })
    const s1 = await mk(a.order.id, a.product.id, 100)
    const s2 = await mk(b.order.id, b.product.id, 50)
    const warehouse = await loginCookie(app, 'warehouse')
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s1.json().id, headers: { cookie: warehouse }, payload: { status: 'picked' } })
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s2.json().id, headers: { cookie: warehouse }, payload: { status: 'picked' } })

    // 一票出 A 60 + B 50
    const ship = await app.inject({
      method: 'POST', url: '/api/shipments', headers: { cookie: sales },
      payload: {
        hubId: hub.id,
        invoiceNo: 'ZRH-TEST-1',
        schedules: [
          { id: s1.json().id, qty: 60 },
          { id: s2.json().id, qty: 50 },
        ],
      },
    })
    expect(ship.statusCode).toBe(200)
    const lines = ship.json().lines as Array<{ qty: number; customerPoNo: string | null; salesOrderId: number }>
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.customerPoNo).sort()).toEqual(['PO-A1', 'PO-B1'])
    expect(ship.json().hub.name).toBe('VPC-MEL.')

    // 库存：A 剩 140，B 剩 50
    const stockA = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: a.product.id } } })
    const stockB = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: b.product.id } } })
    expect(stockA?.qtyOnHand).toBe(140)
    expect(stockB?.qtyOnHand).toBe(50)

    // A 未出满保持 confirmed（无生产记录），B 出满自动 shipped；排程 A 剩 40，B shipped
    expect((await prisma.salesOrder.findUnique({ where: { id: a.order.id } }))?.status).toBe('confirmed')
    expect((await prisma.salesOrder.findUnique({ where: { id: b.order.id } }))?.status).toBe('shipped')
    const schA = await prisma.shipmentSchedule.findUnique({ where: { id: s1.json().id } })
    const schB = await prisma.shipmentSchedule.findUnique({ where: { id: s2.json().id } })
    expect(schA?.qty).toBe(40)
    expect(schA?.status).toBe('picked')
    expect(schB?.status).toBe('shipped')

    // 出货单列表详情 shippedQty
    const detail = await app.inject({ method: 'GET', url: '/api/orders/' + a.order.id, headers: { cookie: sales } })
    expect(detail.json().shippedQty).toBe(60)

    // 出完 A 剩余 40 → A shipped
    const rest = await app.inject({
      method: 'POST', url: '/api/shipments', headers: { cookie: sales },
      payload: { hubId: hub.id, schedules: [{ id: s1.json().id, qty: 40 }] },
    })
    expect(rest.statusCode).toBe(200)
    expect((await prisma.salesOrder.findUnique({ where: { id: a.order.id } }))?.status).toBe('shipped')
  })

  it('排程未备好出货返回 400；跨仓拼票返回 400', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const { product, order } = await seedOrder('SO-M1', 'PO-M1', 10, 5)
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
    const hub = await prisma.shipToHub.create({ data: { name: 'VPC-MEL.' } })
    const hub2 = await prisma.shipToHub.create({ data: { name: 'VUC-DFW.' } })
    const mk = (hubId: number) =>
      app.inject({
        method: 'POST', url: '/api/schedules', headers: { cookie: sales },
        payload: { salesOrderId: order.id, productId: product.id, qty: 5, hubId, needByDate: '2026-09-30', promisedDate: '2026-09-20' },
      })
    const s1 = await mk(hub.id)
    const s2 = await mk(hub2.id)

    const notPicked = await app.inject({
      method: 'POST', url: '/api/shipments', headers: { cookie: sales },
      payload: { hubId: hub.id, schedules: [{ id: s1.json().id, qty: 5 }] },
    })
    expect(notPicked.statusCode).toBe(400)
    expect(notPicked.json().error).toContain('尚未备好')

    const warehouse = await loginCookie(app, 'warehouse')
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s1.json().id, headers: { cookie: warehouse }, payload: { status: 'picked' } })
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s2.json().id, headers: { cookie: warehouse }, payload: { status: 'picked' } })
    const crossHub = await app.inject({
      method: 'POST', url: '/api/shipments', headers: { cookie: sales },
      payload: { hubId: hub.id, schedules: [{ id: s1.json().id, qty: 5 }, { id: s2.json().id, qty: 5 }] },
    })
    expect(crossHub.statusCode).toBe(400)
    expect(crossHub.json().error).toContain('到货仓')
  })

  it('销售可增改删客户（客户资料开放给销售）', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const create = await app.inject({
      method: 'POST', url: '/api/customers', headers: { cookie: sales },
      payload: { name: 'CUSTOMER-SALES', defaultPaymentTerms: 'NET 60', defaultIncoterm: 'FCA' },
    })
    expect(create.statusCode).toBe(200)
    expect(create.json().defaultPaymentTerms).toBe('NET 60')
    const put = await app.inject({
      method: 'PUT', url: '/api/customers/' + create.json().id, headers: { cookie: sales },
      payload: { name: 'CUSTOMER-SALES', defaultMark: 'FANATEC', defaultPaymentTerms: 'NET 60', defaultIncoterm: 'FCA' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().defaultMark).toBe('FANATEC')
  })
})
