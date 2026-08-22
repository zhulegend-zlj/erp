import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { bomExplode, computePurchaseGap } from '../domain/bom'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo } from '../errors'
import { parsePagination, pagedResult } from '../pagination'

const purchaseItemSchema = z.object({
  partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
  qty: z
    .number({ error: '数量必填' })
    .int({ error: '数量必须为整数' })
    .positive({ error: '数量必须为正整数' })
    .max(2147483647, { error: '数量超出允许范围' }),
  unitPrice: z
    .number({ error: '单价必填' })
    .nonnegative({ error: '单价必须为非负数' })
    .max(9999999999.99, { error: '单价超出允许范围' }),
})

const createPurchaseOrderSchema = z.object({
  supplierId: z.number({ error: '供应商必填' }).int({ error: '供应商必须为整数' }).positive({ error: '供应商必须为正整数' }),
  salesOrderId: z.number().int().positive().optional(),
  items: z.array(purchaseItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
})

const batchPurchaseOrderSchema = z.object({
  salesOrderId: z.number().int().positive().optional(),
  items: z.array(purchaseItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
})

const receiptSchema = z.object({
  purchaseOrderId: z.number({ error: '采购单必填' }).int({ error: '采购单必须为整数' }).positive({ error: '采购单必须为正整数' }),
  items: z.array(
    z
      .object({
        partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
        qty: z
          .number({ error: '数量必填' })
          .int({ error: '数量必须为整数' })
          .positive({ error: '数量必须为正整数' })
          .max(2147483647, { error: '数量超出允许范围' }),
        lotNo: z.string().nullable().optional(),
        qcStatus: z.string().nullable().optional(),
        defectiveQty: z.number({ error: '不良品数量必须为整数' }).int().nonnegative().nullable().optional(),
      })
      .refine((v) => (v.defectiveQty ?? 0) <= v.qty, {
        message: '不良品数量不能大于收货数量',
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

async function generatePurchaseOrderNoFor(tx: Prisma.TransactionClient): Promise<string> {
  const prefix = `PO-${utcDateStamp()}-`
  const count = await tx.purchaseOrder.count({ where: { orderNo: { startsWith: prefix } } })
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
      prisma.part.findMany({
        where: { id: { in: partIds } },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
    ])
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))
    const gapMap = new Map(computePurchaseGap(requirements, stockMap).map((g) => [g.partId, g.gapQty]))

    return requirements.map((r) => {
      const part = partMap.get(r.partId)
      const onHand = stockMap.get(r.partId) ?? 0
      return {
        partId: r.partId,
        sku: part?.sku ?? '',
        partName: part?.name ?? '',
        supplierId: part?.supplierId ?? null,
        supplierName: part?.supplier?.name ?? '',
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

    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })

    const toRow = (po: Prisma.PurchaseOrderGetPayload<{ include: typeof PURCHASE_ORDER_INCLUDE }>) => {
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
    }

    const orderBy = { id: 'desc' as const }
    if (pagination.kind === 'none') {
      const rows = await prisma.purchaseOrder.findMany({ where, orderBy, include: PURCHASE_ORDER_INCLUDE })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        orderBy,
        include: PURCHASE_ORDER_INCLUDE,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.purchaseOrder.count({ where }),
    ])
    return pagedResult(rows.map(toRow), total, page)
  })

  // 采购单：仅 purchase 可创建
  app.post('/api/purchase-orders', { preHandler: requireRole('purchase') }, async (req, reply) => {
    const data = parseBody(createPurchaseOrderSchema, req.body, reply)
    if (data === null) return

    // 明细去重 + 零件必须属于所选供应商（与批量按供应商分组的口径一致，防发错供应商）
    const partIds = [...new Set(data.items.map((item) => item.partId))]
    if (partIds.length !== data.items.length) {
      return reply.code(400).send({ error: '采购单明细不能重复' })
    }
    const parts = await prisma.part.findMany({
      where: { id: { in: partIds } },
      select: { id: true, name: true, supplierId: true },
    })
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const missing = data.items.filter((item) => !partMap.has(item.partId))
    if (missing.length > 0) {
      return reply.code(400).send({ error: '采购单包含不存在的零件' })
    }
    const mismatched = data.items.filter((item) => partMap.get(item.partId)!.supplierId !== data.supplierId)
    if (mismatched.length > 0) {
      const names = mismatched.map((item) => partMap.get(item.partId)!.name || String(item.partId)).join('、')
      return reply.code(400).send({ error: '零件「' + names + '」的供应商不是所选供应商，请先在零件资料中挂好供应商' })
    }

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

  // 批量生成采购单：按零件供应商自动分组，每组一张采购单
  app.post('/api/purchase-orders/batch', { preHandler: requireRole('purchase') }, async (req, reply) => {
    const data = parseBody(batchPurchaseOrderSchema, req.body, reply)
    if (data === null) return

    const partIds = [...new Set(data.items.map((item) => item.partId))]
    if (partIds.length !== data.items.length) {
      return reply.code(400).send({ error: '采购明细不能重复' })
    }
    const parts = await prisma.part.findMany({
      where: { id: { in: partIds } },
      include: { supplier: { select: { id: true, name: true } } },
    })
    const partMap = new Map(parts.map((p) => [p.id, p]))

    const missingSupplier = data.items.filter((item) => !partMap.get(item.partId)?.supplierId)
    if (missingSupplier.length > 0) {
      const names = missingSupplier
        .map((item) => partMap.get(item.partId)?.name ?? String(item.partId))
        .join('、')
      return reply.code(400).send({ error: '零件「' + names + '」未设置供应商，不能生成采购单' })
    }

    const groups = new Map<number, { partId: number; qty: number; unitPrice: number }[]>()
    for (const item of data.items) {
      const supplierId = partMap.get(item.partId)!.supplierId!
      const list = groups.get(supplierId) ?? []
      list.push(item)
      groups.set(supplierId, list)
    }

    const orders = await prisma.$transaction(async (tx) => {
      const createdOrders: any[] = []
      for (const [supplierId, items] of groups.entries()) {
        const orderNo = await generatePurchaseOrderNoFor(tx)
        const created = await tx.purchaseOrder.create({
          data: { orderNo, supplierId, salesOrderId: data.salesOrderId ?? null },
        })
        for (const item of items) {
          await tx.purchaseOrderItem.create({
            data: { purchaseOrderId: created.id, partId: item.partId, qty: item.qty, unitPrice: item.unitPrice },
          })
        }
        createdOrders.push(
          await tx.purchaseOrder.findUniqueOrThrow({
            where: { id: created.id },
            include: {
              supplier: { select: { id: true, name: true } },
              items: {
                include: { part: { select: { id: true, sku: true, name: true } } },
                orderBy: { id: 'asc' as const },
              },
            },
          }),
        )
      }
      return createdOrders
    })

    return reply.code(200).send(orders)
  })

  // 收货：仅 warehouse 可操作，事务内写 Receipt 并入库
  app.post('/api/receipts', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(receiptSchema, req.body, reply)
    if (data === null) return

    try {
      await prisma.$transaction(async (tx) => {
        const purchaseOrder = await tx.purchaseOrder.findUnique({
          where: { id: data.purchaseOrderId },
          select: { id: true, salesOrderId: true, items: { select: { partId: true, qty: true } } },
        })
        if (!purchaseOrder) throw new Error('采购单不存在')

        // 已收货数量（事务内聚合，含本事务之前的历史收货）
        const receivedGroups = await tx.receipt.groupBy({
          by: ['partId'],
          where: { purchaseOrderId: data.purchaseOrderId },
          _sum: { qty: true },
        })
        const receivedMap = new Map(receivedGroups.map((g) => [g.partId, g._sum.qty ?? 0]))
        const poItemMap = new Map(purchaseOrder.items.map((i) => [i.partId, i.qty]))
        // 本批次内累计（同 partId 多次提交时叠加判断）
        const pending = new Map<number, number>()

        for (const item of data.items) {
          const orderedQty = poItemMap.get(item.partId)
          if (!orderedQty) {
            throw new Error('零件（ID ' + item.partId + '）不在该采购单中，不能收货')
          }
          const already = (receivedMap.get(item.partId) ?? 0) + (pending.get(item.partId) ?? 0)
          if (already + item.qty > orderedQty) {
            throw new Error('零件（ID ' + item.partId + '）收货数量超过订购数量，不能重复收货')
          }
          pending.set(item.partId, already + item.qty)

          const receipt = await tx.receipt.create({
            data: {
              purchaseOrderId: data.purchaseOrderId,
              partId: item.partId,
              qty: item.qty,
              lotNo: item.lotNo || null,
              qcStatus: item.qcStatus || null,
              defectiveQty: item.defectiveQty ?? 0,
            },
          })
          await applyStockChange(tx, 'part', item.partId, item.qty, 'receipt', receipt.id, purchaseOrder.salesOrderId)
        }

        // 按累计收货更新采购单状态：全部收齐 → received；部分 → partial
        const allReceived = purchaseOrder.items.every(
          (i) => (receivedMap.get(i.partId) ?? 0) + (pending.get(i.partId) ?? 0) >= i.qty,
        )
        const anyReceived = purchaseOrder.items.some(
          (i) => (receivedMap.get(i.partId) ?? 0) + (pending.get(i.partId) ?? 0) > 0,
        )
        if (allReceived) {
          await tx.purchaseOrder.update({ where: { id: purchaseOrder.id }, data: { status: 'received' } })
        } else if (anyReceived) {
          await tx.purchaseOrder.update({ where: { id: purchaseOrder.id }, data: { status: 'partial' } })
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '收货失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      if (message.includes('采购单不存在')) return reply.code(404).send({ error: message })
      if (message.includes('不在该采购单') || message.includes('超过订购数量')) {
        return reply.code(400).send({ error: message })
      }
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '收货失败，请稍后重试' })
    }

    return reply.code(200).send({ ok: true })
  })
}
