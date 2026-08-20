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
