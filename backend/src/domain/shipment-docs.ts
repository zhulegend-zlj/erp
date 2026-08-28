import ExcelJS from 'exceljs'
import { amountInWords, cartonsInWords } from '../utils/amount-words'

// 三份单证（收款发票 Official Invoice / 商业发票 Commercial Invoice / 装箱单 Packing List）
// 布局按销售提供的微信模板还原（2026-08-26，ZRH20260814006 与 EU ZRHS20260814002）。

export interface DocLine {
  product: { sku: string; name: string; nameEn: string | null; hsCode: string | null }
  qty: number
  unitPrice: string
  customerPoNo: string | null
  lineNo: string | null // 客户OPO行号 Line#（销售录入，原样打印）
  lotNo: string | null
  cartons: number | null
  netWeight: string | null
  grossWeight: string | null
  cbm: string | null
  containerNo: string | null
  sealNo: string | null
  hblNo: string | null
  remark: string | null
}

export interface DocCustomer {
  name: string
  country: string | null
  contact: string | null
  address: string | null
  vatNo: string | null
  eori: string | null
  notifyParty: string | null
}

export interface DocCompany {
  name: string
  address: string
  contact: string
  email: string
  vatNo: string
  taxRate: string
  bankName: string
  bankPhone: string
  bankAddress: string
  swift: string
  accountName: string
  accountNo: string
}

export interface DocPayment {
  amount: string
  paidAt: Date
}

export interface ShipmentDocData {
  company: DocCompany
  customer: DocCustomer
  orderNo: string
  shipment: {
    invoiceNo: string | null
    paymentTerms: string | null
    incoterm: string | null
    mark: string | null
    origin: string | null
    hsCode: string | null
    taxRate: string | null
    vesselVoyage: string | null
    etd: Date | null
    eta: Date | null
    shippingInstructions: string | null
    shippedAt: Date
  }
  lines: DocLine[]
  payments: DocPayment[]
}

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '.' + m + '.' + day
}

function excelDate(d: Date): Date {
  const out = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  return out
}

/** 付款条件 NET 60 / N60 → 60 天；识别不出返回 null */
export function paymentDays(terms: string | null | undefined): number | null {
  if (!terms) return null
  const m = /(?:NET|N)\s*(\d+)/i.exec(terms)
  if (!m) return null
  const days = Number(m[1])
  return Number.isFinite(days) && days >= 0 ? days : null
}

function dueDateFor(shippedAt: Date, terms: string | null): Date | null {
  const days = paymentDays(terms)
  if (days === null) return null
  return excelDate(new Date(shippedAt.getTime() + days * 86400000))
}

/** 行号：优先用销售录入的客户 Line#（如 2.1）原样打印；没有才按 Item#（SKU）分组编号兜底 */
function lineNoMap(lines: DocLine[]): Map<string, string> {
  const map = new Map<string, string>()
  let n = 0
  for (const l of lines) {
    if (!map.has(l.product.sku)) {
      n++
      map.set(l.product.sku, l.lineNo?.trim() || n + '.1')
    }
  }
  return map
}

function descriptionOf(l: DocLine): string {
  return l.product.nameEn || l.product.name
}

function setLabel(ws: ExcelJS.Worksheet, addr: string, text: string, bold = true) {
  const cell = ws.getCell(addr)
  cell.value = text
  if (bold) cell.font = { bold: true }
}

function headerCell(ws: ExcelJS.Worksheet, addr: string, text: string) {
  const cell = ws.getCell(addr)
  cell.value = text
  cell.font = { bold: true, size: 11 }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = THIN
}

