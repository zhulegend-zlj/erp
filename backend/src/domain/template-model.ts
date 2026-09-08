import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'

/**
 * A4 采购单迷你模板模型（2026-09-07 老板方案：一张 A4 专用画布，预览=打印=导出同一模型渲染）
 * - cols/rows：列宽/行高（像素，96dpi 口径，A4 宽 ≈ 794px）
 * - cells：key "r:c" → 单元格（合并 = 左上角格带 rs/cs 跨行跨列）
 * - detailRow：明细模板行（渲染时按明细行数重复；可空）
 * - 占位符：{{单号}} {{下单日期}} {{供应商名称}} {{联系人}} {{电话}} {{传真}} {{邮箱}} {{机型}}
 *           {{付款方式}} {{预计交货}} {{备注条款}} {{公司抬头}}
 *           明细：{{序号}} {{料号}} {{名称}} {{规格}} {{材质}} {{表面处理}} {{单位}} {{用量}} {{数量}} {{单价}} {{含税单价}} {{金额}} {{备注}}
 *           {{合计}} {{合计大写}}
 */
export interface TmplCell {
  rs?: number // 行跨
  cs?: number // 列跨
  text?: string
  bold?: boolean
  fs?: number // 字号
  ha?: 'l' | 'c' | 'r'
  va?: 't' | 'm' | 'b'
  bg?: string // 底色 #rrggbb
  border?: boolean
}

export interface TmplModel {
  version: 2
  cols: number[] // 每列宽 px
  rows: number[] // 每行高 px
  cells: Record<string, TmplCell>
  detailRow?: number
}

export interface TmplDocData {
  orderNo: string
  orderDate: string
  headerName: string
  model: string
  paymentTerms: string | null
  expectedDeliveryDate: string | null
  termsNote: string | null
  supplier: { name: string; contactPerson: string | null; phone: string | null; fax: string | null; email: string | null }
  lines: Array<{
    sku: string
    name: string
    spec: string | null
    material: string | null
    finish: string | null
    unit: string
    usage: number | string | null
    qty: number
    unitPrice: number
    unitPriceInclTax: number | null
    note: string | null
  }>
}

// —— xlsx → 模型 ——

function rgbOf(color: { argb?: string } | undefined): string | undefined {
  if (!color?.argb) return undefined
  const a = color.argb
  return a.length === 8 ? '#' + a.slice(2) : '#' + a
}

export function xlsxToModel(buffer: Buffer): TmplModel {
  const wb = new ExcelJS.Workbook()
  void wb.xlsx.load(buffer as never).then(() => undefined)
  return { version: 2, cols: [], rows: [], cells: {} }
}

/** SheetJS 兜底解析（.xls/.csv 及 exceljs 读不了的 xlsx）：合并/宽高/加粗/对齐/边框 */
export function sheetjsToModel(buffer: Buffer): TmplModel {
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true })
  const ws = wb.Sheets[wb.SheetNames[0]!]!
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const cols: number[] = []
  for (let c = 0; c <= range.e.c; c++) {
    const wch = ws['!cols']?.[c]?.wch ?? 9
    cols.push(Math.max(16, Math.round(wch * 7)))
  }
  const rows: number[] = []
  for (let r = 0; r <= range.e.r; r++) {
    const hpt = ws['!rows']?.[r]?.hpt ?? 18
    rows.push(Math.max(16, Math.round((hpt * 96) / 72)))
  }
  const cells: Record<string, TmplCell> = {}
  for (const m of ws['!merges'] ?? []) {
    const rs = m.e.r - m.s.r + 1
    const cs = m.e.c - m.s.c + 1
    cells[m.s.r + ':' + m.s.c] = { ...(cells[m.s.r + ':' + m.s.c] ?? {}), rs, cs }
  }
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as
        | { v?: unknown; s?: { font?: { bold?: boolean; sz?: number }; fill?: { fgColor?: { rgb?: string } }; alignment?: { horizontal?: string; vertical?: string }; border?: unknown } }
        | undefined
      if (!cell) continue
      const s = cell.s ?? {}
      const v = cell.v
      const text = v == null ? '' : typeof v === 'number' ? String(v) : String(v)
      const hasBorder = s.border != null && /thin|medium|thick|double/.test(JSON.stringify(s.border))
      const merged = cells[r + ':' + c]
      if (text === '' && !merged && !hasBorder) continue
      const style: TmplCell = {}
      if (text !== '') style.text = text
      if (s.font?.bold) style.bold = true
      if (typeof s.font?.sz === 'number') style.fs = s.font.sz
      if (s.alignment?.horizontal === 'left' || s.alignment?.horizontal === 'center' || s.alignment?.horizontal === 'right') {
        style.ha = s.alignment.horizontal === 'left' ? 'l' : s.alignment.horizontal === 'center' ? 'c' : 'r'
      }
      if (s.alignment?.vertical === 'top' || s.alignment?.vertical === 'middle' || s.alignment?.vertical === 'bottom') {
        style.va = s.alignment.vertical === 'top' ? 't' : s.alignment.vertical === 'middle' ? 'm' : 'b'
      }
      if (s.fill?.fgColor?.rgb && s.fill.fgColor.rgb !== 'FFFFFFFF') style.bg = '#' + s.fill.fgColor.rgb.slice(-6)
      if (hasBorder) style.border = true
      cells[r + ':' + c] = { ...(cells[r + ':' + c] ?? {}), ...style }
    }
  }
  return { version: 2, cols, rows, cells }
}

