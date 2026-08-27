import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
import { parseOrderImageText, readOrderImageWithModlens } from '../domain/order-image'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

// 状态推进权限（新分工）——销售/老板只负责 草稿↔已确认 与 已出货→已完成；
// 采购中/生产中由采购/仓库的实际操作自动点亮与熄灭（见 domain/order-phase.ts）。
// 注意：ready → shipped 只能通过出货模块（POST /api/shipments）完成，
// 不允许 PATCH 直接点成已出货（否则会绕过出货单与成品扣库）。
const SALES_TRANSITIONS: Record<string, string[]> = {
  draft: ['confirmed'],
  confirmed: ['draft'],
  shipped: ['completed'],
}
// 老板额外保留紧急兜底：可把运作中订单强制回退到已确认（同时清空双阶段标志）
const BOSS_TRANSITIONS: Record<string, string[]> = {
  ...SALES_TRANSITIONS,
  in_production: ['confirmed'],
  ready: ['confirmed'],
}

const dateSchema = (label: string) =>
  z
    .string({ error: label + '必填' })
    .refine((v) => !Number.isNaN(Date.parse(v)), label + '必须为合法日期')

const orderItemSchema = z.object({
  productId: z.number({ error: '商品必填' }).int({ error: '商品必须为整数' }).positive({ error: '商品必须为正整数' }),
  qty: z
    .number({ error: '数量必填' })
    .int({ error: '数量必须为整数' })
    .positive({ error: '数量必须为正整数' })
    .max(2147483647, { error: '数量超出允许范围' }),
  unitPrice: z
    .number({ error: '单价必填' })
    .nonnegative({ error: '单价必须为非负数' })
    .max(9999999999.99, { error: '单价超出允许范围' }),
  // 交期在明细行级：同一张订单里不同成品可以有不同的交期
  customerDeliveryDate: dateSchema('客户交期'),
  zrhDeliveryDate: dateSchema('ZRH交货日期'),
})

const createOrderSchema = z.object({
  customerId: z.number({ error: '客户必填' }).int({ error: '客户必须为整数' }).positive({ error: '客户必须为正整数' }),
  customerPoNo: z.string({ error: '客户PO号必填' }).min(1, '客户PO号必填').max(60, '客户PO号过长'),
  orderDate: z
    .string({ error: '订单日期必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '订单日期必须为合法日期')
    .optional(),
  paymentTerms: z.string().nullable().optional(),
  items: z
    .array(orderItemSchema, { error: '明细必填' })
    .min(1, '订单至少包含一个明细')
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: '同一成品不能在订单明细中重复',
    }),
})

const statusSchema = z.object({
  status: z.string({ error: '状态必填' }).min(1, '状态必填'),
})

