import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

// 采购跟进（2026-09-09，老板口径）：
// - 一行 = 一个采购单明细行，交货数量是累计值（采购录本次送货量、系统自动累加）
// - 未交 = 订购 − 累计收货 − 累计补货 + 累计退货（多送记收货、退还记退货自动算平）
// - 收齐双条件：未交 ≤ 0 且采购点了「已收齐」
// - 采购可改交货数量，但必须留痕（DeliveryEditLog）

async function setup(qty = 100) {
  const supplier = await prisma.supplier.create({ data: { name: '跟进供应商' } })
  const part = await prisma.part.create({ data: { sku: 'PF-1', name: '跟进零件' } })
  const po = await prisma.purchaseOrder.create({
    data: {
      orderNo: 'PO-FU-1',
      supplierId: supplier.id,
      items: { create: { partId: part.id, qty, unitPrice: 1 } },
    },
    include: { items: true },
  })
  return { supplier, part, po, itemId: po.items[0]!.id }
}

async function followRow(app: ReturnType<typeof buildApp>, cookie: string, itemId: number) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/purchasing/follow-up?onlyOutstanding=false',
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  const rows = res.json() as Array<Record<string, unknown>>
  const row = rows.find((r) => r.id === itemId)
  expect(row).toBeTruthy()
  return row!
}

