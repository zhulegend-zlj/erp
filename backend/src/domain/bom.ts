export interface BomRow { productId: number; partId: number; qty: number }

export function bomExplode(productId: number, qty: number, boms: BomRow[]) {
  const map = new Map<number, number>()
  for (const b of boms) {
    if (b.productId !== productId) continue
    map.set(b.partId, (map.get(b.partId) ?? 0) + b.qty * qty)
  }
  return [...map.entries()].map(([partId, requiredQty]) => ({ partId, requiredQty }))
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
