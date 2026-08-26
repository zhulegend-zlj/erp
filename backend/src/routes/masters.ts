import type { FastifyInstance, FastifyReply } from 'fastify'
import { mkdir, readdir, readFile, rename, rename as renameFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import ExcelJS from 'exceljs'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
import {
  movePartFolder,
  moveProductFolder,
  partDirName,
  partTargetRelDir,
  placeRootFileIntoPartFolder,
  removePartFolder,
  SHARED,
  slugify,
  UNCATEGORIZED,
  UPLOAD_DIR,
  urlFor,
} from '../uploads-store'

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer'] as const
// 客户/供应商：采购与老板维护；客户额外开放给销售（销售最熟客户，可增改删）
const SUPPLIER_WRITE_ROLES = ['boss', 'purchase'] as const
const CUSTOMER_WRITE_ROLES = ['boss', 'purchase', 'sales'] as const
// 成品/零件/BOM：工程与老板维护
const ENGINEER_WRITE_ROLES = ['boss', 'engineer'] as const

const customerSchema = z.object({
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  country: z.string().optional(),
  contact: z.string().optional(),
  // 单证字段：收货地址/VAT/EORI/通知方（发票/装箱单自动带出）
  address: z.string().nullable().optional(),
  vatNo: z.string().nullable().optional(),
  eori: z.string().nullable().optional(),
  notifyParty: z.string().nullable().optional(),
  // 单证默认值（新建订单/出货自动带出）
  defaultPaymentTerms: z.string().nullable().optional(),
  defaultIncoterm: z.string().nullable().optional(),
  defaultMark: z.string().nullable().optional(),
  defaultTaxRate: z.string().nullable().optional(),
})

const supplierSchema = z.object({
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  contact: z.string().optional(),
})

const productSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  // 单证字段：英文品名（发票 Description 列）、海关编码
  nameEn: z.string().nullable().optional(),
  hsCode: z.string().nullable().optional(),
  unit: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
})

const partSchema = z.object({
  sku: z.string({ error: 'SKU 必填' }).min(1, 'SKU 必填'),
  name: z.string({ error: '名称必填' }).min(1, '名称必填'),
  nameEn: z.string().nullable().optional(),
  unit: z.string().optional(),
  spec: z.string().nullable().optional(),
  weight: z.string().nullable().optional(),
  revision: z.string().nullable().optional(),
  material: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  artId: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  drawingsUrl: z.string().nullable().optional(),
  tooling: z.string().nullable().optional(),
  usedIn: z.string().nullable().optional(),
  process: z.string().nullable().optional(),
  moq: z.number({ error: 'MOQ 必须为整数' }).int().positive().max(2147483647, { error: 'MOQ 超出允许范围' }).nullable().optional(),
  price: z
    .number({ error: '价格必须为数字' })
    .nonnegative({ error: '价格必须为非负数' })
    .max(9999999999.99, { error: '价格超出允许范围' })
    .nullable()
    .optional(),
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
  // 主图档 = <partDir>-图档.<ext>（-图档2.pdf 等旧版留档不算图档）；图片 = 图片扩展名文件。
  // 注意：不能用「不含 -图档. 的文件就是图片」判断——-图档2.pdf 不含该子串，会被误判成图片。
  const drawingFile = files.find((f) => /-图档\.[^.]+$/i.test(f))
  const imageFile = files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && !f.includes('图档'))
  const newImage = imageFile ? urlFor(relDir, imageFile) : null
  const newDrawing = drawingFile ? urlFor(relDir, drawingFile) : null
  if (!newImage && !newDrawing) return
  // 与库内现值比较，未变化则跳过写库（避免保存 BOM 时对每个零件做无效 UPDATE）
  const current = await prisma.part.findUnique({ where: { id: partId }, select: { imageUrl: true, drawingsUrl: true } })
  const data: { imageUrl?: string; drawingsUrl?: string } = {}
  if (newImage && current?.imageUrl !== newImage) data.imageUrl = newImage
  if (newDrawing && current?.drawingsUrl !== newDrawing) data.drawingsUrl = newDrawing
  if (data.imageUrl || data.drawingsUrl) {
    await prisma.part.update({ where: { id: partId }, data })
  }
}

