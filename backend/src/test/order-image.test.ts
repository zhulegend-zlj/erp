import { describe, it, expect } from 'vitest'
import { parseOrderImageText } from '../domain/order-image'

const OCR_SAMPLE = [
  'PO Line Supplier Country of Manufacturing Ship To Hub Ship to Location Purchasing Entity Item Density Qty Need by date Ship Method Unit Cost PO Cost',
  '270993 1 Dongguan Zhiruiheng Electronic Co., Ltd CN VUC DFW 100 SP-CSS_T-SLOT_NUTS SP-CSS T-Slot nuts 30 2026/8/22 Ocean 7 210',
  '270991 2 Dongguan Zhiruiheng Electronic Co., Ltd CN VEC ALU 100 SP-CSP_V3_PU_F SP-CSP V3 PU F 30 2026/8/22 Ocean 7.11 213.3',
  '270992 1 Dongguan Zhiruiheng Electronic Co., Ltd CN VPC TYO 100 SP-CSP_SPRING_SETH SP-CSP Spring SetH 10 2026/8/22 Ocean 7.5 75',
].join('\n')

describe('parseOrderImageText（客户 PO 截图 OCR 解析）', () => {
  it('从客户 PO 表 OCR 全文中解析 PO/料号/数量/单价/日期', () => {
    const r = parseOrderImageText(OCR_SAMPLE)
    expect(r.po).toBe('270993')
    expect(r.lines).toHaveLength(3)
    expect(r.lines[0]).toMatchObject({ sku: 'SP-CSS_T-SLOT_NUTS', qty: 30, unitPrice: 7, needByDate: '2026/8/22' })
    expect(r.lines[1]).toMatchObject({ sku: 'SP-CSP_V3_PU_F', qty: 30, unitPrice: 7.11 })
    expect(r.lines[2]).toMatchObject({ sku: 'SP-CSP_SPRING_SETH', qty: 10, unitPrice: 7.5 })
  })

  it('简单列表（无日期）：SKU 数量 单价 也能解析', () => {
    const r = parseOrderImageText('CSP_V3 100 38.59\nCSS_SQ 50 45')
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toMatchObject({ sku: 'CSP_V3', qty: 100, unitPrice: 38.59 })
    expect(r.lines[1]).toMatchObject({ sku: 'CSS_SQ', qty: 50, unitPrice: 45 })
  })

  it('完全相同的重复行去重，非表格文本被忽略', () => {
    const r = parseOrderImageText('说明文字没有料号\nCSP_V3 10 5\nCSP_V3 10 5')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({ sku: 'CSP_V3', qty: 10, unitPrice: 5 })
  })

  it('空文本返回空结果', () => {
    const r = parseOrderImageText('')
    expect(r.po).toBeNull()
    expect(r.lines).toHaveLength(0)
  })
})