// ============================== 收款发票（Official Invoice） ==============================
export function buildOfficialInvoice(d: ShipmentDocData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'erp'
  const ws = wb.addWorksheet('Official Invoice')
  ws.columns = [8, 12, 16, 18, 18, 18, 18, 12, 14, 14, 14, 12, 14, 16, 10, 10].map((w) => ({ width: w }))
  ws.getCell('A1').value = 'Official Invoice'
  ws.getCell('A1').font = { bold: true, size: 16 }
  ws.mergeCells('A1:M1')

  ws.getCell('M2').value = 'DATE:'
  const d2 = ws.getCell('N2')
  d2.value = excelDate(d.shipment.shippedAt)
  d2.numFmt = 'yyyy.mm.dd'
  ws.getCell('M3').value = 'INV.#:'
  ws.getCell('N3').value = d.shipment.invoiceNo ?? ''

  // 抬头（Issuer）与客户（TO）
  setLabel(ws, 'C4', 'Issuer:')
  ws.getCell('D4').value = d.company.name
  ws.mergeCells('D4:G4')
  setLabel(ws, 'K4', 'TO:')
  ws.getCell('L4').value = d.customer.name
  ws.mergeCells('L4:P4')
  const companyAddr = (d.company.address || '').split('\n')
  const custAddr = (d.customer.address || '').split('\n')
  for (let i = 0; i < 3; i++) {
    ws.getCell('D' + (5 + i)).value = companyAddr[i] ?? ''
    ws.mergeCells('D' + (5 + i) + ':G' + (5 + i))
    ws.getCell('L' + (5 + i)).value = custAddr[i] ?? ''
    ws.mergeCells('L' + (5 + i) + ':P' + (5 + i))
  }
  ws.getCell('D8').value = 'Contact: ' + (d.company.contact || '')
  ws.mergeCells('D8:G8')
  ws.getCell('L8').value = 'Contact: ' + (d.customer.contact || '')
  ws.mergeCells('L8:P8')
  ws.getCell('D9').value = d.company.email
  ws.mergeCells('D9:G9')

  // 明细表头（Excel 第 13 行起，照模板）
  const header = ['Line#', 'P.O #', 'Item#', 'Description', '', '', '', "Q'TY\n(PCS)", 'Unite Price\n(CNY)', 'Extended\n(CNY)', 'Due Amount\n(CNY)', 'Due Date', 'Remark', '', '', '']
  header.forEach((h, i) => {
    if (h) headerCell(ws, String.fromCharCode(65 + i) + '13', h)
  })
  ws.mergeCells('D13:G13')
  const noMap = lineNoMap(d.lines)
  let r = 14
  for (const l of d.lines) {
    const row = ws.getRow(r)
    const ext = Math.round((l.qty * (num(l.unitPrice) ?? 0)) * 100) / 100
    // Remark 无内容时回填付款条件（如 N60），保证该列有数据
    const vals = [noMap.get(l.product.sku) ?? '', l.customerPoNo ?? '', l.product.sku, descriptionOf(l), '', '', '', l.qty, num(l.unitPrice) ?? '', ext, ext, '', l.remark ?? d.shipment.paymentTerms ?? '', '', '', '']
    row.values = vals
    const due = dueDateFor(d.shipment.shippedAt, d.shipment.paymentTerms)
    if (due) {
      const cell = ws.getCell('L' + r)
      cell.value = due
      cell.numFmt = 'yyyy.mm.dd'
    }
    row.eachCell((c) => {
      c.border = THIN
      c.alignment = { vertical: 'middle', wrapText: true }
    })
    r++
  }

  // 付款记录（来自财务收款）
  r++
  ws.getCell('A' + r).value = 'Payment record'
  ws.getCell('A' + r).font = { bold: true }
  ws.mergeCells('A' + r + ':G' + r)
  r++
  headerCell(ws, 'A' + r, 'Amount\n(RMB)')
  headerCell(ws, 'B' + r, 'payment date')
  headerCell(ws, 'C' + r, 'Remark')
  for (const p of d.payments) {
    r++
    ws.getCell('A' + r).value = num(p.amount) ?? ''
    const bc = ws.getCell('B' + r)
    bc.value = excelDate(p.paidAt)
    bc.numFmt = 'yyyy.mm.dd'
    ws.getRow(r).eachCell((c) => (c.border = THIN))
  }

  // 合计 + 大写
  r += 2
  setLabel(ws, 'G' + r, 'Total:')
  ws.getCell('H' + r).value = d.lines.reduce((s, l) => s + l.qty, 0)
  const totalAmount = d.lines.reduce((s, l) => s + l.qty * (num(l.unitPrice) ?? 0), 0)
  ws.getCell('K' + r).value = Math.round(totalAmount * 100) / 100
  ;['G' + r, 'H' + r, 'K' + r].forEach((a) => {
    ws.getCell(a).font = { bold: true }
    ws.getCell(a).border = THIN
  })
  r++
  ws.getCell('A' + r).value = 'SAY TOTAL : CNY ' + amountInWords(Math.round(totalAmount * 100) / 100) + ' ONLY.'
  ws.getCell('A' + r).font = { bold: true }
  ws.mergeCells('A' + r + ':M' + r)

  // 条款区
  r += 2
  const footers: [string, string, boolean][] = [
    ['1.Shipping Date:', fmtDate(d.shipment.shippedAt), false],
    ['2.Shipping instructions:', d.shipment.shippingInstructions ?? '', false],
    ['3.Payment terms:', d.shipment.paymentTerms ?? '', false],
    ['4.VAT identification number:', d.company.vatNo, true],
    ['5.Tax rate:', (d.shipment.taxRate || d.company.taxRate).trim() === '' ? '' : /^\d+(\.\d+)?$/.test((d.shipment.taxRate || d.company.taxRate).trim()) ? (d.shipment.taxRate || d.company.taxRate).trim() + '%' : (d.shipment.taxRate || d.company.taxRate).trim(), false],
    ['6.Collecting bank:', d.company.bankName, true],
  ]
  for (const [k, v, merge] of footers) {
    setLabel(ws, 'A' + r, k)
    ws.getCell('D' + r).value = v
    if (merge) ws.mergeCells('D' + r + ':M' + r)
    r++
  }
  for (const v of [d.company.bankPhone, d.company.bankAddress, 'SWIFT: ' + d.company.swift, 'Account Name: ' + d.company.accountName, 'Account Number: ' + d.company.accountNo]) {
    ws.getCell('D' + r).value = v
    ws.mergeCells('D' + r + ':M' + r)
    r++
  }
  setLabel(ws, 'A' + r, '7.Incoterm :')
  ws.getCell('D' + r).value = d.shipment.incoterm ?? ''
  r += 2
  ws.getCell('J' + r).value = d.company.name
  ws.getCell('J' + r).font = { bold: true }
  ws.mergeCells('J' + r + ':M' + r)
  return wb
}