/** 异步版（exceljs load 是异步的） */
export async function xlsxToModelAsync(buffer: Buffer): Promise<TmplModel> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as never)
  const ws = wb.worksheets[0]!
  const cols: number[] = []
  for (let c = 1; c <= ws.columnCount; c++) {
    const col = ws.getColumn(c)
    cols.push(Math.max(16, Math.round((typeof col.width === 'number' ? col.width : 9) * 7)))
  }
  const rows: number[] = []
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const h = typeof row.height === 'number' ? row.height : 18
    rows.push(Math.max(16, Math.round(h * 96 / 72)))
  }
  const cells: Record<string, TmplCell> = {}
  // 合并区域
  const mergeOf = new Map<string, { rs: number; cs: number }>()
  for (const m of (ws.model.merges ?? []) as unknown as Array<{ top: number | string; left: number | string; bottom: number | string; right: number | string }>) {
    const top = Number(m.top) - 1
    const left = Number(m.left) - 1
    const rs = Number(m.bottom) - Number(m.top) + 1
    const cs = Number(m.right) - Number(m.left) + 1
    mergeOf.set(top + ':' + left, { rs, cs })
  }
  // 单元格
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = ws.getCell(r, c)
      const v = cell.value
      const m = mergeOf.get((r - 1) + ':' + (c - 1))
      if (m && m.rs * m.cs > 1) {
        cells[(r - 1) + ':' + (c - 1)] = { rs: m.rs, cs: m.cs }
      }
      let text = ''
      if (typeof v === 'string') text = v
      else if (typeof v === 'number') text = String(v)
      else if (v instanceof Date) text = v.toISOString().slice(0, 10)
      else if (v && typeof v === 'object' && (v as { richText?: Array<{ text: string }> }).richText) {
        text = (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
      } else if (v && typeof v === 'object' && (v as { text?: string }).text) {
        text = String((v as { text: string }).text)
      }
      const hasBorder = Object.values(cell.border ?? {}).some((b) => (b as { style?: string } | undefined)?.style != null)
      if (text === '' && !m && !hasBorder) continue
      const style: TmplCell = {}
      if (text !== '') style.text = text
      if (cell.font?.bold) style.bold = true
      if (typeof cell.font?.size === 'number') style.fs = cell.font.size
      const halign = cell.alignment?.horizontal
      if (halign === 'left' || halign === 'center' || halign === 'right') style.ha = halign === 'left' ? 'l' : halign === 'center' ? 'c' : 'r'
      const valign = cell.alignment?.vertical
      if (valign === 'top' || valign === 'middle' || valign === 'bottom') style.va = valign === 'top' ? 't' : valign === 'middle' ? 'm' : 'b'
      const bg = rgbOf(cell.fill as { argb?: string } | undefined)
      if (bg && bg !== '#ffffff') style.bg = bg
      if (hasBorder) style.border = true
      cells[(r - 1) + ':' + (c - 1)] = { ...(cells[(r - 1) + ':' + (c - 1)] ?? {}), ...style }
    }
  }
  return { version: 2, cols, rows, cells }
}