// 零件可空文本字段：空字符串统一归一为 null（前端与直调接口都安全）
const PART_NULLABLE_TEXT_KEYS = [
  'spec', 'nameEn', 'weight', 'revision', 'material', 'dimensions', 'finish', 'artId',
  'imageUrl', 'drawingsUrl', 'tooling', 'usedIn', 'process',
] as const

function normalizePartText(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const k of PART_NULLABLE_TEXT_KEYS) {
    if (out[k] === '') out[k] = null
  }
  return out
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

/** 解析 PNG/JPEG 尺寸（用于导出表格时保持缩略图比例） */
function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
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
      // 搜索：料号/中文名称/英文品名/供应商/表面处理，不区分大小写模糊匹配（LIKE 特殊字符转义）
      const searchRaw = (req.query as Record<string, unknown>).search
      let search = ''
      if (searchRaw !== undefined && searchRaw !== null) {
        if (typeof searchRaw !== 'string') return reply.code(400).send({ error: 'search 必须为字符串' })
        search = searchRaw.trim().slice(0, 100)
      }
      // 成品筛选：只显示该成品 BOM 内的零件
      const productIdRaw = (req.query as Record<string, unknown>).productId
      let productId: number | null = null
      if (productIdRaw !== undefined && productIdRaw !== null && String(productIdRaw) !== '') {
        productId = parsePositiveInt(String(productIdRaw))
        if (productId === null) return reply.code(400).send({ error: 'productId 必须为正整数' })
        const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
        if (!product) return reply.code(404).send({ error: '成品不存在' })
      }
      const conds: Prisma.Sql[] = []
      if (search) {
        const escaped = search.replace(/[\\%_]/g, (c) => '\\' + c)
        const pattern = '%' + escaped + '%'
        conds.push(Prisma.sql`(lower("sku") LIKE lower(${pattern}) ESCAPE '\\' OR lower("name") LIKE lower(${pattern}) ESCAPE '\\' OR lower(coalesce("nameEn", '')) LIKE lower(${pattern}) ESCAPE '\\' OR lower(coalesce("finish", '')) LIKE lower(${pattern}) ESCAPE '\\' OR EXISTS (SELECT 1 FROM "Supplier" s WHERE s.id = "Part"."supplierId" AND lower(s.name) LIKE lower(${pattern}) ESCAPE '\\'))`)
      }
      if (productId !== null) {
        conds.push(Prisma.sql`id IN (SELECT "partId" FROM "Bom" WHERE "productId" = ${productId})`)
      }
      const whereSql = conds.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty
      const role = (req as { user?: { role?: string } }).user?.role ?? ''
      // 采购价格仅采购/老板可见：其余角色（工程/仓库/销售/财务）剥离 price
      const hidePrice = role !== 'purchase' && role !== 'boss'
      const strip = (rows: unknown[]) =>
        hidePrice ? rows.map((r) => { const { price: _price, ...rest } = (r ?? {}) as Record<string, unknown>; return rest }) : rows
      if (pagination.kind === 'none') {
        const rows = await prisma.$queryRaw(Prisma.sql`SELECT * FROM "Part" ${whereSql} ${orderBySql}`)
        return strip(rows as unknown[])
      }
      const page = pagination.page
      const offset = (page.page - 1) * page.pageSize
      const [rows, totalRows] = await Promise.all([
        prisma.$queryRaw(Prisma.sql`SELECT * FROM "Part" ${whereSql} ${orderBySql} LIMIT ${page.pageSize} OFFSET ${offset}`),
        prisma.$queryRaw`SELECT count(*)::int AS n FROM "Part" ${whereSql}`,
      ])
      const total = (totalRows as { n: number }[])[0]?.n ?? 0
      return pagedResult(strip(rows as unknown[]), total, page)
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
    // 零件：价格与供应商归采购维护，工程创建时不可填写
    if (spec.resource === 'part') {
      const role = (req as { user?: { role?: string } }).user?.role
      if (role === 'engineer') {
        const body = (req.body as object) ?? {}
        if ('price' in body) return reply.code(400).send({ error: '价格由采购维护，工程不可填写' })
        if ('supplierId' in body) return reply.code(400).send({ error: '供应商由采购维护，工程不可填写' })
      }
    }
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const record = await delegate.create({ data: spec.resource === 'part' ? normalizePartText(data as Record<string, unknown>) : data })
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
      if (role === 'engineer') {
        if ('price' in body) return reply.code(400).send({ error: '价格由采购维护，工程不可修改' })
        if ('supplierId' in body) return reply.code(400).send({ error: '供应商由采购维护，工程不可修改' })
      }
    }
    const before =
      spec.resource === 'part' || spec.resource === 'product'
        ? await delegate.findUnique({ where: { id } }).catch(() => null)
        : null
    const data = parseBody(spec.schema, req.body, reply)
    if (data === null) return
    const record = await delegate.update({
      where: { id },
      data: spec.resource === 'part' ? normalizePartText(data as Record<string, unknown>) : data,
    })

    // 零件改名/改 SKU：移动文件夹并同步图片/图档 URL
    if (spec.resource === 'part' && before && (before.sku !== record.sku || before.name !== record.name)) {
      const productSkus = await productSkusForPart(record.id)
      const moved = await movePartFolder(partDirName(before.sku, before.name), partDirName(record.sku, record.name), productSkus)
      await syncPartUrlsFromFolder(record.id, moved.relDir, moved.files)
    }
    // 成品改 SKU：移动成品目录并更新其中所有文件 URL 前缀
    if (spec.resource === 'product' && before && (before.sku !== record.sku || before.name !== record.name)) {
      const { moved } = await moveProductFolder(before.sku, record.sku)
      // 成品图片文件名跟随 SKU/名称：<SKU>-<名称>.ext
      const relDir = slugify(record.sku)
      const oldName = [slugify(before.sku), slugify(before.name)].filter(Boolean).join('-')
      const newName = [slugify(record.sku), slugify(record.name)].filter(Boolean).join('-')
      const prod = await prisma.product.findUnique({ where: { id: record.id } })
      if (prod?.imageUrl && oldName !== newName) {
        const ext = prod.imageUrl.slice(prod.imageUrl.lastIndexOf('.'))
        const oldPath = resolve(UPLOAD_DIR, relDir, oldName + ext)
        const newPath = resolve(UPLOAD_DIR, relDir, newName + ext)
        if (await stat(oldPath).then(() => true).catch(() => false)) {
          await renameFile(oldPath, newPath).catch(() => {})
          await prisma.product.update({
            where: { id: record.id },
            data: { imageUrl: urlFor(relDir, newName + ext) },
          })
        }
      }
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
  registerCrud(app, { resource: 'customer', schema: customerSchema, writeRoles: CUSTOMER_WRITE_ROLES })
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

  // BOM 一键导出：13 列（序号/料号/图片/Description-EN/英文品名/中文名称/重量/版本/材质/尺寸规格/表面处理/用量/供应商），
  // 嵌入图片缩略图 + 表头样式 + 冻结首行 + 每列排序筛选，文件名带 erp
  app.get('/api/products/:id/bom/export', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const productId = parseId(req as { params: { id: string } }, reply)
    if (productId === null) return
    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) return reply.code(404).send({ error: '成品不存在' })
    const boms = await prisma.bom.findMany({
      where: { productId },
      include: { part: { include: { supplier: { select: { name: true } } } } },
    })
    // 排序与零件页一致：SKU 字母前缀分组 + 组内数字升序
    const prefixOf = (s: string) => (s.match(/^[A-Za-z]*/)?.[0] ?? '').toLowerCase()
    const digitsOf = (s: string) => (s.match(/[0-9]+/g) ?? []).map(Number)
    const cmp = (a: string, b: string) => {
      const pa = prefixOf(a)
      const pb = prefixOf(b)
      if (pa !== pb) return pa < pb ? -1 : 1
      const da = digitsOf(a)
      const db = digitsOf(b)
      for (let i = 0; i < Math.max(da.length, db.length); i++) {
        const x = da[i] ?? -1
        const y = db[i] ?? -1
        if (x !== y) return x - y
      }
      return a < b ? -1 : a > b ? 1 : 0
    }
    boms.sort((x, y) => cmp(x.part.sku, y.part.sku))
    // 导出列（权限口径）：基础 13 列（序号/料号/图片/Description-EN/英文品名/中文名称/重量/版本/材质/尺寸规格/表面处理/用量/供应商）；
    // 采购/老板额外在「用量」后带「价格」列（与零件列表价格可见性口径一致），其余角色无价格列
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const showPrice = role === 'purchase' || role === 'boss'
    const header = [
      'Item-No.\n序号', 'Part ID\n料号', 'photo\n图片', 'Description - EN', 'Part name (EN)\n（英文品名）',
      'Part Name （CN）\n中文名称', 'Weight（g)\n重量', 'Revision\n版本', 'Material \n材质', 'Dimensions\n尺寸规格 ',
      'Finish\n表面处理', 'Amout\n用量',
      ...(showPrice ? ['price   价格'] : []),
      'Vendorid\n供应商',
    ]
    const widths = [8, 16, 12, 14, 26, 26, 10, 8, 24, 20, 22, 8, ...(showPrice ? [10] : []), 14]
    // exceljs 生成：嵌入图片缩略图 + 表头样式 + 冻结首行 + 每列筛选排序
    const wb = new ExcelJS.Workbook()
    wb.creator = 'erp'
    const ws = wb.addWorksheet(product.sku, { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = header.map((h, i) => ({ header: h, key: 'c' + i, width: widths[i] ?? 10 }))
    const headerRow = ws.getRow(1)
    headerRow.height = 32
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 11 }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FF' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    })
    const IMG_COL_INDEX = 2 // C 列（图片，0 基）
    for (let i = 0; i < boms.length; i++) {
      const b = boms[i]!
      const p = b.part
      const row = ws.addRow([
        i + 1, // 序号
        p.sku, // 料号
        '', // 图片（下方嵌入缩略图）
        '', // Description-EN（未录入）
        p.nameEn ?? '', // 英文品名
        p.name, // 中文名称
        p.weight ?? '', // 重量
        p.revision ?? '', // 版本
        p.material ?? '', // 材质
        p.dimensions ?? '', // 尺寸规格
        p.finish ?? '', // 表面处理
        b.qty, // 用量
        ...(showPrice ? [p.price == null ? '' : Number(p.price.toString())] : []), // 价格（仅采购/老板）
        p.supplier?.name ?? '', // 供应商
      ])
      row.eachCell((cell) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
        cell.alignment = { vertical: 'middle', wrapText: true }
      })
      // 嵌入零件图片缩略图（保持比例，行高放大）
      if (p.imageUrl) {
        const rel = p.imageUrl.replace(/^\/uploads\//, '')
        const raw = await readFile(resolve(UPLOAD_DIR, rel)).catch(() => null)
        if (raw) {
          const buf = Buffer.from(raw)
          const ext = /\.png$/i.test(rel) ? 'png' : 'jpeg'
          const imageId = wb.addImage({ base64: buf.toString('base64'), extension: ext })
          const dims = imageSize(buf)
          const h = 46
          const w = dims && dims.h > 0 ? Math.min(84, Math.round((dims.w / dims.h) * h)) : 64
          ws.addImage(imageId, {
            tl: { col: IMG_COL_INDEX + 0.15, row: i + 1 + 0.08 },
            ext: { width: w, height: h },
          })
          row.height = 52
        }
      }
    }
    // 每列排序筛选：覆盖全部列（含价格列则为 A..N，否则 A..M）
    ws.autoFilter = { from: 'A1', to: (showPrice ? 'N' : 'M') + (boms.length + 1) }
    const buf = await wb.xlsx.writeBuffer()
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    // 文件名带导出身份（中文账号名，如 工程/采购），便于区分谁导出的版本
    const userId = (req as { user?: { userId?: number; role?: string } }).user?.userId
    const exporter = userId != null
      ? ((await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || role)
      : role
    const fileName = 'erp-' + product.sku + '-BOM-' + date + '-' + exporter + '.xlsx'
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName) + '; filename="erp-bom.xlsx"')
    reply.send(Buffer.from(buf))
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
    // 保存 BOM 后把受影响的零件文件归位（_未分类 → 成品目录 / _共用），并同步数据库 URL。
    // 批量化：受影响零件/零件→成品归属各一条 SQL；uploads 目录结构只扫一遍；位置未变且 URL 已就位则零操作。
    const affected = [...new Set([...oldPartIds, ...items.map((i) => i.partId)])]
    const parts = await prisma.part.findMany({ where: { id: { in: affected } } })
    const bomRows = await prisma.bom.findMany({
      where: { partId: { in: affected } },
      select: { partId: true, product: { select: { sku: true } } },
    })
    const skusByPart = new Map<number, string[]>()
    for (const b of bomRows) {
      const arr = skusByPart.get(b.partId) ?? []
      arr.push(b.product.sku)
      skusByPart.set(b.partId, arr)
    }
    // 一次扫描 uploads 目录树，建立 零件文件夹名 → { abs, relDir } 索引
    const rootEntries = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => [] as Dirent[])
    const folderIndex = new Map<string, { abs: string }>()
    const scanDir = async (rel: string) => {
      const entries = await readdir(resolve(UPLOAD_DIR, rel), { withFileTypes: true }).catch(() => [] as Dirent[])
      for (const e of entries) {
        if (e.isDirectory()) folderIndex.set(e.name, { abs: resolve(UPLOAD_DIR, rel, e.name) })
      }
    }
    await scanDir(UNCATEGORIZED)
    await scanDir(SHARED)
    for (const e of rootEntries) {
      if (e.isDirectory() && !e.name.startsWith('_')) await scanDir(e.name)
    }

    for (const part of parts) {
      const productSkus = skusByPart.get(part.id) ?? []
      const partDir = partDirName(part.sku, part.name)
      const targetRelDir = partTargetRelDir(productSkus, partDir)
      const targetAbs = resolve(UPLOAD_DIR, targetRelDir)
      const current = folderIndex.get(partDir)
      const moved = current !== undefined && current.abs !== targetAbs
      if (moved) {
        await mkdir(dirname(targetAbs), { recursive: true })
        await rename(current.abs, targetAbs)
      }
      // URL 已指向目标目录则无需再同步（最常见情况：再次保存 BOM 零开销）
      const prefix = '/uploads/' + targetRelDir.replace(/\\/g, '/') + '/'
      const inPlace =
        (part.imageUrl == null || part.imageUrl.startsWith(prefix)) &&
        (part.drawingsUrl == null || part.drawingsUrl.startsWith(prefix))
      if (current !== undefined && (moved || !inPlace)) {
        const files = await readdir(targetAbs).catch(() => [] as string[])
        await syncPartUrlsFromFolder(part.id, targetRelDir, files)
      }
      // 旧版兜底：图片/图档若还是根目录 uuid 文件，一并归入零件文件夹
      const imageUrl = await placeRootFileIntoPartFolder(part.imageUrl, targetRelDir, 'image')
      const drawingsUrl = await placeRootFileIntoPartFolder(part.drawingsUrl, targetRelDir, 'drawing')
      if (imageUrl || drawingsUrl) {
        await prisma.part.update({
          where: { id: part.id },
          data: { ...(imageUrl ? { imageUrl } : {}), ...(drawingsUrl ? { drawingsUrl } : {}) },
        })
      }
    }
    const boms = await prisma.bom.findMany({
      where: { productId },
      orderBy: { partId: 'asc' },
      include: { part: { select: { id: true, sku: true, name: true } } },
    })
    return reply.code(200).send(boms)
  })
}
