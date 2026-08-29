export interface BomRow { productId: number; partId: number; qty: number }

export function bomExplode(productId: number, qty: number, boms: BomRow[]) {
  const map = new Map<number, number>()
  for (const b of boms) {
    if (b.productId !== productId) continue
    map.set(b.partId, (map.get(b.partId) ?? 0) + b.qty * qty)
  }
  return [...map.entries()].map(([partId, requiredQty]) => ({ partId, requiredQty }))
}

/** 「用量/台」显示口径：零件只在一个成品（或多成品用量相同）→ 整数；多个成品用量不同 → 明细文本（SKU×用量）。 */
export function usageDisplay(
  usageByProduct: Map<number, number> | undefined,
  productSkuMap: Map<number, string>
): { usage: number | null; usageText?: string } {
  if (!usageByProduct || usageByProduct.size === 0) return { usage: 0 }
  const values = [...new Set(usageByProduct.values())]
  if (values.length === 1) return { usage: values[0] ?? 0 }
  const text = [...usageByProduct.entries()]
    .map(([productId, qty]) => `${productSkuMap.get(productId) ?? '成品#' + productId}×${qty}`)
    .join('、')
  return { usage: null, usageText: text }
}

export function computePurchaseGap(
  requirements: Array<{ partId: number; requiredQty: number }>,
  stock: Map<number, number>
) {
  return requirements.map(r => {
    const onHand = stock.get(r.partId) ?? 0
    return { partId: r.partId, gapQty: Math.max(0, r.requiredQty - onHand) }
  })
}

/**
 * 采购计划（2026-08-29 老板拍板的安全库存补货口径）：
 * - 默认采购量 = 需求 − 库存（与原 gapQty 一致）
 * - 若本来要买（gap>0）且设了安全库存、采购后库存会低于安全线 → 多买补到安全线：
 *   suggestedQty = 需求 − 库存 + 安全库存（采购后剩余正好 = 安全库存）
 * - 这单不用买的料（gap=0）不额外补货
 */
export function computePurchasePlan(
  requirements: Array<{ partId: number; requiredQty: number }>,
  stock: Map<number, number>,
  safetyStockMap: Map<number, number>,
) {
  return requirements.map(r => {
    const onHand = stock.get(r.partId) ?? 0
    const gapQty = Math.max(0, r.requiredQty - onHand)
    const safetyStock = safetyStockMap.get(r.partId) ?? 0
    // 有缺口时按缺口采购后库存归零，必然低于安全线（safety>0）→ 补到安全线：
    // 采购后库存 = onHand + suggested − required = safetyStock
    const suggestedQty =
      gapQty > 0 && safetyStock > 0 ? r.requiredQty - onHand + safetyStock : gapQty
    return { partId: r.partId, gapQty, suggestedQty }
  })
}
