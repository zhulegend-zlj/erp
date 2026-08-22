import type { Prisma } from '@prisma/client'

/**
 * 订单双阶段标志与自动推进助手。
 * - 采购中：订单存在采购单且至少一张未收齐（status !== 'received'）。
 * - 生产中：已产生成品入库且仍有成品未收满。
 * 两个阶段可同时为真（货没到齐也能先生产）；都熄灭且状态为 in_production 时自动推进 ready（待出货）。
 */

/** 生成采购单后调用：点亮采购中并推进状态 */
export async function markPurchasingStarted(
  tx: Prisma.TransactionClient,
  salesOrderId: number | null | undefined,
): Promise<void> {
  if (!salesOrderId) return
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { id: true, status: true },
  })
  if (!order) return
  const data: { purchasing: boolean; status?: string } = { purchasing: true }
  if (order.status === 'confirmed') data.status = 'in_production'
  await tx.salesOrder.update({ where: { id: salesOrderId }, data })
}

/** 收货完成后调用：按采购单收齐情况刷新采购中，并尝试自动推进 ready */
export async function refreshPurchasingPhase(
  tx: Prisma.TransactionClient,
  salesOrderId: number | null | undefined,
): Promise<void> {
  if (!salesOrderId) return
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { id: true, status: true, producing: true },
  })
  if (!order) return
  const pos = await tx.purchaseOrder.findMany({
    where: { salesOrderId },
    select: { status: true },
  })
  const purchasing = pos.length > 0 && pos.some((p) => p.status !== 'received')
  const data: { purchasing: boolean; status?: string } = { purchasing }
  if (order.status === 'in_production' && !purchasing && !order.producing) data.status = 'ready'
  await tx.salesOrder.update({ where: { id: salesOrderId }, data })
}

/** 成品入库后调用：按入库累计刷新生产中，并尝试自动推进 ready */
export async function refreshProducingPhase(
  tx: Prisma.TransactionClient,
  salesOrderId: number,
): Promise<void> {
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { id: true, status: true, purchasing: true, items: { select: { productId: true, qty: true } } },
  })
  if (!order) return
  const groups = await tx.productionEntry.groupBy({
    by: ['productId'],
    where: { salesOrderId },
    _sum: { qty: true },
  })
  const doneMap = new Map(groups.map((g) => [g.productId, g._sum.qty ?? 0]))
  const producing =
    groups.length > 0 && order.items.some((it) => (doneMap.get(it.productId) ?? 0) < it.qty)
  const data: { producing: boolean; status?: string } = { producing }
  if (order.status === 'in_production' && !producing && !order.purchasing) data.status = 'ready'
  await tx.salesOrder.update({ where: { id: salesOrderId }, data })
}
