import ExcelJS from 'exceljs'
import { resolve } from 'node:path'
import { amountInWords, cartonsInWords } from '../utils/amount-words'
import type { ShipmentDocData, DocLine } from './shipment-docs'

// 以微信原始模板为基础的单证导出：打开模板 → 只填内容 → 样式/合并/列宽原样保留。
// 行数超过模板容量时 duplicateRow 复制最后一条样式行（exceljs spliceRows 自动平移下方合并单元格）。

const TEMPLATES_DIR = resolve(process.cwd(), 'templates')

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function excelDate(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
}

function findRow(ws: ExcelJS.Worksheet, pred: (cell: ExcelJS.Cell) => boolean): number | null {
  for (let r = 1; r <= 100; r++) {
    const row = ws.getRow(r)
    let hit = false
    row.eachCell((cell) => {
      if (pred(cell)) hit = true
    })
    if (hit) return r
  }
  return null
}

function findRowByText(ws: ExcelJS.Worksheet, prefix: string, col?: string): number | null {
  return findRow(ws, (cell) => {
    if (col && cell.address.replace(/\d+$/g, '') !== col) return false
    return typeof cell.value === 'string' && cell.value.startsWith(prefix)
  })
}

function clearCells(ws: ExcelJS.Worksheet, row: number, cols: string[]) {
  const r = ws.getRow(row)
  for (const c of cols) r.getCell(c).value = null
}

function setVal(ws: ExcelJS.Worksheet, addr: string, v: unknown) {
  const cell = ws.getCell(addr)
  cell.value = v === undefined ? null : (v as ExcelJS.CellValue)
}

function addr(col: string, row: number): string {
  return col + row
}

function lineNoMap(lines: DocLine[]): Map<string, string> {
  const map = new Map<string, string>()
  let n = 0
  for (const l of lines) {
    if (!map.has(l.product.sku)) {
      n++
      map.set(l.product.sku, n + '.1')
    }
  }
  return map
}

function descriptionOf(l: DocLine): string {
  return l.product.nameEn || l.product.name
}

function extOf(l: DocLine): number {
  return Math.round(l.qty * (num(l.unitPrice) ?? 0) * 100) / 100
}

function totalAmount(d: ShipmentDocData): number {
  return d.lines.reduce((s, l) => s + l.qty * (num(l.unitPrice) ?? 0), 0)
}

function paymentDays(terms: string | null | undefined): number | null {
  if (!terms) return null
  const m = /NET\s*(\d+)/i.exec(terms)
  if (!m) return null
  const days = Number(m[1])
  return Number.isFinite(days) && days >= 0 ? days : null
}

function markText(l: DocLine): string {
  const parts: string[] = []
  if (l.hblNo) parts.push('HBL#\n' + l.hblNo)
  if (l.containerNo) parts.push('CONTANER:\n' + l.containerNo)
  if (l.sealNo) parts.push('SEAL:\n' + l.sealNo)
  return parts.join('\n')
}

function excelSerial(d: Date): number {
  return Math.round((excelDate(d).getTime() - Date.UTC(1899, 11, 30)) / 86400000)
}

function setWrap(ws: ExcelJS.Worksheet, addr: string) {
  const cell = ws.getCell(addr)
  cell.alignment = { wrapText: true, vertical: 'top' }
}

/** 运输说明：出货时未填则按明细自动生成（SKU 数量 pcs, ...） */
function shippingInstructionsText(d: ShipmentDocData): string {
  if (d.shipment.shippingInstructions) return d.shipment.shippingInstructions
  const bySku = new Map<string, number>()
  for (const l of d.lines) bySku.set(l.product.sku, (bySku.get(l.product.sku) ?? 0) + l.qty)
  const text = [...bySku.entries()].map(([sku, qty]) => sku + ' ' + qty + ' pcs').join(', ')
  return text.slice(0, 240)
}

function fillNotify(ws: ExcelJS.Worksheet, d: ShipmentDocData) {
  const labelRow = findRowByText(ws, 'Notity Party:', 'A')
  if (labelRow === null) return
  const lines = (d.customer.notifyParty || '').split('\n').filter(Boolean).slice(0, 7)
  for (let i = 0; i < 7; i++) {
    setVal(ws, addr('A', labelRow + 1 + i), lines[i] ?? '')
    setWrap(ws, addr('A', labelRow + 1 + i))
  }
}

