import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildPoTemplate, type PoDocData } from '../domain/purchase-doc'

async function readBuf(buf: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as never)
  const ws = wb.worksheets[0]!
  const get = (r: number, c: number) => {
    const v = ws.getCell(r, c).value
    if (v && typeof v === 'object') {
      const o = v as { formula?: string; result?: unknown; richText?: Array<{ text: string }> }
      if (o.formula) return o.formula
      if (o.richText) return o.richText.map((t) => t.text).join('')
    }
    return String(v ?? '')
  }
  return { ws, get }
}

const base: PoDocData = {
  headerName: '东莞市智锐恒电子有限公司',
  orderNo: '272750T',
  orderDate: '2026-08-18T00:00:00.000Z',
  supplier: {
    name: '东莞市粤徽磁铁制品有限公司',
    contactPerson: '何先生',
    phone: '0769-33217318',
    fax: '0769-86935376',
    email: '',
  },
  model: 'CSP_V3i',
  paymentTerms: '货到付款',
  expectedDeliveryDate: '2026.09.12',
  taxPoint: 10,
  lines: [
    {
      sku: 'CSP-058', name: '磁铁', spec: 'F5*4*3', material: '强磁 镀锌', finish: '电镀白镍',
      unit: 'PCS', usage: 2, qty: 2050, unitPrice: 0.24, unitPriceInclTax: 0.264, note: '请给3‰免费备品',
    },
  ],
}

describe('采购单模板填充（新模板：共有内容口径）', () => {
  it('模板 A（智锐恒=含税）：序号/备注/材质/表面处理/交货时间 全填充', async () => {
    const buf = await buildPoTemplate(base)
    const { get } = await readBuf(buf)
    expect(get(2, 10)).toBe('采购单编号：272750T')
    expect(get(3, 1)).toBe('TO:东莞市粤徽磁铁制品有限公司')
    expect(get(4, 1)).toBe('ATTN:何先生')
    expect(get(6, 10)).toBe('适用机型：CSP_V3i')
    // 明细行：序号|SKU|名称|规格|材质|表面处理|单位|用量|数量|单价含税|金额|备注|不含税
    expect(get(10, 1)).toBe('1')
    expect(get(10, 2)).toBe('CSP-058')
    expect(get(10, 3)).toBe('磁铁')
    expect(get(10, 4)).toBe('F5*4*3')
    expect(get(10, 5)).toBe('强磁 镀锌')
    expect(get(10, 6)).toBe('电镀白镍')
    expect(get(10, 7)).toBe('PCS')
    expect(get(10, 8)).toBe('2')
    expect(get(10, 9)).toBe('2050')
    expect(get(10, 10)).toBe('0.264')
    expect(get(10, 11)).toBe('=J10*I10')
    expect(get(10, 12)).toBe('请给3‰免费备品')
    expect(get(10, 15)).toBe('0.24')
    // 合计/大写
    expect(get(12, 11)).toBe('=SUM(K10:K10)')
    expect(get(13, 11)).toBe('=K12')
    // 条款动态：付款方式 + 交货时间
    expect(get(17, 1)).toContain('付款方式：货到付款')
    expect(get(25, 1)).toBe('3.3 预计交货时间：2026.09.12')
  })

  it('模板 A 多行明细：插入样式行、合计覆盖、大写指向新行、数量逐行填充', async () => {
    const data: PoDocData = {
      ...base,
      lines: [
        base.lines[0]!,
        { ...base.lines[0]!, sku: 'CSP-100', name: '不锈钢轴', qty: 1000, unitPriceInclTax: 0.55 },
        { ...base.lines[0]!, sku: 'CSP-015', name: '支撑铁片', qty: 500, unitPriceInclTax: 3.25 },
      ],
    }
    const buf = await buildPoTemplate(data)
    const { get } = await readBuf(buf)
    expect(get(11, 1)).toBe('2')
    expect(get(11, 2)).toBe('CSP-100')
    expect(get(11, 9)).toBe('1000')
    expect(get(12, 2)).toBe('CSP-015')
    expect(get(12, 9)).toBe('500')
    // 明细 3 行 R10-R12 → 合计 R13、大写 R14
    expect(get(13, 11)).toBe('=SUM(K10:K12)')
    expect(get(14, 11)).toBe('=K13')
  })

  it('模板 B（锦名诚=不含税）：序号/表面处理/备注/金额=数量×单价/交货时间', async () => {
    const data: PoDocData = {
      ...base,
      headerName: '东莞市锦名诚电子有限公司',
      orderNo: 'PO-DS-0217D',
      taxPoint: null,
      lines: [
        {
          sku: 'P1927-24554', name: '磁铁', spec: 'Ø15*5', material: 'N54', finish: '电镀白镍',
          unit: 'pcs', usage: 4, qty: 2000, unitPrice: 4.46, unitPriceInclTax: null, note: '请给3‰免费备品',
        },
      ],
    }
    const buf = await buildPoTemplate(data)
    const { get } = await readBuf(buf)
    expect(get(2, 10)).toBe('采购单编号：PO-DS-0217D')
    expect(get(10, 1)).toBe('1')
    expect(get(10, 2)).toBe('P1927-24554')
    expect(get(10, 3)).toBe('磁铁')
    expect(get(10, 6)).toBe('电镀白镍')
    expect(get(10, 8)).toBe('4')
    expect(get(10, 9)).toBe('2000')
    expect(get(10, 10)).toBe('4.46')
    expect(get(10, 11)).toBe('=I10*J10')
    expect(get(10, 12)).toBe('请给3‰免费备品')
    expect(get(13, 11)).toBe('=SUM(K10:K10)')
    expect(get(14, 11)).toBe('=K13')
    expect(get(18, 1)).toContain('付款方式：货到付款')
    expect(get(29, 1)).toBe('3.4 交货时间：2026.09.12')
  })

  it('模板 B 多行明细：插入后合计/大写行号正确', async () => {
    const data: PoDocData = {
      ...base,
      headerName: '东莞市锦名诚电子有限公司',
      lines: [
        base.lines[0]!,
        { ...base.lines[0]!, sku: 'CSS-064', qty: 4000 },
        { ...base.lines[0]!, sku: 'CSS-016', qty: 4000 },
        { ...base.lines[0]!, sku: 'CSS-078', qty: 4000 },
      ],
    }
    const buf = await buildPoTemplate(data)
    const { get } = await readBuf(buf)
    // 明细 4 行 R10-R13 → 合计 R14、大写 R15
    expect(get(14, 11)).toBe('=SUM(K10:K13)')
    expect(get(15, 11)).toBe('=K14')
  })
})
