import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('inventory', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('领料出库减少库存，记录领料人', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-1', name: '成品柜' } })
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 50 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-ISS-1', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 30 }] }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(20)

    const issue = await prisma.issue.findFirst({ where: { partId: part.id } })
    expect(issue).toMatchObject({ salesOrderId: order.id, partId: part.id, qty: 30, issuedBy: '张组长' })

    const ledger = await prisma.inventoryLedger.findFirst({
      where: { itemType: 'part', itemId: part.id, refType: 'issue', refId: issue!.id }
    })
    expect(ledger).toMatchObject({ delta: -30, balance: 20 })
  })

  it('库存不足返回 400', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-2', name: '成品柜2' } })
    const part = await prisma.part.create({ data: { sku: 'P8-B', name: '螺丝' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 5 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-ISS-2', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 10 }] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('库存不足')
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(5)
  })

  it('成品入库增加库存', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-1', name: '成品柜' } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-PROD-1', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 20, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/production-entries', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 20 }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: product.id } } })
    expect(stock?.qtyOnHand).toBe(20)
    const entry = await prisma.productionEntry.findFirst({ where: { productId: product.id } })
    expect(entry).toMatchObject({ salesOrderId: order.id, productId: product.id, qty: 20 })
  })

  it('成品入库数量不能超过订单该成品数量（累计）', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-CAP', name: '限量成品' } })
    const customer = await prisma.customer.create({ data: { name: '客户CAP' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-CAP-1', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 100, unitPrice: 5 } },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    // 第一次入 60 台 → 成功
    const ok = await app.inject({
      method: 'POST', url: '/api/production-entries', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 60 },
    })
    expect(ok.statusCode).toBe(200)
    // 再入 50 台（累计 110 > 100）→ 400 超限
    const over = await app.inject({
      method: 'POST', url: '/api/production-entries', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 50 },
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toContain('入库数量超限')
    expect(over.json().error).toContain('已入库 60')
    expect(over.json().error).toContain('最多还能入 40')
    // 订单详情带出按成品已入库量
    const detail = await app.inject({ method: 'GET', url: '/api/orders/' + order.id, headers: { cookie } })
    expect(detail.statusCode).toBe(200)
    const body = detail.json()
    expect(body.producedByProduct[product.id]).toBe(60)
  })

  it('库存列表返回 itemType/itemId/名称/qtyOnHand/不良品', async () => {
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    const product = await prisma.product.create({ data: { sku: 'F8-1', name: '成品柜' } })
    await prisma.stock.createMany({
      data: [
        { itemType: 'part', itemId: part.id, qtyOnHand: 20 },
        { itemType: 'product', itemId: product.id, qtyOnHand: 8 }
      ]
    })
    // 收货记录 QC 补录不良品：零件汇总为该 part 的 defectiveQty 之和，成品为 0
    await prisma.receipt.create({ data: { partId: part.id, qty: 20, defectiveQty: 5 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({ method: 'GET', url: '/api/stock', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const partRow = rows.find((r: any) => r.itemType === 'part' && r.itemId === part.id)
    const productRow = rows.find((r: any) => r.itemType === 'product' && r.itemId === product.id)
    expect(partRow).toMatchObject({ itemType: 'part', itemId: part.id, name: '木板', qtyOnHand: 20, defectiveQty: 5 })
    expect(productRow).toMatchObject({ itemType: 'product', itemId: product.id, name: '成品柜', qtyOnHand: 8, defectiveQty: 0 })
  })

  it('库存列表不良品与退补货实时联动，并返回已退/已补/应补', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-RR' } })
    const part = await prisma.part.create({ data: { sku: 'P-RR', name: '联动零件', supplierId: supplier.id } })
    const product = await prisma.product.create({ data: { sku: 'F-RR', name: '联动成品' } })
    await prisma.stock.createMany({
      data: [
        { itemType: 'part', itemId: part.id, qtyOnHand: 50 },
        { itemType: 'product', itemId: product.id, qtyOnHand: 8 },
      ],
    })
    // 收货不良 10
    await prisma.receipt.create({ data: { partId: part.id, qty: 20, defectiveQty: 10 } })
    // 退补货：退 3 补 2 + 退 5 补 0 => 已退 8、已补 2、应补 6、不良 10-8=2
    await prisma.returnReplenish.createMany({
      data: [
        { partId: part.id, supplierId: supplier.id, returnQty: 3, replenishQty: 2 },
        { partId: part.id, supplierId: supplier.id, returnQty: 5, replenishQty: 0 },
      ],
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({ method: 'GET', url: '/api/stock', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const partRow = rows.find((r: any) => r.itemType === 'part' && r.itemId === part.id)
    const productRow = rows.find((r: any) => r.itemType === 'product' && r.itemId === product.id)
    expect(partRow).toMatchObject({
      itemType: 'part',
      itemId: part.id,
      qtyOnHand: 50,
      defectiveQty: 2,
      returnedQty: 8,
      replenishedQty: 2,
      pendingReplenishQty: 6,
    })
    expect(productRow).toMatchObject({
      itemType: 'product',
      itemId: product.id,
      qtyOnHand: 8,
      defectiveQty: 0,
      returnedQty: 0,
      replenishedQty: 0,
      pendingReplenishQty: 0,
    })
  })

  it('库存列表不良品不足退货时不出现负数', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-RR2' } })
    const part = await prisma.part.create({ data: { sku: 'P-RR2', name: '负数零件', supplierId: supplier.id } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 10 } })
    await prisma.receipt.create({ data: { partId: part.id, qty: 5, defectiveQty: 1 } })
    await prisma.returnReplenish.create({ data: { partId: part.id, supplierId: supplier.id, returnQty: 2 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')
    const res = await app.inject({ method: 'GET', url: '/api/stock', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const partRow = rows.find((r: any) => r.itemType === 'part' && r.itemId === part.id)
    expect(partRow).toMatchObject({
      defectiveQty: 0,
      returnedQty: 2,
      replenishedQty: 0,
      pendingReplenishQty: 2,
    })
  })

  it('出入库流水按时间升序返回', async () => {
    const product = await prisma.product.create({ data: { sku: 'F8-LED', name: '成品LED' } })
    const part = await prisma.part.create({ data: { sku: 'P8-A', name: '木板' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-ISS-1', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const first = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 10 }] }
    })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 5 }] }
    })
    expect(second.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET', url: `/api/stock/ledger?itemType=part&itemId=${part.id}`, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const ledger = res.json()
    expect(ledger.length).toBeGreaterThanOrEqual(2)
    expect(ledger[0].delta).toBe(-10)
    expect(ledger[1].delta).toBe(-5)
  })

  it('非 warehouse 无权领料（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: 1, issuedBy: '张组长', items: [{ partId: 1, qty: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })

  it('订单物料计算返回需求/已出库/差值', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商A' } })
    const part = await prisma.part.create({ data: { sku: 'P-MAT', name: '螺丝', spec: 'M4', supplierId: supplier.id } })
    const product = await prisma.product.create({ data: { sku: 'F-MAT', name: '成品' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 2 } })
    const customer = await prisma.customer.create({ data: { name: '客户MAT' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-MAT',
        customerId: customer.id,
        zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } }
      }
    })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 50 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const issue = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: part.id, qty: 12 }] }
    })
    expect(issue.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET', url: '/api/inventory/order-materials?orderNo=' + order.orderNo, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.orderQty).toBe(10)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      partId: part.id,
      sku: 'P-MAT',
      name: '螺丝',
      spec: 'M4',
      supplierName: '供应商A',
      requiredQty: 20,
      issuedQty: 12,
      variance: -8
    })
    // 用量口径：单一成品 BOM 用量 2 → 整数 2（旧逻辑 20/10 也是 2，此处防回归）
    expect(body.items[0].usage).toBe(2)
    expect(Number.isInteger(body.items[0].usage)).toBe(true)
  })

  it('订单流水查询返回流水并汇总出库', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-LED', name: '成品LED' } })
    const part = await prisma.part.create({ data: { sku: 'P-LED', name: '木板' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const customer = await prisma.customer.create({ data: { name: '客户LED' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-LED', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const issue = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: part.id, qty: 10 }] }
    })
    expect(issue.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET', url: '/api/inventory/order-ledger?orderNo=' + order.orderNo, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.orderNo).toBe('SO-LED')
    expect(body.totalOutboundQty).toBe(10)
    expect(body.rows.length).toBeGreaterThanOrEqual(1)
    expect(body.rows[0]).toMatchObject({ itemType: 'part', itemId: part.id, delta: -10 })
  })

  it('采购单流水返回需求/已入库/未到/结存', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-PO-LED' } })
    const part = await prisma.part.create({ data: { sku: 'P-PO-LED', name: '采购零件' } })
    const po = await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-LED-TEST',
        supplierId: supplier.id,
        items: { create: { partId: part.id, qty: 100, unitPrice: 1 } }
      }
    })
    await prisma.receipt.create({
      data: { purchaseOrderId: po.id, partId: part.id, qty: 30 }
    })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 30 } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'GET', url: '/api/inventory/po-ledger?purchaseOrderNo=' + po.orderNo, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.purchaseOrderNo).toBe('PO-LED-TEST')
    expect(body.supplierName).toBe('供应商-PO-LED')
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      partId: part.id,
      sku: 'P-PO-LED',
      name: '采购零件',
      requiredQty: 100,
      receivedQty: 30,
      outstanding: 70,
      balance: 30,
    })
  })

  it('订单流水绑定物料查询只返回该物料流水并给出需求/出库/未出汇总', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-OLB' } })
    const partA = await prisma.part.create({ data: { sku: 'P-OLB-1', name: '螺丝', supplierId: supplier.id } })
    const partB = await prisma.part.create({ data: { sku: 'P-OLB-2', name: '木板' } })
    const product = await prisma.product.create({ data: { sku: 'F-OLB', name: '成品' } })
    await prisma.bom.createMany({
      data: [
        { productId: product.id, partId: partA.id, qty: 2 },
        { productId: product.id, partId: partB.id, qty: 1 },
      ],
    })
    const customer = await prisma.customer.create({ data: { name: '客户OLB' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-OLB',
        customerId: customer.id,
        zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } }
      }
    })
    await prisma.stock.createMany({
      data: [
        { itemType: 'part', itemId: partA.id, qtyOnHand: 100 },
        { itemType: 'part', itemId: partB.id, qtyOnHand: 100 },
      ]
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    for (const [partId, qty] of [[partA.id, 12], [partB.id, 5]] as const) {
      const res = await app.inject({
        method: 'POST', url: '/api/issues', headers: { cookie },
        payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId, qty }] }
      })
      expect(res.statusCode).toBe(200)
    }

    // 不带物料：返回订单全部流水
    const all = await app.inject({
      method: 'GET', url: '/api/inventory/order-ledger?orderNo=' + order.orderNo, headers: { cookie }
    })
    expect(all.statusCode).toBe(200)
    expect(all.json().rows.length).toBeGreaterThanOrEqual(2)

    // 绑定物料：只返回该物料流水，并汇总需求/出库/未出
    const res = await app.inject({
      method: 'GET',
      url: `/api/inventory/order-ledger?orderNo=${order.orderNo}&itemType=part&itemId=${partA.id}`,
      headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.orderNo).toBe('SO-OLB')
    expect(body.itemName).toContain('螺丝')
    expect(body.requiredQty).toBe(20)
    expect(body.issuedQty).toBe(12)
    expect(body.outstanding).toBe(8)
    expect(body.totalOutboundQty).toBe(12)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ itemType: 'part', itemId: partA.id, delta: -12 })
  })

  it('订单流水绑定查询参数不合法返回 400', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户OLB2' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'SO-OLB2', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30') }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')

    const onlyType = await app.inject({
      method: 'GET',
      url: '/api/inventory/order-ledger?orderNo=' + order.orderNo + '&itemType=part',
      headers: { cookie }
    })
    expect(onlyType.statusCode).toBe(400)

    const badType = await app.inject({
      method: 'GET',
      url: '/api/inventory/order-ledger?orderNo=' + order.orderNo + '&itemType=bogus&itemId=1',
      headers: { cookie }
    })
    expect(badType.statusCode).toBe(400)

    const badId = await app.inject({
      method: 'GET',
      url: '/api/inventory/order-ledger?orderNo=' + order.orderNo + '&itemType=part&itemId=0',
      headers: { cookie }
    })
    expect(badId.statusCode).toBe(400)
  })

  it('撤销收货扣回库存并保留冲销流水', async () => {
    const part = await prisma.part.create({ data: { sku: 'P-VOID-R', name: '撤销收货零件' } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 50 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const created = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { items: [{ partId: part.id, qty: 20 }] },
    })
    expect(created.statusCode).toBe(200)
    let stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(70)
    const receipt = await prisma.receipt.findFirst({ where: { partId: part.id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/receipts/' + receipt!.id, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(50)
    const voidLedger = await prisma.inventoryLedger.findFirst({ where: { refType: 'void', refId: receipt!.id } })
    expect(voidLedger).toMatchObject({ delta: -20, balance: 50 })
    const original = await prisma.inventoryLedger.findFirst({ where: { refType: 'receipt', refId: receipt!.id } })
    expect(original).toMatchObject({ delta: 20, balance: 70 })
  })

  it('撤销领料加回库存', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-VOID-I', name: '撤销领料成品' } })
    const part = await prisma.part.create({ data: { sku: 'P-VOID-I', name: '撤销领料零件' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 50 } })
    const customer = await prisma.customer.create({ data: { name: '客户VOID-I' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-VOID-I', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const created = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '张组长', items: [{ partId: part.id, qty: 30 }] },
    })
    expect(created.statusCode).toBe(200)
    let stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(20)
    const issue = await prisma.issue.findFirst({ where: { partId: part.id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/issues/' + issue!.id, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(50)
    const voidLedger = await prisma.inventoryLedger.findFirst({ where: { refType: 'void', refId: issue!.id } })
    expect(voidLedger).toMatchObject({ delta: 30, balance: 50 })
  })

  it('撤销成品入库扣回库存', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-VOID-P', name: '撤销入库成品' } })
    await prisma.stock.create({ data: { itemType: 'product', itemId: product.id, qtyOnHand: 5 } })
    const customer = await prisma.customer.create({ data: { name: '客户VOID-P' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-VOID-P', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const created = await app.inject({
      method: 'POST', url: '/api/production-entries', headers: { cookie },
      payload: { salesOrderId: order.id, productId: product.id, qty: 5 },
    })
    expect(created.statusCode).toBe(200)
    let stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: product.id } } })
    expect(stock?.qtyOnHand).toBe(10)
    const entry = await prisma.productionEntry.findFirst({ where: { productId: product.id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/production-entries/' + entry!.id, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: product.id } } })
    expect(stock?.qtyOnHand).toBe(5)
    const voidLedger = await prisma.inventoryLedger.findFirst({ where: { refType: 'void', refId: entry!.id } })
    expect(voidLedger).toMatchObject({ delta: -5, balance: 5 })
  })

  it('撤销退补货反向:退的加回、补的扣回', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商VOID-RR' } })
    const part = await prisma.part.create({ data: { sku: 'P-VOID-RR', name: '退补货零件', supplierId: supplier.id } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 30 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const created = await app.inject({
      method: 'POST', url: '/api/return-replenishments', headers: { cookie },
      payload: { partId: part.id, supplierId: supplier.id, returnQty: 5, replenishQty: 3 },
    })
    expect(created.statusCode).toBe(200)
    let stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(28)
    const rr = await prisma.returnReplenish.findFirst({ where: { partId: part.id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/return-replenishments/' + rr!.id, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(30)
    const voids = await prisma.inventoryLedger.findMany({ where: { refType: 'void', refId: rr!.id, itemId: part.id } })
    expect(voids.length).toBe(2)
    expect(voids.some((v) => v.delta === 5)).toBe(true)
    expect(voids.some((v) => v.delta === -3)).toBe(true)
  })

  it('撤销收货但库存已被后续领用消耗时返回400', async () => {
    const product = await prisma.product.create({ data: { sku: 'F-VOID-B', name: '库存不足成品' } })
    const part = await prisma.part.create({ data: { sku: 'P-VOID-B', name: '库存不足零件' } })
    await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty: 1 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 10 } })
    const customer = await prisma.customer.create({ data: { name: '客户VOID-B' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-VOID-B', customerId: customer.id, zrhDeliveryDate: new Date('2026-09-30'),
        status: 'in_production',
        items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const recv = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { items: [{ partId: part.id, qty: 20 }] },
    })
    expect(recv.statusCode).toBe(200)
    const iss = await app.inject({
      method: 'POST', url: '/api/issues', headers: { cookie },
      payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: part.id, qty: 30 }] },
    })
    expect(iss.statusCode).toBe(200)
    const receipt = await prisma.receipt.findFirst({ where: { partId: part.id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/receipts/' + receipt!.id, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('该记录已被后续领用/使用，无法撤销')
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(0)
  })
})