// ============================== 商业发票（Commercial Invoice） ==============================
export function buildCommercialInvoice(d: ShipmentDocData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'erp'
  const ws = wb.addWorksheet('Commercial invoice')
  ws.columns = [22, 16, 46, 14, 12, 12, 14, 14, 12, 12].map((w) => ({ width: w }))
  ws.getCell('A1').value = 'Commercial invoice'
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.mergeCells('A1:H1')

  ws.getCell('E3').value = 'Invoice Number:'
  ws.getCell('F3').value = d.shipment.invoiceNo ?? ''
  ws.mergeCells('F3:G3')
  ws.getCell('E4').value = 'Date:'
  const d4 = ws.getCell('F4')
  d4.value = excelDate(d.shipment.shippedAt)
  d4.numFmt = 'yyyy.mm.dd'
  ws.mergeCells('F4:G4')

  setLabel(ws, 'A5', 'shipper:')
  ws.getCell('A6').value = d.company.name
  ws.getCell('A7').value = d.company.address
  ws.getCell('A7').alignment = { wrapText: true }
  ws.getCell('A8').value = 'Contact: ' + (d.company.contact || '') + (d.company.email ? ';' + d.company.email : '')

  setLabel(ws, 'A11', 'Consignee:')
  ws.getCell('A12').value = d.customer.name
  ws.getCell('A13').value = d.customer.address ?? ''
  ws.getCell('A13').alignment = { wrapText: true }
  ws.getCell('A14').value = d.customer.country ?? ''
  ws.getCell('A15').value = 'VAT#: ' + (d.customer.vatNo ?? '')
  ws.getCell('A16').value = 'EORI: ' + (d.customer.eori ?? '')

  setLabel(ws, 'A18', 'Notity Party:')
  const notify = (d.customer.notifyParty || '').split('\n').filter(Boolean).slice(0, 7)
  notify.forEach((line, i) => {
    ws.getCell('A' + (19 + i)).value = line
  })

  // 表头照模板：28 行为表头、29 行为单位行、数据从 30 行起
  ;['Line#', 'Item#', 'Description', 'PO#', 'Quantity', 'Unit Price', 'Amount', 'Lot. No.'].forEach((h, i) => {
    headerCell(ws, String.fromCharCode(65 + i) + '28', h)
  })
  headerCell(ws, 'E29', '(pcs.)')
  headerCell(ws, 'F29', '(CNY)')
  headerCell(ws, 'G29', '(CNY)')
  const noMap = lineNoMap(d.lines)
  let r = 30
  for (const l of d.lines) {
    const row = ws.getRow(r)
    row.values = [
      noMap.get(l.product.sku) ?? '',
      l.product.sku,
      descriptionOf(l),
      l.customerPoNo ?? '',
      l.qty,
      num(l.unitPrice) ?? '',
      Math.round(l.qty * (num(l.unitPrice) ?? 0) * 100) / 100,
      l.lotNo ?? '',
    ]
    row.eachCell((c) => {
      c.border = THIN
      c.alignment = { vertical: 'middle', wrapText: true }
    })
    r++
  }
  r++
  ws.getCell('C' + r).value = 'MARK:' + (d.shipment.mark ?? '')
  r += 2
  ws.getCell('E' + r).value = 'Total amount:'
  ws.getCell('E' + r).font = { bold: true }
  ws.getCell('F' + r).font = { bold: true }
  ws.mergeCells('E' + r + ':F' + r)
  const totalAmount = d.lines.reduce((s, l) => s + l.qty * (num(l.unitPrice) ?? 0), 0)
  ws.getCell('G' + r).value = Math.round(totalAmount * 100) / 100
  ws.getCell('G' + r).font = { bold: true }
  r += 2
  ws.getCell('A' + r).value = 'SAY CNY ' + amountInWords(Math.round(totalAmount * 100) / 100) + ' ONLY.'
  ws.getCell('A' + r).font = { bold: true }
  ws.mergeCells('A' + r + ':G' + r)
  r += 2
  setLabel(ws, 'A' + r, 'Incoterm: ')
  ws.getCell('C' + r).value = d.shipment.incoterm ?? ''
  r++
  setLabel(ws, 'A' + r, 'Transport Details:')
  ws.getCell('C' + r).value = 'BY Ocean'
  ws.getCell('D' + r).value = 'Vessel/Voyage-No.: '
  ws.getCell('E' + r).value = d.shipment.vesselVoyage ?? ''
  ws.mergeCells('E' + r + ':J' + r)
  r++
  ws.getCell('D' + r).value = 'ETD:'
  const etd = ws.getCell('E' + r)
  if (d.shipment.etd) {
    etd.value = excelDate(d.shipment.etd)
    etd.numFmt = 'yyyy.mm.dd'
  }
  ws.getCell('F' + r).value = 'ETA:'
  const eta = ws.getCell('G' + r)
  if (d.shipment.eta) {
    eta.value = excelDate(d.shipment.eta)
    eta.numFmt = 'yyyy.mm.dd'
  }
  r++
  setLabel(ws, 'A' + r, 'Land of  origin:')
  ws.getCell('C' + r).value = d.shipment.origin ?? ''
  r++
  ws.getCell('A' + r).value = 'customs tariff number: ' + (d.shipment.hsCode ?? '')
  r++
  setLabel(ws, 'A' + r, 'description of goods: ', false)
  return wb
}

