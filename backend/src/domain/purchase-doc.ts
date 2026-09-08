import ExcelJS from 'exceljs'
import { isAbsolute, resolve } from 'node:path'
import { amountToCn } from './template-model'

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
export const PO_TEMPLATE_JMC = 'PurchaseOrder-JMC.xlsx' // 锦名诚（不含税，旧版横向表）
export const PO_TEMPLATE_STD = 'PurchaseOrder-STD.xlsx' // 2026-09-07 老板指定标准模板：原样采购单（A4 纵向，9 列，21 行明细槽位）

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
  sourcing?: string | null // 采购方式（2026-09-01：自购件标橙色提醒）
}

/** 打印模板配置（2026-09-07 老板方案A：预览=导出，模板可控） */
export interface PoTemplateConfig {
  /** 列配置：key = seq/sku/name/spec/material/finish/unit/usage/qty/price/priceInclTax/amount/note */
  cols?: Record<string, { visible?: boolean; width?: number; title?: string }>
  /** 条款覆盖：原文本片段 → 新文本（按单元格整行查找替换） */
  terms?: Record<string, string>
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
  termsNote?: string | null
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
  email: { col: number; row: number; prefix: string } | null
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
  deliveryRow: number | null
  endRow: number // 打印区域最后内容行（确认栏/审核行）
  isZrh: boolean
  slot: number // 模板自带明细行槽位数
  orientation: 'landscape' | 'portrait'
  printCol: string // 打印区域最右列
  amountFormula: (r: number) => string // 金额列公式
  capitalAsText?: boolean // 大写金额直接写文本（RMB 大写），而非公式
  companyBlock?: {
    title: { col: number; row: number } // 抬头大字块：第一行（富文本首个 run）按 headerName 替换公司名
    from: { col: number; row: number; prefix: string } // FROM: 公司名
    confirm: { col: number; row: number } // 底部供应商确认栏右侧公司名
  }
  finishOrMaterial?: boolean // 表面处理列：finish 为空时回退材质
  headerLabels?: Array<{ col: number; zrh: string; jmc: string }> // 表头按含税/未税口径替换
  noteMerged?: boolean // 备注列整列合并成一个单元格（对整单的备注）
}

export const ZRH: TplPos = {
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
  deliveryRow: 25,
  isZrh: true,
  slot: 2,
  orientation: 'landscape',
  printCol: 'R',
  amountFormula: (r) => '=J' + r + '*I' + r,
  endRow: 25,
}

export const JMC: TplPos = {
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
  slot: 3,
  orientation: 'landscape',
  printCol: 'L',
  amountFormula: (r) => '=I' + r + '*J' + r,
  endRow: 29,
}

/** 2026-09-07 老板指定标准模板（D 文件「ZRH含税」表为准 + 信杰文件参考补备注列，A4 纵向）：
 *  料号|品名规格|表面处理/颜色|单位|用量|采购数量|单价(含税)|金额(含税)|备注，23 行明细槽位，含 3.3 交货时间行 */
