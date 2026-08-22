import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
import {
  movePartFolder,
  moveProductFolder,
  partDirName,
  placeRootFileIntoPartFolder,
  rehomePartFolder,
  removePartFolder,
  slugify,
  urlFor,
} from '../uploads-store'

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer'] as const
// 客户/供应商：采购与老板维护
const SUPPLIER_WRITE_ROLES = ['boss', 'purchase'] as const
// 成品/零件/BOM：工程与老板维护
const ENGINEER_WRITE_ROLES = ['boss', 'engineer'] as const

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

// 采购在零件上的写权限：供应商（挂链接）与价格；其余字段一律拒绝
const purchasePartUpdateSchema = z.object({
  supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
  price: z.number({ error: '价格必须为数字' }).nonnegative({ error: '价格必须为非负数' }).nullable().optional(),
})

const bomSchema = z.array(
  z.object({
    partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
    qty: z.number({ error: '数量必填' }).int({ error: '数量必须为整数' }).positive({ error: '数量必须为正整数' }),
  }),
)

async function productSkusForPart(partId: number): Promise<string[]> {
  const boms = await prisma.bom.findMany({
    where: { partId },
    include: { product: { select: { sku: true } } },
  })
  return boms.map((b) => b.product.sku)
}

/** 按零件文件夹内的文件更新零件图片/图档 URL（归位或改名后调用） */
async function syncPartUrlsFromFolder(partId: number, relDir: string, files: string[]): Promise<void> {
  const drawingFile = files.find((f) => f.includes('-图档.'))
  const imageFile = files.find((f) => !f.includes('-图档.'))
  const data: { imageUrl?: string; drawingsUrl?: string } = {}
  if (imageFile) data.imageUrl = urlFor(relDir, imageFile)
  if (drawingFile) data.drawingsUrl = urlFor(relDir, drawingFile)
  if (data.imageUrl || data.drawingsUrl) {
    await prisma.part.update({ where: { id: partId }, data })
  }
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
  writeRoles: readonly string[]
}

function registerCrud(app: FastifyInstance, spec: CrudSpec) {
  const delegate = (prisma as any)[spec.resource]
  const read = requireRole(...READ_ROLES)
  const write = requireRole(...spec.writeRoles)
  const base = `/api/${spec.resource}s`

  app.get(base, { preHandler: read }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })

    // 零件：按 SKU 字母前缀分组（同一产品族排在一起），组内按 SKU 中的数字从小到大排序
    if (spec.resource === 'part') {
      const orderBySql = Prisma.sql`ORDER BY lower(substring("sku" FROM '^[A-Za-z]*')) ASC, (SELECT array_agg(x)::bigint[] FROM regexp_matches("sku", '[0-9]+', 'g') AS x) ASC, "sku" ASC`
      if (pagination.kind === 'none') {
        const rows = await prisma.$queryRaw(Prisma.sql`SELECT * FROM "Part" ${orderBySql}`)
        return rows
      }
      const page = pagination.page
      const offset = (page.page - 1) * page.pageSize
      const [rows, total] = await Promise.all([
        prisma.$queryRaw(Prisma.sql`SELECT * FROM "Part" ${orderBySql} LIMIT ${page.pageSize} OFFSET ${offset}`),
        prisma.part.count(),
      ])
      return pagedResult(rows as unknown[], total, page)
    }

    if (pagination.kind === 'none') {
      return delegate.findMany({ orderBy: { id: 'asc' } })
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      delegate.findMany({
        orderBy: { id: 'asc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      delegate.count({}),
    ])
    return pagedResult(rows as unknown[], total, page)
  })

  app.post(base, { preHandler: write }, async (req, reply) => {
    // 零件：价格归采购维护，工程创建时不可填写
    if (spec.resource === 'part') {
      const role = (req as { user?: { role?: string } }).user?.role
      if (role === 'engineer' && 'price' in ((req.body as object) ?? {})) {
        return reply.code(400).send({ error: '价格由采购维护，工程不可填写' })
      }
    }
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const record = await delegate.create({ data })
    return reply.code(200).send(record)
  })

  // 零件特殊：采购只能维护供应商与价格；boss 全量修改；工程全量修改但不可动价格
  const putRoles = spec.resource === 'part' ? requireRole('boss', 'engineer', 'purchase') : write
  app.put(`${base}/:id`, { preHandler: putRoles }, async (req, reply) => {
    const id = parseId(req as { params: { id: string } }, reply)
    if (id === null) return
    const role = (req as { user?: { role?: string } }).user?.role
    if (spec.resource === 'part') {
      const body = (req.body as object) ?? {}
      if (role === 'purchase') {
        const keys = Object.keys(body)
        if (keys.length === 0) {
          return reply.code(400).send({ error: '请至少提供 supplierId 或 price' })
        }
        if (keys.some((k) => k !== 'supplierId' && k !== 'price')) {
          return reply.code(400).send({ error: '采购仅可修改零件的供应商与价格，其他资料请联系工程维护' })
        }
        const data = parseBody(purchasePartUpdateSchema, req.body, reply)
        if (data === null) return
        const record = await delegate.update({ where: { id }, data })
        return reply.code(200).send(record)
      }
      if (role === 'engineer' && 'price' in body) {
        return reply.code(400).send({ error: '价格由采购维护，工程不可修改' })
      }
    }
    const before =
      spec.resource === 'part' || spec.resource === 'product'
        ? await delegate.findUnique({ where: { id } }).catch(() => null)
        : null
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const record = await delegate.update({ where: { id }, data })

    // 零件改名/改 SKU：移动文件夹并同步图片/图档 URL
    if (spec.resource === 'part' && before && (before.sku !== record.sku || before.name !== record.name)) {
      const productSkus = await productSkusForPart(record.id)
      const moved = await movePartFolder(partDirName(before.sku, before.name), partDirName(record.sku, record.name), productSkus)
      await syncPartUrlsFromFolder(record.id, moved.relDir, moved.files)
    }
    // 成品改 SKU：移动成品目录并更新其中所有文件 URL 前缀
    if (spec.resource === 'product' && before && before.sku !== record.sku) {
      const { moved } = await moveProductFolder(before.sku, record.sku)
      if (moved) {
        const oldPrefix = '/uploads/' + slugify(before.sku) + '/'
        const newPrefix = '/uploads/' + slugify(record.sku) + '/'
        const upd = await prisma.product.findUnique({ where: { id: record.id } })
        if (upd?.imageUrl?.startsWith(oldPrefix)) {
          await prisma.product.update({
            where: { id: record.id },
            data: { imageUrl: upd.imageUrl.replace(oldPrefix, newPrefix) },
          })
        }
        const parts = await prisma.part.findMany({
          where: { OR: [{ imageUrl: { startsWith: oldPrefix } }, { drawingsUrl: { startsWith: oldPrefix } }] },
          select: { id: true, imageUrl: true, drawingsUrl: true },
        })
        for (const p of parts) {
          await prisma.part.update({
            where: { id: p.id },
            data: {
              ...(p.imageUrl?.startsWith(oldPrefix) ? { imageUrl: p.imageUrl.replace(oldPrefix, newPrefix) } : {}),
              ...(p.drawingsUrl?.startsWith(oldPrefix) ? { drawingsUrl: p.drawingsUrl.replace(oldPrefix, newPrefix) } : {}),
            },
          })
        }
      }
    }
    return reply.code(200).send(record)
  })

  app.delete(`${base}/:id`, { preHandler: write }, async (req, reply) => {
    const id = parseId(req as { params: { id: string } }, reply)
    if (id === null) return
    if (spec.resource === 'part') {
      const before = await delegate.findUnique({ where: { id } }).catch(() => null)
      await delegate.delete({ where: { id } })
      if (before) await removePartFolder(partDirName(before.sku, before.name))
    } else {
      await delegate.delete({ where: { id } })
    }
    return reply.code(200).send({ ok: true })
  })
}

