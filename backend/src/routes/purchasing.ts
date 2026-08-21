import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { bomExplode, computePurchaseGap } from '../domain/bom'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo } from '../errors'

const purchaseItemSchema = z.object({
  partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
  unitPrice: z.number({ error: '单价必填' }).nonnegative({ error: '单价必须为非负数' }),
})

const createPurchaseOrderSchema = z.object({
  supplierId: z.number({ error: '供应商必填' }).int({ error: '供应商必须为整数' }).positive({ error: '供应商必须为正整数' }),
  salesOrderId: z.number().int().positive().optional(),
  items: z.array(purchaseItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
})

const receiptSchema = z.object({
  purchaseOrderId: z.number({ error: '采购单必填' }).int({ error: '采购单必须为整数' }).positive({ error: '采购单必须为正整数' }),
  items: z.array(
    z.object({
      partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
      qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
    }),
    { error: '明细必填' }
  ).min(1, '收货至少包含一个明细'),
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

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const PURCHASE_ORDER_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  items: {
    include: { part: { select: { id: true, sku: true, name: true, unit: true } } },
    orderBy: { id: 'asc' as const },
  },
  payments: true,
} as const

function utcDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

async function generatePurchaseOrderNo(): Promise<string> {
  const prefix = `PO-${utcDateStamp()}-`
  const count = await prisma.purchaseOrder.count({ where: { orderNo: { startsWith: prefix } } })
  return `${prefix}${String(count + 1).padStart(3, '0')}`
}

export function purchasingRoutes(app: FastifyInstance) {
  // 需求计算：purchase / boss 可查
  app.get('/api/purchasing/requirements', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const raw = (req.query as { orderId?: string }).orderId
    const orderId = Number(raw)
    if (!raw || !Number.isInteger(orderId) || orderId <= 0) {
      return reply.code(400).send({ error: 'orderId 必填且为正整数' })
    }

    const order = await prisma.salesOrder.findUnique({ where: { id: orderId }, include: { items: true } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const productIds = [...new Set(order.items.map((item) => item.productId))]
    const boms = await prisma.bom.findMany({ where: { productId: { in: productIds } } })

    // 跨所有订单明细累加同一零件的 requiredQty
    const requiredMap = new Map<number, number>()
    for (const item of order.items) {
      for (const r of bomExplode(item.productId, item.qty, boms)) {
        requiredMap.set(r.partId, (requiredMap.get(r.partId) ?? 0) + r.requiredQty)
      }
    }
    const requirements = [...requiredMap.entries()].map(([partId, requiredQty]) => ({ partId, requiredQty }))
    const partIds = requirements.map((r) => r.partId)

    const [parts, stocks] = await Promise.all([
      prisma.part.findMany({ where: { id: { in: partIds } } }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
    ])
    const partNameMap = new Map(parts.map((p) => [p.id, p.name]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))
    const gapMap = new Map(computePurchaseGap(requirements, stockMap).map((g) => [g.partId, g.gapQty]))

    return requirements.map((r) => {
      const onHand = stockMap.get(r.partId) ?? 0
      return {
        partId: r.partId,
        partName: partNameMap.get(r.partId) ?? '',
        requiredQty: r.requiredQty,
        onHand,
        gapQty: gapMap.get(r.partId) ?? 0,
      }
    })
  })

  // 采购单列表：5 角色均可查，可选按状态/供应商/销售订单过滤
  app.get('/api/purchase-orders', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const query = req.query as { status?: string; supplierId?: string; salesOrderId?: string }
    const where: { status?: string; supplierId?: number; salesOrderId?: number } = {}
    if (query.status) where.status = query.status
    if (query.supplierId) {
      const supplierId = Number(query.supplierId)
      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return reply.code(400).send({ error: 'supplierId 必须为正整数' })
      }
      where.supplierId = supplierId
    }
    if (query.salesOrderId) {
      const salesOrderId = Number(query.salesOrderId)
      if (!Number.isInteger(salesOrderId) || salesOrderId <= 0) {
        return reply.code(400).send({ error: 'salesOrderId 必须为正整数' })
      }
      where.salesOrderId = salesOrderId
    }

    const rows = await prisma.purchaseOrder.findMany({
      where,
      orderBy: { id: 'desc' as const },
      include: PURCHASE_ORDER_INCLUDE,
    })
    return rows.map((po) => {
      const totalAmount = po.items.reduce((sum, it) => sum + it.qty * it.unitPrice.toNumber(), 0)
      const paidAmount = po.payments.reduce((sum, p) => sum + p.amount.toNumber(), 0)
      return {
        id: po.id,
        orderNo: po.orderNo,
        status: po.status,
        supplierId: po.supplierId,
        supplierName: po.supplier.name,
        salesOrderId: po.salesOrderId,
        createdAt: po.createdAt,
        totalAmount,
        paidAmount,
        outstanding: Math.max(0, totalAmount - paidAmount),
        items: po.items.map((it) => ({
          id: it.id,
          partId: it.partId,
          sku: it.part.sku,
          name: it.part.name,
          unit: it.part.unit,
          qty: it.qty,
          unitPrice: it.unitPrice.toNumber(),
        })),
      }
    })
  })

  // 采购单：仅 purchase 可创建
  app.post('/api/purchase-orders', { preHandler: requireRole('purchase') }, async (req, reply) => {
    const data = parseBody(createPurchaseOrderSchema, req.body, reply)
    if (data === null) return

    const orderNo = await generatePurchaseOrderNo()
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: { orderNo, supplierId: data.supplierId, salesOrderId: data.salesOrderId ?? null },
      })
      for (const item of data.items) {
        await tx.purchaseOrderItem.create({
          data: { purchaseOrderId: created.id, partId: item.partId, qty: item.qty, unitPrice: item.unitPrice },
        })
      }
      return tx.purchaseOrder.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          items: {
            include: { part: { select: { id: true, sku: true, name: true } } },
            orderBy: { id: 'asc' as const },
          },
        },
      })
    })

    return reply.code(200).send(order)
  })

  // 收货：仅 warehouse 可操作，事务内写 Receipt 并入库
  app.post('/api/receipts', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(receiptSchema, req.body, reply)
    if (data === null) return

    try {
      await prisma.$transaction(async (tx) => {
        for (const item of data.items) {
          const receipt = await tx.receipt.create({
            data: { purchaseOrderId: data.purchaseOrderId, partId: item.partId, qty: item.qty },
          })
          await applyStockChange(tx, 'part', item.partId, item.qty, 'receipt', receipt.id)
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '收货失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '收货失败：' + message })
    }

    return reply.code(200).send({ ok: true })
  })
}
