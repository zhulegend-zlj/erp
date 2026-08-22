import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'
import { parsePagination, pagedResult } from '../pagination'

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
})

const createOrderSchema = z.object({
  customerId: z.number({ error: '客户必填' }).int({ error: '客户必须为整数' }).positive({ error: '客户必须为正整数' }),
  deliveryDate: z.string({ error: '交货日期必填' }).refine((v) => !Number.isNaN(Date.parse(v)), '交货日期必须为合法日期'),
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

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}

function utcDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

async function generateOrderNo(): Promise<string> {
  const prefix = `SO-${utcDateStamp()}-`
  const count = await prisma.salesOrder.count({ where: { orderNo: { startsWith: prefix } } })
  return `${prefix}${String(count + 1).padStart(3, '0')}`
}

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

    const orderNo = await generateOrderNo()
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.salesOrder.create({
        data: {
          orderNo,
          customerId: data.customerId,
          deliveryDate: new Date(data.deliveryDate),
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
          },
        })
      }
      return tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include: ITEMS_INCLUDE })
    })

    return reply.code(200).send(order)
  })

  // 5 角色均可查看列表；可选 page/pageSize 分页；purchase/warehouse/engineer 隐藏销售单价
  app.get('/api/orders', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const orderBy = { id: 'desc' as const }
    const toRow = (order: Prisma.SalesOrderGetPayload<{ include: typeof ITEMS_INCLUDE }>) =>
      sanitizeOrderForRole(order, role)
    if (pagination.kind === 'none') {
      const rows = await prisma.salesOrder.findMany({ orderBy, include: ITEMS_INCLUDE })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.salesOrder.findMany({
        orderBy,
        include: ITEMS_INCLUDE,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.salesOrder.count(),
    ])
    return pagedResult(rows.map(toRow), total, page)
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
    const totalQty = order.items.reduce((sum, it) => sum + it.qty, 0)
    return {
      ...sanitizeOrderForRole(order, role),
      producedQty: produced._sum.qty ?? 0,
      totalQty,
    }
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
    const updated = await prisma.salesOrder.updateMany({
      where: { id, status: order.status },
      data: { status: data.status },
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
}
