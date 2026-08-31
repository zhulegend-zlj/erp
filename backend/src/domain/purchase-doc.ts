import ExcelJS from 'exceljs'
import { resolve } from 'node:path'

/**
 * 采购单打印模板填充（2026-08-31 按老板要求重做模板，总结 590 张历史单的共有内容）：
 * - PurchaseOrder-ZRH.xlsx：抬头=智锐恒 → 含税模板
 *   表头：序号|产品编号|产品名称|规格|材质|表面处理|单位|用量|采购数量|单价(含税)|金额(含税)|备注|不含税
 *   条款：1.1 人民币结算 / 1.2 付款方式（动态）/ 2.1 按工程图 / 2.2 检验+AQL / 3.1 两天回签 /
 *         3.2 送货单注明 / 3.3 预计交货时间（动态）
 * - PurchaseOrder-JMC.xlsx：抬头=锦名诚 → 不含税模板
 *   表头：序号|产品编号|产品名称|规格|材质|表面处理|单位|用量|数量|产品单价|金额|备注
 *   条款：1.1 / 1.2 付款方式（动态）/ 1.3 不含13%增值税 / 2.1 / 2.2+AQL / 3.1 / 3.2 / 3.3 / 3.4 交货时间（动态）
 * 明细行数超过模板时复制样式行插入、合并单元格同步位移、合计/大写公式重写；模板已设一页打印（fitToPage 1×1 横向 A4）。
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
  orderDate: string // ISO 日期
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

interface TplPos {
  file: string
  no: { col: number; row: number; prefix: string }
  to: { col: number; row: number; prefix: string }
  orderDate: { col: number; row: number; prefix: string }
  attn: { col: number; row: number; prefix: string }
  tel: { col: number; row: number; prefix: string }
  fax: { col: number; row: number; prefix: string } | null
  email: { col: number; row: number; prefix: string }
  model: { col: number; row: number; prefix: string }
  headerRow: number
  firstDataRow: number
  cols: {
    seq: number
    sku: number
    name: number
    spec: number
    material: number
    finish: number
    unit: number
    usage: number
    qty: number
    price: number
    priceInclTax: number
    amount: number
    note: number
  }
  totalRowOffset: number
  totalCol: number
  paymentRow: number
  deliveryRow: number
  isZrh: boolean
}

const ZRH: TplPos = {
  file: PO_TEMPLATE_ZRH,
  no: { col: 10, row: 2, prefix: '采购单编号：' },
  to: { col: 1, row: 3, prefix: 'TO:' },
  orderDate: { col: 10, row: 4, prefix: '下单日期：' },
  attn: { col: 1, row: 4, prefix: 'ATTN:' },
  tel: { col: 1, row: 5, prefix: 'TEL:' },
  fax: { col: 1, row: 6, prefix: 'FAX:' },
  email: { col: 1, row: 7, prefix: 'E-mail:' },
  model: { col: 10, row: 6, prefix: '机型：' },
  headerRow: 9,
  firstDataRow: 10,
  cols: { seq: 1, sku: 2, name: 3, spec: 4, material: 5, finish: 6, unit: 8, usage: 7, qty: 9, price: 18, priceInclTax: 10, amount: 11, note: 12 },
  totalRowOffset: 1,
  totalCol: 11,
  paymentRow: 17,
  deliveryRow: 26,
  isZrh: true,
}

const JMC: TplPos = {
  file: PO_TEMPLATE_JMC,
  no: { col: 10, row: 2, prefix: '采购单编号：' },
  to: { col: 1, row: 3, prefix: 'TO:' },
  orderDate: { col: 10, row: 4, prefix: '下单日期：' },
  attn: { col: 1, row: 4, prefix: 'ATTN:' },
  tel: { col: 1, row: 5, prefix: 'TEL:' },
  fax: { col: 1, row: 6, prefix: 'FAX:' },
  email: { col: 1, row: 7, prefix: 'E-mail:' },
  model: { col: 10, row: 6, prefix: '适用机型：' },
  headerRow: 9,
  firstDataRow: 10,
  cols: { seq: 1, sku: 2, name: 3, spec: 4, material: 5, finish: 6, unit: 7, usage: 8, qty: 9, price: 10, priceInclTax: 0, amount: 11, note: 12 },
  totalRowOffset: 1,
  totalCol: 11,
  paymentRow: 18,
  deliveryRow: 29,
  isZrh: false,
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function dotDate(d: string | Date | null | undefined): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return String(d)
  return dt.getFullYear() + '.' + pad(dt.getMonth() + 1) + '.' + pad(dt.getDate())
}

function colLetter(n: number): string {
  let s = ''
  let v = n
  while (v > 0) {
    const rem = (v - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    v = Math.floor((v - 1) / 26)
  }
  return s
}

export async function buildPoTemplate(data: PoDocData): Promise<Buffer> {
  const tpl = (data.headerName ?? '').includes('锦名诚') ? JMC : ZRH
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(resolve(PO_TEMPLATE_DIR, tpl.file))
  const ws = wb.worksheets[0]!
  const n = Math.max(data.lines.length, 1)
  const first = tpl.firstDataRow
  const slot = tpl.isZrh ? 2 : 3 // 模板自带明细行槽位数（智锐恒 2 行、锦名诚 3 行）
  const last = first + n - 1
  const c = tpl.cols

  // 1) 明细行数超过模板槽位：复制样式行插入 + 合并单元格同步位移；
  //    未超过时合计/大写行位置不变（模板原样）
  if (n > slot) {
    const insertCount = n - slot
    const merges = JSON.parse(JSON.stringify(ws.model.merges ?? [])) as Array<{ top: number; bottom: number }>
    ws.duplicateRow(first, insertCount, true)
    for (const m of merges) {
      if (m.top >= first) {
        m.top += insertCount
        m.bottom += insertCount
      }
    }
    ws.model.merges = merges as never
  }

  // 2) 头部
  const setCell = (pos: { col: number; row: number } | null, prefix: string, value: string | null | undefined) => {
    if (!pos) return
    const cell = ws.getCell(pos.row, pos.col)
    cell.value = prefix + (value ?? '')
  }
  setCell(tpl.no, tpl.no.prefix, data.orderNo)
  setCell(tpl.to, tpl.to.prefix, data.supplier.name)
  setCell(tpl.orderDate, tpl.orderDate.prefix, dotDate(data.orderDate))
  setCell(tpl.attn, tpl.attn.prefix, data.supplier.contactPerson)
  setCell(tpl.tel, tpl.tel.prefix, data.supplier.phone)
  setCell(tpl.fax, tpl.fax?.prefix ?? '', data.supplier.fax)
  setCell(tpl.email, tpl.email.prefix, data.supplier.email)
  setCell(tpl.model, tpl.model.prefix, data.model)

  // 3) 明细行（序号/料号/名称/规格/材质/表面处理/单位/用量/数量/单价/金额/备注/不含税）
  data.lines.forEach((line, i) => {
    const r = first + i
    const set = (col: number, v: string | number | null | undefined) => {
      if (!col) return
      ws.getCell(r, col).value = v == null || v === '' ? '' : v
    }
    set(c.seq, i + 1)
    set(c.sku, line.sku)
    set(c.name, line.name)
    set(c.spec, line.spec)
    set(c.material, line.material)
    set(c.finish, line.finish)
    set(c.unit, line.unit)
    set(c.usage, line.usage ?? '')
    set(c.qty, line.qty)
    set(c.price, line.unitPrice)
    set(c.note, line.note)
    if (tpl.isZrh) {
      // 金额(含税) = 单价(含税)J × 采购数量I
      set(c.priceInclTax, line.unitPriceInclTax ?? '')
      ws.getCell(r, c.amount).value = { formula: '=J' + r + '*I' + r }
      // 隐藏计算列 S：不含税R×(1+税点)
      const tp = data.taxPoint ?? 0
      ws.getCell(r, 19).value = { formula: '=R' + r + '*' + (1 + tp / 100) }
    } else {
      // 金额 = 数量 × 单价
      ws.getCell(r, c.amount).value = { formula: '=I' + r + '*J' + r }
    }
  })

  // 4) 合计公式覆盖全部明细行 + 大写金额行指向新合计行
  const totalRow = first + Math.max(n, slot) - 1 + tpl.totalRowOffset
  const amountCol = colLetter(tpl.totalCol)
  ws.getCell(totalRow, tpl.totalCol).value = {
    formula: '=SUM(' + amountCol + first + ':' + amountCol + last + ')',
  }
  ws.getCell(totalRow + 1, tpl.totalCol).value = { formula: '=' + amountCol + totalRow }

  // 5) 付款方式（1.2 行替换；模板文字可能是富文本，先转纯文本再替换）
  if (data.paymentTerms) {
    const cell = ws.getCell(tpl.paymentRow, 1)
    const raw = cell.value
    let current = ''
    if (typeof raw === 'string') current = raw
    else if (raw && typeof raw === 'object' && (raw as { richText?: Array<{ text: string }> }).richText) {
      current = (raw as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
    }
    cell.value = current.replace(/付款方式[：:].*$/, '付款方式：' + data.paymentTerms + '；')
  }

  // 6) 交货时间行（3.3/3.4 动态填值；无值时只留条款文字）
  const dCell = ws.getCell(tpl.deliveryRow, 1)
  const dRaw = dCell.value
  let dText = ''
  if (typeof dRaw === 'string') dText = dRaw
  else if (dRaw && typeof dRaw === 'object' && (dRaw as { richText?: Array<{ text: string }> }).richText) {
    dText = (dRaw as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
  }
  dCell.value = dText.replace(/(预计交货时间|交货时间)[：:].*$/, '$1：' + (data.expectedDeliveryDate ?? ''))

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 导出文件名字 */
export function poDocFileName(orderNo: string): string {
  return '采购单-' + orderNo + '.xlsx'
}
