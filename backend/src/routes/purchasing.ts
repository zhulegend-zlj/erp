import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { bomExplode, computePurchaseGap, usageDisplay } from '../domain/bom'
import { applyStockChange } from '../domain/inventory'
import { markPurchasingStarted, refreshPurchasingPhase, refreshPurchasingPhaseAfterUndo } from '../domain/order-phase'
import { parsePositiveInt, prismaErrorInfo, routeError } from '../errors'
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

// 批量生成允许行级供应商覆盖（未挂供应商的零件可在弹窗里现选，不强制先写回零件资料）
const batchItemSchema = purchaseItemSchema.extend({
  supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
})
const batchPurchaseOrderSchema = z.object({
  salesOrderId: z.number().int().positive().optional(),
  items: z.array(batchItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
})

const receiptItemSchema = z
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
    // 自购买（无采购单）时可选挂供应商便于追溯
    supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
  })
  .refine((v) => (v.defectiveQty ?? 0) <= v.qty, {
    message: '不良品数量不能大于收货数量',
  })

// 收货两种模式：有采购单（校验归属/不超量/推进状态）或自购买（purchaseOrderId 不传）
const receiptSchema = z.object({
  purchaseOrderId: z.number({ error: '采购单必须为整数' }).int().positive().nullable().optional(),
  items: z.array(receiptItemSchema, { error: '明细必填' }).min(1, '收货至少包含一个明细'),
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
  salesOrder: { select: { id: true, orderNo: true } },
  items: {
    include: { part: { select: { id: true, sku: true, name: true, unit: true } } },
    orderBy: { id: 'asc' as const },
  },
  payments: true,
} as const

function utcDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

// 采购单号规则：
// 1) 挂销售订单：订单号（=客户PO号）+ -Z001/-Z002…（同一订单内按创建顺序递增，一次批量按供应商分组的 N 张自动排 Z001..Z00N）
// 2) 自购（无销售订单）：保留旧规则 PO-YYYYMMDD-NNN
function zrhPoSuffix(seq: number): string {
  return `-Z${String(seq).padStart(3, '0')}`
}

async function nextPurchaseOrderNo(salesOrderId: number | null, tx: Prisma.TransactionClient): Promise<string> {
  if (salesOrderId === null) {
    const prefix = `PO-${utcDateStamp()}-`
    const count = await tx.purchaseOrder.count({ where: { orderNo: { startsWith: prefix } } })
    return `${prefix}${String(count + 1).padStart(3, '0')}`
  }
  const salesOrder = await tx.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    select: { orderNo: true },
  })
  const base = salesOrder.orderNo
  const count = await tx.purchaseOrder.count({ where: { salesOrderId, orderNo: { startsWith: base + '-Z' } } })
  return `${base}${zrhPoSuffix(count + 1)}`
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

    // 零件 → 各成品 BOM 用量明细（用于「用量/台」显示：单一用量显示整数，多成品不同用量显示明细）
    const usageByPart = new Map<number, Map<number, number>>()
    for (const b of boms) {
      const m = usageByPart.get(b.partId) ?? new Map<number, number>()
      m.set(b.productId, (m.get(b.productId) ?? 0) + b.qty)
      usageByPart.set(b.partId, m)
    }

    const [parts, stocks, products] = await Promise.all([
      prisma.part.findMany({
        where: { id: { in: partIds } },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
      prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }),
    ])
    const productSkuMap = new Map(products.map((p) => [p.id, p.sku]))
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))
    const gapMap = new Map(computePurchaseGap(requirements, stockMap).map((g) => [g.partId, g.gapQty]))

    return requirements.map((r) => {
      const part = partMap.get(r.partId)
      const onHand = stockMap.get(r.partId) ?? 0
      const usage = usageDisplay(usageByPart.get(r.partId), productSkuMap)
      return {
        partId: r.partId,
        sku: part?.sku ?? '',
        partName: part?.name ?? '',
        supplierId: part?.supplierId ?? null,
        supplierName: part?.supplier?.name ?? '',
        price: part?.price != null ? part.price.toNumber() : null,
        ...usage,
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

    // 采购单价口径（BUG-09）：与零件价格一致——仅 采购/老板/财务 可见，销售/仓库/工程剥离
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const hidePrice = ['sales', 'warehouse', 'engineer'].includes(role)
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
        salesOrderNo: po.salesOrder?.orderNo ?? '',
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
          ...(hidePrice ? {} : { unitPrice: it.unitPrice.toNumber() }),
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

    // 草稿订单不能生成采购单：需先提醒销售确认（老板口径 2026-08-26）
    if (data.salesOrderId != null) {
      const so = await prisma.salesOrder.findUnique({ where: { id: data.salesOrderId }, select: { status: true } })
      if (so && so.status === 'draft') {
        return reply.code(400).send({ error: '销售还未确认该订单（草稿状态），请提醒销售确认后再生成采购单' })
      }
    }

    const orderNo = await nextPurchaseOrderNo(data.salesOrderId ?? null, prisma)
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: { orderNo, supplierId: data.supplierId, salesOrderId: data.salesOrderId ?? null },
      })
      for (const item of data.items) {
        await tx.purchaseOrderItem.create({
          data: { purchaseOrderId: created.id, partId: item.partId, qty: item.qty, unitPrice: item.unitPrice },
        })
      }
      // 挂销售订单的采购单：点亮订单「采购中」
      await markPurchasingStarted(tx, data.salesOrderId)
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

    // 草稿订单不能生成采购单：需先提醒销售确认（老板口径 2026-08-26）
    if (data.salesOrderId != null) {
      const so = await prisma.salesOrder.findUnique({ where: { id: data.salesOrderId }, select: { status: true } })
      if (so && so.status === 'draft') {
        return reply.code(400).send({ error: '销售还未确认该订单（草稿状态），请提醒销售确认后再生成采购单' })
      }
    }

    const partIds = [...new Set(data.items.map((item) => item.partId))]
    if (partIds.length !== data.items.length) {
      return reply.code(400).send({ error: '采购明细不能重复' })
    }
    const parts = await prisma.part.findMany({
      where: { id: { in: partIds } },
      include: { supplier: { select: { id: true, name: true } } },
    })
    const partMap = new Map(parts.map((p) => [p.id, p]))

    // 供应商来源：行级覆盖 > 零件资料；两者都没有才报错
    const missingSupplier = data.items.filter((item) => {
      const part = partMap.get(item.partId)
      return !(item.supplierId ?? part?.supplierId)
    })
    if (missingSupplier.length > 0) {
      const names = missingSupplier
        .map((item) => partMap.get(item.partId)?.name ?? String(item.partId))
        .join('、')
      return reply.code(400).send({ error: '零件「' + names + '」未设置供应商，不能生成采购单' })
    }

    const groups = new Map<number, { partId: number; qty: number; unitPrice: number }[]>()
    for (const item of data.items) {
      const supplierId = item.supplierId ?? partMap.get(item.partId)!.supplierId!
      const list = groups.get(supplierId) ?? []
      list.push(item)
      groups.set(supplierId, list)
    }

    const orders = await prisma.$transaction(async (tx) => {
      const createdOrders: any[] = []
      for (const [supplierId, items] of groups.entries()) {
        const orderNo = await nextPurchaseOrderNo(data.salesOrderId ?? null, tx)
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
      // 挂销售订单的采购单：点亮订单「采购中」
      await markPurchasingStarted(tx, data.salesOrderId)
      return createdOrders
    })

    return reply.code(200).send(orders)
  })

  // 收货：仅 warehouse 可操作。两种模式：
  // 1) 有采购单：校验零件归属/不超订购量，更新采购单状态并刷新订单「采购中」；
  // 2) 自购买（purchaseOrderId 不传）：直接按零件入库，可挂供应商追溯。
  app.post('/api/receipts', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(receiptSchema, req.body, reply)
    if (data === null) return

    try {
      await prisma.$transaction(async (tx) => {
        // 并发防护（BUG-01）：锁采购单行，同单并发收货串行化，累计校验不再竞态
        if (data.purchaseOrderId != null) {
          await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${data.purchaseOrderId} FOR UPDATE`
        }
        const purchaseOrder = data.purchaseOrderId != null
          ? await tx.purchaseOrder.findUnique({
              where: { id: data.purchaseOrderId },
              select: { id: true, salesOrderId: true, items: { select: { partId: true, qty: true } } },
            })
          : null
        if (data.purchaseOrderId != null && !purchaseOrder) throw new Error('采购单不存在')

        const receivedMap = new Map<number, number>()
        const poItemMap = new Map<number, number>()
        if (purchaseOrder) {
          // 已收货数量（事务内聚合，含本事务之前的历史收货）
          const receivedGroups = await tx.receipt.groupBy({
            by: ['partId'],
            where: { purchaseOrderId: purchaseOrder.id },
            _sum: { qty: true },
          })
          receivedGroups.forEach((g) => receivedMap.set(g.partId, g._sum.qty ?? 0))
          purchaseOrder.items.forEach((i) => poItemMap.set(i.partId, i.qty))
        }
        // 本批次内累计（同 partId 多次提交时叠加判断）
        const pending = new Map<number, number>()
        const seen = new Set<number>()

        for (const item of data.items) {
          if (purchaseOrder) {
            const orderedQty = poItemMap.get(item.partId)
            if (!orderedQty) {
              throw new Error('零件（ID ' + item.partId + '）不在该采购单中，不能收货')
            }
            const already = (receivedMap.get(item.partId) ?? 0) + (pending.get(item.partId) ?? 0)
            if (already + item.qty > orderedQty) {
              throw new Error('零件（ID ' + item.partId + '）收货数量超过订购数量，不能重复收货')
            }
          } else {
            if (seen.has(item.partId)) throw new Error('收货明细不能重复')
            seen.add(item.partId)
            const part = await tx.part.findUnique({ where: { id: item.partId }, select: { id: true } })
            if (!part) throw new Error('零件（ID ' + item.partId + '）不存在')
          }
          pending.set(item.partId, (pending.get(item.partId) ?? 0) + item.qty)

          const receipt = await tx.receipt.create({
            data: {
              purchaseOrderId: purchaseOrder?.id ?? null,
              supplierId: item.supplierId ?? null,
              partId: item.partId,
              qty: item.qty,
              lotNo: item.lotNo || null,
              qcStatus: item.qcStatus || null,
              defectiveQty: item.defectiveQty ?? 0,
            },
          })
          await applyStockChange(tx, 'part', item.partId, item.qty, 'receipt', receipt.id, purchaseOrder?.salesOrderId ?? null)
        }

        if (purchaseOrder) {
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
          // 刷新订单「采购中」：全部采购单收齐自动熄灭，两阶段都完成自动推进待出货
          await refreshPurchasingPhase(tx, purchaseOrder.salesOrderId)
        }
      })
    } catch (err) {
      const e = routeError(err, ['采购单不存在'])
      return reply.code(e.status).send({ error: e.message })
    }

    return reply.code(200).send({ ok: true })
  })

  // 收货记录列表：仓库 QC 补录用（可按时收倒序、按采购单过滤、分页）
  app.get('/api/receipts', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const query = req.query as { purchaseOrderId?: string }
    const where: { purchaseOrderId?: number } = {}
    if (query.purchaseOrderId !== undefined && query.purchaseOrderId !== '') {
      const poId = parsePositiveInt(query.purchaseOrderId)
      if (poId === null) return reply.code(400).send({ error: 'purchaseOrderId 必须为正整数' })
      where.purchaseOrderId = poId
    }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      part: { select: { id: true, sku: true, name: true } },
      purchaseOrder: { select: { id: true, orderNo: true } },
      supplier: { select: { id: true, name: true } },
    } as const
    const orderBy = [{ receivedAt: 'desc' as const }, { id: 'desc' as const }]
    const toRow = (r: Prisma.ReceiptGetPayload<{ include: typeof include }>) => ({
      id: r.id,
      purchaseOrderId: r.purchaseOrderId,
      purchaseOrderNo: r.purchaseOrder?.orderNo ?? '',
      partId: r.partId,
      sku: r.part.sku,
      partName: r.part.name,
      supplierId: r.supplierId,
      supplierName: r.supplier?.name ?? '',
      qty: r.qty,
      lotNo: r.lotNo,
      qcStatus: r.qcStatus,
      defectiveQty: r.defectiveQty,
      receivedAt: r.receivedAt,
    })
    if (pagination.kind === 'none') {
      const rows = await prisma.receipt.findMany({ where, include, orderBy })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.receipt.findMany({
        where,
        include,
        orderBy,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.receipt.count({ where }),
    ])
    return pagedResult(rows.map(toRow), total, page)
  })

  // QC 补录：收货入库后，仓库再对收货记录补充 QC 状态 / 不良品数量 / 来料单号
  app.patch('/api/receipts/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '收货记录 ID 必须为正整数' })
    const body = (req.body ?? {}) as { lotNo?: unknown; qcStatus?: unknown; defectiveQty?: unknown }
    const data: { lotNo?: string | null; qcStatus?: string | null; defectiveQty?: number } = {}
    if ('lotNo' in body) data.lotNo = typeof body.lotNo === 'string' && body.lotNo !== '' ? body.lotNo : null
    if ('qcStatus' in body) data.qcStatus = typeof body.qcStatus === 'string' && body.qcStatus !== '' ? body.qcStatus : null
    if ('defectiveQty' in body) {
      const dq = body.defectiveQty
      if (typeof dq !== 'number' || !Number.isInteger(dq) || dq < 0) {
        return reply.code(400).send({ error: '不良品数量必须为非负整数' })
      }
      data.defectiveQty = dq
    }
    const receipt = await prisma.receipt.findUnique({ where: { id } })
    if (!receipt) return reply.code(404).send({ error: '收货记录不存在' })
    if (data.defectiveQty !== undefined && data.defectiveQty > receipt.qty) {
      return reply.code(400).send({ error: '不良品数量不能大于收货数量' })
    }
    const updated = await prisma.receipt.update({ where: { id }, data })
    return reply.code(200).send(updated)
  })

  // 撤销收货：库存反向扣回，原流水保留，新增 void 冲销流水
  app.delete('/api/receipts/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '收货记录 ID 必须为正整数' })
    try {
      await prisma.$transaction(async (tx) => {
        const record = await tx.receipt.findUnique({ where: { id } })
        if (!record) throw new Error('收货记录不存在')
        const po = record.purchaseOrderId != null
          ? await tx.purchaseOrder.findUnique({
              where: { id: record.purchaseOrderId },
              select: { id: true, salesOrderId: true, items: { select: { partId: true, qty: true } } },
            })
          : null
        await applyStockChange(tx, 'part', record.partId, -record.qty, 'void', id, po?.salesOrderId ?? null)
        await tx.receipt.delete({ where: { id } })
        if (po) {
          // 撤销后按剩余收货重算采购单状态（收齐→received / 部分→partial / 无→open），并回退订单「采购中」标志
          const groups = await tx.receipt.groupBy({
            by: ['partId'],
            where: { purchaseOrderId: po.id },
            _sum: { qty: true },
          })
          const receivedMap = new Map(groups.map((g) => [g.partId, g._sum.qty ?? 0]))
          const allReceived = po.items.every((i) => (receivedMap.get(i.partId) ?? 0) >= i.qty)
          const anyReceived = po.items.some((i) => (receivedMap.get(i.partId) ?? 0) > 0)
          const status = allReceived ? 'received' : anyReceived ? 'partial' : 'open'
          await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } })
          await refreshPurchasingPhaseAfterUndo(tx, po.salesOrderId)
        }
      })
      return reply.code(200).send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '撤销收货失败'
      if (message.includes('收货记录不存在')) return reply.code(404).send({ error: message })
      if (message.includes('库存不足')) return reply.code(400).send({ error: '该记录已被后续领用/使用，无法撤销' })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '撤销收货失败，请稍后重试' })
    }
  })
}
