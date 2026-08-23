import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { parsePositiveInt, prismaErrorInfo } from '../errors'
import { parsePagination, pagedResult } from '../pagination'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const returnReplenishSchema = z
  .object({
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
  .refine((v) => v.returnQty + v.replenishQty > 0, {
    message: '退货与补货数量至少填写一项',
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
  app.get('/api/return-replenishments', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      part: { select: { id: true, sku: true, name: true } },
      supplier: { select: { id: true, name: true } },
    } as const
    const orderBy = { createdAt: 'desc' as const }
    if (pagination.kind === 'none') {
      return prisma.returnReplenish.findMany({ orderBy, include })
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.returnReplenish.findMany({
        orderBy,
        include,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.returnReplenish.count(),
    ])
    return pagedResult(rows, total, page)
  })

  app.post('/api/return-replenishments', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(returnReplenishSchema, req.body, reply)
    if (data === null) return

    try {
      const record = await prisma.$transaction(async (tx) => {
        // 供应商归属校验：退补货对象必须是该零件当前挂的供应商（或绑定采购单对应的供应商）
        const part = await tx.part.findUnique({
          where: { id: data.partId },
          select: { supplierId: true },
        })
        if (!part) throw new Error('物料不存在')
        let expectedSupplierId = part.supplierId ?? null
        if (data.purchaseOrderNo) {
          // 绑定采购单：必须真实存在，且该物料必须属于该采购单
          const po = await tx.purchaseOrder.findUnique({
            where: { orderNo: data.purchaseOrderNo },
            select: { id: true, supplierId: true, items: { select: { partId: true } } },
          })
          if (!po) throw new Error('采购单不存在')
          expectedSupplierId = po.supplierId
          if (!po.items.some((i) => i.partId === data.partId)) {
            throw new Error('该物料不属于所选采购单')
          }
        }
        if (expectedSupplierId !== null && expectedSupplierId !== data.supplierId) {
          throw new Error('退补货的供应商与零件/采购单不匹配')
        }
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
      if (message.includes('不匹配') || message.includes('不属于所选采购单') || message.includes('不存在')) {
        if (message.includes('采购单不存在')) return reply.code(404).send({ error: message })
        return reply.code(400).send({ error: message })
      }
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '退补货失败，请稍后重试' })
    }
  })

  // 撤销退补货：退货数量加回、补货数量扣回，原流水保留，新增 void 冲销流水
  app.delete('/api/return-replenishments/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '退补货记录 ID 必须为正整数' })
    try {
      await prisma.$transaction(async (tx) => {
        const record = await tx.returnReplenish.findUnique({ where: { id } })
        if (!record) throw new Error('退补货记录不存在')
        if (record.returnQty > 0) {
          await applyStockChange(tx, 'part', record.partId, record.returnQty, 'void', id)
        }
        if (record.replenishQty > 0) {
          await applyStockChange(tx, 'part', record.partId, -record.replenishQty, 'void', id)
        }
        await tx.returnReplenish.delete({ where: { id } })
      })
      return reply.code(200).send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '撤销退补货失败'
      if (message.includes('退补货记录不存在')) return reply.code(404).send({ error: message })
      if (message.includes('库存不足')) return reply.code(400).send({ error: '该记录已被后续领用/使用，无法撤销' })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '撤销退补货失败，请稍后重试' })
    }
  })
}
