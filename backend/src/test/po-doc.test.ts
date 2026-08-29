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
      sku: 'CSP-058', name: '磁铁', spec: 'F5*4*3', material: '强磁 镀锌', finish: null,
      unit: 'PCS', usage: 2, qty: 2050, unitPrice: 0.24, unitPriceInclTax: 0.264, note: null,
    },
  ],
}

describe('采购单模板填充（两套模板，老板拍板口径）', () => {
  it('模板 A（智锐恒=含税）：编号/TO/ATTN/机型/明细/含税公式/不含税列 全部正确', async () => {
    const buf = await buildPoTemplate(base)
    const { get } = await readBuf(buf)
    expect(get(2, 8)).toBe('采购单编号：272750T')
    expect(get(3, 1)).toBe('TO:东莞市粤徽磁铁制品有限公司')
    expect(get(4, 1)).toBe('ATTN:何先生')
    expect(get(6, 8)).toBe('适用机型：CSP_V3i')
    expect(get(10, 1)).toBe('CSP-058')
    expect(get(10, 2)).toBe('磁铁')
    expect(get(10, 3)).toBe('F5*4*3')
    expect(get(10, 5)).toBe('2') // 用量
    expect(get(10, 7)).toBe('2050') // 采购数量
    expect(get(10, 8)).toBe('0.264') // 含税价
    expect(get(10, 9)).toBe('=H10*G10') // 金额公式
    expect(get(10, 10)).toBe('2026.09.12') // 预计交货
    expect(get(10, 12)).toBe('0.24') // 不含税
    expect(get(12, 9)).toBe('=SUM(I10:I10)') // 合计覆盖
  })

  it('模板 A 多行明细：插入样式行、合计公式覆盖全部、合并块位移', async () => {
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
    expect(get(11, 1)).toBe('CSP-100')
    expect(get(12, 1)).toBe('CSP-015')
    // 明细 3 行（R10-R12），合计在 R14
    expect(get(14, 9)).toBe('=SUM(I10:I12)')
    // 数量列必须按行填充（回归：曾残留模板值 2050 导致金额错）
    expect(get(11, 7)).toBe('1000')
    expect(get(12, 7)).toBe('500')
    // 大写金额公式指向新合计行
    expect(get(15, 9)).toBe('=I14')
  })

  it('模板 B（锦名诚=不含税）：单价单列、金额=H*I、序号/备注列', async () => {
    const data: PoDocData = {
      ...base,
      headerName: '东莞市锦名诚电子有限公司',
      orderNo: 'PO-DS-0217D',
      taxPoint: null,
      lines: [
        {
          sku: 'P1927-24554', name: '磁铁', spec: 'Ø15*5', material: null, finish: '电镀白镍',
          unit: 'pcs', usage: 4, qty: 2000, unitPrice: 4.46, unitPriceInclTax: null, note: '请给3‰免费备品',
        },
      ],
    }
    const buf = await buildPoTemplate(data)
    const { get } = await readBuf(buf)
    expect(get(2, 9)).toBe('采购单编号：PO-DS-0217D')
    expect(get(10, 1)).toBe('1') // 序号
    expect(get(10, 2)).toBe('P1927-24554')
    expect(get(10, 3)).toBe('磁铁')
    expect(get(10, 6)).toBe('电镀白镍') // 表面处理
    expect(get(10, 8)).toBe('2000')
    expect(get(10, 9)).toBe('4.46')
    expect(get(10, 10)).toBe('=H10*I10')
    expect(get(10, 11)).toBe('请给3‰免费备品')
    expect(get(12, 10)).toBe('=SUM(J10:J10)')
  })
})
