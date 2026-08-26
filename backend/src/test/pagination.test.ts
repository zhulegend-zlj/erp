import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('列表分页', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function seedOrders(n: number): Promise<void> {
    const customer = await prisma.customer.create({ data: { name: '客户分页' } })
    for (let i = 1; i <= n; i++) {
      await prisma.salesOrder.create({
        data: { orderNo: 'SO-PAGE-' + i, customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30') }
      })
    }
  }

  it('订单列表支持 page/pageSize 分页并返回 total/totalPages', async () => {
    await seedOrders(3)
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const page1 = await app.inject({ method: 'GET', url: '/api/orders?page=1&pageSize=2', headers: { cookie } })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json()
    expect(body1.items).toHaveLength(2)
    expect(body1.total).toBe(3)
    expect(body1.page).toBe(1)
    expect(body1.pageSize).toBe(2)
    expect(body1.totalPages).toBe(2)

    const page2 = await app.inject({ method: 'GET', url: '/api/orders?page=2&pageSize=2', headers: { cookie } })
    expect(page2.statusCode).toBe(200)
    expect(page2.json().items).toHaveLength(1)
  })

  it('订单列表不带分页参数仍返回数组（兼容旧调用）', async () => {
    await seedOrders(2)
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    expect(res.json()).toHaveLength(2)
  })

  it('非法分页参数返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const urls = ['/api/orders?page=0', '/api/orders?page=abc', '/api/orders?pageSize=0', '/api/orders?pageSize=9999']
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(res.statusCode).toBe(400)
    }
  })

  it('库存列表分页且 keyword 过滤后再分页', async () => {
    const partA = await prisma.part.create({ data: { sku: 'P-ST-1', name: '木板甲' } })
    const partB = await prisma.part.create({ data: { sku: 'P-ST-2', name: '螺丝乙' } })
    const partC = await prisma.part.create({ data: { sku: 'P-ST-3', name: '木板丙' } })
    await prisma.stock.createMany({
      data: [
        { itemType: 'part', itemId: partA.id, qtyOnHand: 10 },
        { itemType: 'part', itemId: partB.id, qtyOnHand: 20 },
        { itemType: 'part', itemId: partC.id, qtyOnHand: 30 },
      ]
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')

    const res = await app.inject({ method: 'GET', url: '/api/stock?page=1&pageSize=2', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(3)
    expect(body.totalPages).toBe(2)

    const filtered = await app.inject({
      method: 'GET', url: '/api/stock?keyword=%E6%9C%A8%E6%9D%BF&page=1&pageSize=10', headers: { cookie }
    })
    expect(filtered.statusCode).toBe(200)
    const fb = filtered.json()
    expect(fb.total).toBe(2)
    expect(fb.items.every((r: { name: string }) => r.name.includes('木板'))).toBe(true)
  })

  it('物料流水分页按时间升序', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-LED-P', name: '成品LEDP' } })
    const part = await prisma.part.create({ data: { sku: 'P-LED-P', name: '木板' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: '客户LEDP' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-LEDP', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    for (const qty of [10, 5]) {
      const res = await app.inject({
        method: 'POST', url: '/api/issues', headers: { cookie },
        payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: part.id, qty }] }
      })
      expect(res.statusCode).toBe(200)
    }
    const res = await app.inject({
      method: 'GET', url: '/api/stock/ledger?itemType=part&itemId=' + part.id + '&page=1&pageSize=1', headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(1)
    expect(body.total).toBe(2)
    expect(body.items[0].delta).toBe(-10)
  })

  it('收发台账分页且按订单号过滤', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-WL-P', name: '成品WLP' } })
    const part = await prisma.part.create({ data: { sku: 'P-WL-P', name: '木板' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: '客户WLP' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-WL-PAGE', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const issue = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: part.id, qty: 7 }] }
    })
    expect(issue.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET', url: '/api/inventory/warehouse-ledger?orderNo=SO-WL-PAGE&page=1&pageSize=10', headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ sku: 'P-WL-P', orderNo: 'SO-WL-PAGE', outQty: 7 })

    const legacy = await app.inject({
      method: 'GET', url: '/api/inventory/warehouse-ledger?orderNo=SO-WL-PAGE', headers: { cookie }
    })
    expect(legacy.statusCode).toBe(200)
    expect(Array.isArray(legacy.json())).toBe(true)
  })

  it('采购单列表支持分页', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商分页' } })
    const part = await prisma.part.create({ data: { sku: 'P-PO-P', name: '零件' } })
    for (let i = 1; i <= 3; i++) {
      await prisma.purchaseOrder.create({
        data: {
          orderNo: 'PO-PAGE-' + i,
          supplierId: supplier.id,
          items: { create: { partId: part.id, qty: 10, unitPrice: 1 } }
        }
      })
    }
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({ method: 'GET', url: '/api/purchase-orders?page=1&pageSize=2', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(3)
    expect(body.totalPages).toBe(2)
    expect(body.items[0].orderNo).toBe('PO-PAGE-3')
  })

  it('基础资料（parts/products/customers/suppliers）支持分页', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商A' } })
    await prisma.supplier.create({ data: { name: '供应商B' } })
    await prisma.supplier.create({ data: { name: '供应商C' } })
    const partA = await prisma.part.create({ data: { sku: 'P-B-1', name: '零件甲', supplierId: supplier.id } })
    await prisma.part.create({ data: { sku: 'P-B-2', name: '零件乙', supplierId: supplier.id } })
    await prisma.part.create({ data: { sku: 'P-B-3', name: '零件丙', supplierId: supplier.id } })
    for (let i = 1; i <= 3; i++) {
      await prisma.product.create({ data: { sku: 'F-B-' + i, name: '成品' + i } })
      await prisma.customer.create({ data: { name: '客户' + i } })
    }
    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')
    const urls = ['/api/parts?page=1&pageSize=2', '/api/products?page=1&pageSize=2', '/api/customers?page=1&pageSize=2', '/api/suppliers?page=1&pageSize=2']
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.items).toHaveLength(2)
      expect(body.total).toBe(3)
      expect(body.totalPages).toBe(2)
    }
    expect(partA.id).toBeGreaterThan(0)
  })

  it('出货单与退补货列表支持分页', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户SH' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-SH-P', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30') }
    })
    await prisma.shipment.createMany({
      data: [
        { salesOrderId: order.id },
        { salesOrderId: order.id },
      ]
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商SH' } })
    const part = await prisma.part.create({ data: { sku: 'P-RR-P', name: '零件' } })
    await prisma.returnReplenish.createMany({
      data: [
        { partId: part.id, supplierId: supplier.id, returnQty: 1 },
        { partId: part.id, supplierId: supplier.id, returnQty: 1 },
        { partId: part.id, supplierId: supplier.id, returnQty: 1 },
      ]
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')

    const ship = await app.inject({ method: 'GET', url: '/api/shipments?page=1&pageSize=1', headers: { cookie } })
    expect(ship.statusCode).toBe(200)
    expect(ship.json()).toMatchObject({ total: 2, totalPages: 2 })
    expect(ship.json().items).toHaveLength(1)

    const rr = await app.inject({ method: 'GET', url: '/api/return-replenishments?page=1&pageSize=2', headers: { cookie } })
    expect(rr.statusCode).toBe(200)
    expect(rr.json()).toMatchObject({ total: 3, totalPages: 2 })
    expect(rr.json().items).toHaveLength(2)
  })
})

