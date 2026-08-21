import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo } from '../errors'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const issueItemSchema = z.object({
  partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
})

const issueSchema = z.object({
  salesOrderId: z.number({ error: '订单必填' }).int({ error: '订单必须为整数' }).positive({ error: '订单必须为正整数' }),
  issuedBy: z.string({ error: '领料人必填' }).min(1, '领料人必填'),
  items: z.array(issueItemSchema, { error: '明细必填' }).min(1, '领料至少包含一个明细'),
  note: z.string().optional(),
})

const productionEntrySchema = z.object({
  salesOrderId: z.number({ error: '订单必填' }).int({ error: '订单必须为整数' }).positive({ error: '订单必须为正整数' }),
  productId: z.number({ error: '成品必填' }).int({ error: '成品必须为整数' }).positive({ error: '成品必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
  entryDate: z
    .string({ error: '入库日期必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '入库日期必须为合法日期')
    .optional(),
})

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}

export function inventoryRoutes(app: FastifyInstance) {
  // 领料出库：仅 warehouse
  app.post('/api/issues', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(issueSchema, req.body, reply)
    if (data === null) return

    try {
      const issues = await prisma.$transaction(async (tx) => {
        const created: { id: number; partId: number; qty: number }[] = []
        for (const item of data.items) {
          const issue = await tx.issue.create({
            data: {
              salesOrderId: data.salesOrderId,
              partId: item.partId,
              qty: item.qty,
              issuedBy: data.issuedBy,
              ...(data.note !== undefined && data.note !== '' ? { note: data.note } : {}),
            },
          })
          await applyStockChange(tx, 'part', item.partId, -item.qty, 'issue', issue.id, data.salesOrderId)
          created.push({ id: issue.id, partId: item.partId, qty: item.qty })
        }
        return created
      })
      return reply.code(200).send({ ok: true, issues })
    } catch (err) {
      const message = err instanceof Error ? err.message : '领料失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '领料失败：' + message })
    }
  })

  // 成品入库：仅 warehouse
  app.post('/api/production-entries', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(productionEntrySchema, req.body, reply)
    if (data === null) return

    try {
      const entry = await prisma.$transaction(async (tx) => {
        const created = await tx.productionEntry.create({
          data: {
            salesOrderId: data.salesOrderId,
            productId: data.productId,
            qty: data.qty,
            ...(data.entryDate ? { entryDate: new Date(data.entryDate) } : {}),
          },
        })
        await applyStockChange(tx, 'product', data.productId, data.qty, 'production', created.id, data.salesOrderId)
        return created
      })
      return reply.code(200).send(entry)
    } catch (err) {
      const message = err instanceof Error ? err.message : '成品入库失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '成品入库失败：' + message })
    }
  })

  // 库存列表：5 角色均可查
  app.get('/api/stock', { preHandler: requireRole(...ALL_ROLES) }, async (req) => {
    const query = req.query as { itemType?: string; keyword?: string }
    const where: { itemType?: string } = {}
    if (query.itemType) where.itemType = query.itemType

    const stocks = await prisma.stock.findMany({
      where,
      orderBy: [{ itemType: 'asc' }, { itemId: 'asc' }],
    })

    const partIds = stocks.filter((s) => s.itemType === 'part').map((s) => s.itemId)
    const productIds = stocks.filter((s) => s.itemType === 'product').map((s) => s.itemId)

    const [parts, products] = await Promise.all([
      prisma.part.findMany({ where: { id: { in: partIds } } }),
      prisma.product.findMany({ where: { id: { in: productIds } } }),
    ])
    const partNameMap = new Map(parts.map((p) => [p.id, p.name]))
    const productNameMap = new Map(products.map((p) => [p.id, p.name]))

    let rows = stocks.map((s) => ({
      itemType: s.itemType,
      itemId: s.itemId,
      name: s.itemType === 'part' ? (partNameMap.get(s.itemId) ?? '') : (productNameMap.get(s.itemId) ?? ''),
      qtyOnHand: s.qtyOnHand,
    }))

    if (query.keyword) {
      const kw = query.keyword
      rows = rows.filter((r) => r.name.includes(kw))
    }
    return rows
  })

  // 出入库流水：5 角色均可查，按时间升序（早→晚）
  app.get('/api/stock/ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = req.query as { itemType?: string; itemId?: string }
    const itemType = raw.itemType
    const itemId = Number(raw.itemId)
    if (!itemType || !raw.itemId || !Number.isInteger(itemId) || itemId <= 0) {
      return reply.code(400).send({ error: 'itemType 与 itemId 必填且 itemId 为正整数' })
    }
    return prisma.inventoryLedger.findMany({
      where: { itemType, itemId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    })
  })

  // 订单物料计算：按销售订单号统计零件需求、已出库、差值（参考用户 Excel 布局）
  app.get('/api/inventory/order-materials', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const raw = (req.query as { orderNo?: string }).orderNo
    if (!raw || !raw.trim()) {
      return reply.code(400).send({ error: 'orderNo 必填' })
    }
    const orderNo = raw.trim()

    const order = await prisma.salesOrder.findUnique({ where: { orderNo }, include: { items: true } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const totalOrderQty = order.items.reduce((sum, it) => sum + it.qty, 0)
    const productIds = [...new Set(order.items.map((it) => it.productId))]
    const boms = await prisma.bom.findMany({ where: { productId: { in: productIds } } })

    const requiredMap = new Map<number, number>()
    for (const item of order.items) {
      for (const b of boms) {
        if (b.productId !== item.productId) continue
        requiredMap.set(b.partId, (requiredMap.get(b.partId) ?? 0) + b.qty * item.qty)
      }
    }
    const partIds = [...requiredMap.keys()]

    const [parts, issueGroups] = await Promise.all([
      prisma.part.findMany({
        where: { id: { in: partIds } },
        include: { supplier: { select: { name: true } } },
      }),
      prisma.issue.groupBy({
        by: ['partId'],
        where: { salesOrderId: order.id, partId: { in: partIds } },
        _sum: { qty: true },
      }),
    ])

    const issueMap = new Map(issueGroups.map((g) => [g.partId, g._sum.qty ?? 0]))
    const items = parts.map((part, index) => {
      const requiredQty = requiredMap.get(part.id) ?? 0
      const issuedQty = issueMap.get(part.id) ?? 0
      return {
        seq: index + 1,
        partId: part.id,
        sku: part.sku,
        name: part.name,
        imageUrl: part.imageUrl ?? '',
        supplierName: part.supplier?.name ?? '',
        spec: part.spec ?? '',
        unit: part.unit,
        usage: totalOrderQty > 0 ? requiredQty / totalOrderQty : 0,
        requiredQty,
        issuedQty,
        variance: issuedQty - requiredQty,
      }
    })

    return { orderNo: order.orderNo, orderQty: totalOrderQty, items }
  })

  // 订单流水：按销售订单号查询该订单全部出入库流水，并汇总出库数量
  app.get('/api/inventory/order-ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = (req.query as { orderNo?: string }).orderNo
    if (!raw || !raw.trim()) {
      return reply.code(400).send({ error: 'orderNo 必填' })
    }
    const orderNo = raw.trim()

    const order = await prisma.salesOrder.findUnique({ where: { orderNo }, select: { id: true, orderNo: true } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const rows = await prisma.inventoryLedger.findMany({
      where: { salesOrderId: order.id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    })

    const partIds = [...new Set(rows.filter((r) => r.itemType === 'part').map((r) => r.itemId))]
    const productIds = [...new Set(rows.filter((r) => r.itemType === 'product').map((r) => r.itemId))]
    const [parts, products] = await Promise.all([
      prisma.part.findMany({ where: { id: { in: partIds } } }),
      prisma.product.findMany({ where: { id: { in: productIds } } }),
    ])
    const partNameMap = new Map(parts.map((p) => [p.id, p.name + '（' + p.sku + '）']))
    const productNameMap = new Map(products.map((p) => [p.id, p.name + '（' + p.sku + '）']))

    const totalOutboundQty = rows.reduce((sum, r) => sum + (r.delta < 0 ? -r.delta : 0), 0)
    return {
      orderNo: order.orderNo,
      totalOutboundQty,
      rows: rows.map((r) => ({
        id: r.id,
        itemType: r.itemType,
        itemId: r.itemId,
        itemName: r.itemType === 'part' ? (partNameMap.get(r.itemId) ?? '') : (productNameMap.get(r.itemId) ?? ''),
        delta: r.delta,
        balance: r.balance,
        refType: r.refType,
        refId: r.refId,
        at: r.at,
        orderNo: order.orderNo,
      })),
    }
  })

  // 采购单流水：按采购单号查询每个零件的收货情况
  app.get('/api/inventory/po-ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = (req.query as { purchaseOrderNo?: string }).purchaseOrderNo
    if (!raw || !raw.trim()) {
      return reply.code(400).send({ error: 'purchaseOrderNo 必填' })
    }
    const purchaseOrderNo = raw.trim()

    const po = await prisma.purchaseOrder.findUnique({
      where: { orderNo: purchaseOrderNo },
      include: {
        supplier: { select: { name: true } },
        items: {
          include: { part: { select: { id: true, sku: true, name: true } } },
          orderBy: { partId: 'asc' as const },
        },
      },
    })
    if (!po) return reply.code(404).send({ error: '采购单不存在' })

    const partIds = po.items.map((item) => item.partId)
    const [receiptGroups, stocks] = await Promise.all([
      prisma.receipt.groupBy({
        by: ['partId'],
        where: { purchaseOrderId: po.id, partId: { in: partIds } },
        _sum: { qty: true },
      }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
    ])
    const receivedMap = new Map(receiptGroups.map((g) => [g.partId, g._sum.qty ?? 0]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))

    const items = po.items.map((item, index) => {
      const requiredQty = item.qty
      const receivedQty = receivedMap.get(item.partId) ?? 0
      return {
        seq: index + 1,
        partId: item.partId,
        sku: item.part.sku,
        name: item.part.name,
        requiredQty,
        receivedQty,
        outstanding: Math.max(0, requiredQty - receivedQty),
        balance: stockMap.get(item.partId) ?? 0,
      }
    })

    return { purchaseOrderNo: po.orderNo, supplierName: po.supplier.name, items }
  })
}
