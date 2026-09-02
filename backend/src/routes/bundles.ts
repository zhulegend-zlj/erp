import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'

// 套餐价组（2026-09-01 老板设计）：外购零件打包一口价——供应商按「每套产品用量」报总价，
// 系统自动分摊出各零件单价并回写零件价格（Part.price / priceBundleId），零件列表/采购单直接可用。

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer'] as const
const WRITE_ROLES = ['boss', 'purchase'] as const

const bundleItemSchema = z.object({
  partId: z.number({ error: '零件必填' }).int().positive(),
  qty: z.number({ error: '每套用量必填' }).int().positive(),
  // 手改单价覆盖（可空=自动分摊）
  unitPrice: z.number({ error: '手改单价必须为数字' }).nonnegative().max(9999999999.99).nullable().optional(),
})

const bundleSchema = z.object({
  supplierId: z.number({ error: '供应商必填' }).int().positive(),
  name: z.string({ error: '套餐名必填' }).min(1, '套餐名必填').max(200, '套餐名过长（最多 200 字）'),
  totalPrice: z.number({ error: '每套总价必须为数字' }).nonnegative({ error: '每套总价必须为非负数' }).max(9999999999.99, '总价超出范围'),
  note: z.string().nullable().optional(),
  items: z.array(bundleItemSchema).min(1, '至少选 1 个零件'),
})

/** 分摊计算：手改单价的按「单价×用量」占用金额；其余成员均分剩余金额（等额单价法）。返回 partId→单价 */
function allocate(
  items: { partId: number; qty: number; unitPrice?: number | null | undefined }[],
  totalPrice: number,
): Map<number, number> {
  const result = new Map<number, number>()
  const overrideCost = items.reduce((sum, it) => sum + (it.unitPrice != null ? it.unitPrice * it.qty : 0), 0)
  const remaining = Math.max(0, totalPrice - overrideCost)
  const restQty = items.reduce((sum, it) => sum + (it.unitPrice == null ? it.qty : 0), 0)
  const unit = restQty > 0 ? remaining / restQty : 0
  for (const it of items) {
    const price = it.unitPrice != null ? it.unitPrice : unit
    result.set(it.partId, Math.round(price * 10000) / 10000)
  }
  return result
}

async function applyPartPrices(
  db: { part: { updateMany: typeof prisma.part.updateMany; update: typeof prisma.part.update } },
  bundleId: number,
  items: { partId: number; qty: number; unitPrice?: number | null | undefined }[],
  totalPrice: number,
) {
  const unitMap = allocate(items, totalPrice)
  // 先清掉旧成员的套餐关联（成员变更时旧成员解除关联）
  await db.part.updateMany({ where: { priceBundleId: bundleId }, data: { priceBundleId: null } })
  for (const [partId, unitPrice] of unitMap) {
    await db.part.update({
      where: { id: partId },
      data: { price: unitPrice, priceBundleId: bundleId },
    })
  }
}

function parseBundleId(req: { params: unknown }, reply: FastifyReply): number | null {
  const raw = (req.params as { id?: string } | undefined)?.id
  const id = parsePositiveInt(String(raw ?? ''))
  if (id === null) reply.code(400).send({ error: 'ID 必须为正整数' })
  return id
}

