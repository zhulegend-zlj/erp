import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { refreshProducingPhase } from '../domain/order-phase'
import { parsePositiveInt, prismaErrorInfo } from '../errors'
import { parsePagination, pagedResult } from '../pagination'

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
        // 订单状态与物料归属校验：只能对已确认/生产中/待出货的订单领料，且零件必须在该订单 BOM 内
        const order = await tx.salesOrder.findUnique({
          where: { id: data.salesOrderId },
          select: { id: true, status: true, items: { select: { productId: true } } },
        })
        if (!order) throw new Error('订单不存在')
        if (order.status === 'draft' || order.status === 'shipped' || order.status === 'completed') {
          throw new Error('订单当前状态不能领料（需已确认/生产中/待出货）')
        }
        const productIds = [...new Set(order.items.map((it) => it.productId))]
        const boms = await tx.bom.findMany({
          where: { productId: { in: productIds } },
          select: { partId: true },
        })
        const allowedPartIds = new Set(boms.map((b) => b.partId))
        const seen = new Set<number>()
        for (const item of data.items) {
          if (seen.has(item.partId)) throw new Error('领料明细不能重复')
          seen.add(item.partId)
          if (!allowedPartIds.has(item.partId)) {
            throw new Error('零件（ID ' + item.partId + '）不在该订单的 BOM 中，不能领料')
          }
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
      if (message.includes('订单不存在')) return reply.code(404).send({ error: message })
      if (message.includes('不能领料') || message.includes('不能重复') || message.includes('不在该订单')) {
        return reply.code(400).send({ error: message })
      }
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '领料失败，请稍后重试' })
    }
  })

  // 最近领料记录：仓库/boss 可查（撤销页用），按发料时间倒序分页
  app.get('/api/issues', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      part: { select: { id: true, sku: true, name: true } },
      salesOrder: { select: { id: true, orderNo: true } },
    } as const
    const orderBy = [{ issuedAt: 'desc' as const }, { id: 'desc' as const }]
    const toRow = (r: any) => ({
      id: r.id,
      partId: r.partId,
      sku: r.part.sku,
      name: r.part.name,
      qty: r.qty,
      issuedBy: r.issuedBy,
      orderNo: r.salesOrder.orderNo,
      issuedAt: r.issuedAt,
    })
    if (pagination.kind === 'none') {
      const rows = await prisma.issue.findMany({ include, orderBy })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.issue.findMany({ include, orderBy, skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
      prisma.issue.count(),
    ])
    return pagedResult(rows.map(toRow), total, page)
  })

  // 撤销领料：库存反向加回，原流水保留，新增 void 冲销流水
  app.delete('/api/issues/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '领料记录 ID 必须为正整数' })
    try {
      await prisma.$transaction(async (tx) => {
        const record = await tx.issue.findUnique({ where: { id } })
        if (!record) throw new Error('领料记录不存在')
        await applyStockChange(tx, 'part', record.partId, record.qty, 'void', id, record.salesOrderId)
        await tx.issue.delete({ where: { id } })
      })
      return reply.code(200).send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '撤销领料失败'
      if (message.includes('领料记录不存在')) return reply.code(404).send({ error: message })
      if (message.includes('库存不足')) return reply.code(400).send({ error: '该记录已被后续领用/使用，无法撤销' })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '撤销领料失败，请稍后重试' })
    }
  })

  // 成品入库：仅 warehouse
  app.post('/api/production-entries', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(productionEntrySchema, req.body, reply)
    if (data === null) return

    try {
      const entry = await prisma.$transaction(async (tx) => {
        // 成品必须属于该订单明细，且订单处于生产相关状态（防凭空虚增库存）
        const order = await tx.salesOrder.findUnique({
          where: { id: data.salesOrderId },
          select: { id: true, status: true, items: { select: { productId: true } } },
        })
        if (!order) throw new Error('订单不存在')
        if (order.status === 'draft' || order.status === 'shipped' || order.status === 'completed') {
          throw new Error('订单当前状态不能成品入库（需已确认/生产中/待出货）')
        }
        if (!order.items.some((it) => it.productId === data.productId)) {
          throw new Error('该成品不在所选订单中，不能入库')
        }
        const created = await tx.productionEntry.create({
          data: {
            salesOrderId: data.salesOrderId,
            productId: data.productId,
            qty: data.qty,
            ...(data.entryDate ? { entryDate: new Date(data.entryDate) } : {}),
          },
        })
        await applyStockChange(tx, 'product', data.productId, data.qty, 'production', created.id, data.salesOrderId)
        // 刷新「生产中」：入库未收满保持生产中，收满自动熄灭（采购中也完成则自动推进待出货）
        await refreshProducingPhase(tx, data.salesOrderId)
        return created
      })
      return reply.code(200).send(entry)
    } catch (err) {
      const message = err instanceof Error ? err.message : '成品入库失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      if (message.includes('订单不存在')) return reply.code(404).send({ error: message })
      if (message.includes('不能成品入库') || message.includes('不在所选订单')) {
        return reply.code(400).send({ error: message })
      }
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '成品入库失败，请稍后重试' })
    }
  })

  // 最近成品入库记录：仓库/boss 可查（撤销页用），按入库时间倒序分页
  app.get('/api/production-entries', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      product: { select: { id: true, sku: true, name: true } },
      salesOrder: { select: { id: true, orderNo: true } },
    } as const
    const orderBy = [{ entryDate: 'desc' as const }, { id: 'desc' as const }]
    const toRow = (r: any) => ({
      id: r.id,
      productId: r.productId,
      sku: r.product.sku,
      name: r.product.name,
      qty: r.qty,
      orderNo: r.salesOrder.orderNo,
      entryDate: r.entryDate,
    })
    if (pagination.kind === 'none') {
      const rows = await prisma.productionEntry.findMany({ include, orderBy })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.productionEntry.findMany({ include, orderBy, skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
      prisma.productionEntry.count(),
    ])
    return pagedResult(rows.map(toRow), total, page)
  })

  // 撤销成品入库：库存反向扣回，原流水保留，新增 void 冲销流水
  app.delete('/api/production-entries/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '成品入库记录 ID 必须为正整数' })
    try {
      await prisma.$transaction(async (tx) => {
        const record = await tx.productionEntry.findUnique({ where: { id } })
        if (!record) throw new Error('成品入库记录不存在')
        await applyStockChange(tx, 'product', record.productId, -record.qty, 'void', id, record.salesOrderId)
        await tx.productionEntry.delete({ where: { id } })
      })
      return reply.code(200).send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '撤销成品入库失败'
      if (message.includes('成品入库记录不存在')) return reply.code(404).send({ error: message })
      if (message.includes('库存不足')) return reply.code(400).send({ error: '该记录已被后续使用，无法撤销' })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '撤销成品入库失败，请稍后重试' })
    }
  })

  // 库存列表：5 角色均可查；可选 page/pageSize 分页；keyword 按物料名称/料号过滤（数据库层）
  app.get('/api/stock', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const query = req.query as { itemType?: string; keyword?: string }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const page = pagination.kind === 'ok' ? pagination.page : null

    if (query.itemType && query.itemType !== 'part' && query.itemType !== 'product') {
      return reply.code(400).send({ error: 'itemType 必须为 part 或 product' })
    }
    const and: Record<string, unknown>[] = []
    if (query.itemType) and.push({ itemType: query.itemType })
    const kw = query.keyword?.trim()
    if (kw) {
      // 名称/料号搜索，不区分大小写
      const [partIds, productIds] = await Promise.all([
        prisma.part.findMany({
          where: {
            OR: [
              { name: { contains: kw, mode: 'insensitive' } },
              { sku: { contains: kw, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        }),
        prisma.product.findMany({
          where: {
            OR: [
              { name: { contains: kw, mode: 'insensitive' } },
              { sku: { contains: kw, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        }),
      ])
      and.push({
        OR: [
          { itemType: 'part', itemId: { in: partIds.map((p) => p.id) } },
          { itemType: 'product', itemId: { in: productIds.map((p) => p.id) } },
        ],
      })
    }
    const where = and.length > 0 ? { AND: and } : {}

    const stocks = await prisma.stock.findMany({
      where,
      orderBy: [{ itemType: 'asc' }, { itemId: 'asc' }],
      ...(page ? { skip: (page.page - 1) * page.pageSize, take: page.pageSize } : {}),
    })

    const partIds = stocks.filter((s) => s.itemType === 'part').map((s) => s.itemId)
    const productIds = stocks.filter((s) => s.itemType === 'product').map((s) => s.itemId)

    const [parts, products] = await Promise.all([
      prisma.part.findMany({ where: { id: { in: partIds } } }),
      prisma.product.findMany({ where: { id: { in: productIds } } }),
    ])
    const partNameMap = new Map(parts.map((p) => [p.id, p.name]))
    const productNameMap = new Map(products.map((p) => [p.id, p.name]))

    const partMap = new Map(parts.map((p) => [p.id, p]))
    const productMap = new Map(products.map((p) => [p.id, p]))
    // 不良品按零件汇总：收货记录 QC 补录的 defectiveQty
    const defectiveGroup = await prisma.receipt.groupBy({
      by: ['partId'],
      _sum: { defectiveQty: true },
    })
    const defectiveMap = new Map<number, number>(
      defectiveGroup.map((g) => [g.partId, g._sum.defectiveQty ?? 0]),
    )
    // 退补货按零件汇总：已退/已补，用于不良品实时联动与应补计算
    const rrGroup = await prisma.returnReplenish.groupBy({
      by: ['partId'],
      _sum: { returnQty: true, replenishQty: true },
    })
    const returnedMap = new Map<number, number>(rrGroup.map((g) => [g.partId, g._sum.returnQty ?? 0]))
    const replenishedMap = new Map<number, number>(rrGroup.map((g) => [g.partId, g._sum.replenishQty ?? 0]))

    const rows = stocks.map((s) => {
      const master = s.itemType === 'part' ? partMap.get(s.itemId) : productMap.get(s.itemId)
      if (s.itemType === 'product') {
        return {
          itemType: s.itemType,
          itemId: s.itemId,
          name: master?.name ?? productNameMap.get(s.itemId) ?? '',
          sku: master?.sku ?? '',
          imageUrl: master?.imageUrl ?? '',
          qtyOnHand: s.qtyOnHand,
          defectiveQty: 0,
          returnedQty: 0,
          replenishedQty: 0,
          pendingReplenishQty: 0,
        }
      }
      const receivedDefective = defectiveMap.get(s.itemId) ?? 0
      const returnedQty = returnedMap.get(s.itemId) ?? 0
      const replenishedQty = replenishedMap.get(s.itemId) ?? 0
      return {
        itemType: s.itemType,
        itemId: s.itemId,
        name: master?.name ?? partNameMap.get(s.itemId) ?? '',
        sku: master?.sku ?? '',
        imageUrl: master?.imageUrl ?? '',
        qtyOnHand: s.qtyOnHand,
        defectiveQty: Math.max(0, receivedDefective - returnedQty),
        returnedQty,
        replenishedQty,
        pendingReplenishQty: Math.max(0, returnedQty - replenishedQty),
      }
    })

    if (!page) return rows
    const total = await prisma.stock.count({ where })
    return pagedResult(rows, total, page)
  })

  // 出入库流水：5 角色均可查，按时间升序（早→晚）；可选 page/pageSize 分页
  app.get('/api/stock/ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = req.query as { itemType?: string; itemId?: string }
    const itemType = raw.itemType
    const itemId = parsePositiveInt(raw.itemId)
    if (itemType !== 'part' && itemType !== 'product') {
      return reply.code(400).send({ error: 'itemType 必须为 part 或 product' })
    }
    if (itemId === null) {
      return reply.code(400).send({ error: 'itemType 与 itemId 必填且 itemId 为正整数' })
    }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const where = { itemType, itemId }
    const orderBy = [{ at: 'asc' as const }, { id: 'asc' as const }]
    if (pagination.kind === 'none') {
      return prisma.inventoryLedger.findMany({ where, orderBy })
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.inventoryLedger.findMany({
        where,
        orderBy,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.inventoryLedger.count({ where }),
    ])
    return pagedResult(rows, total, page)
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

  // 订单流水：按销售订单号查询该订单全部出入库流水，并汇总出库数量；
  // 可与物料绑定（itemType+itemId）：只返回该物料流水，并给出该订单该物料的需求/已出库/未出汇总
  app.get('/api/inventory/order-ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const query = req.query as { orderNo?: string; itemType?: string; itemId?: string }
    const raw = query.orderNo
    if (!raw || !raw.trim()) {
      return reply.code(400).send({ error: 'orderNo 必填' })
    }
    const orderNo = raw.trim()

    let bindItem: { itemType: 'part' | 'product'; itemId: number } | null = null
    if (query.itemType !== undefined && query.itemType !== '') {
      if (query.itemType !== 'part' && query.itemType !== 'product') {
        return reply.code(400).send({ error: 'itemType 必须为 part 或 product' })
      }
      const itemId = Number(query.itemId)
      if (!query.itemId || !Number.isInteger(itemId) || itemId <= 0) {
        return reply.code(400).send({ error: '绑定物料时 itemId 必填且为正整数' })
      }
      bindItem = { itemType: query.itemType, itemId }
    }

    const order = await prisma.salesOrder.findUnique({ where: { orderNo }, select: { id: true, orderNo: true } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const rows = await prisma.inventoryLedger.findMany({
      where: {
        salesOrderId: order.id,
        ...(bindItem ? { itemType: bindItem.itemType, itemId: bindItem.itemId } : {}),
      },
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

    // 绑定零件时计算该订单该零件的需求/已出库/未出
    let bound: { itemName: string; requiredQty: number; issuedQty: number; outstanding: number } | null = null
    if (bindItem) {
      const itemName =
        bindItem.itemType === 'part' ? (partNameMap.get(bindItem.itemId) ?? '') : (productNameMap.get(bindItem.itemId) ?? '')
      let requiredQty = 0
      if (bindItem.itemType === 'part') {
        const orderItems = await prisma.salesOrderItem.findMany({
          where: { orderId: order.id },
          select: { productId: true, qty: true },
        })
        const productIdsInOrder = [...new Set(orderItems.map((it) => it.productId))]
        const boms = await prisma.bom.findMany({
          where: { productId: { in: productIdsInOrder }, partId: bindItem.itemId },
        })
        const usageMap = new Map(boms.map((b) => [b.productId, b.qty]))
        for (const it of orderItems) {
          requiredQty += (usageMap.get(it.productId) ?? 0) * it.qty
        }
      }
      const issuedQty = rows.reduce((sum, r) => sum + (r.delta < 0 ? -r.delta : 0), 0)
      bound = { itemName, requiredQty, issuedQty, outstanding: Math.max(0, requiredQty - issuedQty) }
    }

    return {
      orderNo: order.orderNo,
      ...(bindItem ? { itemType: bindItem.itemType, itemId: bindItem.itemId } : {}),
      ...(bound ?? {}),
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
        _sum: { qty: true, defectiveQty: true },
      }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
    ])
    const receivedMap = new Map(receiptGroups.map((g) => [g.partId, g._sum.qty ?? 0]))
    const defectiveMap = new Map(receiptGroups.map((g) => [g.partId, g._sum.defectiveQty ?? 0]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))

    const items = po.items.map((item, index) => {
      const requiredQty = item.qty
      const receivedQty = receivedMap.get(item.partId) ?? 0
      const defectiveQty = defectiveMap.get(item.partId) ?? 0
      return {
        seq: index + 1,
        partId: item.partId,
        sku: item.part.sku,
        name: item.part.name,
        requiredQty,
        receivedQty,
        defectiveQty,
        outstanding: Math.max(0, requiredQty - receivedQty),
        balance: stockMap.get(item.partId) ?? 0,
      }
    })

    return { purchaseOrderNo: po.orderNo, supplierName: po.supplier.name, items }
  })

  // 仓库收发台账：带物料图片/供应商/规格/订单号/来料单号/入库/出库/结存；
  // 可选 page/pageSize 分页；keyword/orderNo 过滤下推到数据库再分页
  app.get('/api/inventory/warehouse-ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const query = req.query as { itemType?: string; keyword?: string; orderNo?: string }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const page = pagination.kind === 'ok' ? pagination.page : null

    const and: Record<string, unknown>[] = []
    if (query.itemType) and.push({ itemType: query.itemType })

    const kw = query.keyword?.trim()
    if (kw) {
      const [partIds, productIds] = await Promise.all([
        prisma.part.findMany({
          where: {
            OR: [
              { name: { contains: kw, mode: 'insensitive' } },
              { sku: { contains: kw, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        }),
        prisma.product.findMany({
          where: {
            OR: [
              { name: { contains: kw, mode: 'insensitive' } },
              { sku: { contains: kw, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        }),
      ])
      and.push({
        OR: [
          { itemType: 'part', itemId: { in: partIds.map((p) => p.id) } },
          { itemType: 'product', itemId: { in: productIds.map((p) => p.id) } },
        ],
      })
    }

    const ono = query.orderNo?.trim()
    if (ono) {
      const [issueIds, receiptIds, returnIds] = await Promise.all([
        prisma.issue.findMany({ where: { salesOrder: { orderNo: { contains: ono, mode: 'insensitive' } } }, select: { id: true } }),
        prisma.receipt.findMany({ where: { purchaseOrder: { orderNo: { contains: ono, mode: 'insensitive' } } }, select: { id: true } }),
        prisma.returnReplenish.findMany({ where: { purchaseOrderNo: { contains: ono, mode: 'insensitive' } }, select: { id: true } }),
      ])
      and.push({
        OR: [
          { refType: 'issue', refId: { in: issueIds.map((i) => i.id) } },
          { refType: 'receipt', refId: { in: receiptIds.map((i) => i.id) } },
          { refType: { in: ['return', 'replenish'] }, refId: { in: returnIds.map((i) => i.id) } },
        ],
      })
    }

    const where = and.length > 0 ? { AND: and } : {}
    const rows = await prisma.inventoryLedger.findMany({
      where,
      orderBy: [{ at: 'asc' as const }, { id: 'asc' as const }],
      ...(page ? { skip: (page.page - 1) * page.pageSize, take: page.pageSize } : {}),
    })

    const partIds = [...new Set(rows.filter((r) => r.itemType === 'part').map((r) => r.itemId))]
    const productIds = [...new Set(rows.filter((r) => r.itemType === 'product').map((r) => r.itemId))]
    const receiptIds = rows.filter((r) => r.refType === 'receipt').map((r) => r.refId)
    const issueIds = rows.filter((r) => r.refType === 'issue').map((r) => r.refId)
    const returnIds = rows.filter((r) => r.refType === 'return' || r.refType === 'replenish').map((r) => r.refId)

    const [parts, products, receipts, issues, returns] = await Promise.all([
      prisma.part.findMany({
        where: { id: { in: partIds } },
        include: { supplier: { select: { name: true } } },
      }),
      prisma.product.findMany({ where: { id: { in: productIds } } }),
      prisma.receipt.findMany({
        where: { id: { in: receiptIds } },
        include: { purchaseOrder: { select: { orderNo: true } } },
      }),
      prisma.issue.findMany({
        where: { id: { in: issueIds } },
        include: { salesOrder: { select: { orderNo: true } } },
      }),
      prisma.returnReplenish.findMany({ where: { id: { in: returnIds } } }),
    ])

    const partMap = new Map(parts.map((p) => [p.id, p]))
    const productMap = new Map(products.map((p) => [p.id, p]))
    const receiptMap = new Map(receipts.map((r) => [r.id, r]))
    const issueMap = new Map(issues.map((r) => [r.id, r]))
    const returnMap = new Map(returns.map((r) => [r.id, r]))

    const items = rows.map((r) => {
      const part = r.itemType === 'part' ? partMap.get(r.itemId) : undefined
      const product = r.itemType === 'product' ? productMap.get(r.itemId) : undefined
      let orderNo = ''
      let lotNo = ''
      if (r.refType === 'receipt') {
        const rec = receiptMap.get(r.refId)
        orderNo = rec?.purchaseOrder?.orderNo ?? ''
        lotNo = rec?.lotNo ?? ''
      } else if (r.refType === 'issue') {
        orderNo = issueMap.get(r.refId)?.salesOrder?.orderNo ?? ''
      } else if (r.refType === 'return' || r.refType === 'replenish') {
        const rr = returnMap.get(r.refId)
        orderNo = rr?.purchaseOrderNo ?? ''
        lotNo = rr?.lotNo ?? ''
      }
      return {
        id: r.id,
        at: r.at,
        itemType: r.itemType,
        sku: part?.sku ?? product?.sku ?? '',
        name: part?.name ?? product?.name ?? '',
        imageUrl: part?.imageUrl ?? product?.imageUrl ?? '',
        supplierName: part?.supplier?.name ?? '',
        spec: part?.spec ?? '',
        orderNo,
        lotNo,
        inQty: r.delta > 0 ? r.delta : 0,
        outQty: r.delta < 0 ? -r.delta : 0,
        balance: r.balance,
      }
    })

    if (!page) return items
    const total = await prisma.inventoryLedger.count({ where })
    return pagedResult(items, total, page)
  })

  // 流水级联查询：销售订单（可选）→ 采购订单（可选）→ 零件（可选）；全不选 = 查所有流水
  app.get('/api/inventory/ledger-search', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const query = req.query as { salesOrderNo?: string; purchaseOrderNo?: string; partId?: string }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const page = pagination.kind === 'ok' ? pagination.page : null
    const and: Record<string, unknown>[] = []

    // 零件过滤（仅零件类流水）
    if (query.partId !== undefined && query.partId !== '') {
      const partId = parsePositiveInt(query.partId)
      if (partId === null) return reply.code(400).send({ error: 'partId 必须为正整数' })
      and.push({ itemType: 'part', itemId: partId })
    }

    // 采购订单过滤：该采购单的收货/退补货流水
    const poNo = query.purchaseOrderNo?.trim()
    if (poNo) {
      const po = await prisma.purchaseOrder.findUnique({ where: { orderNo: poNo }, select: { id: true } })
      if (!po) return reply.code(404).send({ error: '采购单不存在' })
      const [receiptIds, returnIds] = await Promise.all([
        prisma.receipt.findMany({ where: { purchaseOrderId: po.id }, select: { id: true } }),
        prisma.returnReplenish.findMany({ where: { purchaseOrderNo: poNo }, select: { id: true } }),
      ])
      and.push({
        OR: [
          { refType: 'receipt', refId: { in: receiptIds.map((r) => r.id) } },
          { refType: { in: ['return', 'replenish'] }, refId: { in: returnIds.map((r) => r.id) } },
        ],
      })
    }

    // 销售订单过滤：该订单的领料/成品入库/出货流水 + 该订单采购单的收货流水
    const soNo = query.salesOrderNo?.trim()
    if (soNo) {
      const so = await prisma.salesOrder.findUnique({ where: { orderNo: soNo }, select: { id: true } })
      if (!so) return reply.code(404).send({ error: '销售订单不存在' })
      const [issueIds, prodIds, shipIds, poIds] = await Promise.all([
        prisma.issue.findMany({ where: { salesOrderId: so.id }, select: { id: true } }),
        prisma.productionEntry.findMany({ where: { salesOrderId: so.id }, select: { id: true } }),
        prisma.shipment.findMany({ where: { salesOrderId: so.id }, select: { id: true } }),
        prisma.purchaseOrder.findMany({ where: { salesOrderId: so.id }, select: { id: true } }),
      ])
      const receiptIdsOfOrder = poIds.length > 0
        ? await prisma.receipt.findMany({ where: { purchaseOrderId: { in: poIds.map((p) => p.id) } }, select: { id: true } })
        : []
      and.push({
        OR: [
          { refType: 'issue', refId: { in: issueIds.map((r) => r.id) } },
          { refType: 'production', refId: { in: prodIds.map((r) => r.id) } },
          { refType: 'shipment', refId: { in: shipIds.map((r) => r.id) } },
          { refType: 'receipt', refId: { in: receiptIdsOfOrder.map((r) => r.id) } },
        ],
      })
    }

    const where = and.length > 0 ? { AND: and } : {}
    const orderBy = [{ at: 'asc' as const }, { id: 'asc' as const }]
    const rows = await prisma.inventoryLedger.findMany({
      where,
      orderBy,
      ...(page ? { skip: (page.page - 1) * page.pageSize, take: page.pageSize } : {}),
    })
    const partIds = [...new Set(rows.filter((r) => r.itemType === 'part').map((r) => r.itemId))]
    const productIds = [...new Set(rows.filter((r) => r.itemType === 'product').map((r) => r.itemId))]
    const receiptIds = rows.filter((r) => r.refType === 'receipt').map((r) => r.refId)
    const issueIds = rows.filter((r) => r.refType === 'issue').map((r) => r.refId)
    const returnIds = rows.filter((r) => r.refType === 'return' || r.refType === 'replenish').map((r) => r.refId)
    const [parts, products, receipts, issues, returns] = await Promise.all([
      prisma.part.findMany({ where: { id: { in: partIds } }, include: { supplier: { select: { name: true } } } }),
      prisma.product.findMany({ where: { id: { in: productIds } } }),
      prisma.receipt.findMany({ where: { id: { in: receiptIds } }, include: { purchaseOrder: { select: { orderNo: true } } } }),
      prisma.issue.findMany({ where: { id: { in: issueIds } }, include: { salesOrder: { select: { orderNo: true } } } }),
      prisma.returnReplenish.findMany({ where: { id: { in: returnIds } } }),
    ])
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const productMap = new Map(products.map((p) => [p.id, p]))
    const receiptMap = new Map(receipts.map((r) => [r.id, r]))
    const issueMap = new Map(issues.map((r) => [r.id, r]))
    const returnMap = new Map(returns.map((r) => [r.id, r]))
    const items = rows.map((r) => {
      const part = r.itemType === 'part' ? partMap.get(r.itemId) : undefined
      const product = r.itemType === 'product' ? productMap.get(r.itemId) : undefined
      let orderNo = ''
      let lotNo = ''
      if (r.refType === 'receipt') {
        const rec = receiptMap.get(r.refId)
        orderNo = rec?.purchaseOrder?.orderNo ?? ''
        lotNo = rec?.lotNo ?? ''
      } else if (r.refType === 'issue') {
        orderNo = issueMap.get(r.refId)?.salesOrder?.orderNo ?? ''
      } else if (r.refType === 'return' || r.refType === 'replenish') {
        const rr = returnMap.get(r.refId)
        orderNo = rr?.purchaseOrderNo ?? ''
        lotNo = rr?.lotNo ?? ''
      }
      return {
        id: r.id,
        at: r.at,
        itemType: r.itemType,
        sku: part?.sku ?? product?.sku ?? '',
        name: part?.name ?? product?.name ?? '',
        imageUrl: part?.imageUrl ?? product?.imageUrl ?? '',
        supplierName: part?.supplier?.name ?? '',
        spec: part?.spec ?? '',
        orderNo,
        lotNo,
        inQty: r.delta > 0 ? r.delta : 0,
        outQty: r.delta < 0 ? -r.delta : 0,
        balance: r.balance,
      }
    })
    if (!page) return items
    const total = await prisma.inventoryLedger.count({ where })
    return pagedResult(items, total, page)
  })

  // 领料上下文：订单的采购单（含零件）与 BOM 零件清单，供领料页绑定采购单自动带出零件
  app.get('/api/inventory/issue-context', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const raw = (req.query as { orderId?: string }).orderId
    const orderId = parsePositiveInt(raw)
    if (orderId === null) return reply.code(400).send({ error: 'orderId 必填且为正整数' })
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, orderNo: true, status: true, items: { select: { productId: true } } },
    })
    if (!order) return reply.code(404).send({ error: '订单不存在' })
    const productIds = [...new Set(order.items.map((it) => it.productId))]
    const [boms, purchaseOrders] = await Promise.all([
      prisma.bom.findMany({
        where: { productId: { in: productIds } },
        include: { part: { select: { id: true, sku: true, name: true } } },
        orderBy: { partId: 'asc' as const },
      }),
      prisma.purchaseOrder.findMany({
        where: { salesOrderId: orderId },
        select: {
          id: true,
          orderNo: true,
          supplier: { select: { name: true } },
          items: {
            include: { part: { select: { id: true, sku: true, name: true } } },
            orderBy: { partId: 'asc' as const },
          },
        },
      }),
    ])
    // BOM 零件去重（同一零件可能挂在多个成品下）
    const bomPartMap = new Map<number, { partId: number; sku: string; name: string }>()
    for (const b of boms) {
      if (!bomPartMap.has(b.partId)) {
        bomPartMap.set(b.partId, { partId: b.partId, sku: b.part.sku, name: b.part.name })
      }
    }
    // 汇总所有涉及零件 id，一次查询当前库存（缺省 0）
    const allPartIds = new Set<number>()
    for (const b of boms) allPartIds.add(b.partId)
    for (const po of purchaseOrders) for (const it of po.items) allPartIds.add(it.partId)
    const stockRows = await prisma.stock.findMany({
      where: { itemType: 'part', itemId: { in: [...allPartIds] } },
    })
    const onHandMap = new Map(stockRows.map((s) => [s.itemId, s.qtyOnHand]))
    const onHandOf = (partId: number) => onHandMap.get(partId) ?? 0
    return {
      orderNo: order.orderNo,
      status: order.status,
      purchaseOrders: purchaseOrders.map((po) => ({
        id: po.id,
        orderNo: po.orderNo,
        supplierName: po.supplier?.name ?? '',
        items: po.items.map((it) => ({ partId: it.partId, sku: it.part.sku, name: it.part.name, onHand: onHandOf(it.partId) })),
      })),
      bomParts: [...bomPartMap.values()].map((p) => ({ ...p, onHand: onHandOf(p.partId) })),
    }
  })
}