// —— 模型 → HTML（预览/打印同一渲染，保证所见即所得）——

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fillToken(token: string, line: TmplDocData['lines'][number] | null, data: TmplDocData, totalAmount: number, totalAmountCn: string): string {
  if (line) {
    const map: Record<string, string> = {
      '序号': String(data.lines.indexOf(line) + 1),
      '料号': line.sku,
      '名称': line.name,
      '规格': line.spec ?? '',
      '材质': line.material ?? '',
      '表面处理': line.finish ?? '',
      '单位': line.unit,
      '用量': line.usage == null ? '' : String(line.usage),
      '数量': String(line.qty),
      '单价': String(line.unitPrice),
      '含税单价': line.unitPriceInclTax != null ? String(line.unitPriceInclTax) : '',
      '金额': String(Math.round(line.qty * line.unitPrice * 100) / 100),
      '备注': line.note ?? '',
    }
    return map[token] ?? ''
  }
  const map: Record<string, string> = {
    '单号': data.orderNo,
    '下单日期': data.orderDate,
    '供应商名称': data.supplier.name,
    '联系人': data.supplier.contactPerson ?? '',
    '电话': data.supplier.phone ?? '',
    '传真': data.supplier.fax ?? '',
    '邮箱': data.supplier.email ?? '',
    '机型': data.model,
    '付款方式': data.paymentTerms ?? '',
    '预计交货': data.expectedDeliveryDate ?? '',
    '备注条款': data.termsNote ?? '',
    '公司抬头': data.headerName,
    '合计': String(totalAmount),
    '合计大写': totalAmountCn,
  }
  return map[token] ?? ''
}

function cellHtml(cell: TmplCell, line: TmplDocData['lines'][number] | null, data: TmplDocData, totalAmount: number, totalAmountCn: string): string {
  let text = cell.text ?? ''
  text = text.replace(/{{([^}]+)}}/g, (_, token: string) => fillToken(token.trim(), line, data, totalAmount, totalAmountCn))
  const style: string[] = []
  if (cell.bold) style.push('font-weight:700')
  if (cell.fs) style.push('font-size:' + cell.fs + 'pt')
  if (cell.ha === 'c') style.push('text-align:center')
  else if (cell.ha === 'r') style.push('text-align:right')
  else style.push('text-align:left')
  if (cell.va === 'm') style.push('vertical-align:middle')
  else if (cell.va === 'b') style.push('vertical-align:bottom')
  else style.push('vertical-align:top')
  if (cell.bg) style.push('background:' + cell.bg)
  style.push('border:1px solid #999')
  return '<td style="' + style.join(';') + '">' + escHtml(text) + '</td>'
}

export function modelToHtml(model: TmplModel, data: TmplDocData, totalAmount: number, totalAmountCn: string): string {
  const rowCount = model.rows.length
  const colCount = model.cols.length
  const n = Math.max(1, data.lines.length)
  // 明细行重复：detailRow 之前照常；detailRow 重复 n 次；其后照常（合计行等）
  const order: Array<number | 'detail'> = []
  for (let r = 0; r < rowCount; r++) {
    if (model.detailRow != null && r === model.detailRow) order.push('detail')
    else order.push(r)
  }
  // 被合并覆盖的格子跳过
  const covered = new Set<string>()
  for (const [key, cell] of Object.entries(model.cells)) {
    if (!cell.rs || !cell.cs || cell.rs * cell.cs <= 1) continue
    const [r, c] = key.split(':').map(Number)
    if (r == null || c == null) continue
    for (let i = 0; i < cell.rs; i++) {
      for (let j = 0; j < cell.cs; j++) {
        if (i !== 0 || j !== 0) covered.add((r + i) + ':' + (c + j))
      }
    }
  }
  const lines = data.lines
  let html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:#525659;font-family:SimSun,"Microsoft YaHei",serif;}' +
    '.page{background:#fff;width:794px;margin:0 auto;padding:18px 24px;box-sizing:border-box;}' +
    'table{border-collapse:collapse;table-layout:fixed;width:100%;}' +
    'td{word-break:break-all;overflow:hidden;padding:2px 4px;font-size:12pt;}' +
    '@media print{body{background:#fff}.page{margin:0;padding:0}}' +
    '@page{size:A4 landscape;margin:8mm}' +
    '</style></head><body><div class="page"><table><colgroup>' +
    model.cols.map((w) => '<col style="width:' + w + 'px">').join('') +
    '</colgroup>'
  for (const r of order) {
    if (r === 'detail') {
      for (let li = 0; li < n; li++) {
        html += '<tr style="height:' + model.rows[model.detailRow!] + 'px">'
        for (let c = 0; c < colCount; c++) {
          if (covered.has(model.detailRow + ':' + c)) continue
          const cell = model.cells[model.detailRow + ':' + c]
          if (cell?.rs && cell.rs > 1) {
            const flatCell: TmplCell = { ...cell }
            delete flatCell.rs
            delete flatCell.cs
            html += cellHtml(flatCell, lines[li] ?? null, data, totalAmount, totalAmountCn)
          } else {
            html += cellHtml(cell ?? {}, lines[li] ?? null, data, totalAmount, totalAmountCn)
          }
        }
        html += '</tr>'
      }
      continue
    }
    html += '<tr style="height:' + (model.rows[r] ?? 18) + 'px">'
    for (let c = 0; c < colCount; c++) {
      if (covered.has(r + ':' + c)) continue
      const cell = model.cells[r + ':' + c] ?? {}
      html += cellHtml(cell, null, data, totalAmount, totalAmountCn)
    }
    html += '</tr>'
  }
  html += '</table></div></body></html>'
  return html
}