export function mastersRoutes(app: FastifyInstance) {
  registerCrud(app, { resource: 'customer', schema: customerSchema, writeRoles: SUPPLIER_WRITE_ROLES })
  registerCrud(app, { resource: 'supplier', schema: supplierSchema, writeRoles: SUPPLIER_WRITE_ROLES })
  registerCrud(app, { resource: 'product', schema: productSchema, writeRoles: ENGINEER_WRITE_ROLES })
  registerCrud(app, { resource: 'part', schema: partSchema, writeRoles: ENGINEER_WRITE_ROLES })

  app.get('/api/products/:id/bom', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const productId = parseId(req as { params: { id: string } }, reply)
    if (productId === null) return
    return prisma.bom.findMany({
      where: { productId },
      orderBy: { partId: 'asc' },
      include: { part: { select: { id: true, sku: true, name: true } } },
    })
  })

  app.put('/api/products/:id/bom', { preHandler: requireRole(...ENGINEER_WRITE_ROLES) }, async (req, reply) => {
    const productId = parseId(req as { params: { id: string } }, reply)
    if (productId === null) return
    const items = parseBody(bomSchema, req.body, reply)
    if (items === null) return
    const oldPartIds = (await prisma.bom.findMany({ where: { productId }, select: { partId: true } })).map((b) => b.partId)
    await prisma.$transaction([
      prisma.bom.deleteMany({ where: { productId } }),
      prisma.bom.createMany({ data: items.map((item) => ({ productId, ...item })) }),
    ])
    // 保存 BOM 后把受影响的零件文件归位（_未分类 → 成品目录 / _共用），并同步数据库 URL
    const affected = [...new Set([...oldPartIds, ...items.map((i) => i.partId)])]
    for (const partId of affected) {
      const part = await prisma.part.findUnique({ where: { id: partId } })
      if (!part) continue
      const productSkus = await productSkusForPart(partId)
      const partDir = partDirName(part.sku, part.name)
      const result = await rehomePartFolder(partDir, productSkus)
      await syncPartUrlsFromFolder(partId, result.relDir, result.files)
      // 旧版兜底：图片/图档若还是根目录 uuid 文件，一并归入零件文件夹
      const imageUrl = await placeRootFileIntoPartFolder(part.imageUrl, result.relDir, 'image')
      if (imageUrl) await prisma.part.update({ where: { id: partId }, data: { imageUrl } })
      const drawingsUrl = await placeRootFileIntoPartFolder(part.drawingsUrl, result.relDir, 'drawing')
      if (drawingsUrl) await prisma.part.update({ where: { id: partId }, data: { drawingsUrl } })
    }
    const boms = await prisma.bom.findMany({
      where: { productId },
      orderBy: { partId: 'asc' },
      include: { part: { select: { id: true, sku: true, name: true } } },
    })
    return reply.code(200).send(boms)
  })
}
