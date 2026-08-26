import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

async function seedReadyOrder() {
  const product = await prisma.product.create({
    data: { sku: 'CSP-V3', name: 'CSP V3 挂档器', nameEn: 'CLUBSPORT PEDALE V3', hsCode: '9504 50 0000' },
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
      deliveryDate: new Date(),
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

  it('出货带明细行：按行扣库存、字段落库、订单变已出货', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: {
        salesOrderId: order.id,
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
        lines: [
          { productId: product.id, qty: 60, unitPrice: 56.97, customerPoNo: '269776', lotNo: 'ABO5D6341', cartons: 1, netWeight: 44.1, grossWeight: 254.94, cbm: 1.512, containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884', remark: '100% payment' },
          { productId: product.id, qty: 40, unitPrice: 56.97, customerPoNo: '269776', lotNo: 'ABO5D6341', cartons: 1, netWeight: 0.14, grossWeight: 0.22, cbm: 0.015552, containerNo: 'SELU4535980', sealNo: 'M4492285', hblNo: 'SZX31192884' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.invoiceNo).toBe('ZRH20260814006')
    expect(body.vesselVoyage).toContain('CMA CGM ZHENG HE')
    expect(body.lines).toHaveLength(2)
    expect(body.lines[0]).toMatchObject({ qty: 60, customerPoNo: '269776', hblNo: 'SZX31192884' })

    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } },
    })
    expect(stock?.qtyOnHand).toBe(0)
    const updated = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(updated?.status).toBe('shipped')
  })

  it('出货不带明细行时自动按订单明细生成行', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().lines).toHaveLength(1)
    expect(res.json().lines[0]).toMatchObject({ productId: product.id, qty: 100 })
  })

  it('出货明细行数量合计与订单不符返回 400', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: {
        salesOrderId: order.id,
        lines: [{ productId: product.id, qty: 90, unitPrice: 56.97 }],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('数量')
    const stock = await prisma.stock.findUnique({
      where: { itemType_itemId: { itemType: 'product', itemId: product.id } },
    })
    expect(stock?.qtyOnHand).toBe(100)
  })

  it('PATCH 出货单更新单证字段与明细行（不动库存），仅 sales 可改', async () => {
    const app = buildApp()
    const { product, order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const created = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: { salesOrderId: order.id },
    })
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
    const { order } = await seedReadyOrder()
    const cookie = await loginCookie(app, 'sales')
    const created = await app.inject({
      method: 'POST',
      url: '/api/shipments',
      headers: { cookie },
      payload: {
        salesOrderId: order.id,
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

  it('公司资料：默认可读，老板可改，销售改返回 403', async () => {
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

    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/company-profile',
      headers: { cookie: sales },
      payload: { name: 'hack' },
    })
    expect(forbidden.statusCode).toBe(403)
  })
})
