import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'

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
          await applyStockChange(tx, 'part', item.partId, -item.qty, 'issue', issue.id)
          created.push({ id: issue.id, partId: item.partId, qty: item.qty })
        }
        return created
      })
      return reply.code(200).send({ ok: true, issues })
    } catch (err) {
      const message = err instanceof Error ? err.message : '领料失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
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
        await applyStockChange(tx, 'product', data.productId, data.qty, 'production', created.id)
        return created
      })
      return reply.code(200).send(entry)
    } catch (err) {
      const message = err instanceof Error ? err.message : '成品入库失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
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

  // 出入库流水：5 角色均可查，按时间倒序
  app.get('/api/stock/ledger', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = req.query as { itemType?: string; itemId?: string }
    const itemType = raw.itemType
    const itemId = Number(raw.itemId)
    if (!itemType || !raw.itemId || !Number.isInteger(itemId) || itemId <= 0) {
      return reply.code(400).send({ error: 'itemType 与 itemId 必填且 itemId 为正整数' })
    }
    return prisma.inventoryLedger.findMany({
      where: { itemType, itemId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    })
  })
}
