import { describe, it, expect } from 'vitest'
import { bomExplode, computePurchaseGap, computePurchasePlan } from '../domain/bom'
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

describe('computePurchasePlan（安全库存补货，老板拍板口径）', () => {
  it('未设安全库存：建议采购量 = 缺口（与原口径一致）', () => {
    const req = [{ partId: 10, requiredQty: 100 }]
    const plan = computePurchasePlan(req, new Map([[10, 30]]), new Map())
    expect(plan).toEqual([{ partId: 10, gapQty: 70, suggestedQty: 70 }])
  })

  it('本来要买且设了安全库存 → 多买补到安全线（=需求−库存+安全库存，采购后剩安全线）', () => {
    // 库存100 安全库存200 需求500 → 采购600，采购后剩200=安全线
    const req = [{ partId: 10, requiredQty: 500 }]
    const plan = computePurchasePlan(req, new Map([[10, 100]]), new Map([[10, 200]]))
    expect(plan).toEqual([{ partId: 10, gapQty: 400, suggestedQty: 600 }])
  })

  it('这单不用买的料（gap=0）不额外补货', () => {
    const req = [{ partId: 11, requiredQty: 50 }]
    const plan = computePurchasePlan(req, new Map([[11, 100]]), new Map([[11, 200]]))
    expect(plan).toEqual([{ partId: 11, gapQty: 0, suggestedQty: 0 }])
  })

  it('设安全库存且有缺口 → 采购后剩安全线（库存300 安全200 需求400 → 采购300）', () => {
    const req = [{ partId: 12, requiredQty: 400 }]
    const plan = computePurchasePlan(req, new Map([[12, 300]]), new Map([[12, 200]]))
    expect(plan).toEqual([{ partId: 12, gapQty: 100, suggestedQty: 300 }])
  })

  it('无库存且需求小于安全库存 → 补到安全线', () => {
    const req = [{ partId: 13, requiredQty: 100 }]
    const plan = computePurchasePlan(req, new Map(), new Map([[13, 300]]))
    expect(plan).toEqual([{ partId: 13, gapQty: 100, suggestedQty: 400 }])
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
