import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

async function seedOrder(app: ReturnType<typeof buildApp>) {
  const customer = await prisma.customer.create({ data: { name: 'ACME' } })
  const product = await prisma.product.create({ data: { sku: 'F001', name: '成品A' } })
  const cookie = await loginCookie(app, 'sales')
  return { customer, product, cookie }
}

describe('orders', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('sales 可创建订单，自动生成 orderNo', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 100, unitPrice: 10 }]
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toMatch(/^SO-\d{8}-\d{3}$/)
    expect(res.json().status).toBe('draft')
    expect(res.json().items).toHaveLength(1)
  })

  it('创建订单时 items 为空返回 400', async () => {
    const app = buildApp()
    const { customer, cookie } = await seedOrder(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30', items: [] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('交货日期非法返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        zrhDeliveryDate: 'not-a-date',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    expect(res.statusCode).toBe(400)
  })

  it('数量非正整数或单价为负返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const badQty = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 0, unitPrice: 1 }]
      }
    })
    expect(badQty.statusCode).toBe(400)

    const badPrice = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: -1 }]
      }
    })
    expect(badPrice.statusCode).toBe(400)
  })

  it('非 sales 角色无权创建订单（403）', async () => {
    const app = buildApp()
    const customer = await prisma.customer.create({ data: { name: 'ACME2' } })
    const product = await prisma.product.create({ data: { sku: 'F002', name: '成品B' } })
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    expect(res.statusCode).toBe(403)
  })

  it('列表与详情返回含 product 名称的 items', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 100, unitPrice: 10 }]
      }
    })
    const orderId = createRes.json().id

    const financeCookie = await loginCookie(app, 'finance')
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: financeCookie } })
    expect(list.statusCode).toBe(200)
    expect(Array.isArray(list.json())).toBe(true)
    expect(list.json().length).toBeGreaterThan(0)

    const detail = await app.inject({ method: 'GET', url: `/api/orders/${orderId}`, headers: { cookie: financeCookie } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().items).toHaveLength(1)
    expect(detail.json().items[0].product.name).toBe('成品A')
  })

  it('订单列表与详情返回客户名称（采购页选中订单后展示客户）', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    expect(createRes.statusCode).toBe(200)
    const orderId = createRes.json().id

    const purchaseCookie = await loginCookie(app, 'purchase')
    const detail = await app.inject({ method: 'GET', url: `/api/orders/${orderId}`, headers: { cookie: purchaseCookie } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().customer).toMatchObject({ name: 'ACME' })

    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: purchaseCookie } })
    expect(list.statusCode).toBe(200)
    const row = (list.json() as { customer?: { name?: string } }[]).find((o) => o.customer?.name === 'ACME')
    expect(row).toBeDefined()
  })

  it('状态机允许合法迁移，非法迁移返回 400 中文', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    const orderId = createRes.json().id

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'confirmed' }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('confirmed')

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'shipped' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/不能从|不能把|无法|不合法/)
  })

  it('非法目标状态返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${createRes.json().id}/status`,
      headers: { cookie },
      payload: { status: 'nonsense' }
    })
    expect(bad.statusCode).toBe(400)
  })

  it('销售只能草稿↔已确认：确认后可回退，不能再往后推进', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    const orderId = createRes.json().id

    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'confirmed' }
    })
    const toProduction = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'in_production' }
    })
    expect(toProduction.statusCode).toBe(400)
    expect(toProduction.json().error).toContain('销售不能')

    const rollback = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'draft' }
    })
    expect(rollback.statusCode).toBe(200)
    expect(rollback.json().status).toBe('draft')
  })

  it('老板可把运作中订单强制回退到已确认（清空双阶段标志）', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const bossCookie = await loginCookie(app, 'boss')
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 1 }]
      }
    })
    const orderId = createRes.json().id
    await prisma.salesOrder.update({
      where: { id: orderId },
      data: { status: 'in_production', purchasing: true, producing: true },
    })

    const rollback = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie: bossCookie },
      payload: { status: 'confirmed' }
    })
    expect(rollback.statusCode).toBe(200)
    const refreshed = await prisma.salesOrder.findUnique({ where: { id: orderId } })
    expect(refreshed?.status).toBe('confirmed')
    expect(refreshed?.purchasing).toBe(false)
    expect(refreshed?.producing).toBe(false)
  })

  it('销售可删除无业务痕迹的草稿订单（明细一并删除）', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 2, unitPrice: 10 }]
      }
    })
    const orderId = createRes.json().id

    const del = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    const gone = await prisma.salesOrder.findUnique({ where: { id: orderId } })
    expect(gone).toBeNull()
    const items = await prisma.salesOrderItem.findMany({ where: { orderId } })
    expect(items).toHaveLength(0)
    const detail = await app.inject({ method: 'GET', url: `/api/orders/${orderId}`, headers: { cookie } })
    expect(detail.statusCode).toBe(404)
  })

  it('老板可删除无业务痕迹的已确认订单', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const bossCookie = await loginCookie(app, 'boss')
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 10 }]
      }
    })
    const orderId = createRes.json().id
    await prisma.salesOrder.update({ where: { id: orderId }, data: { status: 'confirmed' } })

    const del = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, headers: { cookie: bossCookie } })
    expect(del.statusCode).toBe(200)
    expect(await prisma.salesOrder.findUnique({ where: { id: orderId } })).toBeNull()
  })

  it('非销售/老板角色删除订单返回 403', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 10 }]
      }
    })
    const warehouseCookie = await loginCookie(app, 'warehouse')
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${createRes.json().id}`,
      headers: { cookie: warehouseCookie }
    })
    expect(del.statusCode).toBe(403)
  })

  it('订单已有采购单时删除返回 400 并提示原因', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 10 }]
      }
    })
    const orderId = createRes.json().id
    const supplier = await prisma.supplier.create({ data: { name: '供A' } })
    await prisma.purchaseOrder.create({
      data: { orderNo: 'PO-20260826-001', supplierId: supplier.id, salesOrderId: orderId }
    })

    const del = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, headers: { cookie } })
    expect(del.statusCode).toBe(400)
    expect(del.json().error).toContain('采购单')
    expect(await prisma.salesOrder.findUnique({ where: { id: orderId } })).not.toBeNull()
  })

  it('订单已有出货单或收款时删除返回 400 并提示原因', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 10 }]
      }
    })
    const orderId = createRes.json().id
    await prisma.shipment.create({ data: { salesOrderId: orderId } })

    const del1 = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, headers: { cookie } })
    expect(del1.statusCode).toBe(400)
    expect(del1.json().error).toContain('出货单')

    const createRes2 = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        customerDeliveryDate: '2026-09-30',
        zrhDeliveryDate: '2026-09-30',
        items: [{ productId: product.id, qty: 1, unitPrice: 10 }]
      }
    })
    const orderId2 = createRes2.json().id
    await prisma.customerPayment.create({
      data: { customerId: customer.id, salesOrderId: orderId2, amount: 100 }
    })
    const del2 = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId2}`, headers: { cookie } })
    expect(del2.statusCode).toBe(400)
    expect(del2.json().error).toContain('收款')
  })

  it('删除不存在的订单返回 404，非法 id 返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const missing = await app.inject({ method: 'DELETE', url: '/api/orders/999999', headers: { cookie } })
    expect(missing.statusCode).toBe(404)
    const bad = await app.inject({ method: 'DELETE', url: '/api/orders/abc', headers: { cookie } })
    expect(bad.statusCode).toBe(400)
  })
})