function fillShipperConsignee(ws: ExcelJS.Worksheet, d: ShipmentDocData, consigneeLabelRow: number) {
  void consigneeLabelRow
  // 发货人块（两张表一致：A5 标签，名称 A6、地址 A7、联系方式 A8）
  setVal(ws, 'A6', d.company.name)
  setVal(ws, 'A7', d.company.address)
  setVal(ws, 'A8', 'Contact: ' + (d.company.contact || '') + (d.company.email ? ';' + d.company.email : ''))
  setWrap(ws, 'A6')
  setWrap(ws, 'A7')
  setWrap(ws, 'A8')
  // 收货人块：标签行 +1 名称、+2 地址、+3 国家、+4 VAT、+5 EORI
  setVal(ws, addr('A', consigneeLabelRow + 1), d.customer.name)
  setVal(ws, addr('A', consigneeLabelRow + 2), d.customer.address ?? '')
  setVal(ws, addr('A', consigneeLabelRow + 3), d.customer.country ?? '')
  setVal(ws, addr('A', consigneeLabelRow + 4), 'VAT#: ' + (d.customer.vatNo ?? ''))
  setVal(ws, addr('A', consigneeLabelRow + 5), 'EORI: ' + (d.customer.eori ?? ''))
  setWrap(ws, addr('A', consigneeLabelRow + 1))
  setWrap(ws, addr('A', consigneeLabelRow + 2))
  fillNotify(ws, d)
}

// ============================== 模板入口 ==============================
const SHEET_FILLERS: Record<string, (ws: ExcelJS.Worksheet, d: ShipmentDocData) => void> = {
  official: fillOfficialSheet,
  commercial: fillCommercialSheet,
  packing: fillPackingSheet,
}

