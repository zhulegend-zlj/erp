import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { dueDate, computeOrderCost, computeOrderProfit, round2 } from '../domain/finance'

const DAY_MS = 86_400_000

const supplierPaymentSchema = z.object({
  supplierId: z.number({ error: '供应商必填' }).int({ error: '供应商必须为整数' }).positive({ error: '供应商必须为正整数' }),
  purchaseOrderId: z.number({ error: '采购单必须为整数' }).int({ error: '采购单必须为整数' }).positive({ error: '采购单必须为正整数' }).optional(),
  amount: z
    .number({ error: '金额必填' })
    .positive({ error: '金额必须为正数' })
    .max(9999999999.99, { error: '金额超出允许范围' }),
  paidAt: z
    .string({ error: '付款时间必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '付款时间必须为合法日期')
    .optional(),
})

const customerPaymentSchema = z.object({
  customerId: z.number({ error: '客户必填' }).int({ error: '客户必须为整数' }).positive({ error: '客户必须为正整数' }),
  salesOrderId: z.number({ error: '订单必须为整数' }).int({ error: '订单必须为整数' }).positive({ error: '订单必须为正整数' }).optional(),
  amount: z
    .number({ error: '金额必填' })
    .positive({ error: '金额必须为正数' })
    .max(9999999999.99, { error: '金额超出允许范围' }),
  receivedAt: z
    .string({ error: '收款时间必须为字符串' })
    .refine((v) => !Number.isNaN(Date.parse(v)), '收款时间必须为合法日期')
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

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

export function financeRoutes(app: FastifyInstance) {
  // 供应商付款：仅 finance
  app.post('/api/supplier-payments', { preHandler: requireRole('finance') }, async (req, reply) => {
    const data = parseBody(supplierPaymentSchema, req.body, reply)
    if (data === null) return

    // 归属校验：付款可挂采购单，但采购单必须属于该供应商
    if (data.purchaseOrderId !== undefined) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: data.purchaseOrderId },
        select: { supplierId: true },
      })
      if (!po) return reply.code(404).send({ error: '采购单不存在' })
      if (po.supplierId !== data.supplierId) {
        return reply.code(400).send({ error: '该采购单不属于所选供应商' })
      }
    }

    const payment = await prisma.supplierPayment.create({
      data: {
        supplierId: data.supplierId,
        purchaseOrderId: data.purchaseOrderId ?? null,
        amount: data.amount,
        ...(data.paidAt ? { paidAt: new Date(data.paidAt) } : {}),
      },
    })
    return reply.code(200).send(payment)
  })

  // 客户收款：仅 finance
  app.post('/api/customer-payments', { preHandler: requireRole('finance') }, async (req, reply) => {
    const data = parseBody(customerPaymentSchema, req.body, reply)
    if (data === null) return

    // 归属校验：收款可挂销售订单，但订单必须属于该客户
    if (data.salesOrderId !== undefined) {
      const order = await prisma.salesOrder.findUnique({
        where: { id: data.salesOrderId },
        select: { customerId: true },
      })
      if (!order) return reply.code(404).send({ error: '销售订单不存在' })
      if (order.customerId !== data.customerId) {
        return reply.code(400).send({ error: '该销售订单不属于所选客户' })
      }
    }

    const payment = await prisma.customerPayment.create({
      data: {
        customerId: data.customerId,
        salesOrderId: data.salesOrderId ?? null,
        amount: data.amount,
        ...(data.receivedAt ? { receivedAt: new Date(data.receivedAt) } : {}),
      },
    })
    return reply.code(200).send(payment)
  })

  // 订单成本/利润/账期汇总：finance / boss
  app.get('/api/finance/orders/:id/summary', { preHandler: requireRole('finance', 'boss') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '订单 ID 必须为正整数' })
    }

    const order = await prisma.salesOrder.findUnique({
      where: { id },
      include: {
        purchaseOrders: { include: { items: true } },
        customerPayments: true,
        shipments: { orderBy: { shippedAt: 'asc' as const } },
      },
    })
    if (!order) return reply.code(404).send({ error: '订单不存在' })

    const purchaseItems = order.purchaseOrders.flatMap((po) =>
      po.items.map((it) => ({ qty: it.qty, unitPrice: it.unitPrice }))
    )
    const cost = round2(computeOrderCost(purchaseItems, order.otherCost.toNumber()))
    const totalReceived = round2(order.customerPayments.reduce((sum, p) => sum + p.amount.toNumber(), 0))
    const profit = round2(computeOrderProfit(totalReceived, cost))

    const earliest = order.shipments[0]
    const due = earliest ? formatDate(dueDate(earliest.shippedAt)) : null

    return { orderNo: order.orderNo, cost, totalReceived, profit, dueDate: due, received: totalReceived }
  })

  // 账期清单（未来 days 天内到期应收/应付）：finance / boss
  app.get('/api/finance/due', { preHandler: requireRole('finance', 'boss') }, async (req, reply) => {
    const raw = (req.query as { days?: string }).days
    let days = 60
    if (raw !== undefined) {
      days = Number(raw)
      if (!Number.isInteger(days) || days <= 0) {
        return reply.code(400).send({ error: 'days 必须为正整数' })
      }
    }

    const now = new Date()
    const end = new Date(now.getTime() + days * DAY_MS)

    // 应收：有 shipment 且 shippedAt+60 天落在 [now, end] 的订单（按订单去重，取最早出货）；
    // 金额为余额口径：整单金额 - 已收款，已收完的不再列出
    const shipments = await prisma.shipment.findMany({
      include: {
        salesOrder: {
          include: { customer: true, items: true },
        },
      },
      orderBy: { shippedAt: 'asc' as const },
    })
    const customerPaidGroups = await prisma.customerPayment.groupBy({
      by: ['salesOrderId'],
      where: { salesOrderId: { not: null } },
      _sum: { amount: true },
    })
    const customerPaidMap = new Map(customerPaidGroups.map((g) => [g.salesOrderId!, g._sum.amount?.toNumber() ?? 0]))
    const receivableMap = new Map<number, { customerName: string; orderNo: string; dueDate: string; amount: number }>()
    for (const shipment of shipments) {
      const due = dueDate(shipment.shippedAt)
      if (due < now || due > end) continue
      if (receivableMap.has(shipment.salesOrderId)) continue
      const order = shipment.salesOrder
      const total = order.items.reduce((sum, it) => sum + it.qty * it.unitPrice.toNumber(), 0)
      const outstanding = Math.max(0, round2(total - (customerPaidMap.get(order.id) ?? 0)))
      if (outstanding <= 0) continue
      receivableMap.set(shipment.salesOrderId, {
        customerName: order.customer.name,
        orderNo: order.orderNo,
        dueDate: formatDate(due),
        amount: outstanding,
      })
    }

    // 应付：采购单创建后 30 天落在 [now, end] 的采购单；金额为余额口径：采购金额 - 已付款
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      include: { supplier: true, items: true, payments: true },
      orderBy: { createdAt: 'asc' as const },
    })
    const payable = purchaseOrders
      .map((po) => {
        const due = addDays(po.createdAt, 30)
        const total = po.items.reduce((sum, it) => sum + it.qty * it.unitPrice.toNumber(), 0)
        const paid = po.payments.reduce((sum, p) => sum + p.amount.toNumber(), 0)
        return {
          due,
          supplierName: po.supplier.name,
          orderNo: po.orderNo,
          amount: Math.max(0, round2(total - paid)),
        }
      })
      .filter((row) => row.due >= now && row.due <= end && row.amount > 0)
      .map(({ due, ...row }) => ({ ...row, dueDate: formatDate(due) }))

    return {
      receivable: [...receivableMap.values()],
      payable,
    }
  })
}
