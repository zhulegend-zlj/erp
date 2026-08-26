import type { FastifyInstance } from 'fastify'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { dueDate, computeOrderCost, computeOrderProfit, round2 } from '../domain/finance'

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
  // 看板/首页摘要：老板 + 采购（采购用于「待采购」提醒）
  app.get('/api/dashboard/summary', { preHandler: requireRole('boss', 'purchase') }, async () => {
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
      const cost = round2(computeOrderCost(purchaseItems, order.otherCost.toNumber()))
      const totalReceived = round2(order.customerPayments.reduce((sum, p) => sum + p.amount.toNumber(), 0))
      const profit = round2(computeOrderProfit(totalReceived, cost))

      const amount = round2(orderAmount(order.items))
      const earliest = order.shipments[0]
      const due = earliest ? formatDate(dueDate(earliest.shippedAt)) : null

      // 应收余额：有出货的订单金额扣除已收款，只统计仍未收回的部分
      if (earliest) {
        const outstanding = Math.max(0, round2(amount - totalReceived))
        receivableTotal += outstanding
        if (dueDate(earliest.shippedAt) < now) {
          overdueReceivable += outstanding
        }
      }

      return {
        id: order.id,
        orderNo: order.orderNo,
        customerName: order.customer.name,
        status: order.status,
        purchasing: order.purchasing,
        producing: order.producing,
        progress: progressOf(order.status),
        cost,
        profit,
        dueDate: due,
      }
    })

    // 待采购：已确认且尚未生成任何采购单的订单数（采购页/首页提醒用）
    const pendingPurchaseOrders = await prisma.salesOrder.count({
      where: { status: 'confirmed', purchaseOrders: { none: {} } },
    })

    // 应付余额：全部采购单金额 - 全部供应商付款（含未挂采购单的付款），下限 0
    const [purchaseOrders, supplierPaid] = await Promise.all([
      prisma.purchaseOrder.findMany({ include: { items: true } }),
      prisma.supplierPayment.aggregate({ _sum: { amount: true } }),
    ])
    const payableTotal = Math.max(
      0,
      round2(
        purchaseOrders.reduce((sum, po) => sum + orderAmount(po.items), 0) -
          (supplierPaid._sum.amount?.toNumber() ?? 0),
      ),
    )

    return { orders: rows, receivableTotal, payableTotal, overdueReceivable, pendingPurchaseOrders }
  })
}