function fillOfficialSheet(ws: ExcelJS.Worksheet, d: ShipmentDocData) {
  // 右上角日期与发票号
  const d2 = ws.getCell('M2')
  d2.value = excelDate(d.shipment.shippedAt)
  setVal(ws, 'M3', d.shipment.invoiceNo ?? '')

  // 抬头（Issuer）
  const issuerAddr = (d.company.address || '').split('\n')
  setVal(ws, 'D4', d.company.name)
  setVal(ws, 'D5', issuerAddr[0] ?? '')
  setVal(ws, 'D6', issuerAddr[1] ?? '')
  setVal(ws, 'D7', issuerAddr[2] ?? '')
  setVal(ws, 'D8', 'Contact: ' + (d.company.contact || ''))
  setVal(ws, 'D9', d.company.email)
  for (const a of ['D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'K4', 'K5', 'K6', 'K7', 'K8']) setWrap(ws, a)

  // 客户（TO）：模板在 K 列（K4 名称、K5-7 地址、K8 联系方式）
  const custAddr = (d.customer.address || '').split('\n')
  setVal(ws, 'K4', d.customer.name)
  setVal(ws, 'K5', custAddr[0] ?? '')
  setVal(ws, 'K6', custAddr[1] ?? '')
  setVal(ws, 'K7', custAddr[2] ?? '')
  setVal(ws, 'K8', 'Contact: ' + (d.customer.contact || ''))

  // 明细：表头 A13 起，模板明细区 6 行（14-19）
  const headerRow = findRowByText(ws, 'Line#', 'A') ?? 13
  const dataStart = headerRow + 1
  const capacity = 6
  const lastDataRow = dataStart + capacity - 1
  const k = d.lines.length
  if (k > capacity) {
    ws.duplicateRow(lastDataRow, k - capacity, true)
  }
  const noMap = lineNoMap(d.lines)
  for (let i = 0; i < k; i++) {
    const l = d.lines[i]!
    const row = dataStart + i
    const ext = extOf(l)
    setVal(ws, addr('A', row), noMap.get(l.product.sku) ?? '')
    setVal(ws, addr('B', row), l.customerPoNo ?? '')
    setVal(ws, addr('C', row), l.product.sku)
    setVal(ws, addr('D', row), descriptionOf(l))
    setVal(ws, addr('H', row), l.qty)
    setVal(ws, addr('I', row), num(l.unitPrice) ?? '')
    setVal(ws, addr('J', row), ext)
    setVal(ws, addr('K', row), ext)
    // Due Date 与原表一致：公式 =M2+账期天数（保留模板 m/d/yy 显示格式）
    const days = paymentDays(d.shipment.paymentTerms)
    const dueCell = ws.getCell(addr('L', row))
    if (days === null) {
      dueCell.value = null
    } else {
      dueCell.value = { formula: 'M2+' + days, result: excelSerial(d.shipment.shippedAt) + days } as ExcelJS.CellFormulaValue
    }
    setVal(ws, addr('M', row), l.remark ?? '')
  }
  for (let i = k; i < capacity; i++) {
    clearCells(ws, dataStart + i, ['A', 'B', 'C', 'D', 'H', 'I', 'J', 'K', 'L', 'M'])
  }

  // 付款记录（来自财务收款）
  const payLabelRow = findRowByText(ws, 'Payment record', 'A')
  if (payLabelRow !== null) {
    const payHeader = payLabelRow + 1
    const payCapacity = 3
    const lastPayRow = payHeader + payCapacity // 最后一个空付款行（表头+1 .. 表头+3）
    if (d.payments.length > payCapacity) {
      ws.duplicateRow(lastPayRow, d.payments.length - payCapacity, true)
    }
    for (let i = 0; i < d.payments.length; i++) {
      const row = payHeader + 1 + i
      setVal(ws, addr('A', row), num(d.payments[i]!.amount) ?? '')
      const bc = ws.getCell(addr('B', row))
      bc.value = excelDate(d.payments[i]!.paidAt)
      bc.numFmt = 'yyyy.mm.dd'
      setVal(ws, addr('C', row), '')
    }
    for (let i = d.payments.length; i < payCapacity; i++) {
      clearCells(ws, payHeader + 1 + i, ['A', 'B', 'C'])
    }
  }

  // 合计 + 大写
  const totalRow = findRow(ws, (c) => c.address === 'G' + c.row && c.value === 'Total:')
  if (totalRow !== null) {
    setVal(ws, addr('H', totalRow), d.lines.reduce((s, l) => s + l.qty, 0))
    setVal(ws, addr('K', totalRow), Math.round(totalAmount(d) * 100) / 100)
  }
  const sayRow = findRow(ws, (c) => typeof c.value === 'string' && c.value.startsWith('SAY'))
  if (sayRow !== null) {
    setVal(ws, addr('A', sayRow), 'SAY TOTAL : CNY ' + amountInWords(Math.round(totalAmount(d) * 100) / 100) + ' ONLY.')
  }

  // 条款区（按标签定位填写）
  const footerMap: Array<[string, string | null]> = [
    ['1.Shipping Date:', null],
    ['2.Shipping instructions:', shippingInstructionsText(d)],
    ['3.Payment terms:', d.shipment.paymentTerms ?? ''],
    ['4.VAT identification number:', d.company.vatNo],
    ['5.Tax rate:', d.shipment.taxRate || d.company.taxRate],
  ]
  for (const [label, value] of footerMap) {
    const r = findRowByText(ws, label, 'A')
    if (r === null) continue
    if (label === '1.Shipping Date:') {
      const c = ws.getCell(addr('D', r))
      c.value = excelDate(d.shipment.shippedAt)
      c.numFmt = 'yyyy.mm.dd'
    } else {
      const c = ws.getCell(addr('D', r))
      c.value = value ?? ''
      if (label === '2.Shipping instructions:') c.numFmt = 'General'
    }
  }
  const bankRow = findRowByText(ws, '6.Collecting bank:', 'A')
  if (bankRow !== null) {
    setVal(ws, addr('D', bankRow), d.company.bankName)
    setVal(ws, addr('D', bankRow + 1), d.company.bankPhone)
    setVal(ws, addr('D', bankRow + 2), d.company.bankAddress)
    setVal(ws, addr('D', bankRow + 4), 'SWIFT: ' + d.company.swift)
    setVal(ws, addr('D', bankRow + 5), 'Account Name: ' + d.company.accountName)
    setVal(ws, addr('D', bankRow + 6), 'Account Number: ' + d.company.accountNo)
  }
  const incotermRow = findRowByText(ws, '7.Incoterm', 'A')
  if (incotermRow !== null) {
    setVal(ws, addr('D', incotermRow), d.shipment.incoterm ?? '')
    setVal(ws, addr('J', incotermRow + 2), d.company.name)
  }
}

function fillCommercialSheet(ws: ExcelJS.Worksheet, d: ShipmentDocData) {
  setVal(ws, 'F3', d.shipment.invoiceNo ?? '')
  const f4 = ws.getCell('F4')
  f4.value = excelDate(d.shipment.shippedAt)
  f4.numFmt = 'yyyy.mm.dd'
  fillShipperConsignee(ws, d, 12)

  const headerRow = findRowByText(ws, 'Line#', 'A')
  if (headerRow === null) return
  const dataStart = headerRow + 2 // 29 行为单位行
  const markRow = findRow(ws, (c) => typeof c.value === 'string' && c.value.startsWith('MARK:'))
  const capacity = markRow !== null ? markRow - dataStart : 8
  const lastDataRow = dataStart + capacity - 1
  const k = d.lines.length
  if (k > capacity) {
    ws.duplicateRow(lastDataRow, k - capacity, true)
  }
  const noMap = lineNoMap(d.lines)
  for (let i = 0; i < k; i++) {
    const l = d.lines[i]!
    const row = dataStart + i
    setVal(ws, addr('A', row), noMap.get(l.product.sku) ?? '')
    setVal(ws, addr('B', row), l.product.sku)
    setVal(ws, addr('C', row), descriptionOf(l))
    setVal(ws, addr('D', row), l.customerPoNo ?? '')
    setVal(ws, addr('E', row), l.qty)
    setVal(ws, addr('F', row), num(l.unitPrice) ?? '')
    setVal(ws, addr('G', row), extOf(l))
    setVal(ws, addr('H', row), l.lotNo ?? '')
  }
  for (let i = k; i < capacity; i++) {
    clearCells(ws, dataStart + i, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  }

  const markRow2 = findRow(ws, (c) => typeof c.value === 'string' && c.value.startsWith('MARK:'))
  if (markRow2 !== null) {
    setVal(ws, addr('C', markRow2), 'MARK:' + (d.shipment.mark ?? ''))
    setVal(ws, addr('G', markRow2 + 2), Math.round(totalAmount(d) * 100) / 100) // Total amount 行
    setVal(ws, addr('A', markRow2 + 4), 'SAY CNY ' + amountInWords(Math.round(totalAmount(d) * 100) / 100) + ' ONLY.')
    setVal(ws, addr('C', markRow2 + 7), d.shipment.incoterm ?? '') // Incoterm
    setVal(ws, addr('E', markRow2 + 8), d.shipment.vesselVoyage ?? '') // Vessel
    const etd = ws.getCell(addr('E', markRow2 + 9))
    etd.value = d.shipment.etd ? excelDate(d.shipment.etd) : null
    if (d.shipment.etd) etd.numFmt = 'yyyy.mm.dd'
    const eta = ws.getCell(addr('G', markRow2 + 9))
    eta.value = d.shipment.eta ? excelDate(d.shipment.eta) : null
    if (d.shipment.eta) eta.numFmt = 'yyyy.mm.dd'
    setVal(ws, addr('C', markRow2 + 10), d.shipment.origin ?? '') // Land of origin
    setVal(ws, addr('A', markRow2 + 11), 'customs tariff number: ' + (d.shipment.hsCode ?? ''))
    setVal(ws, addr('A', markRow2 + 12), 'description of goods: ')
  }
}

function fillPackingSheet(ws: ExcelJS.Worksheet, d: ShipmentDocData) {
  setVal(ws, 'H3', d.shipment.invoiceNo ?? '')
  const h4 = ws.getCell('H4')
  h4.value = excelDate(d.shipment.shippedAt)
  h4.numFmt = 'yyyy.mm.dd'
  fillShipperConsignee(ws, d, 11)

  const headerRow = findRowByText(ws, 'Line#', 'A')
  if (headerRow === null) return
  const dataStart = headerRow + 2 // 28 行为单位行
  const totalLabelRow = findRow(ws, (c) => c.value === 'Total amount:')
  const capacity = totalLabelRow !== null ? totalLabelRow - dataStart : 10
  const lastDataRow = dataStart + capacity - 1
  const k = d.lines.length
  if (k > capacity) {
    ws.duplicateRow(lastDataRow, k - capacity, true)
  }
  const noMap = lineNoMap(d.lines)
  for (let i = 0; i < k; i++) {
    const l = d.lines[i]!
    const row = dataStart + i
    setVal(ws, addr('A', row), noMap.get(l.product.sku) ?? '')
    setVal(ws, addr('B', row), l.product.sku)
    setVal(ws, addr('C', row), descriptionOf(l))
    setVal(ws, addr('D', row), l.customerPoNo ?? '')
    setVal(ws, addr('E', row), l.qty)
    setVal(ws, addr('F', row), l.cartons ?? '')
    setVal(ws, addr('G', row), num(l.netWeight) ?? '')
    setVal(ws, addr('H', row), num(l.grossWeight) ?? '')
    setVal(ws, addr('I', row), num(l.cbm) ?? '')
    setVal(ws, addr('J', row), l.lotNo ?? '')
    setVal(ws, addr('K', row), markText(l))
  }
  for (let i = k; i < capacity; i++) {
    clearCells(ws, dataStart + i, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'])
  }
  // 模板 K29:K38 是合并块：Excel 只显示主格（第一行）的值——
  // exceljs 中后写的从格值会覆盖主格显示，因此统一写第一行的唛头，与模板显示一致
  if (d.lines.length > 0) {
    for (let r = dataStart; r <= lastDataRow; r++) {
      setVal(ws, addr('K', r), markText(d.lines[0]!))
    }
  }

  const totalLabelRow2 = findRow(ws, (c) => c.value === 'Total amount:')
  if (totalLabelRow2 !== null) {
    setVal(ws, addr('E', totalLabelRow2), d.lines.reduce((s, l) => s + l.qty, 0))
    setVal(ws, addr('F', totalLabelRow2), d.lines.reduce((s, l) => s + (l.cartons ?? 0), 0))
    setVal(ws, addr('G', totalLabelRow2), Math.round(d.lines.reduce((s, l) => s + (num(l.netWeight) ?? 0), 0) * 100) / 100)
    setVal(ws, addr('H', totalLabelRow2), Math.round(d.lines.reduce((s, l) => s + (num(l.grossWeight) ?? 0), 0) * 100) / 100)
    setVal(ws, addr('I', totalLabelRow2), Math.round(d.lines.reduce((s, l) => s + (num(l.cbm) ?? 0), 0) * 1000000) / 1000000)
    const cartons = d.lines.reduce((s, l) => s + (l.cartons ?? 0), 0)
    setVal(ws, addr('A', totalLabelRow2 + 2), 'SAY TOTAL ' + cartonsInWords(cartons) + ' CARTONS ONLY')
    setVal(ws, addr('C', totalLabelRow2 + 5), d.shipment.incoterm ?? '') // Incoterm（模板 A44 行）
    setVal(ws, addr('G', totalLabelRow2 + 6), d.shipment.vesselVoyage ?? '') // Transport Details
    const etd = ws.getCell(addr('G', totalLabelRow2 + 7))
    etd.value = d.shipment.etd ? excelDate(d.shipment.etd) : null
    if (d.shipment.etd) etd.numFmt = 'yyyy.mm.dd'
    const eta = ws.getCell(addr('I', totalLabelRow2 + 7))
    eta.value = d.shipment.eta ? excelDate(d.shipment.eta) : null
    if (d.shipment.eta) eta.numFmt = 'yyyy.mm.dd'
    setVal(ws, addr('C', totalLabelRow2 + 8), d.shipment.origin ?? '') // Land of origin
    setVal(ws, addr('A', totalLabelRow2 + 9), 'customs tariff number: ' + (d.shipment.hsCode ?? ''))
    setVal(ws, addr('A', totalLabelRow2 + 10), 'description of goods: ')
  }
}

const TEMPLATE_FILES: Record<string, { file: string; sheet: string }> = {
  official: { file: 'OfficialInvoice.xlsx', sheet: 'Sheet1' },
  commercial: { file: 'EU-CommercialInvoice-PackingList.xlsx', sheet: 'Commercial invoice' },
  packing: { file: 'EU-CommercialInvoice-PackingList.xlsx', sheet: 'Packing list' },
}

/** 模板填充：成功返回 Buffer，模板缺失/失败返回 null（调用方回退旧生成器） */
export async function buildFromTemplate(type: 'official' | 'commercial' | 'packing', d: ShipmentDocData): Promise<Buffer | null> {
  const spec = TEMPLATE_FILES[type]
  if (!spec) return null
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(resolve(TEMPLATES_DIR, spec.file))
    const ws = wb.getWorksheet(spec.sheet)
    if (!ws) return null
    SHEET_FILLERS[type]!(ws, d)
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  } catch (err) {
    console.error('[shipment-docs-template] 模板填充失败，回退生成器：', err instanceof Error ? err.message : err)
    return null
  }
}

