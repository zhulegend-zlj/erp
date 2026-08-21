import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const
const WRITE_ROLES = ['boss', 'purchase'] as const

const customerSchema = z.object({
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  country: z.string().optional(),
  contact: z.string().optional(),
})

const supplierSchema = z.object({
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  contact: z.string().optional(),
})

const productSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  unit: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
})

const partSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  unit: z.string().optional(),
  spec: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  drawingsUrl: z.string().nullable().optional(),
  tooling: z.string().nullable().optional(),
  moq: z.number({ error: 'MOQ 必须为整数' }).int().positive().nullable().optional(),
  price: z.number({ error: '价格必须为数字' }).nonnegative().nullable().optional(),
  supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
})

const bomSchema = z.array(
  z.object({
    partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
    qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
  }),
)

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}

function parseId(req: { params: { id: string } }, reply: FastifyReply): number | null {
  const id = parsePositiveInt(req.params.id)
  if (id === null) {
    reply.code(400).send({ error: 'ID 必须为正整数' })
    return null
  }
  return id
}

interface CrudSpec {
  resource: 'customer' | 'supplier' | 'product' | 'part'
  schema: z.ZodTypeAny
}

function registerCrud(app: FastifyInstance, spec: CrudSpec) {
  const delegate = (prisma as any)[spec.resource]
  const read = requireRole(...READ_ROLES)
  const write = requireRole(...WRITE_ROLES)
  const base = `/api/${spec.resource}s`

  app.get(base, { preHandler: read }, async () => {
    return delegate.findMany({ orderBy: { id: 'asc' } })
  })

  app.post(base, { preHandler: write }, async (req, reply) => {
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const record = await delegate.create({ data })
    return reply.code(200).send(record)
  })

  app.put(`${base}/:id`, { preHandler: write }, async (req, reply) => {
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const id = parseId(req as { params: { id: string } }, reply)
    if (id === null) return
    const record = await delegate.update({ where: { id }, data })
    return reply.code(200).send(record)
  })

  app.delete(`${base}/:id`, { preHandler: write }, async (req, reply) => {
    const id = parseId(req as { params: { id: string } }, reply)
    if (id === null) return
    await delegate.delete({ where: { id } })
    return reply.code(200).send({ ok: true })
  })
}

export function mastersRoutes(app: FastifyInstance) {
  registerCrud(app, { resource: 'customer', schema: customerSchema })
  registerCrud(app, { resource: 'supplier', schema: supplierSchema })
  registerCrud(app, { resource: 'product', schema: productSchema })
  registerCrud(app, { resource: 'part', schema: partSchema })

  app.get('/api/products/:id/bom', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const productId = parseId(req as { params: { id: string } }, reply)
    if (productId === null) return
    return prisma.bom.findMany({
      where: { productId },
      orderBy: { partId: 'asc' },
      include: { part: { select: { id: true, sku: true, name: true } } },
    })
  })

  app.put('/api/products/:id/bom', { preHandler: requireRole(...WRITE_ROLES) }, async (req, reply) => {
    const productId = parseId(req as { params: { id: string } }, reply)
    if (productId === null) return
    const items = parseBody(bomSchema, req.body, reply)
    if (items === null) return
    await prisma.$transaction([
      prisma.bom.deleteMany({ where: { productId } }),
      prisma.bom.createMany({ data: items.map((item) => ({ productId, ...item })) }),
    ])
    const boms = await prisma.bom.findMany({
      where: { productId },
      orderBy: { partId: 'asc' },
      include: { part: { select: { id: true, sku: true, name: true } } },
    })
    return reply.code(200).send(boms)
  })
}
