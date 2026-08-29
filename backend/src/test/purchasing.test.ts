import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('purchasing', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('收货后零件库存增加', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const part = await prisma.part.create({ data: { sku: 'P100', name: '螺丝' } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'PO-1', supplierId: supplier.id, items: { create: { partId: part.id, qty: 100, unitPrice: 0.5 } } }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 100 }] }
    })
    expect(res.statusCode).toBe(200)
    const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
    expect(stock?.qtyOnHand).toBe(100)
  })

  it('需求计算跨订单明细累加同一零件并扣减库存得出缺口', async () => {
    const partA = await prisma.part.create({ data: { sku: 'P7-A', name: '螺丝A' } })
    const partB = await prisma.part.create({ data: { sku: 'P7-B', name: '螺丝B' } })
    const p1 = await prisma.product.create({ data: { sku: 'F7-1', name: '成品1' } })
    const p2 = await prisma.product.create({ data: { sku: 'F7-2', name: '成品2' } })
    await prisma.bom.createMany({
      data: [
        { productId: p1.id, partId: partA.id, qty: 2 },
        { productId: p2.id, partId: partA.id, qty: 1 },
        { productId: p2.id, partId: partB.id, qty: 5 }
      ]
    })
    const customer = await prisma.customer.create({ data: { name: '客户7' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-REQ-7',
        customerId: customer.id,
        zrhDeliveryDate: new Date('2026-10-01'),
        status: 'confirmed',
        items: {
          create: [
            { productId: p1.id, qty: 3, unitPrice: 10 },
            { productId: p2.id, qty: 4, unitPrice: 20 }
          ]
        }
      }
    })
    await prisma.stock.create({ data: { itemType: 'part', itemId: partA.id, qtyOnHand: 3 } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'GET', url: `/api/purchasing/requirements?orderId=${order.id}`, headers: { cookie }
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const a = rows.find((r: any) => r.partId === partA.id)
    const b = rows.find((r: any) => r.partId === partB.id)
    expect(a).toMatchObject({ partId: partA.id, partName: '螺丝A', requiredQty: 10, onHand: 3, gapQty: 7 })
    expect(b).toMatchObject({ partId: partB.id, partName: '螺丝B', requiredQty: 20, onHand: 0, gapQty: 20 })
    // 用量口径：partA 在两个成品用量不同（2/1）→ usageText 明细；partB 只在一个成品 → 整数 5
    expect(a.usage).toBeNull()
    expect(a.usageText).toBe('F7-1×2、F7-2×1')
    expect(b.usage).toBe(5)
    expect(b.usageText).toBeUndefined()
  })

  it('用量/台不再出现小数：零件只在订单内一个成品时显示 BOM 整数用量', async () => {
    const partX = await prisma.part.create({ data: { sku: 'P8-X', name: '单成品零件' } })
    const pa = await prisma.product.create({ data: { sku: 'F8-A', name: '成品A' } })
    const pb = await prisma.product.create({ data: { sku: 'F8-B', name: '成品B' } })
    const pc = await prisma.product.create({ data: { sku: 'F8-C', name: '成品C' } })
    // partX 只在成品A 的 BOM 里用量 1；B/C 不含该零件
    await prisma.bom.createMany({
      data: [
        { productId: pa.id, partId: partX.id, qty: 1 },
        { productId: pb.id, partId: (await prisma.part.create({ data: { sku: 'P8-Y', name: 'B用零件' } })).id, qty: 1 },
      ],
    })
    const customer = await prisma.customer.create({ data: { name: '客户8' } })
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: 'SO-REQ-8',
        customerId: customer.id,
        zrhDeliveryDate: new Date('2026-10-01'),
        status: 'confirmed',
        items: {
          create: [
            { productId: pa.id, qty: 1, unitPrice: 10 },
            { productId: pb.id, qty: 1, unitPrice: 20 },
            { productId: pc.id, qty: 1, unitPrice: 30 },
          ],
        },
      },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'GET', url: `/api/purchasing/requirements?orderId=${order.id}`, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const row = (res.json() as Array<{ partId: number; usage: number | null; usageText?: string; requiredQty: number }>).find(
      (r) => r.partId === partX.id,
    )
    // 旧逻辑会算出 1/3 = 0.3333…；新口径 = BOM 整数 1
    expect(row).toMatchObject({ requiredQty: 1, usage: 1 })
    expect(row?.usageText).toBeUndefined()
    expect(Number.isInteger(row?.usage)).toBe(true)
  })

  it('自购（无销售订单）采购单自动生成 PO 单号', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const part = await prisma.part.create({ data: { sku: 'P100', name: '螺丝', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, items: [{ partId: part.id, qty: 100, unitPrice: 0.5 }] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toMatch(/^PO-\d{8}-[A-Z]{2}$/)
    expect(res.json().items).toHaveLength(1)
  })

  it('草稿订单不能生成采购单：提示销售未确认，可提醒销售；确认后可正常生成', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户D' } })
    const supplier = await prisma.supplier.create({ data: { name: '供应商D' } })
    const part = await prisma.part.create({ data: { sku: 'P-D', name: '零件D', supplierId: supplier.id } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'PO-DRAFT-1', customerId: customer.id, customerPoNo: 'PO-DRAFT-1', status: 'draft' },
    })
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    const sales = await loginCookie(app, 'sales')
    // 待采购列表应包含草稿订单（采购可见）
    const pending = await app.inject({
      method: 'GET', url: '/api/orders?pendingPurchase=true', headers: { cookie: purchase },
    })
    expect(pending.statusCode).toBe(200)
    expect((pending.json() as Array<{ id: number }>).some((o) => o.id === order.id)).toBe(true)

    // 草稿订单生成采购单 → 400 销售还未确认
    const blocked = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchase },
      payload: { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] },
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error).toContain('销售还未确认')

    // 采购一键提醒销售确认
    const remind = await app.inject({
      method: 'PATCH', url: '/api/orders/' + order.id + '/remind-confirm', headers: { cookie: purchase },
    })
    expect(remind.statusCode).toBe(200)
    const reminded = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(reminded?.confirmReminderAt).not.toBeNull()
    expect(reminded?.confirmReminderBy).toBe('purchase') // 测试账号 name=role，生产环境为中文名

    // 订单列表带出催办标记（销售可见）
    const listForSales = await app.inject({
      method: 'GET', url: '/api/orders', headers: { cookie: sales },
    })
    const row = (listForSales.json() as Array<{ id: number; confirmReminderAt?: string | null }>).find((o) => o.id === order.id)
    expect(row?.confirmReminderAt).toBeTruthy()

    // 销售确认订单 → 催办标记清空
    const confirm = await app.inject({
      method: 'PATCH', url: '/api/orders/' + order.id + '/status', headers: { cookie: sales },
      payload: { status: 'confirmed' },
    })
    expect(confirm.statusCode).toBe(200)
    const afterConfirm = await prisma.salesOrder.findUnique({ where: { id: order.id } })
    expect(afterConfirm?.status).toBe('confirmed')
    expect(afterConfirm?.confirmReminderAt).toBeNull()

    // 确认后采购可以正常生成采购单
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchase },
      payload: { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orderNo).toBe('PO-DRAFT-1A')
  })

  it('挂销售订单的采购单号 = 订单PO号 + 字母递增（A→B）', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户Z' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: '265440545874390', customerId: customer.id, customerPoNo: '265440545874390', zrhDeliveryDate: new Date('2026-09-30'), status: 'confirmed' },
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商Z' } })
    const part = await prisma.part.create({ data: { sku: 'P-Z', name: '零件Z', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const payload = { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] }
    const r1 = await app.inject({ method: 'POST', url: '/api/purchase-orders', headers: { cookie }, payload })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().orderNo).toBe('265440545874390A')
    const r2 = await app.inject({ method: 'POST', url: '/api/purchase-orders', headers: { cookie }, payload })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().orderNo).toBe('265440545874390B')
  })

  it('批量生成：同一订单按供应商分组自动排 A/B 字母', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户B' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: 'PO-BATCH-9', customerId: customer.id, customerPoNo: 'PO-BATCH-9', zrhDeliveryDate: new Date('2026-09-30'), status: 'confirmed' },
    })
    const s1 = await prisma.supplier.create({ data: { name: '供应商Z1' } })
    const s2 = await prisma.supplier.create({ data: { name: '供应商Z2' } })
    const p1 = await prisma.part.create({ data: { sku: 'P-Z1', name: '零件Z1', supplierId: s1.id } })
    const p2 = await prisma.part.create({ data: { sku: 'P-Z2', name: '零件Z2', supplierId: s2.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: {
        salesOrderId: order.id,
        items: [
          { partId: p1.id, qty: 10, unitPrice: 1 },
          { partId: p2.id, qty: 20, unitPrice: 2 },
        ]
      }
    })
    expect(res.statusCode).toBe(200)
    const orders = res.json()
    expect(orders).toHaveLength(2)
    expect(orders.map((o: any) => o.orderNo).sort()).toEqual(['PO-BATCH-9A', 'PO-BATCH-9B'])
  })

  it('创建采购单 items 为空返回 400', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商X' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, items: [] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('warehouse 无权创建采购单（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: 1, items: [{ partId: 1, qty: 1, unitPrice: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })

  it('非 warehouse 无权收货（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/receipts', headers: { cookie },
      payload: { purchaseOrderId: 1, items: [{ partId: 1, qty: 1 }] }
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/purchase-orders 返回含供应商与金额的采购单列表', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-LIST' } })
    const part = await prisma.part.create({ data: { sku: 'P-LIST', name: '螺丝LIST' } })
    const po = await prisma.purchaseOrder.create({
      data: {
        orderNo: 'PO-LIST',
        supplierId: supplier.id,
        items: { create: { partId: part.id, qty: 10, unitPrice: 2.5 } }
      }
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({ method: 'GET', url: '/api/purchase-orders', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    const row = rows.find((r: any) => r.id === po.id)
    expect(row).toMatchObject({
      id: po.id,
      orderNo: 'PO-LIST',
      supplierId: supplier.id,
      supplierName: '供应商-LIST',
      totalAmount: 25,
      paidAmount: 0,
      outstanding: 25,
    })
    expect(row.items).toHaveLength(1)
    // 采购单价口径：仓库不可见，采购/老板/财务可见
    expect(row.items[0]).toMatchObject({ partId: part.id, sku: 'P-LIST', name: '螺丝LIST', qty: 10 })
    expect(row.items[0].unitPrice).toBeUndefined()
    const purchaseCookie = await loginCookie(app, 'purchase')
    const res2 = await app.inject({ method: 'GET', url: '/api/purchase-orders', headers: { cookie: purchaseCookie } })
    const row2 = res2.json().find((r: any) => r.id === po.id)
    expect(row2.items[0].unitPrice).toBe(2.5)
  })

  it('需求计算仅 purchase/boss 可访问（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'GET', url: '/api/purchasing/requirements?orderId=1', headers: { cookie }
    })
    expect(res.statusCode).toBe(403)
  })

  it('批量生成采购单按零件供应商自动分组', async () => {
    const s1 = await prisma.supplier.create({ data: { name: '供应商-B1' } })
    const s2 = await prisma.supplier.create({ data: { name: '供应商-B2' } })
    const p1 = await prisma.part.create({ data: { sku: 'P-B1', name: '零件B1', supplierId: s1.id } })
    const p2 = await prisma.part.create({ data: { sku: 'P-B2', name: '零件B2', supplierId: s2.id } })

    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: {
        items: [
          { partId: p1.id, qty: 10, unitPrice: 1 },
          { partId: p2.id, qty: 20, unitPrice: 2 },
        ]
      }
    })
    expect(res.statusCode).toBe(200)
    const orders = res.json()
    expect(orders).toHaveLength(2)
    expect(orders.map((o: any) => o.supplierId).sort()).toEqual([s1.id, s2.id].sort())
  })

  it('零件未设置供应商时批量生成返回 400', async () => {
    const part = await prisma.part.create({ data: { sku: 'P-B3', name: '零件B3' } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-orders/batch',
      headers: { cookie },
      payload: { items: [{ partId: part.id, qty: 1, unitPrice: 1 }] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('未设置供应商')
  })

  it('并发收货不超订购量（BUG-01 回归：8 并发收 2 台只成功 2 次）', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商-CONC' } })
    const part = await prisma.part.create({ data: { sku: 'P-CONC', name: '零件CONC', supplierId: supplier.id } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'PO-CONC', supplierId: supplier.id, items: { create: { partId: part.id, qty: 2, unitPrice: 1 } } },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST', url: '/api/receipts', headers: { cookie },
          payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 1 }] },
        }),
      ),
    )
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2)
    const receipts = await prisma.receipt.findMany({ where: { purchaseOrderId: po.id } })
    expect(receipts.reduce((s, r) => s + r.qty, 0)).toBe(2)
  })

  it('多订单合并生成采购单：编号=首PO-末PO+字母，中间表关联全部订单', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户MG' } })
    const o1 = await prisma.salesOrder.create({
      data: { orderNo: '259283', customerId: customer.id, customerPoNo: '259283', status: 'confirmed' },
    })
    const o2 = await prisma.salesOrder.create({
      data: { orderNo: '259288', customerId: customer.id, customerPoNo: '259288', status: 'confirmed' },
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商MG' } })
    const part = await prisma.part.create({ data: { sku: 'P-MG', name: '零件MG', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: {
        supplierId: supplier.id,
        salesOrderIds: [o1.id, o2.id],
        items: [{ partId: part.id, qty: 10, unitPrice: 1, unitPriceInclTax: 1.07, usage: 2, note: '合并两单' }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orderNo: string; salesOrderId: number }
    expect(body.orderNo).toBe('259283-288A')
    // 中间表关联两个订单
    const links = await prisma.purchaseOrderSalesOrder.findMany({
      where: { purchaseOrder: { orderNo: body.orderNo } },
    })
    expect(links.map((l) => l.salesOrderId).sort()).toEqual([o1.id, o2.id].sort())
    // 双价与明细新字段落库
    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { orderNo: body.orderNo },
      include: { items: true },
    })
    expect(po.items[0]!.unitPriceInclTax?.toNumber()).toBe(1.07)
    expect(po.items[0]!.usage).toBe(2)
    expect(po.items[0]!.note).toBe('合并两单')
    // 两个订单都点亮采购中
    const so1 = await prisma.salesOrder.findUnique({ where: { id: o1.id } })
    const so2 = await prisma.salesOrder.findUnique({ where: { id: o2.id } })
    expect(so1?.purchasing).toBe(true)
    expect(so2?.purchasing).toBe(true)
  })

  it('拆单：同供应商同零件不同 splitNo 生成多张单，字母顺延', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户SP' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: '272750', customerId: customer.id, customerPoNo: '272750', status: 'confirmed' },
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商SP' } })
    const part = await prisma.part.create({ data: { sku: 'P-SP', name: '零件SP', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders/batch', headers: { cookie },
      payload: {
        salesOrderId: order.id,
        items: [
          { partId: part.id, qty: 4000, unitPrice: 0.24, splitNo: 0, expectedDeliveryDate: '2026-09-12' },
          { partId: part.id, qty: 2672, unitPrice: 0.24, splitNo: 1, expectedDeliveryDate: '2026-09-30' },
        ],
        expectedDeliveryDate: '2026-09-12',
      },
    })
    if (res.statusCode !== 200) console.log('SPLIT-DEBUG', res.body.slice(0, 300))
    expect(res.statusCode).toBe(200)
    const orders = res.json() as Array<{ orderNo: string }>
    expect(orders).toHaveLength(2)
    expect(orders.map((o) => o.orderNo).sort()).toEqual(['272750A', '272750B'])
  })

  it('免费备品单：poType=spare 单价必须为 0，编号=订单号+备品', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户SP2' } })
    const order = await prisma.salesOrder.create({
      data: { orderNo: '259203', customerId: customer.id, customerPoNo: '259203', status: 'confirmed' },
    })
    const supplier = await prisma.supplier.create({ data: { name: '供应商SP2' } })
    const part = await prisma.part.create({ data: { sku: 'P-SP2', name: '零件SP2', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    // 单价>0 → 400
    const bad = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, salesOrderId: order.id, poType: 'spare', items: [{ partId: part.id, qty: 10, unitPrice: 5 }] },
    })
    expect(bad.statusCode).toBe(400)
    // 正常备品单
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: {
        supplierId: supplier.id, salesOrderId: order.id, poType: 'spare',
        items: [{ partId: part.id, qty: 10, unitPrice: 0, note: '请给3‰免费备品' }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orderNo: string; poType: string; poStatus: string }
    expect(body.orderNo).toBe('259203备品')
    // 再下一张 → -2
    const res2 = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, salesOrderId: order.id, poType: 'spare', items: [{ partId: part.id, qty: 5, unitPrice: 0 }] },
    })
    expect((res2.json() as { orderNo: string }).orderNo).toBe('259203备品-2')
  })

  it('手工编号：manualOrderNo 优先 + 唯一性校验', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商MN' } })
    const part = await prisma.part.create({ data: { sku: 'P-MN', name: '零件MN', supplierId: supplier.id } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, manualOrderNo: 'JMC20200475备品', items: [{ partId: part.id, qty: 10, unitPrice: 0 }] },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { orderNo: string }).orderNo).toBe('JMC20200475备品')
    // 重复编号 → 400
    const dup = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie },
      payload: { supplierId: supplier.id, manualOrderNo: 'JMC20200475备品', items: [{ partId: part.id, qty: 10, unitPrice: 0 }] },
    })
    expect(dup.statusCode).toBe(400)
    expect(dup.json().error).toContain('已存在')
  })

  it('需求计算：多订单 orderIds 合并 + 安全库存补货 + MOQ/共用料标识', async () => {
    const customer = await prisma.customer.create({ data: { name: '客户RQ' } })
    const o1 = await prisma.salesOrder.create({
      data: { orderNo: 'RQ-1', customerId: customer.id, customerPoNo: 'RQ-1', status: 'confirmed' },
    })
    const o2 = await prisma.salesOrder.create({
      data: { orderNo: 'RQ-2', customerId: customer.id, customerPoNo: 'RQ-2', status: 'confirmed' },
    })
    const p1 = await prisma.product.create({ data: { sku: 'RQ-P1', name: '成品RQ1' } })
    const p2 = await prisma.product.create({ data: { sku: 'RQ-P2', name: '成品RQ2' } })
    const part = await prisma.part.create({ data: { sku: 'RQ-PART', name: '共用零件', moq: 5000, safetyStock: 200, leadTime: '90天' } })
    // 共用料：挂在两个成品 BOM 里
    await prisma.bom.create({ data: { productId: p1.id, partId: part.id, qty: 2 } })
    await prisma.bom.create({ data: { productId: p2.id, partId: part.id, qty: 1 } })
    await prisma.salesOrderItem.create({ data: { orderId: o1.id, productId: p1.id, qty: 1000, unitPrice: 10 } })
    await prisma.salesOrderItem.create({ data: { orderId: o2.id, productId: p2.id, qty: 1000, unitPrice: 10 } })
    await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'GET', url: '/api/purchasing/requirements?orderIds=' + o1.id + ',' + o2.id, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{
      partId: number; requiredQty: number; onHand: number; gapQty: number; suggestedQty: number
      moq: number | null; safetyStock: number | null; leadTime: string | null; isCommonPart: boolean
    }>
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // 需求 = 2×1000 + 1×1000 = 3000；缺口 = 3000−100 = 2900
    expect(row.requiredQty).toBe(3000)
    expect(row.gapQty).toBe(2900)
    // 安全库存补货：2900 缺口买完库存归零 < 安全线 200 → 补到线 = 3000−100+200 = 3100
    expect(row.suggestedQty).toBe(3100)
    expect(row.moq).toBe(5000)
    expect(row.safetyStock).toBe(200)
    expect(row.leadTime).toBe('90天')
    expect(row.isCommonPart).toBe(true)
  })

  it('采购单状态流转：未下单→已下单→已打印→已回签 单向，只能向后', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商ST' } })
    const part = await prisma.part.create({ data: { sku: 'P-ST', name: '零件ST', supplierId: supplier.id } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'ST-1A', supplierId: supplier.id, items: { create: { partId: part.id, qty: 10, unitPrice: 1 } } },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const go = async (poStatus: string) =>
      app.inject({ method: 'PATCH', url: '/api/purchase-orders/' + po.id + '/status', headers: { cookie }, payload: { poStatus } })
    expect((await go('sent')).statusCode).toBe(200)
    // 不能跳级也不能回退
    expect((await go('confirmed')).statusCode).toBe(400)
    expect((await go('pending')).statusCode).toBe(400)
    expect((await go('printed')).statusCode).toBe(200)
    expect((await go('confirmed')).statusCode).toBe(200)
    // 终点后不能再改
    expect((await go('sent')).statusCode).toBe(400)
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: po.id } })
    expect(saved?.poStatus).toBe('confirmed')
    // 收货进度不受影响
    expect(saved?.status).toBe('open')
  })

  it('改单留历史：未收货可改明细并写 EditLog；有收货后锁定', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商ED' } })
    const part = await prisma.part.create({ data: { sku: 'P-ED', name: '零件ED', supplierId: supplier.id } })
    const part2 = await prisma.part.create({ data: { sku: 'P-ED2', name: '零件ED2', supplierId: supplier.id } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'ED-1A', supplierId: supplier.id, items: { create: { partId: part.id, qty: 10, unitPrice: 1 } } },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'PATCH', url: '/api/purchase-orders/' + po.id, headers: { cookie },
      payload: {
        expectedDeliveryDate: '2026-09-12',
        items: [{ partId: part.id, qty: 20, unitPrice: 1.5 }, { partId: part2.id, qty: 5, unitPrice: 2 }],
      },
    })
    expect(res.statusCode).toBe(200)
    const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { items: true } })
    expect(saved.expectedDeliveryDate).toBe('2026-09-12')
    expect(saved.items.map((i) => i.qty)).toEqual([20, 5])
    const logs = await prisma.purchaseOrderEditLog.findMany({ where: { purchaseOrderId: po.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.beforeJson).toContain('"qty":10')
    // 收货后锁定
    await prisma.receipt.create({ data: { purchaseOrderId: po.id, partId: part.id, qty: 1 } })
    const locked = await app.inject({
      method: 'PATCH', url: '/api/purchase-orders/' + po.id, headers: { cookie },
      payload: { expectedDeliveryDate: '2026-10-01' },
    })
    expect(locked.statusCode).toBe(400)
    expect(locked.json().error).toContain('不能再编辑')
  })

  it('回签件：上传/列表/删除', async () => {
    const supplier = await prisma.supplier.create({ data: { name: '供应商AT' } })
    const part = await prisma.part.create({ data: { sku: 'P-AT', name: '零件AT', supplierId: supplier.id } })
    const po = await prisma.purchaseOrder.create({
      data: { orderNo: 'AT-1A', supplierId: supplier.id, items: { create: { partId: part.id, qty: 10, unitPrice: 1 } } },
    })
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const created = await app.inject({
      method: 'POST', url: '/api/purchase-orders/' + po.id + '/attachments', headers: { cookie },
      payload: { url: '/uploads/po/AT-1A-回签.png', name: '供应商回签扫描件' },
    })
    expect(created.statusCode).toBe(200)
    const attId = (created.json() as { id: number }).id
    const list = await app.inject({ method: 'GET', url: '/api/purchase-orders/' + po.id + '/attachments', headers: { cookie } })
    expect(list.statusCode).toBe(200)
    expect((list.json() as unknown[]).length).toBe(1)
    const del = await app.inject({ method: 'DELETE', url: '/api/purchase-orders/' + po.id + '/attachments/' + attId, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    const list2 = await app.inject({ method: 'GET', url: '/api/purchase-orders/' + po.id + '/attachments', headers: { cookie } })
    expect((list2.json() as unknown[]).length).toBe(0)
  })
})
