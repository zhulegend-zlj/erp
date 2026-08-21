import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo } from '../errors'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const returnReplenishSchema = z.object({
  partId: z.number({ error: '物料必填' }).int().positive(),
  supplierId: z.number({ error: '供应商必填' }).int().positive(),
  returnDate: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '退货日期不合法').optional(),
  returnQty: z.number({ error: '退货数量必须为数字' }).int().nonnegative().default(0),
  replenishDate: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '补货日期不合法').optional(),
  replenishQty: z.number({ error: '补货数量必须为数字' }).int().nonnegative().default(0),
  purchaseOrderNo: z.string().nullable().optional(),
  lotNo: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
})

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}

export function returnReplenishRoutes(app: FastifyInstance) {
  app.get('/api/return-replenishments', { preHandler: requireRole(...ALL_ROLES) }, async () => {
    return prisma.returnReplenish.findMany({
      orderBy: { createdAt: 'desc' as const },
      include: {
        part: { select: { id: true, sku: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    })
  })

  app.post('/api/return-replenishments', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(returnReplenishSchema, req.body, reply)
    if (data === null) return

    try {
      const record = await prisma.$transaction(async (tx) => {
        const created = await tx.returnReplenish.create({
          data: {
            partId: data.partId,
            supplierId: data.supplierId,
            returnDate: data.returnDate ? new Date(data.returnDate) : null,
            returnQty: data.returnQty,
            replenishDate: data.replenishDate ? new Date(data.replenishDate) : null,
            replenishQty: data.replenishQty,
            purchaseOrderNo: data.purchaseOrderNo || null,
            lotNo: data.lotNo || null,
            note: data.note || null,
          },
        })
        if (data.returnQty > 0) {
          await applyStockChange(tx, 'part', data.partId, -data.returnQty, 'return', created.id)
        }
        if (data.replenishQty > 0) {
          await applyStockChange(tx, 'part', data.partId, data.replenishQty, 'replenish', created.id)
        }
        return created
      })
      return reply.code(200).send(record)
    } catch (err) {
      const message = err instanceof Error ? err.message : '退补货失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '退补货失败：' + message })
    }
  })
}
