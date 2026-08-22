import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'
import { __resetLoginRateLimit } from '../routes/auth'

const DAY = 86_400_000

describe('hardening（加固回归）', () => {
  beforeEach(async () => {
    await resetDb()
    __resetLoginRateLimit()
  })

  describe('A1 库存原子增减', () => {
    it('无库存行时首笔收货创建行，多笔收货余额连续累加', async () => {
      const supplier = await prisma.supplier.create({ data: { name: '供应商-H1' } })
      const part = await prisma.part.create({ data: { sku: 'P-H1', name: '零件H1' } })
      const po = await prisma.purchaseOrder.create({
        data: { orderNo: 'PO-H1', supplierId: supplier.id, items: { create: { partId: part.id, qty: 100, unitPrice: 1 } } },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')
      const first = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 30 }] },
      })
      expect(first.statusCode).toBe(200)
      const second = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: part.id, qty: 20 }] },
      })
      expect(second.statusCode).toBe(200)
      const stock = await prisma.stock.findUnique({ where: { itemType_itemId: { itemType: 'part', itemId: part.id } } })
      expect(stock?.qtyOnHand).toBe(50)
      const ledgers = await prisma.inventoryLedger.findMany({ where: { itemId: part.id }, orderBy: { id: 'asc' } })
      expect(ledgers.map((l) => l.balance)).toEqual([30, 50])
    })
  })

  describe('A2 状态机与出货', () => {
    it('PATCH 不能把 ready 直接置为 shipped；销售也不能回退运作中订单', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-H2' } })
      const product = await prisma.product.create({ data: { sku: 'F-H2', name: '成品H2' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-H2', customerId: customer.id, deliveryDate: new Date(), status: 'ready',
          items: { create: { productId: product.id, qty: 1, unitPrice: 1 } },
        },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'sales')
      const toShipped = await app.inject({
        method: 'PATCH', url: '/api/orders/' + order.id + '/status', headers: { cookie },
        payload: { status: 'shipped' },
      })
      expect(toShipped.statusCode).toBe(400)
      const salesRollback = await app.inject({
        method: 'PATCH', url: '/api/orders/' + order.id + '/status', headers: { cookie },
        payload: { status: 'in_production' },
      })
      expect(salesRollback.statusCode).toBe(400)
      const bossCookie = await loginCookie(app, 'boss')
      const bossRollback = await app.inject({
        method: 'PATCH', url: '/api/orders/' + order.id + '/status', headers: { cookie: bossCookie },
        payload: { status: 'confirmed' },
      })
      expect(bossRollback.statusCode).toBe(200)
    })
  })

  describe('A3 收货业务校验', () => {
    it('收非本单零件 / 超订购量 / 不良品超量均被拒绝，状态随收货更新', async () => {
      const supplier = await prisma.supplier.create({ data: { name: '供应商-H3' } })
      const partA = await prisma.part.create({ data: { sku: 'P-H3A', name: '零件H3A' } })
      const partB = await prisma.part.create({ data: { sku: 'P-H3B', name: '零件H3B' } })
      const po = await prisma.purchaseOrder.create({
        data: { orderNo: 'PO-H3', supplierId: supplier.id, items: { create: { partId: partA.id, qty: 100, unitPrice: 1 } } },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')

      const wrongPart = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partB.id, qty: 1 }] },
      })
      expect(wrongPart.statusCode).toBe(400)
      expect(wrongPart.json().error).toContain('不在该采购单')

      const over = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partA.id, qty: 101 }] },
      })
      expect(over.statusCode).toBe(400)
      expect(over.json().error).toContain('超过订购数量')

      const badDefective = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partA.id, qty: 10, defectiveQty: 11 }] },
      })
      expect(badDefective.statusCode).toBe(400)
      expect(badDefective.json().error).toContain('不良品')

      const partial = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partA.id, qty: 60 }] },
      })
      expect(partial.statusCode).toBe(200)
      let poRow = await prisma.purchaseOrder.findUnique({ where: { id: po.id } })
      expect(poRow?.status).toBe('partial')

      const rest = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partA.id, qty: 40 }] },
      })
      expect(rest.statusCode).toBe(200)
      poRow = await prisma.purchaseOrder.findUnique({ where: { id: po.id } })
      expect(poRow?.status).toBe('received')

      const overAfter = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie },
        payload: { purchaseOrderId: po.id, items: [{ partId: partA.id, qty: 1 }] },
      })
      expect(overAfter.statusCode).toBe(400)
      expect(overAfter.json().error).toContain('超过订购数量')
    })
  })

  describe('A4 手工建采购单', () => {
    it('零件供应商与采购单供应商不一致或明细重复返回 400', async () => {
      const s1 = await prisma.supplier.create({ data: { name: '供应商-H4A' } })
      const s2 = await prisma.supplier.create({ data: { name: '供应商-H4B' } })
      const part = await prisma.part.create({ data: { sku: 'P-H4', name: '零件H4', supplierId: s1.id } })
      const app = buildApp()
      const cookie = await loginCookie(app, 'purchase')

      const mismatch = await app.inject({
        method: 'POST', url: '/api/purchase-orders', headers: { cookie },
        payload: { supplierId: s2.id, items: [{ partId: part.id, qty: 1, unitPrice: 1 }] },
      })
      expect(mismatch.statusCode).toBe(400)
      expect(mismatch.json().error).toContain('供应商')

      const dup = await app.inject({
        method: 'POST', url: '/api/purchase-orders', headers: { cookie },
        payload: {
          supplierId: s1.id,
          items: [
            { partId: part.id, qty: 1, unitPrice: 1 },
            { partId: part.id, qty: 2, unitPrice: 1 },
          ],
        },
      })
      expect(dup.statusCode).toBe(400)
      expect(dup.json().error).toContain('重复')
    })
  })

  describe('A5 领料/成品入库订单约束', () => {
    it('draft 订单不能领料，非 BOM 零件不能领料', async () => {
      const product = await prisma.product.create({ data: { sku: 'F-H5', name: '成品H5' } })
      const partA = await prisma.part.create({ data: { sku: 'P-H5A', name: '零件H5A' } })
      const partB = await prisma.part.create({ data: { sku: 'P-H5B', name: '零件H5B' } })
      await prisma.bom.create({ data: { productId: product.id, partId: partA.id, qty: 1 } })
      await prisma.stock.createMany({
        data: [
          { itemType: 'part', itemId: partA.id, qtyOnHand: 100 },
          { itemType: 'part', itemId: partB.id, qtyOnHand: 100 },
        ],
      })
      const customer = await prisma.customer.create({ data: { name: '客户-H5' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-H5', customerId: customer.id, deliveryDate: new Date('2026-09-30'),
          status: 'draft',
          items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
        },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')

      const onDraft = await app.inject({
        method: 'POST', url: '/api/issues', headers: { cookie },
        payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: partA.id, qty: 1 }] },
      })
      expect(onDraft.statusCode).toBe(400)
      expect(onDraft.json().error).toContain('不能领料')

      await prisma.salesOrder.update({ where: { id: order.id }, data: { status: 'in_production' } })
      const notInBom = await app.inject({
        method: 'POST', url: '/api/issues', headers: { cookie },
        payload: { salesOrderId: order.id, issuedBy: '组长', items: [{ partId: partB.id, qty: 1 }] },
      })
      expect(notInBom.statusCode).toBe(400)
      expect(notInBom.json().error).toContain('不在该订单的 BOM')
    })

    it('成品不属于订单明细或订单未到生产状态不能入库', async () => {
      const product = await prisma.product.create({ data: { sku: 'F-H6', name: '成品H6' } })
      const other = await prisma.product.create({ data: { sku: 'F-H6X', name: '无关成品' } })
      const customer = await prisma.customer.create({ data: { name: '客户-H6' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-H6', customerId: customer.id, deliveryDate: new Date('2026-09-30'),
          status: 'in_production',
          items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
        },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')

      const wrongProduct = await app.inject({
        method: 'POST', url: '/api/production-entries', headers: { cookie },
        payload: { salesOrderId: order.id, productId: other.id, qty: 1 },
      })
      expect(wrongProduct.statusCode).toBe(400)
      expect(wrongProduct.json().error).toContain('不在所选订单')

      await prisma.salesOrder.update({ where: { id: order.id }, data: { status: 'draft' } })
      const onDraft = await app.inject({
        method: 'POST', url: '/api/production-entries', headers: { cookie },
        payload: { salesOrderId: order.id, productId: product.id, qty: 1 },
      })
      expect(onDraft.statusCode).toBe(400)
      expect(onDraft.json().error).toContain('不能成品入库')
    })
  })

  describe('B2 数值上界', () => {
    it('订单单价/数量超界返回 400 而非 500', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-H7' } })
      const product = await prisma.product.create({ data: { sku: 'F-H7', name: '成品H7' } })
      const app = buildApp()
      const cookie = await loginCookie(app, 'sales')
      const res = await app.inject({
        method: 'POST', url: '/api/orders', headers: { cookie },
        payload: {
          customerId: customer.id,
          deliveryDate: '2026-09-30',
          items: [{ productId: product.id, qty: 1, unitPrice: 1e12 }],
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toContain('超出允许范围')
    })

    it('收付款金额超界返回 400', async () => {
      const app = buildApp()
      const cookie = await loginCookie(app, 'finance')
      const res = await app.inject({
        method: 'POST', url: '/api/supplier-payments', headers: { cookie },
        payload: { supplierId: 1, amount: 1e12 },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('B3 登录校验与限流', () => {
    it('缺 password 返回 401 而非 500', async () => {
      const app = buildApp()
      const res = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'boss' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('连续失败 5 次后锁定返回 429', async () => {
      const app = buildApp()
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: 'wrong' },
        })
        expect(res.statusCode).toBe(401)
      }
      const fifth = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: 'wrong' },
      })
      expect(fifth.statusCode).toBe(429)
      const locked = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: '88888888' },
      })
      expect(locked.statusCode).toBe(429)
      expect(locked.json().error).toContain('尝试次数过多')
      __resetLoginRateLimit()
    })
  })

  describe('B4 收付款归属', () => {
    it('付款挂错采购单/收款挂错订单返回 400', async () => {
      const s1 = await prisma.supplier.create({ data: { name: '供应商-H8A' } })
      const s2 = await prisma.supplier.create({ data: { name: '供应商-H8B' } })
      const c1 = await prisma.customer.create({ data: { name: '客户-H8A' } })
      const c2 = await prisma.customer.create({ data: { name: '客户-H8B' } })
      const part = await prisma.part.create({ data: { sku: 'P-H8', name: '零件H8' } })
      const product = await prisma.product.create({ data: { sku: 'F-H8', name: '成品H8' } })
      const po = await prisma.purchaseOrder.create({
        data: { orderNo: 'PO-H8', supplierId: s1.id, items: { create: { partId: part.id, qty: 1, unitPrice: 1 } } },
      })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-H8', customerId: c1.id, deliveryDate: new Date('2026-09-30'),
          items: { create: { productId: product.id, qty: 1, unitPrice: 1 } },
        },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'finance')

      const badPo = await app.inject({
        method: 'POST', url: '/api/supplier-payments', headers: { cookie },
        payload: { supplierId: s2.id, purchaseOrderId: po.id, amount: 1 },
      })
      expect(badPo.statusCode).toBe(400)
      expect(badPo.json().error).toContain('不属于所选供应商')

      const badOrder = await app.inject({
        method: 'POST', url: '/api/customer-payments', headers: { cookie },
        payload: { customerId: c2.id, salesOrderId: order.id, amount: 1 },
      })
      expect(badOrder.statusCode).toBe(400)
      expect(badOrder.json().error).toContain('不属于所选客户')
    })
  })

  describe('B5 /auth/me 用户被删', () => {
    it('用户被删除后 /me 返回 401', async () => {
      const app = buildApp()
      const cookie = await loginCookie(app, 'finance')
      await prisma.user.delete({ where: { username: 'finance' } })
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
      expect(me.statusCode).toBe(401)
    })
  })

  describe('B6 分页参数严格解析', () => {
    it('page=1e2 或 page=0 返回 400', async () => {
      const app = buildApp()
      const cookie = await loginCookie(app, 'boss')
      for (const q of ['page=1e2', 'page=0', 'pageSize=2.5']) {
        const res = await app.inject({ method: 'GET', url: '/api/orders?' + q, headers: { cookie } })
        expect(res.statusCode, q).toBe(400)
      }
    })
  })

  describe('B7 库存查询枚举与严格 ID', () => {
    it('itemType 非法或 itemId 宽松写法返回 400', async () => {
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')
      const badType = await app.inject({ method: 'GET', url: '/api/stock?itemType=bogus', headers: { cookie } })
      expect(badType.statusCode).toBe(400)
      const looseId = await app.inject({
        method: 'GET', url: '/api/stock/ledger?itemType=part&itemId=1e3', headers: { cookie },
      })
      expect(looseId.statusCode).toBe(400)
    })
  })

  describe('B8 退补货校验', () => {
    it('退货与补货数量均为 0 或供应商不匹配返回 400', async () => {
      const s1 = await prisma.supplier.create({ data: { name: '供应商-H9A' } })
      const s2 = await prisma.supplier.create({ data: { name: '供应商-H9B' } })
      const part = await prisma.part.create({ data: { sku: 'P-H9', name: '零件H9', supplierId: s1.id } })
      await prisma.stock.create({ data: { itemType: 'part', itemId: part.id, qtyOnHand: 100 } })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')

      const empty = await app.inject({
        method: 'POST', url: '/api/return-replenishments', headers: { cookie },
        payload: { partId: part.id, supplierId: s1.id, returnQty: 0, replenishQty: 0 },
      })
      expect(empty.statusCode).toBe(400)
      expect(empty.json().error).toContain('至少')

      const mismatch = await app.inject({
        method: 'POST', url: '/api/return-replenishments', headers: { cookie },
        payload: { partId: part.id, supplierId: s2.id, returnQty: 1 },
      })
      expect(mismatch.statusCode).toBe(400)
      expect(mismatch.json().error).toContain('不匹配')
    })
  })

  describe('B9 工程不可写零件供应商', () => {
    it('engineer 创建/修改零件带 supplierId 返回 400', async () => {
      const supplier = await prisma.supplier.create({ data: { name: '供应商-H10' } })
      const app = buildApp()
      const cookie = await loginCookie(app, 'engineer')

      const create = await app.inject({
        method: 'POST', url: '/api/parts', headers: { cookie },
        payload: { sku: 'P-H10', name: '零件H10', supplierId: supplier.id },
      })
      expect(create.statusCode).toBe(400)
      expect(create.json().error).toContain('供应商')

      const part = await prisma.part.create({ data: { sku: 'P-H10B', name: '零件H10B' } })
      const update = await app.inject({
        method: 'PUT', url: '/api/parts/' + part.id, headers: { cookie },
        payload: { sku: 'P-H10B', name: '零件H10B', supplierId: supplier.id },
      })
      expect(update.statusCode).toBe(400)
      expect(update.json().error).toContain('供应商')
    })
  })

  describe('阶段机（采购中/生产中）', () => {
    it('生成采购单点亮采购中；全部收货后熄灭并自动推进待出货', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-PH' } })
      const product = await prisma.product.create({ data: { sku: 'F-PH', name: '成品PH' } })
      const part = await prisma.part.create({ data: { sku: 'P-PH', name: '零件PH' } })
      const supplier = await prisma.supplier.create({ data: { name: '供应商-PH' } })
      await prisma.part.update({ where: { id: part.id }, data: { supplierId: supplier.id } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-PH', customerId: customer.id, deliveryDate: new Date('2026-09-30'),
          status: 'confirmed',
          items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
        },
      })
      const app = buildApp()
      const purchaseCookie = await loginCookie(app, 'purchase')
      const po = await app.inject({
        method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchaseCookie },
        payload: { supplierId: supplier.id, salesOrderId: order.id, items: [{ partId: part.id, qty: 10, unitPrice: 1 }] },
      })
      expect(po.statusCode).toBe(200)
      const afterPo = await prisma.salesOrder.findUnique({ where: { id: order.id } })
      expect(afterPo?.purchasing).toBe(true)
      expect(afterPo?.status).toBe('in_production')

      const warehouseCookie = await loginCookie(app, 'warehouse')
      const receipt = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { cookie: warehouseCookie },
        payload: { purchaseOrderId: po.json().id, items: [{ partId: part.id, qty: 10 }] },
      })
      expect(receipt.statusCode).toBe(200)
      const afterReceipt = await prisma.salesOrder.findUnique({ where: { id: order.id } })
      expect(afterReceipt?.purchasing).toBe(false)
      expect(afterReceipt?.status).toBe('ready') // 采购完成且生产未开始 → 待出货
    })

    it('成品入库点亮生产中，收满后熄灭；采购+生产都完成自动待出货', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-PR' } })
      const product = await prisma.product.create({ data: { sku: 'F-PR', name: '成品PR' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-PR', customerId: customer.id, deliveryDate: new Date('2026-09-30'),
          status: 'in_production', purchasing: true,
          items: { create: { productId: product.id, qty: 10, unitPrice: 5 } },
        },
      })
      const app = buildApp()
      const cookie = await loginCookie(app, 'warehouse')
      const partial = await app.inject({
        method: 'POST', url: '/api/production-entries', headers: { cookie },
        payload: { salesOrderId: order.id, productId: product.id, qty: 4 },
      })
      expect(partial.statusCode).toBe(200)
      let row = await prisma.salesOrder.findUnique({ where: { id: order.id } })
      expect(row?.producing).toBe(true)
      expect(row?.status).toBe('in_production')

      // 采购中且未收满 → 仍是运作中
      const full = await app.inject({
        method: 'POST', url: '/api/production-entries', headers: { cookie },
        payload: { salesOrderId: order.id, productId: product.id, qty: 6 },
      })
      expect(full.statusCode).toBe(200)
      row = await prisma.salesOrder.findUnique({ where: { id: order.id } })
      expect(row?.producing).toBe(false)
      expect(row?.status).toBe('in_production')

      // 采购也完成 → 自动待出货
      await prisma.salesOrder.update({ where: { id: order.id }, data: { purchasing: false, status: 'in_production' } })
      const extra = await app.inject({
        method: 'POST', url: '/api/production-entries', headers: { cookie },
        payload: { salesOrderId: order.id, productId: product.id, qty: 1 },
      })
      expect(extra.statusCode).toBe(200)
      row = await prisma.salesOrder.findUnique({ where: { id: order.id } })
      expect(row?.producing).toBe(false)
      expect(row?.status).toBe('ready')
    })
  })

  describe('销售单价可见性', () => {
    it('purchase/warehouse/engineer 看不到销售单价，sales/boss 可以看到', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-PRC' } })
      const product = await prisma.product.create({ data: { sku: 'F-PRC', name: '成品PRC' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-PRC', customerId: customer.id, deliveryDate: new Date('2026-09-30'),
          status: 'confirmed',
          items: { create: { productId: product.id, qty: 2, unitPrice: 99.5 } },
        },
      })
      const app = buildApp()
      const salesCookie = await loginCookie(app, 'sales')
      const salesDetail = await app.inject({ method: 'GET', url: '/api/orders/' + order.id, headers: { cookie: salesCookie } })
      expect(salesDetail.json().items[0].unitPrice).toBe('99.5')
      for (const role of ['purchase', 'warehouse'] as const) {
        const cookie = await loginCookie(app, role)
        const detail = await app.inject({ method: 'GET', url: '/api/orders/' + order.id, headers: { cookie } })
        expect(detail.statusCode).toBe(200)
        expect(detail.json().items[0].unitPrice).toBeUndefined()
      }
    })
  })

  describe('B10 账期余额口径', () => {
    it('应收/应付扣除已收/已付', async () => {
      const customer = await prisma.customer.create({ data: { name: '客户-H11' } })
      const product = await prisma.product.create({ data: { sku: 'F-H11', name: '成品H11' } })
      const part = await prisma.part.create({ data: { sku: 'P-H11', name: '零件H11' } })
      const supplier = await prisma.supplier.create({ data: { name: '供应商-H11' } })
      const order = await prisma.salesOrder.create({
        data: {
          orderNo: 'SO-H11', customerId: customer.id, deliveryDate: new Date(),
          items: { create: { productId: product.id, qty: 3, unitPrice: 40 } },
        },
      })
      await prisma.shipment.create({ data: { salesOrderId: order.id, shippedAt: new Date(Date.now() - 58 * DAY) } })
      await prisma.customerPayment.create({ data: { customerId: customer.id, salesOrderId: order.id, amount: 50 } })
      const po = await prisma.purchaseOrder.create({
        data: {
          orderNo: 'PO-H11', supplierId: supplier.id, salesOrderId: order.id,
          createdAt: new Date(Date.now() - 28 * DAY),
          items: { create: { partId: part.id, qty: 5, unitPrice: 10 } },
        },
      })
      await prisma.supplierPayment.create({ data: { supplierId: supplier.id, purchaseOrderId: po.id, amount: 20 } })

      const app = buildApp()
      const cookie = await loginCookie(app, 'finance')
      const res = await app.inject({ method: 'GET', url: '/api/finance/due?days=60', headers: { cookie } })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      const recv = body.receivable.find((r: any) => r.orderNo === 'SO-H11')
      expect(recv).toBeDefined()
      expect(recv.amount).toBe(70) // 120 - 50
      const pay = body.payable.find((p: any) => p.orderNo === 'PO-H11')
      expect(pay).toBeDefined()
      expect(pay.amount).toBe(30) // 50 - 20
    })
  })
})
