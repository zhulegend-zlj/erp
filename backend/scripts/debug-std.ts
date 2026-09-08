import ExcelJS from 'exceljs'
import { buildPoTemplate, type PoDocData } from '../src/domain/purchase-doc'

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile('D:/AI/erp/backend/templates/PurchaseOrder-STD.xlsx')
const ws = wb.worksheets[0]!
console.log('R46 value:', JSON.stringify(ws.getCell(46, 1).value))
console.log('R35 value:', JSON.stringify(ws.getCell(35, 1).value))
console.log('R33 value:', JSON.stringify(ws.getCell(33, 1).value))
const merges = (ws.model.merges ?? []) as Array<{ top: number; left: number; bottom: number; right: number }>
console.log('merges near rows 33-49:', JSON.stringify(merges.filter(m => m.top >= 33 && m.top <= 49)))

const data: PoDocData = {
  headerName: '东莞市锦名诚电子有限公司',
  orderNo: 'PO-DS-0217D',
  orderDate: '2026-08-18T00:00:00.000Z',
  supplier: { name: '东莞市粤徽磁铁制品有限公司', contactPerson: '何先生', phone: '0769-33217318', fax: '', email: '' },
  model: 'CSP_V3i',
  paymentTerms: '货到付款',
  expectedDeliveryDate: '2026.09.12',
  taxPoint: null,
  lines: [{ sku: 'P1927-24554', name: '磁铁', spec: 'Ø15*5', material: 'N54', finish: '电镀白镍', unit: 'pcs', usage: 4, qty: 2000, unitPrice: 4.46, unitPriceInclTax: null, note: '请给3‰免费备品' }],
}
const buf = await buildPoTemplate(data)
const wb2 = new ExcelJS.Workbook()
await wb2.xlsx.load(buf as never)
const ws2 = wb2.worksheets[0]!
console.log('FILLED R46:', JSON.stringify(ws2.getCell(46, 1).value))
console.log('FILLED R35:', JSON.stringify(ws2.getCell(35, 1).value))
