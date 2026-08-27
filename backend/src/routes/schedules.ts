import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'

// 出货排程：销售按客户 OPO 表录（订单→成品→数量→到货仓→客户要求日+承诺日）
// pending 待备货 → picked 已备好（仓库确认）→ shipped 已出货；cancelled 可取消

const dateField = (label: string) =>
  z.string({ error: label + '必填' }).refine((v) => !Number.isNaN(Date.parse(v)), label + '必须为合法日期')

const createSchema = z.object({
  salesOrderId: z.number({ error: '订单必填' }).int().positive({ error: '订单必须为正整数' }),
  productId: z.number({ error: '成品必填' }).int().positive({ error: '成品必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int().positive({ error: '数量必须为正整数' }).max(2147483647),
  hubId: z.number({ error: '到货仓必填' }).int().positive({ error: '到货仓必须为正整数' }),
  needByDate: dateField('客户要求日'),
  promisedDate: dateField('承诺日'),
  note: z.string().nullable().optional(),
})

const patchSchema = z.object({
  qty: z.number().int().positive().max(2147483647).optional(),
  hubId: z.number().int().positive().optional(),
  needByDate: dateField('客户要求日').optional(),
  promisedDate: dateField('承诺日').optional(),
  note: z.string().nullable().optional(),
  status: z.enum(['pending', 'picked', 'cancelled']).optional(),
})

function parseBody(schema: z.ZodTypeAny, body: unknown, reply: FastifyReply): Record<string, unknown> | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    reply.code(400).send({ error: result.error.issues.map((i) => i.message).join('；') })
    return null
  }
  return result.data as Record<string, unknown>
}

const INCLUDE = {
  salesOrder: {
    select: {
      id: true,
      orderNo: true,
      customerPoNo: true,
      status: true,
      paymentTerms: true,
      customer: { select: { name: true, defaultIncoterm: true, defaultMark: true, defaultTaxRate: true } },
    },
  },
  product: { select: { id: true, sku: true, name: true } },
  hub: { select: { id: true, name: true } },
} as const

