import ExcelJS from 'exceljs'

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile('D:/AI/temp/std-raw5.xlsx')
const ws = wb.worksheets[0]!
// 删除右侧空列（J 起）：原文件带几百列的列宽定义，导出 Excel 会看到大片空白
if (ws.columns.length > 9) ws.columns.splice(9)
const set = (r: number, c: number, v: string) => { ws.getCell(r, c).value = v }
set(2, 6, '采购单编号：')
set(3, 1, 'TO:')
set(4, 1, 'ATTN:')
set(5, 1, 'TEL:')
set(6, 1, 'FAX:')
set(4, 6, '下单日期：')
set(6, 6, '适用机型：')
// 3.3 与原文件一致：20 个前导空格（与 3.1/3.2 对齐）
set(23, 1, '                    3.3 预计交货时间：')
set(8, 9, '备注')
// 抬头：公司名 + 采购单标题分两行
ws.getCell(1, 1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }
ws.getRow(1).height = 54
// 打印比例 100% 时一页 A4：列宽整体压缩（2026-09-08 老板要求）
for (let c = 1; c <= 9; c++) {
  const col = ws.getColumn(c)
  if (typeof col.width === 'number') col.width = Math.round(col.width * 85) / 100
}
// 备注列（单行槽位；填充时按明细行数动态合并）
ws.getColumn(9).width = 11
const thin = { style: 'thin' as const }
for (const r of [8, 9]) {
  ws.getCell(r, 9).border = { top: thin, left: thin, bottom: thin, right: thin }
}
// 备注列右侧对齐：备注列上面的抬头块与下面的合计/确认栏块全部右扩一列（老板要求）
ws.unMergeCells('A1:H1')
ws.mergeCells('A1:I1')
for (const a of ['F2:H2', 'F3:H3', 'F4:H4', 'F5:H5', 'F6:H6', 'F7:H7']) {
  ws.unMergeCells(a)
  ws.mergeCells(a.replace(':H', ':I'))
}
for (const a of ['G10:H10', 'G11:H11']) {
  ws.unMergeCells(a)
  ws.mergeCells(a.replace(':H', ':I'))
}
for (const a of ['G27:I27', 'G29:I29', 'G30:I30']) ws.mergeCells(a)
ws.pageSetup = {
  paperSize: 9,
  orientation: 'portrait',
  fitToPage: false,
  zoom: 100,
  printArea: 'A1:I32',
}
await wb.xlsx.writeFile('D:/AI/erp/backend/templates/PurchaseOrder-STD.xlsx')
console.log('STD_TEMPLATE_WRITTEN sheet=' + ws.name + ' rows=' + ws.rowCount + ' cols=' + ws.columnCount)
