import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

const CUSTOMER_NAME = '客户-BOSS'
const SUPPLIER_NAME = '供应商-BOSS'
const PRODUCT_SKU = 'F-BOSS'
const PART_SKU = 'P-BOSS'
const DAY = 86_400_000

describe('dashboard', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('boss 可访问，返回数组结构', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().orders)).toBe(true)
    expect(typeof res.json().receivableTotal).toBe('number')
    expect(typeof res.json().payableTotal).toBe('number')
    expect(typeof res.json().overdueReceivable).toBe('number')
  })

  it('非 boss 角色无权访问（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie } })
    expect(res.statusCode).toBe(403)
  })

  it('订单进度按状态映射，成本/利润/账期与 Task 10 口径一致', async () => {
    const customer = await prisma.customer.create({ data: { name: CUSTOMER_NAME } })
    const product = await prisma.product.create({ data: { sku: PRODUCT_SKU, name: '成品BOSS' } })
    const part = await prisma.part.create({ data: { sku: PART_SKU, name: '零件BOSS' } })
    const supplier = await prisma.supplier.create({ data: { name: SUPPLIER_NAME } })

    // 订单 A：confirmed，有采购、有收款、已出货且已过账期（shippedAt = now-100d）
    const orderA = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-BOSS-A',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'confirmed',
        otherCost: 50,
        items: { create: { productId: product.id, qty: 2, unitPrice: 100 } }
      }
    })
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-BOSS-A',
        supplierId: supplier.id,
        salesOrderId: orderA.id,
        items: { create: { partId: part.id, qty: 10, unitPrice: 3 } }
      }
    })
    await prisma.customerPayment.create({
      data: { customerId: customer.id, salesOrderId: orderA.id, amount: 120 }
    })
    await prisma.shipment.create({
      data: { salesOrderId: orderA.id, shippedAt: new Date(Date.now() - 100 * DAY) }
    })

    // 订单 B：shipped，无采购/收款/出货（不计应收）
    await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-BOSS-B',
        customerId: customer.id,
        deliveryDate: new Date(),
        status: 'shipped',
        otherCost: 0,
        items: { create: { productId: product.id, qty: 1, unitPrice: 50 } }
      }
    })

    // 独立采购单：不挂订单，计入应付总额
    await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-BOSS-B',
        supplierId: supplier.id,
        items: { create: { partId: part.id, qty: 5, unitPrice: 20 } }
      }
    })

    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    const a = body.orders.find((o: any) => o.orderNo === 'SO-BOSS-A')
    expect(a).toMatchObject({
      customerName: CUSTOMER_NAME,
      status: 'confirmed',
      progress: 30,
      cost: 80, // 10*3 + 50
      profit: 40 // 120 - 80
    })
    expect(a.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const b = body.orders.find((o: any) => o.orderNo === 'SO-BOSS-B')
    expect(b).toMatchObject({ status: 'shipped', progress: 95, cost: 0, profit: 0, dueDate: null })

    // 合计至少包含本次种子数据（共享库可能残留其它测试数据）
    // 余额口径：订单 A 应收 200，已收 120，故应收/逾期应收余额均为 80；
    // 应付余额 = PO-BOSS-A(30) + PO-BOSS-B(100)，均未付款，合计 130。
    expect(body.receivableTotal).toBeGreaterThanOrEqual(80)
    expect(body.overdueReceivable).toBeGreaterThanOrEqual(80)
    expect(body.payableTotal).toBeGreaterThanOrEqual(130)
  })
})
