import type { Prisma } from '@prisma/client'
import { applyStockChange } from './inventory'
import { refreshPurchasingPhase } from './order-phase'

/**
 * 收货入库公共逻辑（2026-09-09 抽出，仓库收货与采购跟进补录共用同一套口径）：
 * - 挂采购单：校验零件归属；累计收货超订购量时默认拦截，allowOverQty 显式确认后放行并回报超收明细
 *   （老板口径：供应商会多送，多送要记录、之后退还供应商）；
 *   按累计收货更新采购单状态（open/partial/received），并刷新订单「采购中」阶段（照旧联动）。
 * - 不挂采购单（自购买）：直接按零件入库，可挂供应商追溯。
 * - source 区分录入来源（warehouse 仓库收货 / purchase 采购跟进补录），操作人留痕。
 */

export interface ReceiptLineInput {
  partId: number
  qty: number
  lotNo?: string | null | undefined
  qcStatus?: string | null | undefined
  defectiveQty?: number | undefined
  supplierId?: number | null | undefined
  deliveryDate?: Date | null | undefined
}

export interface RecordReceiptInput {
  purchaseOrderId: number | null
  lines: ReceiptLineInput[]
  /** 超收放行：前端确认「已超收 X，确认继续？」后传 true */
  allowOverQty?: boolean
  source?: 'warehouse' | 'purchase'
  operatorId?: number | null
  /** 采购跟进只登记某一明细行时传 itemId，用于额外校验 */
  itemId?: number | null
}

export interface OverQtyInfo {
  partId: number
  sku: string
  orderedQty: number
  receivedQty: number
  incomingQty: number
  overQty: number
}

export interface RecordReceiptResult {
  receiptIds: number[]
  overQty: OverQtyInfo[]
  purchaseOrderStatus: string | null
}

export async function recordReceipt(
  tx: Prisma.TransactionClient,
  input: RecordReceiptInput,
): Promise<RecordReceiptResult> {
  const source = input.source ?? 'warehouse'
  const overQty: OverQtyInfo[] = []
  const receiptIds: number[] = []

  let purchaseOrder: {
    id: number
    salesOrderId: number | null
    items: { id: number; partId: number; qty: number }[]
  } | null = null

  if (input.purchaseOrderId != null) {
    // 并发防护：锁采购单行，同单并发收货串行化，累计校验不再竞态
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${input.purchaseOrderId} FOR UPDATE`
    purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: input.purchaseOrderId },
      select: { id: true, salesOrderId: true, items: { select: { id: true, partId: true, qty: true } } },
    })
    if (!purchaseOrder) throw new Error('采购单不存在')
    if (input.itemId != null && !purchaseOrder.items.some((i) => i.id === input.itemId)) {
      throw new Error('该明细不属于此采购单')
    }
  }

  const receivedMap = new Map<number, number>()
  const poItemMap = new Map<number, { id: number; qty: number }>()
  if (purchaseOrder) {
    const groups = await tx.receipt.groupBy({
      by: ['partId'],
      where: { purchaseOrderId: purchaseOrder.id },
      _sum: { qty: true },
    })
    groups.forEach((g) => receivedMap.set(g.partId, g._sum.qty ?? 0))
    purchaseOrder.items.forEach((i) => poItemMap.set(i.partId, { id: i.id, qty: i.qty }))
  }

  // 本批次内累计（同 partId 多次提交时叠加判断）
  const pending = new Map<number, number>()
  const seen = new Set<number>()

  for (const line of input.lines) {
    const poItem = purchaseOrder ? poItemMap.get(line.partId) : undefined
    if (purchaseOrder) {
      if (!poItem) throw new Error('零件（ID ' + line.partId + '）不在该采购单中，不能收货')
      if (input.itemId != null && poItem.id !== input.itemId) {
        throw new Error('零件（ID ' + line.partId + '）不是所选明细行')
      }
      const already = (receivedMap.get(line.partId) ?? 0) + (pending.get(line.partId) ?? 0)
      const over = already + line.qty - poItem.qty
      if (over > 0) {
        if (!input.allowOverQty) {
          throw new Error(
            '零件（ID ' +
              line.partId +
              '）收货数量超过订购数量，不能重复收货（订购 ' +
              poItem.qty +
              '、已收 ' +
              already +
              '、本次 ' +
              line.qty +
              '，超收 ' +
              over +
              '）',
          )
        }
        const part = await tx.part.findUnique({ where: { id: line.partId }, select: { sku: true } })
        overQty.push({
          partId: line.partId,
          sku: part?.sku ?? '',
          orderedQty: poItem.qty,
          receivedQty: already,
          incomingQty: line.qty,
          overQty: over,
        })
      }
    } else {
      if (seen.has(line.partId)) throw new Error('收货明细不能重复')
      seen.add(line.partId)
      const part = await tx.part.findUnique({ where: { id: line.partId }, select: { id: true } })
      if (!part) throw new Error('零件（ID ' + line.partId + '）不存在')
    }
    pending.set(line.partId, (pending.get(line.partId) ?? 0) + line.qty)

    const receipt = await tx.receipt.create({
      data: {
        purchaseOrderId: purchaseOrder?.id ?? null,
        supplierId: line.supplierId ?? null,
        partId: line.partId,
        qty: line.qty,
        lotNo: line.lotNo || null,
        qcStatus: line.qcStatus || null,
        defectiveQty: line.defectiveQty ?? 0,
        deliveryDate: line.deliveryDate ?? null,
        source,
        createdById: input.operatorId ?? null,
      },
    })
    receiptIds.push(receipt.id)
    await applyStockChange(tx, 'part', line.partId, line.qty, 'receipt', receipt.id, purchaseOrder?.salesOrderId ?? null)
  }

  let purchaseOrderStatus: string | null = null
  if (purchaseOrder) {
    // 按累计收货更新采购单状态：全部收齐 → received；部分 → partial
    const allReceived = purchaseOrder.items.every(
      (i) => (receivedMap.get(i.partId) ?? 0) + (pending.get(i.partId) ?? 0) >= i.qty,
    )
    const anyReceived = purchaseOrder.items.some(
      (i) => (receivedMap.get(i.partId) ?? 0) + (pending.get(i.partId) ?? 0) > 0,
    )
    if (allReceived) purchaseOrderStatus = 'received'
    else if (anyReceived) purchaseOrderStatus = 'partial'
    if (purchaseOrderStatus) {
      await tx.purchaseOrder.update({ where: { id: purchaseOrder.id }, data: { status: purchaseOrderStatus } })
    }
    // 刷新订单「采购中」：全部采购单收齐自动熄灭，两阶段都完成自动推进待出货
    await refreshPurchasingPhase(tx, purchaseOrder.salesOrderId)
  }

  return { receiptIds, overQty, purchaseOrderStatus }
}

/**
 * 采购跟进·未交数量（老板口径）：
 * 未交 = 订购数量 − 累计收货 − 累计补货 + 累计退货
 * - 多送记进收货、退还记退货 → 自动算平；
 * - 不良品由供应商下次带走时记退货 → 未交 +退货（不重复记不良）。
 */
export function outstandingQty(input: {
  orderedQty: number
  receivedQty: number
  replenishQty: number
  returnQty: number
}): number {
  return input.orderedQty - input.receivedQty - input.replenishQty + input.returnQty
}
