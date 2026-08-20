import type { FastifyInstance } from 'fastify'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { dueDate, computeOrderCost, computeOrderProfit } from '../domain/finance'

// 进度按状态映射为百分比
const PROGRESS: Record<string, number> = {
  draft: 10,
  confirmed: 30,
  in_production: 60,
  ready: 85,
  shipped: 95,
  completed: 100,
}

function progressOf(status: string): number {
  return PROGRESS[status] ?? 0
}

function orderAmount(items: Array<{ qty: number; unitPrice: { toNumber(): number } }>): number {
  return items.reduce((sum, it) => sum + it.qty * it.unitPrice.toNumber(), 0)
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function dashboardRoutes(app: FastifyInstance) {
  // 老板看板：仅 boss
  app.get('/api/dashboard/summary', { preHandler: requireRole('boss') }, async () => {
    const orders = await prisma.salesOrder.findMany({
      orderBy: { id: 'desc' as const },
      include: {
        customer: { select: { name: true } },
        items: true,
        purchaseOrders: { include: { items: true } },
        customerPayments: true,
        shipments: { orderBy: { shippedAt: 'asc' as const } },
      },
    })

    const now = new Date()
    let receivableTotal = 0
    let overdueReceivable = 0

    const rows = orders.map((order) => {
      const purchaseItems = order.purchaseOrders.flatMap((po) =>
        po.items.map((it) => ({ qty: it.qty, unitPrice: it.unitPrice }))
      )
      const cost = computeOrderCost(purchaseItems, order.otherCost.toNumber())
      const totalReceived = order.customerPayments.reduce((sum, p) => sum + p.amount.toNumber(), 0)
      const profit = computeOrderProfit(totalReceived, cost)

      const amount = orderAmount(order.items)
      const earliest = order.shipments[0]
      const due = earliest ? formatDate(dueDate(earliest.shippedAt)) : null

      // 应收：有出货订单的订单金额合计；已过账期：最早出货 +60 天已过
      if (earliest) {
        receivableTotal += amount
        if (dueDate(earliest.shippedAt) < now) {
          overdueReceivable += amount
        }
      }

      return {
        id: order.id,
        orderNo: order.orderNo,
        customerName: order.customer.name,
        status: order.status,
        progress: progressOf(order.status),
        cost,
        profit,
        dueDate: due,
      }
    })

    // 应付：全部采购单金额合计
    const purchaseOrders = await prisma.purchaseOrder.findMany({ include: { items: true } })
    const payableTotal = purchaseOrders.reduce((sum, po) => sum + orderAmount(po.items), 0)

    return { orders: rows, receivableTotal, payableTotal, overdueReceivable }
  })
}
