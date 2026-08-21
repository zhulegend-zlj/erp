import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo, parsePositiveInt } from '../errors'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const createShipmentSchema = z.object({
  salesOrderId: z
    .number({ error: '订单必填' })
    .int({ error: '订单必须为整数' })
    .positive({ error: '订单必须为正整数' }),
  shippedAt: z
    .string({ error: '出货时间必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '出货时间必须为合法日期')
    .optional(),
})

const createLegSchema = z.object({
  node: z.string({ error: '运输节点必填' }).min(1, '运输节点必填'),
  at: z
    .string({ error: '节点时间必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '节点时间必须为合法日期')
    .optional(),
  note: z.string().optional(),
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

const LEGS_INCLUDE = {
  legs: { orderBy: { at: 'desc' as const } },
} as const

export function shippingRoutes(app: FastifyInstance) {
  // 出货：仅 sales，事务内创建出货单 + 扣减成品库存 + 订单状态置为 shipped
  app.post('/api/shipments', { preHandler: requireRole('sales') }, async (req, reply) => {
    const data = parseBody(createShipmentSchema, req.body, reply)
    if (data === null) return

    try {
      const shipment = await prisma.$transaction(async (tx) => {
        const order = await tx.salesOrder.findUnique({
          where: { id: data.salesOrderId },
          include: { items: true },
        })
        if (!order) throw new Error('订单不存在')
        if (order.status === 'shipped' || order.status === 'completed') throw new Error('订单已出货')
        if (order.status !== 'ready') throw new Error('订单未到待出货状态，不能出货')

        const created = await tx.shipment.create({
          data: {
            salesOrderId: data.salesOrderId,
            ...(data.shippedAt ? { shippedAt: new Date(data.shippedAt) } : {}),
          },
        })
        for (const item of order.items) {
          await applyStockChange(tx, 'product', item.productId, -item.qty, 'shipment', created.id, order.id)
        }
        await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'shipped' } })
        return created
      })
      return reply.code(200).send(shipment)
    } catch (err) {
      const message = err instanceof Error ? err.message : '出货失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      if (message.includes('订单已出货')) return reply.code(400).send({ error: message })
      if (message.includes('待出货状态')) return reply.code(400).send({ error: message })
      if (message.includes('订单不存在')) return reply.code(404).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '出货失败：' + message })
    }
  })

  // 追加运输节点：仅 sales
  app.post('/api/shipments/:id/legs', { preHandler: requireRole('sales') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '出货单 ID 必须为正整数' })
    const data = parseBody(createLegSchema, req.body, reply)
    if (data === null) return

    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: '出货单不存在' })

    const leg = await prisma.shipmentLeg.create({
      data: {
        shipmentId: id,
        node: data.node,
        ...(data.at ? { at: new Date(data.at) } : {}),
        ...(data.note !== undefined && data.note !== '' ? { note: data.note } : {}),
      },
    })
    return reply.code(200).send(leg)
  })

  // 出货单列表：5 角色均可查，可选按订单过滤，legs 按 at 倒序
  app.get('/api/shipments', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const raw = (req.query as { orderId?: string }).orderId
    let where: { salesOrderId?: number } = {}
    if (raw !== undefined) {
      const orderId = Number(raw)
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return reply.code(400).send({ error: 'orderId 必须为正整数' })
      }
      where = { salesOrderId: orderId }
    }
    return prisma.shipment.findMany({
      where,
      orderBy: { id: 'desc' },
      include: LEGS_INCLUDE,
    })
  })
}