describe('purchase-follow 采购跟进', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('未交 = 订购 − 累计收货 − 累计补货 + 累计退货', async () => {
    const { part, po, itemId, supplier } = await setup(100)
    const app = buildApp()
    const wh = await loginCookie(app, 'warehouse')
    const rec = await app.inject({
      method: 'POST',
      url: '/api/receipts',
      headers: { cookie: wh },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 60 }] },
    })
    expect(rec.statusCode).toBe(200)
    await prisma.returnReplenish.create({
      data: {
        partId: part.id,
        supplierId: supplier.id,
        returnQty: 10,
        replenishQty: 5,
        purchaseOrderNo: po.orderNo,
        purchaseOrderId: po.id,
      },
    })

    const purchase = await loginCookie(app, 'purchase')
    const row = await followRow(app, purchase, itemId)
    expect(row).toMatchObject({
      qty: 100,
      receivedQty: 60,
      returnQty: 10,
      replenishQty: 5,
      outstandingQty: 45, // 100 − 60 − 5 + 10
      done: false,
    })
  })

  it('采购登记本次送货量：系统自动累加，库存同步增加', async () => {
    const { part, itemId } = await setup(100)
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    for (const qty of [60, 40]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/purchasing/follow-up/${itemId}/delivery`,
        headers: { cookie: purchase },
        payload: { qty },
      })
      expect(res.statusCode).toBe(200)
    }
    const row = await followRow(app, purchase, itemId)
    expect(row).toMatchObject({ receivedQty: 100, outstandingQty: 0 })
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'part', itemId: part.id } },
    })
    expect(stock?.qtyOnHand).toBe(100)
  })

  it('超收默认拦截，确认后放行并回报超收明细（仓库与采购共用同一口径）', async () => {
    const { part, po, itemId } = await setup(100)
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')

    const deny = await app.inject({
      method: 'POST',
      url: `/api/purchasing/follow-up/${itemId}/delivery`,
      headers: { cookie: purchase },
      payload: { qty: 150 },
    })
    expect(deny.statusCode).toBe(400)
    expect(deny.json().error).toContain('超过订购数量')

    const ok = await app.inject({
      method: 'POST',
      url: `/api/purchasing/follow-up/${itemId}/delivery`,
      headers: { cookie: purchase },
      payload: { qty: 150, allowOverQty: true },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { overQty: unknown[] }).overQty[0]).toMatchObject({
      orderedQty: 100,
      receivedQty: 0,
      incomingQty: 150,
      overQty: 50,
    })

    // 仓库收货接口同样支持 allowOverQty（共用 recordReceipt）
    const wh = await loginCookie(app, 'warehouse')
    const denyWh = await app.inject({
      method: 'POST',
      url: '/api/receipts',
      headers: { cookie: wh },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 10 }] },
    })
    expect(denyWh.statusCode).toBe(400)
    const okWh = await app.inject({
      method: 'POST',
      url: '/api/receipts',
      headers: { cookie: wh },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 10 }], allowOverQty: true },
    })
    expect(okWh.statusCode).toBe(200)
  })

  it('多送记进交货、退还记退货 → 未交自动算平', async () => {
    const { part, po, itemId, supplier } = await setup(100)
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    await app.inject({
      method: 'POST',
      url: `/api/purchasing/follow-up/${itemId}/delivery`,
      headers: { cookie: purchase },
      payload: { qty: 150, allowOverQty: true },
    })
    await prisma.returnReplenish.create({
      data: {
        partId: part.id,
        supplierId: supplier.id,
        returnQty: 50,
        purchaseOrderNo: po.orderNo,
        purchaseOrderId: po.id,
      },
    })
    const row = await followRow(app, purchase, itemId)
    expect(row).toMatchObject({ receivedQty: 150, returnQty: 50, outstandingQty: 0 })
  })

  it('采购改交货数量：库存同步、留痕可追溯、未交重算；QC 字段仍归仓库', async () => {
    const { part, po, itemId } = await setup(100)
    const app = buildApp()
    const wh = await loginCookie(app, 'warehouse')
    await app.inject({
      method: 'POST',
      url: '/api/receipts',
      headers: { cookie: wh },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 50 }] },
    })
    const receipt = await prisma.receipt.findFirst({ where: { purchaseOrderId: po.id } })
    expect(receipt).toBeTruthy()

    const purchase = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/receipts/' + receipt!.id,
      headers: { cookie: purchase },
      payload: { qty: 80 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().qty).toBe(80)

    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'part', itemId: part.id } },
    })
    expect(stock?.qtyOnHand).toBe(80)

    const log = await prisma.deliveryEditLog.findFirst({
      where: { receiptId: receipt!.id, field: 'qty' },
    })
    expect(log).toMatchObject({ beforeVal: '50', afterVal: '80' })

    const row = await followRow(app, purchase, itemId)
    expect(row).toMatchObject({ receivedQty: 80, outstandingQty: 20 })

    // 采购不能改 QC 状态（仓库专属）
    const deny = await app.inject({
      method: 'PATCH',
      url: '/api/receipts/' + receipt!.id,
      headers: { cookie: purchase },
      payload: { qcStatus: 'ok' },
    })
    expect(deny.statusCode).toBe(403)
  })

  it('收齐双条件：未交>0 不能标已收齐；未交=0 才能标，且默认列表不再显示', async () => {
    const { itemId } = await setup(100)
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    await app.inject({
      method: 'POST',
      url: `/api/purchasing/follow-up/${itemId}/delivery`,
      headers: { cookie: purchase },
      payload: { qty: 40 },
    })

    const deny = await app.inject({
      method: 'PATCH',
      url: `/api/purchasing/follow-up/${itemId}/confirm`,
      headers: { cookie: purchase },
      payload: {},
    })
    expect(deny.statusCode).toBe(400)
    expect(deny.json().error).toContain('未交')

    await app.inject({
      method: 'POST',
      url: `/api/purchasing/follow-up/${itemId}/delivery`,
      headers: { cookie: purchase },
      payload: { qty: 60 },
    })
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/purchasing/follow-up/${itemId}/confirm`,
      headers: { cookie: purchase },
      payload: {},
    })
    expect(ok.statusCode).toBe(200)

    const row = await followRow(app, purchase, itemId)
    expect(row).toMatchObject({ outstandingQty: 0, confirmed: true, done: true })

    // 默认只看未收齐：已收齐的行不出现
    const only = await app.inject({
      method: 'GET',
      url: '/api/purchasing/follow-up',
      headers: { cookie: purchase },
    })
    expect(only.statusCode).toBe(200)
    expect((only.json() as Array<{ id: number }>).some((r) => r.id === itemId)).toBe(false)

    // 改动历史留有确认记录
    const history = await app.inject({
      method: 'GET',
      url: `/api/purchasing/follow-up/${itemId}/history`,
      headers: { cookie: purchase },
    })
    expect(history.statusCode).toBe(200)
    expect((history.json() as Array<{ field: string }>).some((h) => h.field === 'confirm')).toBe(true)
  })

  it('权限：销售/工程看不了跟进表，仓库能看但登记送货是采购专属', async () => {
    const { itemId } = await setup(100)
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')
    const engineer = await loginCookie(app, 'engineer')
    const warehouse = await loginCookie(app, 'warehouse')

    expect(
      (await app.inject({ method: 'GET', url: '/api/purchasing/follow-up', headers: { cookie: sales } })).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'GET', url: '/api/purchasing/follow-up', headers: { cookie: engineer } })).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'GET', url: '/api/purchasing/follow-up', headers: { cookie: warehouse } })).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/purchasing/follow-up/${itemId}/delivery`,
          headers: { cookie: warehouse },
          payload: { qty: 1 },
        })
      ).statusCode,
    ).toBe(403)
  })
})
