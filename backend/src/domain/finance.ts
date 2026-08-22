export function dueDate(shippedAt: Date): Date {
  const d = new Date(shippedAt)
  d.setUTCDate(d.getUTCDate() + 60)
  return d
}

export function computeOrderCost(
  purchaseItems: Array<{ qty: number; unitPrice: number | { toNumber(): number } }>,
  otherCost: number
): number {
  const items = purchaseItems.reduce((sum, it) => {
    const price = typeof it.unitPrice === 'number' ? it.unitPrice : it.unitPrice.toNumber()
    return sum + it.qty * price
  }, 0)
  return items + otherCost
}

export function computeOrderProfit(totalReceived: number, cost: number): number {
  return totalReceived - cost
}

/** 金额展示汇总统一四舍五入到分，避免 Decimal.toNumber() 转 double 后的浮点尾差。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
