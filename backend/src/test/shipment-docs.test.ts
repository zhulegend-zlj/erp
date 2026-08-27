import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb, shipViaSchedule } from './helpers'
import { prisma } from '../db'

async function seedReadyOrder() {
  const product = await prisma.product.create({
    data: { sku: 'CSP_V3', name: 'CSP V3 挂档器', nameEn: 'CLUBSPORT PEDALE V3', hsCode: '9504 50 0000' },
  })
  await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 100 } })
  const customer = await prisma.customer.create({
    data: {
      name: 'CORSAIR COMPONENTS LTD',
      country: 'UNITED KINGDOM',
      address: '1020 ESKDALE ROAD',
      vatNo: 'NL827571732B01',
      eori: 'NL827571732',
      notifyParty: 'Corsair Components, Ltd - BEM\nDHL Supply Chain Bemmel',
    },
  })
  const order = await prisma.salesOrder.create({
    data: {
      orderNo: 'SO-DOC-001',
      customerId: customer.id,
      zrhDeliveryDate: new Date(),
      status: 'ready',
      items: { create: { productId: product.id, qty: 100, unitPrice: 56.97 } },
    },
  })
  return { product, customer, order }
}

describe('shipment docs（出货明细行/单证导出/公司资料）', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('两个排程拼票出货：按行扣库存、字段落库、订单变已出货', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    // 两条排程（60+40）拼一票，替代原手工明细行拆行
    const hub = await prisma.shipToHub.create({ data: { name: 'TEST-HUB-DOC' } })
    const mk = (qty: number) =>
      app.inject({
        method: 'POST', url: '/api/schedules', headers: { cookie },
        payload: { salesOrderId: order.id, productId: product.id, qty, hubId: hub.id, needByDate: '2026-09-30', promisedDate: '2026-09-30' }
      })
    const s1 = await mk(60)
    const s2 = await mk(40)
    expect(s1.statusCode).toBe(200)
    expect(s2.statusCode).toBe(200)
    const wh = await loginCookie(app, 'warehouse')
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s1.json().id, headers: { cookie: wh }, payload: { status: 'picked' } })
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + s2.json().id, headers: { cookie: wh }, payload: { status: 'picked' } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: {
        hubId: hub.id,
        schedules: [
          { id: s1.json().id, qty: 60 },
          { id: s2.json().id, qty: 40 },
        ],
        invoiceNo: 'ZRH20260814006',
        paymentTerms: 'NET 60',
        incoterm: 'FCA',
        mark: 'FANATEC',
        origin: 'China',
        hsCode: '9504 50 0000',
        taxRate: '0',
        vesselVoyage: 'CMA CGM ZHENG HE / 0FMMMW1MA',
        etd: '2026-08-18',
        eta: '2026-09-23',
        shippingInstructions: 'ALU 1264 pcs',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.invoiceNo).toBe('ZRH20260814006')
    expect(body.vesselVoyage).toContain('CMA CGM ZHENG HE')
    expect(body.lines).toHaveLength(2)
    expect(body.lines[0].qty).toBe(60)

    // 出货后补录行级单证（箱数/毛净重/CBM/柜号/HBL 等），不允许改数量
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/shipments/' + body.id,
      headers: { cookie },
      payload: {
        lines: [
          { productId: product.id, qty: 60, unitPrice: 56.97, customerPoNo: '269776', lotNo: 'ABO5D6341', cartons: 1, netWeight: 44.1, grossWeight: 254.94, cbm: 1.512, containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884', remark: '100% payment' },
          { productId: product.id, qty: 40, unitPrice: 56.97, customerPoNo: '269776', lotNo: 'ABO5D6341', cartons: 1, netWeight: 0.14, grossWeight: 0.22, cbm: 0.015552, containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884' },
        ],
      },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().lines[0]).toMatchObject({ qty: 60, customerPoNo: '269776', hblNo: 'SZX31192884' })

    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } },
    })
    expect(stock?.qtyOnHand).toBe(0)
    const updated = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(updated?.status).toBe('shipped')
  })

  it('排程出货自动按排程生成行', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const res = await shipViaSchedule(app, cookie, order.id, product.id, 100)
    expect(res.statusCode).toBe(200)
    expect(res.json().lines).toHaveLength(1)
    expect(res.json().lines[0]).toMatchObject({ productId: product.id, qty: 100 })
  })

  it('部分出货：90/100 出货成功，订单保持待出货并显示已出，超量排程拒绝', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const res = await shipViaSchedule(app, cookie, order.id, product.id, 90)
    expect(res.statusCode).toBe(200)
    expect(res.json().lines[0].qty).toBe(90)
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } },
    })
    expect(stock?.qtyOnHand).toBe(10)
    // 未出满：订单保持 ready，出货单列表能查到 90 台
    const updated = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(updated?.status).toBe('ready')
    const detail = await app.inject({ method: 'GET', url: '/api/orders/' + order.id, headers: { cookie } })
    expect(detail.json().shippedQty).toBe(90)

    // 超出订单剩余数量的排程被拒绝
    const over = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: { cookie },
      payload: {
        salesOrderId: order.id, productId: product.id, qty: 20,
        hubId: (await prisma.shipToHub.create({ data: { name: 'TEST-HUB-OVER' } })).id,
        needByDate: '2026-09-30', promisedDate: '2026-09-30',
      },
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toContain('超过订单剩余')

    // 出完剩余 10 台 → 订单自动已出货
    const rest = await shipViaSchedule(app, cookie, order.id, product.id, 10)
    expect(rest.statusCode).toBe(200)
    const done = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(done?.status).toBe('shipped')
  })

  it('PATCH 出货单更新单证字段（不动库存、不能改数量），仅 sales 可改', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const created = await shipViaSchedule(app, cookie, order.id, product.id, 100)
    const id = created.json().id

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/shipments/' + id,
      headers: { cookie },
      payload: {
        invoiceNo: 'ZRH20260814006',
        vesselVoyage: 'CMA CGM ZHENG HE / 0FMMMW1MA',
        paymentTerms: 'NET 60',
        lines: [{ productId: product.id, qty: 100, unitPrice: 56.97, lotNo: 'ABO5D6341', cartons: 2, hblNo: 'SZX31192884' }],
      },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().invoiceNo).toBe('ZRH20260814006')
    expect(patch.json().lines).toHaveLength(1)
    expect(patch.json().lines[0].hblNo).toBe('SZX31192884')

    // 出货后不能改数量/成品（账实一致性）
    const badQty = await app.inject({
      method: 'PATCH',
      url: '/api/shipments/' + id,
      headers: { cookie },
      payload: { lines: [{ productId: product.id, qty: 120, unitPrice: 56.97 }] },
    })
    expect(badQty.statusCode).toBe(400)
    expect(badQty.json().error).toContain('不能修改')

    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } },
    })
    expect(stock?.qtyOnHand).toBe(0)

    const warehouse = await loginCookie(app, 'warehouse')
    const forbidden = await app.inject({
      method: 'PATCH',
      url: '/api/shipments/' + id,
      headers: { cookie: warehouse },
      payload: { invoiceNo: 'X' },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('三份单证导出：返回 xlsx，非法 type 400，非销售/老板 403', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const hub = await prisma.shipToHub.create({ data: { name: 'TEST-HUB-EXP' } })
    const sched = await app.inject({
      method: 'POST', url: '/api/schedules', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 100, hubId: hub.id, needByDate: '2026-09-30', promisedDate: '2026-09-30' }
    })
    const wh = await loginCookie(app, 'warehouse')
    await app.inject({ method: 'PATCH', url: '/api/schedules/' + sched.json().id, headers: { cookie: wh }, payload: { status: 'picked' } })
    const created = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: {
        hubId: hub.id,
        schedules: [{ id: sched.json().id, qty: 100 }],
        invoiceNo: 'ZRH20260814006',
        paymentTerms: 'NET 60',
        incoterm: 'FCA',
        mark: 'FANATEC',
        origin: 'China',
        hsCode: '9504 50 0000',
        taxRate: '0',
        vesselVoyage: 'CMA CGM ZHENG HE / 0FMMMW1MA',
        etd: '2026-08-18',
        eta: '2026-09-23',
      },
    })
    const id = created.json().id
    for (const type of ['official', 'commercial', 'packing']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/shipments/' + id + '/export?type=' + type,
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('spreadsheetml')
      expect(res.rawPayload.length).toBeGreaterThan(1000)
    }
    const bad = await app.inject({
      method: 'GET',
      url: '/api/shipments/' + id + '/export?type=nonsense',
      headers: { cookie },
    })
    expect(bad.statusCode).toBe(400)

    const warehouse = await loginCookie(app, 'warehouse')
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/shipments/' + id + '/export?type=official',
      headers: { cookie: warehouse },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('公司资料：默认可读，老板与销售都可改', async () => {
    const app = buildApp()
    const boss = await loginCookie(app, 'boss')
    const sales = await loginCookie(app, 'sales')

    const get1 = await app.inject({ method: 'GET', url: '/api/company-profile', headers: { cookie: sales } })
    expect(get1.statusCode).toBe(200)
    expect(get1.json().name).toBe('')

    const put = await app.inject({
      method: 'PUT',
      url: '/api/company-profile',
      headers: { cookie: boss },
      payload: {
        name: 'Dongguan Zhiruiheng Electronic Co., Ltd',
        address: 'Room 201, No.239 Changhuang Road, Changping Town, Dongguan',
        vatNo: '91441900MAG11BDD14',
        taxRate: '0',
        bankName: 'CHINA MERCHANTS BANK DONGGUAN CHANGPING SUB-BRANCH',
        swift: 'CMBCCNBS195',
        accountName: 'Dongguan Zhiruiheng Electronic Co., Ltd',
        accountNo: '769914313710066',
      },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().name).toContain('Zhiruiheng')

    const get2 = await app.inject({ method: 'GET', url: '/api/company-profile', headers: { cookie: sales } })
    expect(get2.json().swift).toBe('CMBCCNBS195')

    const salesPut = await app.inject({
      method: 'PUT',
      url: '/api/company-profile',
      headers: { cookie: sales },
      payload: { taxRate: '0', mark: undefined },
    })
    expect(salesPut.statusCode).toBe(200)
  })
})
