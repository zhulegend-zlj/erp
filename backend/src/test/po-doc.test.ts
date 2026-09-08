import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildPoTemplate, type PoDocData } from '../domain/purchase-doc'
import { amountToCn } from '../domain/template-model'

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

describe('采购单模板填充（标准模板：单行槽位，按明细行数插行）', () => {
  it('智锐恒单 1 行：合计紧跟明细行 + 大写无RMB + 备注合并不波及合计', async () => {
    const buf = await buildPoTemplate(base)
    const { ws, get } = await readBuf(buf)
    expect(get(2, 7)).toBe('采购单编号：272750T')
    expect(get(3, 1)).toBe('TO:东莞市粤徽磁铁制品有限公司')
    expect(get(4, 1)).toBe('ATTN:何先生')
    expect(get(4, 7)).toBe('下单日期：2026.08.18')
    expect(get(6, 7)).toBe('适用机型：CSP_V3i')
    expect(get(1, 1)).toContain('东莞市智锐恒电子有限公司')
    expect(get(3, 7)).toBe('FROM:东莞市智锐恒电子有限公司')
    expect(get(27, 8)).toBe('东莞市智锐恒电子有限公司')
    expect(get(8, 8)).toBe('单价 (含税)')
    expect(get(8, 9)).toBe('金额 (含税)')
    // 明细 1 行 R9 → 合计 R10、大写 R11；10 列布局：料号|品名|材质|表面处理|单位|用量|数量|单价|金额|备注
    expect(get(9, 1)).toBe('CSP-058')
    expect(get(9, 2)).toBe('磁铁') // 品名只填中文名称
    expect(get(9, 3)).toBe('强磁 镀锌') // 材质列
    expect(get(9, 4)).toBe('电镀白镍') // 表面处理只中文
    expect(get(9, 5)).toBe('PCS')
    expect(get(9, 6)).toBe('2')
    expect(get(9, 7)).toBe('2050')
    expect(get(9, 8)).toBe('0.264')
    expect(get(9, 9)).toBe('=H9*G9')
    expect(get(9, 10)).toBe('请给3‰免费备品')
    expect(get(10, 8)).toBe('=SUM(I9:I9)')
    expect(get(11, 8)).toBe(amountToCn(2050 * 0.264)) // 2026-09-08 老板：大写不带 RMB 前缀
    expect(get(15, 1)).toContain('付款方式：货到付款')
    expect(get(23, 1)).toContain('3.3 预计交货时间：2026.09.12')
    // 1 行不合并备注列
    expect(JSON.stringify(ws.model.merges)).not.toContain('J9:')
  })

  it('智锐恒 3 行：插行后合计/大写下移 + 备注列合并 J9:J11（不波及合计）', async () => {
    const data: PoDocData = {
      ...base,
      lines: [
        base.lines[0]!,
        { ...base.lines[0]!, sku: 'CSP-100', name: '不锈钢轴', qty: 1000, unitPriceInclTax: 0.55 },
        { ...base.lines[0]!, sku: 'CSP-015', name: '支撑铁片', qty: 500, unitPriceInclTax: 3.25 },
      ],
    }
    const buf = await buildPoTemplate(data)
    const { ws, get } = await readBuf(buf)
    expect(get(10, 1)).toBe('CSP-100')
    expect(get(10, 2)).toBe('不锈钢轴')
    expect(get(10, 8)).toBe('0.55')
    expect(get(11, 2)).toBe('支撑铁片')
    expect(get(11, 8)).toBe('3.25')
    expect(get(12, 8)).toBe('=SUM(I9:I11)')
    expect(get(13, 8)).toBe(amountToCn(541.2 + 550 + 1625)) // 大写不带 RMB 前缀
    expect(get(17, 1)).toContain('付款方式：货到付款')
    expect(get(9, 10)).toBe('请给3‰免费备品') // 相同备注去重
    // 备注列合并范围 = 明细行数，不波及合计行（2026-09-08 老板口径）
    expect(JSON.stringify(ws.model.merges)).toContain('J9:J11')
    expect(JSON.stringify(ws.model.merges)).not.toContain('J9:J12')
    // 确认栏公司名随插行下移（29 = 27 + 2），原行不再有
    expect(get(29, 8)).toBe('东莞市智锐恒电子有限公司')
    expect(get(27, 8)).toBe('')
  })

  it('锦名诚单（不含税价）：抬头锦名诚 + 表头未税口径', async () => {
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
    expect(get(1, 1)).toContain('东莞市锦名诚电子有限公司')
    expect(get(3, 7)).toBe('FROM:东莞市锦名诚电子有限公司')
    expect(get(27, 8)).toBe('东莞市锦名诚电子有限公司')
    expect(get(8, 8)).toBe('单价')
    expect(get(8, 9)).toBe('金额')
    expect(get(9, 1)).toBe('P1927-24554')
    expect(get(9, 2)).toBe('磁铁')
    expect(get(9, 3)).toBe('N54')
    expect(get(9, 4)).toBe('电镀白镍')
    expect(get(9, 5)).toBe('pcs')
    expect(get(9, 6)).toBe('4')
    expect(get(9, 7)).toBe('2000')
    expect(get(9, 8)).toBe('4.46')
    expect(get(9, 9)).toBe('=H9*G9')
    expect(get(9, 10)).toBe('请给3‰免费备品')
    expect(get(10, 8)).toBe('=SUM(I9:I9)')
    expect(get(11, 8)).toBe(amountToCn(8920)) // 大写不带 RMB 前缀
    expect(get(15, 1)).toContain('付款方式：货到付款')
    expect(get(23, 1)).toContain('3.3 预计交货时间：2026.09.12')
  })

  it('锦名诚 4 行：插行后合计/大写行号正确', async () => {
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
    expect(get(13, 8)).toBe('=SUM(I9:I12)')
    expect(get(14, 8)).toBe(amountToCn(492 + 960 * 3)) // 大写不带 RMB 前缀
  })
})