export function bundleRoutes(app: FastifyInstance) {
  // 套餐列表（含成员与分摊单价）
  app.get('/api/price-bundles', { preHandler: requireRole(...READ_ROLES) }, async () => {
    const bundles = await prisma.priceBundle.findMany({
      orderBy: { id: 'desc' },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { include: { part: { select: { id: true, sku: true, name: true, price: true } } }, orderBy: { partId: 'asc' } },
      },
    })
    return bundles.map((b) => ({
      id: b.id,
      supplierId: b.supplierId,
      supplierName: b.supplier.name,
      name: b.name,
      totalPrice: Number(b.totalPrice),
      note: b.note,
      items: b.items.map((it) => ({
        partId: it.partId,
        sku: it.part.sku,
        partName: it.part.name,
        qty: it.qty,
        unitPrice: it.unitPrice == null ? null : Number(it.unitPrice),
        allocatedPrice: it.part.price == null ? null : Number(it.part.price),
      })),
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }))
  })

  app.post('/api/price-bundles', { preHandler: requireRole(...WRITE_ROLES) }, async (req, reply) => {
    const data = parseBody(bundleSchema, req.body, reply)
    if (data === null) return
    const partIds = data.items.map((it) => it.partId)
    if (new Set(partIds).size !== partIds.length) return reply.code(400).send({ error: '套餐内零件重复' })
    const parts = await prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true } })
    if (parts.length !== partIds.length) return reply.code(400).send({ error: '存在不存在的零件' })
    // 同一零件不允许同时挂在两个套餐
    const conflicts = await prisma.part.findMany({
      where: { id: { in: partIds }, priceBundleId: { not: null } },
      select: { sku: true },
    })
    if (conflicts.length > 0) {
      return reply.code(400).send({ error: '零件已在其他套餐中：' + conflicts.map((c) => c.sku).join('、') })
    }
    const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId }, select: { id: true } })
    if (!supplier) return reply.code(404).send({ error: '供应商不存在' })

    const bundle = await prisma.$transaction(async (tx) => {
      const b = await tx.priceBundle.create({
        data: {
          supplierId: data.supplierId,
          name: data.name,
          totalPrice: data.totalPrice,
          note: data.note ?? null,
          items: { create: data.items.map((it) => ({ partId: it.partId, qty: it.qty, unitPrice: it.unitPrice ?? null })) },
        },
        include: { items: true },
      })
      await applyPartPrices(tx, b.id, data.items, data.totalPrice)
      return b
    })
    return reply.code(200).send(bundle)
  })

  app.put('/api/price-bundles/:id', { preHandler: requireRole(...WRITE_ROLES) }, async (req, reply) => {
    const id = parseBundleId(req, reply)
    if (id === null) return
    const bundle = await prisma.priceBundle.findUnique({ where: { id } })
    if (!bundle) return reply.code(404).send({ error: '套餐不存在' })
    const data = parseBody(bundleSchema, req.body, reply)
    if (data === null) return
    const partIds = data.items.map((it) => it.partId)
    if (new Set(partIds).size !== partIds.length) return reply.code(400).send({ error: '套餐内零件重复' })
    const parts = await prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true } })
    if (parts.length !== partIds.length) return reply.code(400).send({ error: '存在不存在的零件' })
    const conflicts = await prisma.part.findMany({
      where: { id: { in: partIds }, AND: [{ priceBundleId: { not: null } }, { priceBundleId: { not: id } }] },
      select: { sku: true },
    })
    if (conflicts.length > 0) {
      return reply.code(400).send({ error: '零件已在其他套餐中：' + conflicts.map((c) => c.sku).join('、') })
    }
    await prisma.$transaction(async (tx) => {
      await tx.priceBundle.update({ where: { id }, data: { supplierId: data.supplierId, name: data.name, totalPrice: data.totalPrice, note: data.note ?? null } })
      await tx.priceBundleItem.deleteMany({ where: { bundleId: id } })
      await tx.priceBundleItem.createMany({ data: data.items.map((it) => ({ bundleId: id, partId: it.partId, qty: it.qty, unitPrice: it.unitPrice ?? null })) })
      await applyPartPrices(tx, id, data.items, data.totalPrice)
    })
    return reply.code(200).send({ id })
  })

  // 删除套餐：成员解除套餐关联（价格保留为手填价），成员记录级联删除
  app.delete('/api/price-bundles/:id', { preHandler: requireRole(...WRITE_ROLES) }, async (req, reply) => {
    const id = parseBundleId(req, reply)
    if (id === null) return
    const bundle = await prisma.priceBundle.findUnique({ where: { id } })
    if (!bundle) return reply.code(404).send({ error: '套餐不存在' })
    await prisma.$transaction(async (tx) => {
      await tx.part.updateMany({ where: { priceBundleId: id }, data: { priceBundleId: null } })
      await tx.priceBundle.delete({ where: { id } })
    })
    return reply.code(200).send({ ok: true })
  })
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}
