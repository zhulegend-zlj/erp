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
        deliveryDate: '2026-09-30',
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
      payload: { customerId: customer.id, deliveryDate: '2026-09-30', items: [] }
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
        deliveryDate: 'not-a-date',
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
        deliveryDate: '2026-09-30',
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
        deliveryDate: '2026-09-30',
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
        deliveryDate: '2026-09-30',
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
        deliveryDate: '2026-09-30',
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
        deliveryDate: '2026-09-30',
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
        deliveryDate: '2026-09-30',
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
    expect(bad.json().error).toMatch(/不能从|无法|不合法/)
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
        deliveryDate: '2026-09-30',
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

  it('未出货前可回退一步', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        deliveryDate: '2026-09-30',
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
    expect(toProduction.statusCode).toBe(200)
    expect(toProduction.json().status).toBe('in_production')

    const rollback = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: { cookie },
      payload: { status: 'confirmed' }
    })
    expect(rollback.statusCode).toBe(200)
    expect(rollback.json().status).toBe('confirmed')
  })
})