const STD: TplPos = {
  file: PO_TEMPLATE_STD,
  no: { col: 7, row: 2, prefix: '采购单编号：' },
  to: { col: 1, row: 3, prefix: 'TO:' },
  orderDate: { col: 7, row: 4, prefix: '下单日期：' },
  attn: { col: 1, row: 4, prefix: 'ATTN:' },
  tel: { col: 1, row: 5, prefix: 'TEL:' },
  fax: { col: 1, row: 6, prefix: 'FAX:' },
  email: null,
  model: { col: 7, row: 6, prefix: '适用机型：' },
  headerRow: 8,
  firstDataRow: 9,
  // 10 列布局（2026-09-08 老板：加材质列）：料号|品名规格|材质|表面处理/颜色|单位|用量|采购数量|单价|金额|备注
  cols: { seq: 0, sku: 1, name: 2, spec: 2, material: 3, finish: 4, unit: 5, usage: 6, qty: 7, price: 8, priceInclTax: 0, amount: 9, note: 10 },
  totalRowOffset: 1,
  totalCol: 8,
  paymentRow: 15,
  deliveryRow: 23,
  isZrh: false,
  slot: 1,
  orientation: 'portrait',
  printCol: 'J',
  amountFormula: (r) => '=H' + r + '*G' + r,
  capitalAsText: true,
  endRow: 30,
  finishOrMaterial: true,
  noteMerged: true,
  headerLabels: [
    { col: 8, zrh: '单价 (含税)', jmc: '单价' },
    { col: 9, zrh: '金额 (含税)', jmc: '金额' },
  ],
  companyBlock: {
    title: { col: 1, row: 1 },
    from: { col: 7, row: 3, prefix: 'FROM:' },
    confirm: { col: 8, row: 27 },
  },
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

/** 表面处理只留中文（2026-09-08 老板：导出/预览都不填英文） */
export function cnOnlyText(s: string | null | undefined): string {
  return (s ?? '').replace(/[^\u4e00-\u9fa5，、；：（）·%‰]/g, '').trim()
}

async function renderPoDoc(data: PoDocData, cfg?: PoTemplateConfig | null, tplFileOverride?: string | null): Promise<{ buffer: Buffer; html: string }> {
  // 2026-09-07 老板：智锐恒/锦名诚统一用标准模板（原样采购单）；旧横向模板保留仅作显式绑定兜底
  const tpl = STD
  const useInclTax = (data.headerName ?? '').includes('智锐恒') // 智锐恒单：单价列填含税价
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(isAbsolute(tplFileOverride ?? '') ? tplFileOverride! : resolve(PO_TEMPLATE_DIR, tplFileOverride ?? tpl.file))
  const ws = wb.worksheets[0]!
  const n = Math.max(data.lines.length, 1)
  const first = tpl.firstDataRow
  const slot = tpl.slot
  const last = first + n - 1
  const c = tpl.cols
  const totalCol = tpl.totalCol
  const amountFormula = tpl.amountFormula
  const printCol = tpl.printCol

  // 1) 明细行数超过模板槽位：复制样式行插入 + 合并单元格同步位移；
  //    未超过时合计/大写行位置不变（模板原样）
  const insertCount = Math.max(0, n - slot)
  if (insertCount > 0) {
    // duplicateRow 内部处理旧合并单元格的位移（写出时按插入行数下移）
    ws.duplicateRow(first, insertCount, true)
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
  setCell(tpl.email, tpl.email?.prefix ?? '', data.supplier.email)
  setCell(tpl.model, tpl.model.prefix, data.model)

  // 标准模板：抬头公司块按 headerName 切换（2026-09-07 老板：部分采购继续用锦名诚抬头）
  if (tpl.companyBlock) {
    const companyName = (data.headerName ?? '').includes('智锐恒') ? '东莞市智锐恒电子有限公司' : '东莞市锦名诚电子有限公司'
    const tCell = ws.getCell(tpl.companyBlock.title.row, tpl.companyBlock.title.col)
    const tv = tCell.value
    if (tv && typeof tv === 'object' && (tv as { richText?: Array<{ text: string }> }).richText) {
      const rt = (tv as { richText: Array<{ text: string }> }).richText
      if (rt.length > 0) {
        // 保留首 run 末尾的换行（公司名与「采购单」标题分两行）
        rt[0]!.text = companyName + (rt[0]!.text.endsWith('\n') ? '\n' : '')
      }
    } else {
      const lines = String(tv ?? '').split(/\r?\n/)
      lines[0] = companyName
      tCell.value = lines.join('\n')
    }
    setCell(tpl.companyBlock.from, tpl.companyBlock.from.prefix, companyName)
    // 确认栏行号随明细插行下移（2026-09-07 老板：多行时出现重复公司名）
    ws.getCell(tpl.companyBlock.confirm.row + insertCount, tpl.companyBlock.confirm.col).value = companyName
  }

  // 表头按口径替换（含税/未税）
  if (tpl.headerLabels) {
    for (const hl of tpl.headerLabels) {
      ws.getCell(tpl.headerRow, hl.col).value = useInclTax ? hl.zrh : hl.jmc
    }
  }

  // 模板配置（2026-09-07 方案A）：列宽/隐藏/表头文字 + 条款整格替换
  if (cfg?.cols) {
    const colNums = tpl.cols as unknown as Record<string, number>
    for (const [key, col] of Object.entries(cfg.cols)) {
      const num = colNums[key]
      if (!num) continue
      const column = ws.getColumn(num)
      if (col.width != null) column.width = Math.max(2, Math.round(col.width / 7))
      if (col.visible === false) column.hidden = true
      if (col.title != null) ws.getCell(tpl.headerRow, num).value = col.title
    }
  }
  if (cfg?.terms) {
    for (let row = 1; row <= 48; row++) {
      const cell = ws.getCell(row, 1)
      const raw = cell.value
      let text = ''
      if (typeof raw === 'string') text = raw
      else if (raw && typeof raw === 'object' && (raw as { richText?: Array<{ text: string }> }).richText) {
        text = (raw as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
      }
      if (!text) continue
      for (const [from, to] of Object.entries(cfg.terms)) {
        if (from && text.includes(from)) {
          cell.value = to // 整行条款覆盖
          break
        }
      }
    }
  }

  // 3) 明细行（序号/料号/名称/规格/材质/表面处理/单位/用量/数量/单价/金额/备注/不含税）
  data.lines.forEach((line, i) => {
    const r = first + i
    const set = (col: number, v: string | number | null | undefined) => {
      if (!col) return
      ws.getCell(r, col).value = v == null || v === '' ? '' : v
    }
    set(c.seq, i + 1)
    set(c.sku, line.sku)
    // 品名只填中文名称（2026-09-08 老板：与预览一致，不带尺寸规格）
    set(c.name, line.name)
    // 材质列（2026-09-08 老板：导出要有材质列）
    set(c.material, line.material)
    // 表面处理只留中文（2026-09-08 老板：不填英文）
    set(c.finish, cnOnlyText(tpl.finishOrMaterial ? line.finish ?? line.material ?? '' : line.finish))
    set(c.unit, line.unit)
    set(c.usage, line.usage ?? '')
    set(c.qty, line.qty)
    set(c.price, useInclTax ? line.unitPriceInclTax ?? line.unitPrice : line.unitPrice)
    // 备注先写进每行，随后按明细行数整列合并（不波及合计行）
    set(c.note, line.note)
    if (tpl.isZrh) {
      // 金额(含税) = 单价(含税) × 采购数量
      set(c.priceInclTax, line.unitPriceInclTax ?? '')
    }
    ws.getCell(r, c.amount).value = { formula: amountFormula(r) }
  })

  // 备注列合并：合并行数 = 明细行数（零级行），不波及下方金额合计行（2026-09-08 老板口径）
  if (c.note) {
    const notes: string[] = []
    if (data.termsNote?.trim()) notes.push(data.termsNote.trim())
    for (const l of data.lines) {
      const t = l.note?.trim()
      if (t && !notes.includes(t)) notes.push(t)
    }
    if (n > 1) {
      const master = ws.getCell(first, c.note)
      for (let i = first; i <= last; i++) {
        if (i !== first) (ws.getCell(i, c.note) as unknown as { merge: (m: unknown, s?: boolean) => void }).merge(master, true)
      }
    }
    ws.getCell(first, c.note).value = notes.join('；')
  }

  // 4) 合计公式覆盖全部明细行 + 大写金额行指向新合计行
  const totalRow = first + Math.max(n, slot) - 1 + tpl.totalRowOffset
  const sumCol = colLetter(c.amount) // 求和范围 = 金额列
  ws.getCell(totalRow, totalCol).value = {
    formula: '=SUM(' + sumCol + first + ':' + sumCol + last + ')',
  }
  if (tpl.capitalAsText) {
    // 大写金额直接写文本（模板无公式单元格）；智锐恒单按含税价合计
    // 2026-09-08 老板：右边格子只显示大写金额，不要 RMB 前缀
    const total = Math.round(
      data.lines.reduce((s, l) => s + l.qty * (useInclTax ? l.unitPriceInclTax ?? l.unitPrice : l.unitPrice), 0) * 100,
    ) / 100
    ws.getCell(totalRow + 1, totalCol).value = amountToCn(total)
  } else {
    ws.getCell(totalRow + 1, totalCol).value = { formula: '=' + sumCol + totalRow }
  }

  // 合计行金额区右边框补实线：模板「金额合计（小写）」行金额区缺 right 边框（最右不是实线），
  // 打印时右侧开口；小写/大写两行统一补全（2026-09-08 老板反馈）
  for (const row of [totalRow, totalRow + 1]) {
    for (let col = totalCol; col <= c.note; col++) {
      const cell = ws.getCell(row, col)
      cell.border = {
        ...cell.border,
        right: { style: 'thin', color: { argb: 'FF000000' } },
      }
    }
  }

  // 5) 付款方式（1.2 行替换；模板文字可能是富文本，先转纯文本再替换；行号随插入行位移）
  if (data.paymentTerms) {
    const cell = ws.getCell(tpl.paymentRow + insertCount, 1)
    const raw = cell.value
    let current = ''
    if (typeof raw === 'string') current = raw
    else if (raw && typeof raw === 'object' && (raw as { richText?: Array<{ text: string }> }).richText) {
      current = (raw as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
    }
    cell.value = current.replace(/付款方式[：:].*$/, '付款方式：' + data.paymentTerms + '；')
  }

  // 6) 交货时间行（3.3/3.4 动态填值；无此行时跳过）
  if (tpl.deliveryRow != null) {
    const dCell = ws.getCell(tpl.deliveryRow + insertCount, 1)
    const dRaw = dCell.value
    let dText = ''
    if (typeof dRaw === 'string') dText = dRaw
    else if (dRaw && typeof dRaw === 'object' && (dRaw as { richText?: Array<{ text: string }> }).richText) {
      dText = (dRaw as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('')
    }
    dCell.value = dText.replace(/(预计交货时间|交货时间)[：:].*$/, '$1：' + (data.expectedDeliveryDate ?? ''))
  }

  // 7) 页面设置 + 打印区域
  const ps = ws.pageSetup
  if (tpl.file === PO_TEMPLATE_STD) {
    // 标准模板：默认打印比例 100%（2026-09-08 老板要求），模板列宽已压缩到一页 A4 内
    ps.fitToPage = false
    ;(ps as unknown as { zoom?: number }).zoom = 100
  } else {
    ps.fitToPage = true
    ps.fitToWidth = 1
    ps.fitToHeight = 1
  }
  ps.orientation = tpl.orientation
  ps.paperSize = 9 // A4
  const maxRow = Math.max(tpl.endRow + insertCount, totalRow + 2) + 4
  ws.pageSetup.printArea = 'A1:' + printCol + maxRow

  const html = workbookToHtml(wb)
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  return { buffer, html }
}

/** 导出 xlsx（兼容旧签名，模板配置可选；tplFileOverride=自定义底稿文件名） */
export async function buildPoTemplate(data: PoDocData, cfg?: PoTemplateConfig | null, tplFileOverride?: string | null): Promise<Buffer> {
  return (await renderPoDoc(data, cfg, tplFileOverride)).buffer
}

/** 导出 xlsx + 所见即所得 HTML 预览（同一份工作簿渲染，保证预览=导出） */
export async function buildPoTemplateHtml(
  data: PoDocData,
  cfg?: PoTemplateConfig | null,
  tplFileOverride?: string | null,
): Promise<{ buffer: Buffer; html: string }> {
  return renderPoDoc(data, cfg, tplFileOverride)
}

/** 把工作簿里的公式替换成计算值（供 Luckysheet 编辑器打开：编辑器不认公式，先固化值） */
export async function workbookWithCachedValues(input: Buffer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(input as never)
  const ws = wb.worksheets[0]!
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = ws.getCell(r, c)
      const v = cell.value
      if (v && typeof v === 'object' && (v as { formula?: string }).formula) {
        cell.value = cellText(ws, r, c).num ?? cellText(ws, r, c).text
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 导出文件名字 */
export function poDocFileName(orderNo: string): string {
  return '采购单-' + orderNo + '.xlsx'
}

/** 内置标准模板打印区域（A1:I…，随明细行数增长；渲染 PDF 时显式传入，避免 Excel 把右侧空列算进打印区） */
export function builtinPrintArea(lineCount: number): string {
  const n = Math.max(lineCount, 1)
  const insertCount = Math.max(0, n - STD.slot)
  const totalRow = STD.firstDataRow + Math.max(n, STD.slot) - 1 + STD.totalRowOffset
  const maxRow = Math.max(STD.endRow + insertCount, totalRow + 2) + 4
  return 'A1:I' + maxRow
}

/**
 * 仿照标准采购单的前端表格（2026-09-08 老板拍板：放弃 Excel 渲染，预览=仿照的纯前端表格，秒开、不求完全一致）。
 * 打印/存 PDF 走浏览器打印本页面。口径与真模板一致：抬头随 headerName、单价列含税/未税、RMB 大写、备注列整列合并。
 */
export function buildPoMimicHtml(data: PoDocData, opts?: { autoPrint?: boolean }): string {
  const useInclTax = (data.headerName ?? '').includes('智锐恒')
  const company = useInclTax ? '东莞市智锐恒电子有限公司' : '东莞市锦名诚电子有限公司'
  const priceTitle = useInclTax ? '单价 (含税)' : '单价'
  const amountTitle = useInclTax ? '金额 (含税)' : '金额'
  const n = Math.max(data.lines.length, 1)
  // 备注合并单元格内容：整单备注优先 + 各行备注去重拼接（2026-09-08 老板口径）
  const noteParts: string[] = []
  if (data.termsNote?.trim()) noteParts.push(data.termsNote.trim())
  for (const l of data.lines) {
    const t = l.note?.trim()
    if (t && !noteParts.includes(t)) noteParts.push(t)
  }
  const noteText = noteParts.join('；')
  const rows: string[] = []
  data.lines.forEach((l, i) => {
    const price = useInclTax ? (l.unitPriceInclTax ?? l.unitPrice) : l.unitPrice
    const amount = round2(l.qty * price)
    // 备注列：合并行数 = 明细行数（不波及合计行），内容为整单/各行备注拼接
    const noteCell = i === 0 ? '<td class="l" rowspan="' + n + '">' + escHtml(noteText) + '</td>' : ''
    rows.push(
      '<tr><td class="l">' + escHtml(l.sku) + '</td>' +
        '<td class="l">' + escHtml(l.name) + '</td>' + // 品名只展示中文名称，不带尺寸
        '<td class="l">' + escHtml(l.material ?? '') + '</td>' + // 材质列
        '<td class="l">' + escHtml(cnOnlyText(l.finish ?? l.material ?? '')) + '</td>' +
        '<td>' + escHtml(l.unit) + '</td>' +
        '<td>' + (l.usage ?? '') + '</td>' +
        '<td class="r">' + l.qty + '</td>' +
        '<td class="r">' + price + '</td>' +
        '<td class="r">' + amount + '</td>' +
        noteCell + '</tr>',
    )
  })
  const total = round2(data.lines.reduce((s, l) => s + l.qty * (useInclTax ? (l.unitPriceInclTax ?? l.unitPrice) : l.unitPrice), 0))
  const payment = data.paymentTerms ? '1.2  付款方式：' + escHtml(data.paymentTerms) + '；' : '1.2  付款方式：月结；'
  const delivery = '3.3 预计交货时间：' + escHtml(data.expectedDeliveryDate ?? '')
  const printScript = opts?.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){try{var po=document.querySelector(".po");if(po){var target=1040;var h=po.scrollHeight;if(h>target){document.body.style.zoom=(target/h)}}}catch(e){}window.print()},300)})</script>'
    : ''
  // 信息块行：标签定宽右对齐，值左对齐（采购单编号/FROM 等列对齐）
  const headRight = (label: string, value: string) => '<div><span class="lb">' + label + '</span><span class="lv">' + value + '</span></div>'
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>采购单-' + escHtml(data.orderNo) + '</title><style>' +
    'body{margin:0;background:#e9ecef;font-family:宋体,SimSun,serif;color:#111}' +
    '.po{width:794px;margin:0 auto;background:#fff;padding:36px 44px;box-sizing:border-box;min-height:1123px;box-shadow:0 2px 12px rgba(0,0,0,.18)}' +
    '.title{font-size:18px;font-weight:bold;text-align:center;line-height:1.6}' +
    '.sub{font-size:24px;font-weight:bold;text-align:center;letter-spacing:10px;line-height:2;margin-bottom:12px}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;font-size:13px;line-height:2;margin-bottom:10px}' +
    '.head div{white-space:nowrap}' +
    '.lb{display:inline-block;width:5.5em;text-align:right;margin-right:8px;color:#333}' +
    '.lv{font-weight:bold}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'th{background:#f2f4f7;border:1px solid #000;padding:6px;font-weight:bold}' +
    'td{border:1px solid #000;padding:6px;text-align:center;word-break:break-all}' +
    '.l{text-align:left}.r{text-align:right}' +
    '.totrow td{font-weight:bold;background:#fafafa;padding:8px 6px;border:1px solid #000}' +
    '.terms{font-size:12px;line-height:2;margin-top:14px;padding:10px 14px;border:1px solid #d9dde3;border-radius:6px;background:#fafbfc}' +
    '.terms b{font-weight:bold}' +
    '.confirm{display:flex;justify-content:space-between;font-size:13px;line-height:2.2;margin-top:30px}' +
    '@page{size:A4;margin:10mm}' +
    '@media print{body{background:#fff}.po{box-shadow:none;margin:0 auto;width:100%;max-width:720px;padding:0;min-height:0}.terms{border:1px solid #bbb;background:#fff}}' +
    '</style></head><body><div class="po">' +
    '<div class="title">' + escHtml(company) + '</div>' +
    '<div class="sub">采&emsp;购&emsp;单</div>' +
    '<div class="head"><div class="left">' +
      headRight('TO:', escHtml(data.supplier.name)) +
      headRight('ATTN:', escHtml(data.supplier.contactPerson ?? '')) +
      headRight('TEL:', escHtml(data.supplier.phone ?? '')) +
      headRight('FAX:', escHtml(data.supplier.fax ?? '')) +
    '</div><div class="right">' +
      headRight('采购单编号：', escHtml(data.orderNo)) +
      headRight('FROM:', escHtml(company)) +
      headRight('下单日期：', escHtml(dotDate(data.orderDate))) +
      headRight('TEL:', '0769-87187030') +
      headRight('适用机型：', escHtml(data.model)) +
      headRight('币别：', '人民币') +
    '</div></div>' +
    '<table><thead><tr><th style="width:10%">料号</th><th style="width:15%">品名规格</th><th style="width:13%">材质</th><th style="width:16%">表面处理/颜色</th><th style="width:5%">单位</th><th style="width:5%">用量</th><th style="width:8%">采购数量</th><th style="width:8%">' + priceTitle + '</th><th style="width:9%">' + amountTitle + '</th><th style="width:9%">备注</th></tr></thead><tbody>' +
    rows.join('') +
    // 合计两行整体右移两列、金额贴最右；大写金额不带 RMB 前缀（2026-09-08 老板）
    '<tr class="totrow"><td colspan="6"></td><td colspan="2" class="r">金额合计（小写）</td><td colspan="2" class="l">￥' + total + '</td></tr>' +
    '<tr class="totrow"><td colspan="6"></td><td colspan="2" class="r">金额合计（大写）</td><td colspan="2" class="l">' + amountToCn(total) + '</td></tr>' +
    '</tbody></table>' +
    '<div class="terms"><b>备注：</b>' + (data.termsNote ? escHtml(data.termsNote) : '') + '<br/>' +
    '<b>1、货款结算：</b><br/>' +
    '1.1  以上单价以人民币结算；<br/>' +
    payment + '<br/>' +
    '<b>2、品质：</b><br/>' +
    '2.1 产品生产按我司的工程图或合格样品及所规定之要求进行生产加工；<br/>' +
    '2.2 检验方法：我司分为全检和抽检两种方式，抽检按MIL-STD-105E二级正常单次抽样计划表进行检验<br/>' +
    'AQL：CR=0 MAJ=0.4 MIN=1.0；<br/>' +
    '<b>3、其它：</b><br/>' +
    '3.1 供应商在收到我司订单后，应在两天内及时回签，否则视为默认；<br/>' +
    '3.2 交货时请在送货单上注明订单号码、产品编号、产品名称，在卸货时按我司仓管的要求对产品进行合理摆放；<br/>' +
    delivery + '</div>' +
    '<div class="confirm"><div>供应商确认栏<br/>单位、盖章：<br/>经&emsp;办&emsp;人：</div><div>' + escHtml(company) + '<br/>制表：&emsp;袁小琼<br/>审&emsp;核：</div></div>' +
    '</div>' + printScript + '</body></html>'
  )
}

// —— 工作簿 → HTML（所见即所得预览，2026-09-07 方案A）——

function colLetterToNum(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cellText(ws: ExcelJS.Worksheet, r: number, c: number): { text: string; num?: number } {
  const cell = ws.getCell(r, c)
  const v = cell.value
  if (v == null) return { text: '' }
  if (typeof v === 'object' && (v as { formula?: string }).formula) {
    const formula = (v as { formula: string }).formula
    const mul = formula.match(/^=([A-Z]+)(\d+)\*([A-Z]+)(\d+)$/)
    if (mul) {
      const a = cellText(ws, Number(mul[2]), colLetterToNum(mul[1]!))
      const b = cellText(ws, Number(mul[4]), colLetterToNum(mul[3]!))
      const n = round2((a.num ?? 0) * (b.num ?? 0))
      return { text: String(n), num: n }
    }
    const sum = formula.match(/^=SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/)
    if (sum) {
      let total = 0
      const c1 = colLetterToNum(sum[1]!)
      const c2 = colLetterToNum(sum[3]!)
      for (let rr = Number(sum[2]); rr <= Number(sum[4]); rr++) {
        for (let cc = c1; cc <= c2; cc++) total += cellText(ws, rr, cc).num ?? 0
      }
      const n = round2(total)
      return { text: String(n), num: n }
    }
    const ref = formula.match(/^=([A-Z]+)(\d+)$/)
    if (ref) {
      const got = cellText(ws, Number(ref[2]), colLetterToNum(ref[1]!))
      return got
    }
    return { text: formula }
  }
  if (typeof v === 'number') {
    const n = round2(v)
    return { text: String(n), num: n }
  }
  if (v instanceof Date) return { text: v.toISOString().slice(0, 10) }
  if (typeof v === 'object' && (v as { richText?: Array<{ text: string }> }).richText) {
    return { text: (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('') }
  }
  if (typeof v === 'object' && (v as { text?: string }).text) {
    return { text: String((v as { text: string }).text) }
  }
  return { text: String(v) }
}

/** 工作簿第一个 sheet 转 HTML 表格（合并单元格/列宽/公式求值/粗体/右对齐金额） */
export function workbookToHtml(wb: ExcelJS.Workbook): string {
  const ws = wb.worksheets[0]!
  const merges = new Map<string, { rs: number; cs: number }>()
  for (const m of (ws.model.merges ?? []) as unknown as Array<{ top: number | string; left: number | string; bottom: number | string; right: number | string }>) {
    const top = Number(m.top)
    const left = Number(m.left)
    merges.set(top + ':' + left, { rs: Number(m.bottom) - top + 1, cs: Number(m.right) - left + 1 })
  }
  const colCount = ws.columnCount
  const widths: number[] = []
  for (let c = 1; c <= colCount; c++) {
    const col = ws.getColumn(c)
    widths.push(col.hidden ? 0 : Math.round((typeof col.width === 'number' ? col.width : 9) * 7))
  }
  // 找最后一个有内容的行
  let lastRow = 0
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= colCount; c++) {
      if (cellText(ws, r, c).text !== '') {
        lastRow = r
        break
      }
    }
  }
  lastRow = Math.min(lastRow + 2, ws.rowCount)
  let html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:24px;background:#525659;font-family:SimSun,"Microsoft YaHei",serif;}' +
    '.page{background:#fff;margin:0 auto;width:1056px;padding:26px 34px;box-sizing:border-box;}' +
    'table{border-collapse:collapse;table-layout:fixed;font-size:13px;width:100%;}' +
    'td{border:1px solid #c9c9c9;padding:3px 6px;word-break:break-all;vertical-align:top;height:22px;}' +
    '</style></head><body><div class="page"><table>'
  const rowSpanRemain = new Map<number, number>() // col → 剩余行数
  for (let r = 1; r <= lastRow; r++) {
    html += '<tr>'
    let c = 1
    while (c <= colCount) {
      const remain = rowSpanRemain.get(c) ?? 0
      if (remain > 0) {
        rowSpanRemain.set(c, remain - 1)
        c++
        continue
      }
      const w = widths[c - 1] ?? 0
      if (w === 0) {
        c++
        continue
      }
      const m = merges.get(r + ':' + c)
      const cell = ws.getCell(r, c)
      const bold = cell.font?.bold ? 'font-weight:700;' : ''
      if (m && m.rs * m.cs > 1) {
        let tw = 0
        for (let i = c; i < c + m.cs; i++) tw += widths[i - 1] ?? 0
        for (let i = c; i < c + m.cs; i++) rowSpanRemain.set(i, m.rs - 1)
        const v = cellText(ws, r, c)
        const align = v.num != null ? 'text-align:right;' : ''
        html += '<td colspan="' + m.cs + '" rowspan="' + m.rs + '" style="width:' + tw + 'px;' + bold + align + '">' + escHtml(v.text) + '</td>'
        c += m.cs
      } else {
        const v = cellText(ws, r, c)
        const align = v.num != null ? 'text-align:right;' : ''
        html += '<td style="width:' + w + 'px;' + bold + align + '">' + escHtml(v.text) + '</td>'
        c++
      }
    }
    html += '</tr>'
  }
  html += '</table></div></body></html>'
  return html
}
