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

  it('sales 可创建订单，订单号直接使用客户PO号', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerPoNo: 'PO-TEST-1',
        items: [{ productId: product.id, lineNo: '2.1', customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 100, unitPrice: 10 }]
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toBe('PO-TEST-1')
    expect(res.json().status).toBe('draft')
    expect(res.json().items).toHaveLength(1)
    expect(res.json().items[0].lineNo).toBe('2.1')
  })

  it('重复的客户PO号创建订单返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const payload = {
      customerId: customer.id,
      customerPoNo: 'PO-DUP-1',
      items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 10, unitPrice: 10 }]
    }
    const first = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload })
    expect(second.statusCode).toBe(400)
    expect(second.json().error).toContain('已被使用')
  })

  it('销售可编辑草稿订单：追加成品、改交期；订单号跟随客户PO号变化', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const product2 = await prisma.product.create({ data: { sku: 'F002', name: '成品B' } })
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-EDIT-1', items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 10, unitPrice: 10 }] }
    })
    expect(created.statusCode).toBe(200)
    const orderId = created.json().id
    const edited = await app.inject({
      method: 'PATCH', url: '/api/orders/' + orderId, headers: { cookie },
      payload: {
        customerPoNo: 'PO-EDIT-2',
        items: [
          { productId: product.id, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01', qty: 20, unitPrice: 12 },
          { productId: product2.id, customerDeliveryDate: '2026-10-15', zrhDeliveryDate: '2026-10-10', qty: 5, unitPrice: 8 },
        ],
      }
    })
    expect(edited.statusCode).toBe(200)
    const body = edited.json()
    expect(body.orderNo).toBe('PO-EDIT-2')
    expect(body.items).toHaveLength(2)
    expect(body.items[0].qty).toBe(20)
    expect(body.items[1].product.sku).toBe('F002')
  })

  it('编辑订单撞已有客户PO号返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const make = (po: string) =>
      app.inject({
        method: 'POST', url: '/api/orders', headers: { cookie },
        payload: { customerId: customer.id, customerPoNo: po, items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }] }
      })
    const a = await make('PO-EA')
    const b = await make('PO-EB')
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    const res = await app.inject({
      method: 'PATCH', url: '/api/orders/' + a.json().id, headers: { cookie },
      payload: { customerPoNo: 'PO-EB' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('已被使用')
  })

  it('已确认且无业务痕迹的订单可编辑；有采购单后编辑被锁定', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-EC', items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }] }
    })
    const orderId = created.json().id
    await app.inject({ method: 'PATCH', url: '/api/orders/' + orderId + '/status', headers: { cookie }, payload: { status: 'confirmed' } })
    // 无业务痕迹：可编辑
    const ok = await app.inject({
      method: 'PATCH', url: '/api/orders/' + orderId, headers: { cookie },
      payload: { paymentTerms: 'NET 60', items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 2, unitPrice: 1 }] }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().paymentTerms).toBe('NET 60')
    // 有采购单：锁定
    const supplier = await prisma.supplier.create({ data: { name: '供应商-锁定' } })
    await prisma.purchaseOrder.create({ data: { orderNo: 'PO-LOCK-1', supplierId: supplier.id, salesOrderId: orderId } })
    const locked = await app.inject({
      method: 'PATCH', url: '/api/orders/' + orderId, headers: { cookie },
      payload: { items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 3, unitPrice: 1 }] }
    })
    expect(locked.statusCode).toBe(400)
    expect(locked.json().error).toContain('不能编辑')
  })

  it('非销售/老板角色编辑订单返回 403', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-403', items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }] }
    })
    const warehouseCookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'PATCH', url: '/api/orders/' + created.json().id, headers: { cookie: warehouseCookie },
      payload: { paymentTerms: 'X' }
    })
    expect(res.statusCode).toBe(403)
  })

  it('编辑订单明细为空或交期缺失返回 400', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-EMP', items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }] }
    })
    const orderId = created.json().id
    const empty = await app.inject({ method: 'PATCH', url: '/api/orders/' + orderId, headers: { cookie }, payload: { items: [] } })
    expect(empty.statusCode).toBe(400)
    const noDate = await app.inject({
      method: 'PATCH', url: '/api/orders/' + orderId, headers: { cookie },
      payload: { items: [{ productId: product.id, qty: 1, unitPrice: 1 }] }
    })
    expect(noDate.statusCode).toBe(400)
    expect(noDate.json().error).toContain('客户交期')
  })

  it('创建订单时 items 为空返回 400', async () => {
    const app = buildApp()
    const { customer, cookie } = await seedOrder(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: { customerId: customer.id, customerPoNo: 'PO-TEST-1', items: [] }
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: 'not-a-date', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 0, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: -1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 100, unitPrice: 10 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 1 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 2, unitPrice: 10 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 10 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 10 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 10 }]
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
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 10 }]
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
        customerPoNo: 'PO-TEST-2',
        items: [{ productId: product.id, customerDeliveryDate: '2026-09-30', zrhDeliveryDate: '2026-09-30', qty: 1, unitPrice: 10 }]
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

  it('图片识别无文件返回 400 而非 500（BUG-12 回归）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({ method: 'POST', url: '/api/orders/parse-image', headers: { cookie }, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('图片文件')
  })
  it('拆单：按套数拆成子单，原单扣减、拆空改已拆分（反馈 2026-08-31）', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const p2 = await prisma.product.create({ data: { sku: 'F002', name: '成品B' } })
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: {
        customerId: customer.id, customerPoNo: '259203',
        items: [
          { productId: product.id, qty: 2168, unitPrice: 10, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' },
          { productId: p2.id, qty: 4336, unitPrice: 5, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' },
        ]
      }
    })
    expect(created.statusCode).toBe(200)
    const orderId = created.json().id as number

    const split = await app.inject({
      method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie },
      payload: { splits: [1000, 1168] }
    })
    expect(split.statusCode).toBe(200)
    const children = split.json().children as Array<{ id: number; orderNo: string; qty: number }>
    expect(children.map((c) => c.orderNo)).toEqual(['259203-1', '259203-2'])
    expect(children.map((c) => c.qty)).toEqual([1000, 1168])

    // 子单明细按比例分摊：基准套数=4336（最大行），2168 行得 500/584，4336 行得 1000/1168
    const c1 = await prisma.salesOrder.findUniqueOrThrow({ where: { id: children[0]!.id }, include: { items: true } })
    const c2 = await prisma.salesOrder.findUniqueOrThrow({ where: { id: children[1]!.id }, include: { items: true } })
    expect(c1.items.find((i) => i.productId === product.id)?.qty).toBe(500)
    expect(c2.items.find((i) => i.productId === product.id)?.qty).toBe(584)
    expect(c1.items.find((i) => i.productId === p2.id)?.qty).toBe(1000)
    expect(c2.items.find((i) => i.productId === p2.id)?.qty).toBe(1168)
    // 子单状态/客户复制原单（draft→draft，口径=复制原单状态），parentOrderId 指向原单
    expect(c1.status).toBe('draft')
    expect(c1.customerId).toBe(customer.id)
    expect(c1.parentOrderId).toBe(orderId)
    // 未拆空 → 原单保留剩余（2168-1084=1084、4336-2168=2168），状态不变
    const orig = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } })
    expect(orig.status).toBe('draft')
    const origItems = await prisma.salesOrderItem.findMany({ where: { orderId } })
    expect(origItems.find((i) => i.productId === product.id)?.qty).toBe(1084)
    expect(origItems.find((i) => i.productId === p2.id)?.qty).toBe(2168)

    // 继续拆光剩余（2168）：原单变「已拆分」，明细清空；子单编号接 -3
    const split2 = await app.inject({
      method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie },
      payload: { splits: [2168] }
    })
    expect(split2.statusCode).toBe(200)
    expect((split2.json().children as Array<{ orderNo: string }>).map((c) => c.orderNo)).toEqual(['259203-3'])
    const orig2 = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } })
    expect(orig2.status).toBe('split')
    expect(await prisma.salesOrderItem.findMany({ where: { orderId } })).toHaveLength(0)
  })

  it('拆单：部分拆分剩余留在原单，数量比例分摊余数归最后一份', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: {
        customerId: customer.id, customerPoNo: 'SP-PART',
        items: [{ productId: product.id, qty: 100, unitPrice: 1, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' }]
      }
    })
    const orderId = created.json().id as number
    const split = await app.inject({
      method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie },
      payload: { splits: [30, 40] }
    })
    expect(split.statusCode).toBe(200)
    // 原单剩 30
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { orderId } })
    expect(item.qty).toBe(30)
    const orig = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } })
    expect(orig.status).toBe('draft')
  })

  it('拆单：已有采购单/出货的订单拒绝拆分', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: {
        customerId: customer.id, customerPoNo: 'SP-BLOCK',
        items: [{ productId: product.id, qty: 100, unitPrice: 1, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' }]
      }
    })
    const orderId = created.json().id as number
    // 直接造一张采购单挂上去
    const supplier = await prisma.supplier.create({ data: { name: '供应商-SP' } })
    const part = await prisma.part.create({ data: { sku: 'P-SP', name: '零件SP' } })
    await prisma.purchaseOrder.create({ data: { orderNo: 'PO-SP-1', supplierId: supplier.id, salesOrderId: orderId, items: { create: { partId: part.id, qty: 1, unitPrice: 1 } } } })
    const split = await app.inject({
      method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie },
      payload: { splits: [50] }
    })
    expect(split.statusCode).toBe(400)
    expect(split.json().error).toContain('采购单')
  })

  it('拆单：超量拆分、非正整数、无权限、非法参数被拦截', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: {
        customerId: customer.id, customerPoNo: 'SP-VAL',
        items: [{ productId: product.id, qty: 50, unitPrice: 1, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' }]
      }
    })
    const orderId = created.json().id as number
    // 超量
    const over = await app.inject({ method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie }, payload: { splits: [60] } })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toContain('超过')
    // 非正整数
    const bad = await app.inject({ method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie }, payload: { splits: [0] } })
    expect(bad.statusCode).toBe(400)
    // 无权限：仓库
    const whCookie = await loginCookie(app, 'warehouse')
    const denied = await app.inject({ method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie: whCookie }, payload: { splits: [10] } })
    expect(denied.statusCode).toBe(403)
    // 不存在
    const missing = await app.inject({ method: 'POST', url: '/api/orders/999999/split', headers: { cookie }, payload: { splits: [10] } })
    expect(missing.statusCode).toBe(404)
  })

  it('拆单：采购角色可拆；列表返回 splittable 标记与拆单链', async () => {
    const app = buildApp()
    const { customer, product, cookie } = await seedOrder(app)
    const purchaseCookie = await loginCookie(app, 'purchase')
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie: purchaseCookie } // 创建会 403，用 sales cookie
    })
    expect(created.statusCode).toBe(403)
    // 用销售建单
    const salesCreated = await app.inject({
      method: 'POST', url: '/api/orders', headers: { cookie },
      payload: {
        customerId: customer.id, customerPoNo: 'SP-PUR',
        items: [{ productId: product.id, qty: 100, unitPrice: 1, customerDeliveryDate: '2026-10-01', zrhDeliveryDate: '2026-10-01' }]
      }
    })
    const orderId = salesCreated.json().id as number
    const split = await app.inject({
      method: 'POST', url: '/api/orders/' + orderId + '/split', headers: { cookie: purchaseCookie },
      payload: { splits: [40] }
    })
    expect(split.statusCode).toBe(200)
    // 列表 splittable 标记
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: purchaseCookie } })
    const rows = list.json() as Array<{ id: number; orderNo: string; splittable?: boolean; parentOrder?: { orderNo: string } | null; childOrders?: Array<{ orderNo: string }> }>
    const parentRow = rows.find((r) => r.id === orderId)
    expect(parentRow?.splittable).toBe(true) // 无业务痕迹仍可继续拆
    expect(parentRow?.childOrders?.map((c) => c.orderNo)).toContain('SP-PUR-1')
    const childRow = rows.find((r) => r.orderNo === 'SP-PUR-1')
    expect(childRow?.parentOrder?.orderNo).toBe('SP-PUR')
    expect(childRow?.splittable).toBe(true)
  })
})