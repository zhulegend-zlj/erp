import ExcelJS from 'exceljs'
import { resolve } from 'node:path'

/**
 * 采购单打印模板填充（2026-08-29 老板拍板，两套模板）：
 * - PurchaseOrder-ZRH.xlsx：抬头=智锐恒 → 含税模板（单价(含税)+不含税两列，金额=H*G 公式）
 * - PurchaseOrder-JMC.xlsx：抬头=锦名诚 → 不含税模板（单价单列）
 * 模板为采购历史原件的 Excel 转换件（样式 100% 原样）；导出时打开模板只填内容，
 * 明细行数超过模板时复制样式行插入、合并单元格同步位移、合计公式重写覆盖范围。
 */

export const PO_TEMPLATE_DIR = resolve(process.cwd(), 'templates')
export const PO_TEMPLATE_ZRH = 'PurchaseOrder-ZRH.xlsx' // 智锐恒（含税）
export const PO_TEMPLATE_JMC = 'PurchaseOrder-JMC.xlsx' // 锦名诚（不含税）

export interface PoDocLine {
  sku: string
  name: string
  spec: string | null
  material: string | null
  finish: string | null
  unit: string
  usage: number | null
  qty: number
  unitPrice: number // 不含税
  unitPriceInclTax: number | null // 含税（锦名诚单可为空）
  note: string | null
}

export interface PoDocData {
  headerName: string // 智锐恒 / 锦名诚 → 决定模板
  orderNo: string
  orderDate: string // yyyy.mm.dd
  supplier: {
    name: string
    contactPerson: string | null
    phone: string | null
    fax: string | null
    email: string | null
  }
  model: string // 适用机型
  paymentTerms: string | null
  expectedDeliveryDate: string | null
  taxPoint: number | null
  lines: PoDocLine[]
}

const ZRH = {
  file: PO_TEMPLATE_ZRH,
  no: { col: 8, row: 2, prefix: '采购单编号：' },
  to: { col: 1, row: 3, prefix: 'TO:' },
  orderDate: { col: 8, row: 3, prefix: '下单日期：' },
  attn: { col: 1, row: 4, prefix: 'ATTN:' },
  tel: { col: 1, row: 5, prefix: 'TEL:' },
  fax: { col: 1, row: 6, prefix: 'FAX:' },
  email: { col: 1, row: 7, prefix: 'E-mail:' },
  model: { col: 8, row: 6, prefix: '适用机型：' },
  headerRow: 9,
  firstDataRow: 10,
  // 明细列：产品编号/产品名称/规格/材质/用量/单位/采购数量/单价含税/金额含税/预计交货日期/(L)不含税
  cols: { sku: 1, name: 2, spec: 3, material: 4, usage: 5, unit: 6, qty: 7, priceInclTax: 8, amount: 9, delivery: 10, price: 12 },
  totalRowOffset: 2, // 明细最后一行 +2 = 合计行（模板明细1行时合计在 R12）
  totalCol: 9,
  paymentRow: 17, // 1.2 付款方式行
  noteStartRow: 25, // 空行起点（写 3.3/3.4）
  isZrh: true,
}

const JMC = {
  file: PO_TEMPLATE_JMC,
  no: { col: 9, row: 2, prefix: '采购单编号：' },
  to: { col: 1, row: 3, prefix: 'TO:' },
  orderDate: { col: 9, row: 4, prefix: '下单日期：' },
  attn: { col: 1, row: 4, prefix: 'ATTN:' },
  tel: { col: 1, row: 5, prefix: 'TEL:' },
  fax: { col: 1, row: 6, prefix: 'FAX:' },
  email: { col: 1, row: 7, prefix: 'E-mail:' },
  model: { col: 9, row: 6, prefix: '适用机型：' },
  headerRow: 9,
  firstDataRow: 10,
  // 明细列：序号/产品编号/产品名称/规格/材质/表面处理/单位/数量/产品单价/总价/备注
  cols: { seq: 1, sku: 2, name: 3, spec: 4, material: 5, finish: 6, unit: 7, qty: 8, price: 9, amount: 10, note: 11 },
  totalRowOffset: 2,
  totalCol: 10,
  paymentRow: 17, // 1.2 付款方式行
  noteStartRow: 26, // 空行起点（写 3.3/3.4）
  isZrh: false,
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** yyyy.mm.dd */
function dotDate(d: string | Date | null | undefined): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return String(d)
  return dt.getFullYear() + '.' + pad(dt.getMonth() + 1) + '.' + pad(dt.getDate())
}