export function scheduleRoutes(app: FastifyInstance) {
  app.get('/api/schedules', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance') }, async (req) => {
    const status = (req.query as Record<string, unknown>).status
    const where: { status?: string } = {}
    if (typeof status === 'string' && status !== '') where.status = status
    return prisma.shipmentSchedule.findMany({
      where,
      include: INCLUDE,
      orderBy: [{ status: 'asc' as const }, { promisedDate: 'asc' as const }, { id: 'asc' as const }],
    })
  })

  app.post('/api/schedules', { preHandler: requireRole('sales') }, async (req, reply) => {
    const data = parseBody(createSchema, req.body, reply)
    if (data === null) return
    const salesOrderId = data.salesOrderId as number
    const productId = data.productId as number
    const qty = data.qty as number

    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true },
    })
    if (!order) return reply.code(404).send({ error: '订单不存在' })
    if (!['confirmed', 'in_production', 'ready'].includes(order.status)) {
      return reply.code(400).send({ error: '只有已确认/运作中的订单可以安排出货' })
    }
    const item = order.items.find((it) => it.productId === productId)
    if (!item) return reply.code(400).send({ error: '该成品不在订单明细中' })

    const hub = await prisma.shipToHub.findUnique({ where: { id: data.hubId as number } })
    if (!hub) return reply.code(404).send({ error: '到货仓不存在' })

    // 排程+已出 数量不得超过订单数量（按成品）
    const [scheduled, shipped] = await Promise.all([
      prisma.shipmentSchedule.aggregate({
        where: { salesOrderId, productId, status: { not: 'cancelled' } },
        _sum: { qty: true },
      }),
      prisma.shipmentLine.aggregate({
        where: { salesOrderId, productId },
        _sum: { qty: true },
      }),
    ])
    const used = (scheduled._sum.qty ?? 0) + (shipped._sum.qty ?? 0)
    if (used + qty > item.qty) {
      return reply.code(400).send({ error: '排程数量超过订单剩余（订单 ' + item.qty + '，已排/已出 ' + used + '）' })
    }

    const row = await prisma.shipmentSchedule.create({
      data: {
        salesOrderId,
        productId,
        qty,
        hubId: data.hubId as number,
        needByDate: new Date(data.needByDate as string),
        promisedDate: new Date(data.promisedDate as string),
        note: (data.note as string) || null,
      },
      include: INCLUDE,
    })
    return reply.code(200).send(row)
  })

  // 销售可改数量/仓/日期/取消；仓库只负责「已备好」（pending→picked）
  app.patch('/api/schedules/:id', { preHandler: requireRole('sales', 'warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '排程 ID 必须为正整数' })
    const data = parseBody(patchSchema, req.body, reply)
    if (data === null) return
    const role = (req as { user?: { role?: string } }).user?.role ?? ''

    const row = await prisma.shipmentSchedule.findUnique({ where: { id } })
    if (!row) return reply.code(404).send({ error: '排程不存在' })

    if (role === 'warehouse') {
      if (data.status !== 'picked' || Object.keys(data).some((k) => k !== 'status')) {
        return reply.code(400).send({ error: '仓库只能把排程标记为「已备好」' })
      }
      if (row.status !== 'pending') return reply.code(400).send({ error: '只有待备货的排程可以标记已备好' })
      const updated = await prisma.shipmentSchedule.update({ where: { id }, data: { status: 'picked' }, include: INCLUDE })
      return reply.code(200).send(updated)
    }

    // 销售/老板
    const update: Record<string, unknown> = {}
    if (data.qty !== undefined) {
      if (row.status !== 'pending' && row.status !== 'picked') {
        return reply.code(400).send({ error: '已出货/已取消的排程不能修改' })
      }
      // 改数量同样受「订单剩余」约束（BUG-05）：其他排程 + 已出 + 新数量 ≤ 订单该成品数量
      const order = await prisma.salesOrder.findUnique({ where: { id: row.salesOrderId }, include: { items: true } })
      if (!order) return reply.code(404).send({ error: '订单不存在' })
      const item = order.items.find((it) => it.productId === row.productId)
      if (!item) return reply.code(400).send({ error: '该成品不在订单明细中' })
      const [scheduled, shipped] = await Promise.all([
        prisma.shipmentSchedule.aggregate({
          where: { salesOrderId: row.salesOrderId, productId: row.productId, status: { not: 'cancelled' }, id: { not: row.id } },
          _sum: { qty: true },
        }),
        prisma.shipmentLine.aggregate({
          where: { salesOrderId: row.salesOrderId, productId: row.productId },
          _sum: { qty: true },
        }),
      ])
      const used = (scheduled._sum.qty ?? 0) + (shipped._sum.qty ?? 0)
      if (used + (data.qty as number) > item.qty) {
        return reply.code(400).send({ error: '排程数量超过订单剩余（订单 ' + item.qty + '，其他排程/已出 ' + used + '）' })
      }
      update.qty = data.qty
    }
    if (data.hubId !== undefined) {
      const hub = await prisma.shipToHub.findUnique({ where: { id: data.hubId as number } })
      if (!hub) return reply.code(404).send({ error: '到货仓不存在' })
      update.hubId = data.hubId
    }
    if (data.needByDate !== undefined) update.needByDate = new Date(data.needByDate as string)
    if (data.promisedDate !== undefined) update.promisedDate = new Date(data.promisedDate as string)
    if (data.note !== undefined) update.note = (data.note as string) || null
    if (data.status !== undefined) {
      if (data.status === 'picked') return reply.code(400).send({ error: '只有仓库可以标记「已备好」，销售请勿代标' })
      if (row.status === 'shipped') return reply.code(400).send({ error: '已出货的排程不能改状态' })
      update.status = data.status
    }
    const updated = await prisma.shipmentSchedule.update({ where: { id }, data: update, include: INCLUDE })
    return reply.code(200).send(updated)
  })

  app.delete('/api/schedules/:id', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '排程 ID 必须为正整数' })
    const row = await prisma.shipmentSchedule.findUnique({ where: { id } })
    if (!row) return reply.code(404).send({ error: '排程不存在' })
    if (row.status === 'shipped') return reply.code(400).send({ error: '已出货的排程不能删除' })
    await prisma.shipmentSchedule.delete({ where: { id } })
    return reply.code(200).send({ ok: true })
  })
}