// 编辑订单：明细与表头均可改（items 传了就必须 ≥1 行且每行带交期）
const updateOrderSchema = z.object({
  customerId: z.number({ error: '客户必须为整数' }).int().positive().optional(),
  customerPoNo: z.string().min(1, '客户PO号必填').max(60, '客户PO号过长').optional(),
  orderDate: z
    .string({ error: '订单日期必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '订单日期必须为合法日期')
    .optional(),
  paymentTerms: z.string().nullable().optional(),
  items: z
    .array(orderItemSchema, { error: '明细必填' })
    .min(1, '订单至少包含一个明细')
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: '同一成品不能在订单明细中重复',
    })
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

// 订单号 = 客户PO号：全厂生产流程直接沿用客户采购订单号，不再自动生成编号

const ITEMS_INCLUDE = {
  customer: { select: { name: true } },
  items: {
    include: { product: { select: { id: true, sku: true, name: true } } },
    orderBy: { id: 'asc' as const },
  },
} as const

// 销售单价仅销售与老板可见：purchase/warehouse/engineer 的订单数据不返回单价与其他费用
const PRICE_HIDDEN_ROLES = new Set(['purchase', 'warehouse', 'engineer'])
function sanitizeOrderForRole<T extends { items?: Array<Record<string, unknown>>; otherCost?: unknown }>(
  order: T,
  role: string,
): T {
  if (!PRICE_HIDDEN_ROLES.has(role)) return order
  return {
    ...order,
    otherCost: undefined,
    items: order.items?.map((it) => ({ ...it, unitPrice: undefined })),
  } as T
}

export function ordersRoutes(app: FastifyInstance) {
  // 仅 sales 可创建
  app.post('/api/orders', { preHandler: requireRole('sales') }, async (req, reply) => {
    const data = parseBody(createOrderSchema, req.body, reply)
    if (data === null) return

    // 订单号直接取客户PO号；重复PO号先拦截给出明确提示
    const duplicate = await prisma.salesOrder.findUnique({ where: { orderNo: data.customerPoNo } })
    if (duplicate) {
      return reply.code(400).send({ error: `客户PO号「${data.customerPoNo}」已被使用，请核对（同一PO号重复录入会被拦截）` })
    }
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.salesOrder.create({
        data: {
          orderNo: data.customerPoNo,
          customerId: data.customerId,
          customerPoNo: data.customerPoNo,
          orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
          paymentTerms: data.paymentTerms || null,
          status: 'draft',
        },
      })
      for (const item of data.items) {
        await tx.salesOrderItem.create({
          data: {
            orderId: created.id,
            productId: item.productId,
            qty: item.qty,
            unitPrice: item.unitPrice,
            customerDeliveryDate: new Date(item.customerDeliveryDate),
            zrhDeliveryDate: new Date(item.zrhDeliveryDate),
          },
        })
      }
      return tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include: ITEMS_INCLUDE })
    })

    return reply.code(200).send(order)
  })

  // 一键导入图片建单：客户发的订单截图 → modlens 多模态读图 → 解析出 成品/数量/单价/need-by 日期，
  // 并与库内成品 SKU 匹配（大小写不敏感、_ 与 - 互通）。读不出时返回 422，前端提示转人工（智能代理）再读。
  app.post('/api/orders/parse-image', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const dir = await mkdtemp(join(tmpdir(), 'erp-parseimg-'))
    let tmpName: string | null = null
    try {
      for await (const raw of req.parts()) {
        const part = raw as { type: string; fieldname?: string; filename?: string; mimetype?: string; file?: NodeJS.ReadableStream }
        if (part.type === 'file') {
          if (tmpName !== null) {
            part.file?.resume()
            continue
          }
          const mimetype = part.mimetype ?? ''
          const extByMime: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
            'image/gif': '.gif',
          }
          const ext = extByMime[mimetype]
          if (!ext) {
            part.file?.resume()
            return reply.code(400).send({ error: '仅支持 jpg/png/webp/gif 图片' })
          }
          tmpName = join(dir, randomUUID() + ext)
          await pipeline(part.file!, createWriteStream(tmpName))
        }
      }
      if (!tmpName) return reply.code(400).send({ error: '未收到图片文件' })

      const outcome = await readOrderImageWithModlens(tmpName)
      if (!outcome.ok) {
        return reply.code(422).send({ error: '图片识别失败（读不出内容），请换一张更清晰的截图；或转人工由智能代理读取后手工填写', detail: outcome.error })
      }
      const parsed = parseOrderImageText(outcome.rawText)
      if (parsed.lines.length === 0) {
        return reply.code(422).send({ error: '图片里没有识别出订单明细行（成品/数量/单价），请确认截图包含订单表格' })
      }

      // 与库内成品 SKU 匹配：大小写不敏感，_/-/空格归一化
      const products = await prisma.product.findMany({ select: { id: true, sku: true, name: true } })
      const norm = (s: string) => s.trim().toUpperCase().replace(/[_\-\s]+/g, '_')
      const bySku = new Map(products.map((p) => [norm(p.sku), p]))
      const lines = parsed.lines.map((l) => {
        const matched = bySku.get(norm(l.sku))
        return {
          sku: l.sku,
          qty: l.qty,
          unitPrice: l.unitPrice,
          needByDate: l.needByDate ?? null,
          matched: matched ? { productId: matched.id, name: matched.name } : null,
        }
      })
      return reply.code(200).send({ po: parsed.po, lines })
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: '图片超过 20MB 限制' })
      }
      throw err
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // 5 角色均可查看列表；可选 page/pageSize 分页；purchase/warehouse/engineer 隐藏销售单价；
  // 可选 pendingPurchase=true：只返回 草稿/已确认 且未生成采购单的订单（采购提醒用，草稿也可采购）；每行附带 已出/总量
  app.get('/api/orders', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const pendingPurchase = (req.query as Record<string, unknown>).pendingPurchase === 'true'
    const where: Prisma.SalesOrderWhereInput = pendingPurchase
      ? { status: { in: ['draft', 'confirmed'] }, purchaseOrders: { none: {} } }
      : {}
    const orderBy = { id: 'desc' as const }
    // 已出数量：按出货明细行（行级订单）汇总
    const withShipped = async (
      rows: Prisma.SalesOrderGetPayload<{ include: typeof ITEMS_INCLUDE }>[],
    ) => {
      const ids = rows.map((o) => o.id)
      const grouped = await prisma.shipmentLine.groupBy({
        by: ['salesOrderId'],
        where: { salesOrderId: { in: ids } },
        _sum: { qty: true },
      })
      const shippedMap = new Map(grouped.map((g) => [g.salesOrderId, g._sum.qty ?? 0]))
      return rows.map((o) => ({
        ...sanitizeOrderForRole(o, role),
        shippedQty: shippedMap.get(o.id) ?? 0,
        totalQty: o.items.reduce((s, it) => s + it.qty, 0),
        // 列表展示用：本单最早的一行 ZRH交货日期（催货先看它）
        earliestZrhDate: o.items.reduce(
          (min: Date | null, it) =>
            it.zrhDeliveryDate && (min === null || it.zrhDeliveryDate < min) ? it.zrhDeliveryDate : min,
          null,
        ),
      }))
    }
    if (pagination.kind === 'none') {
      const rows = await prisma.salesOrder.findMany({ where, orderBy, include: ITEMS_INCLUDE })
      return withShipped(rows)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        orderBy,
        include: ITEMS_INCLUDE,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.salesOrder.count({ where }),
    ])
    return pagedResult(await withShipped(rows), total, page)
  })

  // 5 角色均可查看详情（含 items 与 product 名称）；附带生产进度；purchase/warehouse/engineer 隐藏销售单价
  app.get('/api/orders/:id', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '订单 ID 必须为正整数' })
    const order = await prisma.salesOrder.findUnique({ where: { id }, include: ITEMS_INCLUDE })
    if (!order) return reply.code(404).send({ error: '订单不存在' })
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const produced = await prisma.productionEntry.aggregate({
      where: { salesOrderId: id },
      _sum: { qty: true },
    })
    const shipped = await prisma.shipmentLine.aggregate({
      where: { salesOrderId: id },
      _sum: { qty: true },
    })
    // 按成品维度的已入库量（成品入库表单提示「最多还能入 X 台」用）
    const producedByProductRows = await prisma.productionEntry.groupBy({
      by: ['productId'],
      where: { salesOrderId: id },
      _sum: { qty: true },
    })
    const producedByProduct: Record<number, number> = {}
    for (const g of producedByProductRows) {
      producedByProduct[g.productId] = g._sum.qty ?? 0
    }
    // 按成品维度的已出货量（出货排程页「可排剩余」用）
    const shippedByProductRows = await prisma.shipmentLine.groupBy({
      by: ['productId'],
      where: { salesOrderId: id },
      _sum: { qty: true },
    })
    const shippedByProduct: Record<number, number> = {}
    for (const g of shippedByProductRows) {
      shippedByProduct[g.productId] = g._sum.qty ?? 0
    }
    const totalQty = order.items.reduce((sum, it) => sum + it.qty, 0)
    return {
      ...sanitizeOrderForRole(order, role),
      producedQty: produced._sum.qty ?? 0,
      producedByProduct,
      shippedQty: shipped._sum.qty ?? 0,
      shippedByProduct,
      totalQty,
    }
  })

  // 采购催销售确认：草稿订单无法生成采购单时，采购/老板一键提醒销售（销售确认订单后自动清空）
  app.patch('/api/orders/:id/remind-confirm', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '订单 ID 必须为正整数' })
    const order = await prisma.salesOrder.findUnique({ where: { id } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })
    if (order.status !== 'draft') {
      return reply.code(400).send({ error: '订单已确认，无需提醒' })
    }
    const userId = (req as { user?: { userId: number } }).user?.userId ?? 0
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
    await prisma.salesOrder.update({
      where: { id },
      data: { confirmReminderAt: new Date(), confirmReminderBy: user?.name ?? '采购' },
    })
    return reply.code(200).send({ ok: true, orderNo: order.orderNo })
  })

  // 状态推进：sales / boss。销售只允许 草稿↔已确认 与 已出货→已完成；老板额外可把运作中订单强制回退到已确认
  app.patch('/api/orders/:id/status', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '订单 ID 必须为正整数' })
    const data = parseBody(statusSchema, req.body, reply)
    if (data === null) return

    const order = await prisma.salesOrder.findUnique({ where: { id } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const transitions = role === 'boss' ? BOSS_TRANSITIONS : SALES_TRANSITIONS
    const allowed = transitions[order.status]
    if (!allowed || !allowed.includes(data.status)) {
      if (role === 'sales') {
        return reply.code(400).send({ error: `销售不能把订单状态从 ${order.status} 变更为 ${data.status}` })
      }
      return reply.code(400).send({ error: `订单状态不能从 ${order.status} 变更为 ${data.status}` })
    }

    // 条件更新（要求当前状态仍为 order.status），并发下只有一个请求能命中，防止重复推进/回退
    // 确认订单（draft→confirmed）时顺带清空采购催办标记
    const updated = await prisma.salesOrder.updateMany({
      where: { id, status: order.status },
      data: {
        status: data.status,
        ...(data.status === 'confirmed' ? { confirmReminderAt: null, confirmReminderBy: null } : {}),
      },
    })
    if (updated.count === 0) {
      return reply.code(400).send({ error: '订单状态已变化，请刷新后重试' })
    }
    // 老板紧急回退到已确认时，同时熄灭采购中/生产中标志
    if (data.status === 'confirmed') {
      await prisma.salesOrder.update({
        where: { id },
        data: { purchasing: false, producing: false },
      })
    }
    const refreshed = await prisma.salesOrder.findUnique({ where: { id }, include: ITEMS_INCLUDE })
    return reply.code(200).send(refreshed)
  })

  // 编辑订单（老板口径：同一客户PO号后续要加成品，不能重复建单 → 用编辑加成品/改数量/改交期）
  // 草稿可随意编辑；已确认但尚无任何业务痕迹（无采购单/出货单/排程/领料/成品入库/收款/库存流水）也可编辑；
  // 一旦开始采购/生产/出货即锁定，防止把运作中的单据改烂。
  app.patch('/api/orders/:id', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '订单 ID 必须为正整数' })
    const data = parseBody(updateOrderSchema, req.body, reply)
    if (data === null) return

    const order = await prisma.salesOrder.findUnique({ where: { id } })
    if (!order) return reply.code(404).send({ error: '订单不存在' })
    if (order.status !== 'draft' && order.status !== 'confirmed') {
      return reply.code(400).send({ error: `订单状态为「${order.status}」，不能编辑（仅草稿、或未开始业务的已确认订单可编辑）` })
    }

    // 改客户PO号 = 改订单号：撞已有订单号要拦截
    const nextOrderNo = data.customerPoNo ?? order.customerPoNo ?? order.orderNo
    if (data.customerPoNo && data.customerPoNo !== order.customerPoNo) {
      const duplicate = await prisma.salesOrder.findUnique({ where: { orderNo: nextOrderNo } })
      if (duplicate) {
        return reply.code(400).send({ error: `客户PO号「${nextOrderNo}」已被使用，请核对（同一PO号重复录入会被拦截）` })
      }
    }

    // 已确认订单：有业务痕迹即锁定（口径与删除一致）
    if (order.status === 'confirmed') {
      const [purchaseOrders, shipments, schedules, issues, productionEntries, payments, ledgers] = await Promise.all([
        prisma.purchaseOrder.count({ where: { salesOrderId: id } }),
        prisma.shipment.count({ where: { salesOrderId: id } }),
        prisma.shipmentSchedule.count({ where: { salesOrderId: id, status: { not: 'cancelled' } } }),
        prisma.issue.count({ where: { salesOrderId: id } }),
        prisma.productionEntry.count({ where: { salesOrderId: id } }),
        prisma.customerPayment.count({ where: { salesOrderId: id } }),
        prisma.inventoryLedger.count({ where: { salesOrderId: id } }),
      ])
      const blockers: string[] = []
      if (purchaseOrders > 0) blockers.push(`${purchaseOrders} 张采购单`)
      if (shipments > 0) blockers.push(`${shipments} 张出货单`)
      if (schedules > 0) blockers.push(`${schedules} 条出货排程`)
      if (issues > 0) blockers.push(`${issues} 条领料`)
      if (productionEntries > 0) blockers.push(`${productionEntries} 条成品入库`)
      if (payments > 0) blockers.push(`${payments} 笔收款`)
      if (ledgers > 0) blockers.push(`${ledgers} 条库存流水`)
      if (blockers.length > 0) {
        return reply.code(400).send({ error: `订单已有业务记录，不能编辑：${blockers.join('、')}` })
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.salesOrder.update({
        where: { id },
        data: {
          ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
          ...(data.customerPoNo !== undefined ? { customerPoNo: data.customerPoNo } : {}),
          orderNo: nextOrderNo,
          ...(data.orderDate ? { orderDate: new Date(data.orderDate) } : {}),
          ...(data.paymentTerms !== undefined ? { paymentTerms: data.paymentTerms } : {}),
        },
      })
      if (data.items) {
        await tx.salesOrderItem.deleteMany({ where: { orderId: id } })
        for (const item of data.items) {
          await tx.salesOrderItem.create({
            data: {
              orderId: id,
              productId: item.productId,
              qty: item.qty,
              unitPrice: item.unitPrice,
              customerDeliveryDate: new Date(item.customerDeliveryDate),
              zrhDeliveryDate: new Date(item.zrhDeliveryDate),
            },
          })
        }
      }
      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include: ITEMS_INCLUDE })
    })

    return reply.code(200).send(updated)
  })

  // 删除订单：仅 sales/boss。只允许删除没有任何业务痕迹的订单
  // （无采购单/出货单/领料/成品入库/收款/库存流水），防止把运作中的单据、库存与账务删烂。
  app.delete('/api/orders/:id', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '订单 ID 必须为正整数' })

    await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({ where: { id } })
      if (!order) throw new Error('订单不存在')

      const [purchaseOrders, shipments, schedules, issues, productionEntries, payments, ledgers] = await Promise.all([
        tx.purchaseOrder.count({ where: { salesOrderId: id } }),
        tx.shipment.count({ where: { salesOrderId: id } }),
        tx.shipmentSchedule.count({ where: { salesOrderId: id, status: { not: 'cancelled' } } }),
        tx.issue.count({ where: { salesOrderId: id } }),
        tx.productionEntry.count({ where: { salesOrderId: id } }),
        tx.customerPayment.count({ where: { salesOrderId: id } }),
        tx.inventoryLedger.count({ where: { salesOrderId: id } }),
      ])
      const blockers: string[] = []
      if (purchaseOrders > 0) blockers.push(`${purchaseOrders} 张采购单`)
      if (shipments > 0) blockers.push(`${shipments} 张出货单`)
      if (schedules > 0) blockers.push(`${schedules} 条出货排程`)
      if (issues > 0) blockers.push(`${issues} 条领料`)
      if (productionEntries > 0) blockers.push(`${productionEntries} 条成品入库`)
      if (payments > 0) blockers.push(`${payments} 笔收款`)
      if (ledgers > 0) blockers.push(`${ledgers} 条库存流水`)
      if (blockers.length > 0) {
        throw new Error(`订单已有业务记录，不能删除：${blockers.join('、')}`)
      }

      await tx.salesOrderItem.deleteMany({ where: { orderId: id } })
      await tx.salesOrder.delete({ where: { id } })
    })
      .then(() => reply.code(200).send({ ok: true }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '删除失败'
        if (message === '订单不存在') return reply.code(404).send({ error: message })
        if (message.startsWith('订单已有业务记录')) return reply.code(400).send({ error: message })
        return reply.code(500).send({ error: '删除失败，请稍后重试' })
      })
  })
}