export async function buildPoTemplate(data: PoDocData): Promise<Buffer> {
  const tpl = (data.headerName ?? '').includes('锦名诚') ? JMC : ZRH
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(resolve(PO_TEMPLATE_DIR, tpl.file))
  const ws = wb.worksheets[0]!
  const n = Math.max(data.lines.length, 1)
  const first = tpl.firstDataRow
  const last = first + n - 1

  // 1) 明细行数 > 模板行数：复制样式行插入（模板只有 1 行数据行）
  if (n > 1) {
    // 先记录插入前的合并块，随后整体下移
    const merges = JSON.parse(JSON.stringify(ws.model.merges ?? [])) as Array<{ top: number; bottom: number }>
    ws.duplicateRow(first, n - 1, true)
    // 合并单元格同步位移（含数据行下方的备注/合计/签名等区块）
    const shift = n - 1
    for (const m of merges) {
      if (m.top >= first) {
        m.top += shift
        m.bottom += shift
      }
    }
    ws.model.merges = merges as never
  }

  // 2) 头部
  const setCell = (pos: { col: number; row: number }, prefix: string, value: string | null | undefined) => {
    if (value == null || value === '') value = ''
    const cell = ws.getCell(pos.row, pos.col)
    cell.value = prefix + value
  }
  setCell(tpl.no, tpl.no.prefix, data.orderNo)
  setCell(tpl.to, tpl.to.prefix, data.supplier.name)
  setCell(tpl.orderDate, tpl.orderDate.prefix, dotDate(data.orderDate))
  setCell(tpl.attn, tpl.attn.prefix, data.supplier.contactPerson)
  setCell(tpl.tel, tpl.tel.prefix, data.supplier.phone)
  setCell(tpl.fax, tpl.fax.prefix, data.supplier.fax)
  setCell(tpl.email, tpl.email.prefix, data.supplier.email)
  setCell(tpl.model, tpl.model.prefix, data.model)

  // 3) 明细行
  data.lines.forEach((line, i) => {
    const r = first + i
    const c = tpl.cols as Record<string, number>
    const set = (col: number | undefined, v: string | number | null | undefined) => {
      if (!col) return
      ws.getCell(r, col).value = v == null || v === '' ? '' : v
    }
    if (!tpl.isZrh) set(c.seq, i + 1)
    set(c.sku, line.sku)
    set(c.name, line.name)
    set(c.spec, line.spec)
    set(c.material, line.material)
    if (tpl.isZrh) {
      set(c.usage, line.usage ?? '')
      set(c.priceInclTax, line.unitPriceInclTax ?? '')
      ws.getCell(r, c.amount!).value = { formula: '=H' + r + '*G' + r }
      set(c.delivery, data.expectedDeliveryDate ?? '')
      set(c.price, line.unitPrice)
      // 含税 = 不含税 × (1+加税点%)：M 列隐藏计算列（原表 =L10*1.1）
      const tp = data.taxPoint ?? 0
      ws.getCell(r, 13).value = { formula: '=L' + r + '*' + (1 + tp / 100) }
    } else {
      set(c.finish, line.finish)
      set(c.qty, line.qty)
      set(c.price, line.unitPrice)
      ws.getCell(r, c.amount!).value = { formula: '=H' + r + '*I' + r }
      set(c.note, line.note)
    }
  })

  // 4) 合计公式覆盖全部明细行
  const totalRow = first + n - 1 + tpl.totalRowOffset
  const colLetter = (n: number) => {
    let s = ''
    let v = n
    while (v > 0) {
      const rem = (v - 1) % 26
      s = String.fromCharCode(65 + rem) + s
      v = Math.floor((v - 1) / 26)
    }
    return s
  }
  const amountCol = colLetter(tpl.totalCol)
  ws.getCell(totalRow, tpl.totalCol).value = {
    formula: '=SUM(' + amountCol + first + ':' + amountCol + last + ')',
  }

  // 5) 付款方式（1.2 行替换）
  if (data.paymentTerms) {
    const cell = ws.getCell(tpl.paymentRow, 1)
    const text = cell.value
    const current = typeof text === 'string' ? text : ''
    cell.value = current.replace(/付款方式[：:].*$/, '付款方式：' + data.paymentTerms + '；')
  }

  // 6) 3.3 / 3.4 条款（模板无此行则写在空行，样式复制上一行）
  if (data.expectedDeliveryDate) {
    let row = ws.getRow(tpl.noteStartRow)
    // 找到第一个空行（该区域模板为空）
    while (row.getCell(1).value !== null && row.getCell(1).value !== '') {
      row = ws.getRow(row.number + 1)
    }
    const base = ws.getRow(tpl.noteStartRow - 1)
    const r1 = row.number
    ws.getCell(r1, 1).value = '                   3.3 请务必在承诺交货时间前交货；'
    base.eachCell({ includeEmpty: false }, (cell, col) => {
      const target = ws.getCell(r1, col)
      target.style = { ...cell.style }
      if (cell.font) target.font = { ...cell.font }
    })
    const r2 = r1 + 1
    ws.getCell(r2, 1).value = '                   3.4 预计交货时间：' + data.expectedDeliveryDate
    const src2 = ws.getRow(tpl.noteStartRow - 1)
    src2.eachCell({ includeEmpty: false }, (cell, col) => {
      const target = ws.getCell(r2, col)
      target.style = { ...cell.style }
      if (cell.font) target.font = { ...cell.font }
    })
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 导出文件名字 */
export function poDocFileName(orderNo: string): string {
  return '采购单-' + orderNo + '.xlsx'
}
