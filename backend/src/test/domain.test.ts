import { describe, it, expect } from 'vitest'
import { bomExplode, computePurchaseGap } from '../domain/bom'
import { dueDate, computeOrderCost, computeOrderProfit } from '../domain/finance'

describe('bomExplode', () => {
  it('按 BOM 汇总零件用量', () => {
    const boms = [
      { productId: 1, partId: 10, qty: 2 },
      { productId: 1, partId: 11, qty: 5 }
    ]
    expect(bomExplode(1, 3, boms)).toEqual([
      { partId: 10, requiredQty: 6 },
      { partId: 11, requiredQty: 15 }
    ])
  })
})

describe('computePurchaseGap', () => {
  it('规则2：扣库存，只采购缺口，负缺口按 0', () => {
    const req = [
      { partId: 10, requiredQty: 100 },
      { partId: 11, requiredQty: 20 }
    ]
    const stock = new Map([[10, 30], [11, 50]])
    expect(computePurchaseGap(req, stock)).toEqual([
      { partId: 10, gapQty: 70 },
      { partId: 11, gapQty: 0 }
    ])
  })
})

describe('finance', () => {
  it('账期为出货后60天', () => {
    expect(dueDate(new Date('2026-08-20T00:00:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z')
  })
  it('成本与利润', () => {
    const purchaseItems = [
      { qty: 100, unitPrice: 1.5 },
      { qty: 20, unitPrice: 3 }
    ]
    expect(computeOrderCost(purchaseItems, 50)).toBe(260)
    expect(computeOrderProfit(1000, 260)).toBe(740)
  })
})