// ============================== 装箱单（Packing List） ==============================
export function buildPackingList(d: ShipmentDocData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'erp'
  const ws = wb.addWorksheet('Packing list')
  ws.columns = [22, 16, 46, 14, 10, 10, 12, 12, 12, 14, 34, 10, 10].map((w) => ({ width: w }))
  ws.getCell('A1').value = 'PACKING LIST'
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.mergeCells('A1:I2')

  ws.getCell('G3').value = 'Invoice Number:'
  ws.getCell('H3').value = d.shipment.invoiceNo ?? ''
  ws.mergeCells('H3:I3')
  ws.getCell('G4').value = 'Date:'
  const d4 = ws.getCell('H4')
  d4.value = excelDate(d.shipment.shippedAt)
  d4.numFmt = 'yyyy.mm.dd'
  ws.mergeCells('H4:I4')

  setLabel(ws, 'A5', 'shipper:')
  ws.getCell('A6').value = d.company.name
  ws.getCell('A7').value = d.company.address
  ws.getCell('A7').alignment = { wrapText: true }
  ws.getCell('A8').value = 'Email: ' + d.company.email

  setLabel(ws, 'A10', 'Consignee:')
  ws.getCell('A11').value = d.customer.name
  ws.getCell('A12').value = d.customer.address ?? ''
  ws.getCell('A12').alignment = { wrapText: true }
  ws.getCell('A13').value = d.customer.country ?? ''
  ws.getCell('A14').value = 'VAT#: ' + (d.customer.vatNo ?? '')
  ws.getCell('A15').value = 'EORI: ' + (d.customer.eori ?? '')

  setLabel(ws, 'A17', 'Notity Party:')
  const notify = (d.customer.notifyParty || '').split('\n').filter(Boolean).slice(0, 7)
  notify.forEach((line, i) => {
    ws.getCell('A' + (18 + i)).value = line
  })

  // 表头照模板：27 行表头、28 行单位行、数据从 29 行起
  ;['Line#', 'Item#', 'Description', 'PO#', 'Quantity', 'Package ', 'net weight', 'Gross weight', 'Measurement', 'Lot. No.', 'Shipping Mark'].forEach((h, i) => {
    headerCell(ws, String.fromCharCode(65 + i) + '27', h)
  })
  ;['', '', '', '', '(pcs.)', '(CTN)', ' (kg)', '(kg)', '(CBM)', '', ''].forEach((h, i) => {
    headerCell(ws, String.fromCharCode(65 + i) + '28', h)
  })
  const noMap = lineNoMap(d.lines)
  let r = 29
  for (const l of d.lines) {
    const markParts: string[] = []
    if (l.hblNo) markParts.push('HBL#\n' + l.hblNo)
    if (l.containerNo) markParts.push('CONTANER:\n' + l.containerNo)
    if (l.sealNo) markParts.push('SEAL:\n' + l.sealNo)
    const row = ws.getRow(r)
    row.values = [
      noMap.get(l.product.sku) ?? '',
      l.product.sku,
      descriptionOf(l),
      l.customerPoNo ?? '',
      l.qty,
      l.cartons ?? '',
      num(l.netWeight) ?? '',
      num(l.grossWeight) ?? '',
      num(l.cbm) ?? '',
      l.lotNo ?? '',
      markParts.join('\n'),
    ]
    row.eachCell((c) => {
      c.border = THIN
      c.alignment = { vertical: 'middle', wrapText: true }
    })
    r++
  }
  r++
  ws.getCell('D' + r).value = 'Total amount:'
  ws.getCell('D' + r).font = { bold: true }
  ws.getCell('E' + r).value = d.lines.reduce((s, l) => s + l.qty, 0)
  ws.getCell('F' + r).value = d.lines.reduce((s, l) => s + (l.cartons ?? 0), 0)
  ws.getCell('G' + r).value = Math.round(d.lines.reduce((s, l) => s + (num(l.netWeight) ?? 0), 0) * 100) / 100
  ws.getCell('H' + r).value = Math.round(d.lines.reduce((s, l) => s + (num(l.grossWeight) ?? 0), 0) * 100) / 100
  ws.getCell('I' + r).value = Math.round(d.lines.reduce((s, l) => s + (num(l.cbm) ?? 0), 0) * 1000000) / 1000000
  ;['D' + r, 'E' + r, 'F' + r, 'G' + r, 'H' + r, 'I' + r].forEach((a) => {
    ws.getCell(a).font = { bold: true }
    ws.getCell(a).border = THIN
  })
  r += 2
  ws.getCell('A' + r).value = 'SAY TOTAL ' + cartonsInWords(d.lines.reduce((s, l) => s + (l.cartons ?? 0), 0)) + ' CARTONS ONLY'
  ws.getCell('A' + r).font = { bold: true }
  ws.mergeCells('A' + r + ':J' + r)
  r += 2
  setLabel(ws, 'A' + r, 'Transport Details:')
  ws.getCell('C' + r).value = 'BY Ocean'
  ws.getCell('F' + r).value = 'Vessel/Voyage-No.: '
  ws.getCell('G' + r).value = d.shipment.vesselVoyage ?? ''
  ws.mergeCells('G' + r + ':M' + r)
  r++
  ws.getCell('F' + r).value = 'ETD:'
  const etd = ws.getCell('G' + r)
  if (d.shipment.etd) {
    etd.value = excelDate(d.shipment.etd)
    etd.numFmt = 'yyyy.mm.dd'
  }
  ws.getCell('H' + r).value = 'ETA:'
  const eta = ws.getCell('I' + r)
  if (d.shipment.eta) {
    eta.value = excelDate(d.shipment.eta)
    eta.numFmt = 'yyyy.mm.dd'
  }
  r++
  setLabel(ws, 'A' + r, 'Land of  origin:')
  ws.getCell('C' + r).value = d.shipment.origin ?? ''
  r++
  ws.getCell('A' + r).value = 'customs tariff number: ' + (d.shipment.hsCode ?? '')
  r++
  setLabel(ws, 'A' + r, 'description of goods: ', false)
  return wb
}