// —— 模型 → xlsx（保留 Excel 导出可选）——

export async function modelToXlsx(model: TmplModel, data: TmplDocData, totalAmount: number, totalAmountCn: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('采购单', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 } })
  for (let c = 0; c < model.cols.length; c++) ws.getColumn(c + 1).width = Math.max(2, model.cols[c]! / 7)
  const rowCount = model.rows.length
  const order: Array<number | 'detail'> = []
  for (let r = 0; r < rowCount; r++) order.push(model.detailRow != null && r === model.detailRow ? 'detail' : r)
  let outRow = 1
  const plainText = (cell: TmplCell, line: TmplDocData['lines'][number] | null): string => {
    let text = cell.text ?? ''
    text = text.replace(/{{([^}]+)}}/g, (_, token: string) => fillToken(token.trim(), line, data, totalAmount, totalAmountCn))
    return text
  }
  for (const r of order) {
    if (r === 'detail') {
      for (const line of data.lines) {
        const dr = model.detailRow ?? 0
        ws.getRow(outRow).height = Math.max(12, (model.rows[dr] ?? 18) * 72 / 96)
        for (let c = 0; c < model.cols.length; c++) {
          const cell = model.cells[model.detailRow + ':' + c] ?? {}
          ws.getCell(outRow, c + 1).value = plainText(cell, line)
        }
        outRow++
      }
      continue
    }
    ws.getRow(outRow).height = Math.max(12, (model.rows[r] ?? 18) * 72 / 96)
    for (let c = 0; c < model.cols.length; c++) {
      const cell = model.cells[r + ':' + c] ?? {}
      const v = plainText(cell, null)
      if (v !== '') ws.getCell(outRow, c + 1).value = v
    }
    outRow++
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 人民币金额大写 */
const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const CN_UNITS = ['', '拾', '佰', '仟']
const CN_GROUP = ['', '万', '亿']
export function amountToCn(amount: number): string {
  const n = Math.round(amount * 100)
  if (n <= 0) return '零元整'
  const yuan = Math.floor(n / 100)
  const jiao = Math.floor((n % 100) / 10)
  const fen = n % 10
  let s = ''
  if (yuan > 0) {
    let g = 0
    let v = yuan
    let part = ''
    while (v > 0) {
      const seg = v % 10000
      if (seg > 0) {
        let segStr = ''
        const segDigits = String(seg).padStart(4, '0')
        let zero = false
        for (let i = 0; i < 4; i++) {
          const d = Number(segDigits[i])
          if (d === 0) zero = true
          else {
            if (zero && segStr !== '') segStr += '零'
            segStr += CN_DIGITS[d]! + CN_UNITS[3 - i]!
            zero = false
          }
        }
        part = segStr + CN_GROUP[g] + part
      } else if (part !== '') {
        part = '零' + part
      }
      v = Math.floor(v / 10000)
      g++
    }
    s = part + '元'
  }
  if (jiao === 0 && fen === 0) return s + '整'
  if (jiao > 0) s += CN_DIGITS[jiao] + '角'
  if (fen > 0) s += CN_DIGITS[fen] + '分'
  return s
}
