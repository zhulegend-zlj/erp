import * as XLSX from 'xlsx'

/** Luckysheet 单元格（getAllSheets 的 celldata 元素，兼容二维数组与带 r/c 的扁平数组） */
interface LsCell {
  r?: number
  c?: number
  v?: { v?: unknown; m?: string; ct?: { t?: string; fa?: string; fc?: string }; bl?: number; fc?: string; bc?: string; ht?: number; vt?: number; fs?: number; bg?: string; it?: number } | string | number
  m?: string
}

interface LsSheet {
  name?: string
  celldata?: Array<Array<LsCell | null>> | LsCell[]
  config?: {
    columnlen?: Record<string, number>
    rowlen?: Record<string, number>
    merge?: Record<string, { r: number; c: number; rs: number; cs: number }>
  }
}

function cellStyle(cell: LsCell): Record<string, unknown> {
  const v = (cell.v ?? {}) as { bl?: number; fc?: string; bc?: string; ht?: number; vt?: number; fs?: number; it?: number }
  const s: Record<string, unknown> = {}
  if (v.bl === 1) s.bold = true
  if (v.it === 1) s.italic = true
  if (typeof v.fs === 'number' && v.fs > 0) s.sz = v.fs
  if (typeof v.fc === 'string' && v.fc !== '#000000') s.color = { rgb: v.fc.replace('#', '') }
  if (typeof v.bc === 'string' && v.bc && v.bc !== '#ffffff') s.fill = { fgColor: { rgb: v.bc.replace('#', '') } }
  const hMap: Record<number, string> = { 0: 'left', 1: 'center', 2: 'right' }
  const vMap: Record<number, string> = { 0: 'top', 1: 'middle', 2: 'bottom' }
  if (v.ht != null && hMap[v.ht]) s.alignment = { horizontal: hMap[v.ht] }
  if (v.vt != null && vMap[v.vt]) s.alignment = { ...((s.alignment as object) ?? {}), vertical: vMap[v.vt] }
  return s
}

/** 单元格显示值 → xlsx 值（数字保留数字） */
function cellValue(cell: LsCell): unknown {
  const raw = cell.v
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') return raw
  const v = raw as { v?: unknown; m?: string; ct?: { t?: string } }
  if (v.ct?.t === 'n' || typeof v.v === 'number') {
    const n = Number(v.v)
    return Number.isFinite(n) ? n : String(v.m ?? v.v ?? '')
  }
  const text = typeof v.v === 'string' && v.v !== '' ? v.v : v.m ?? ''
  return text
}

/** Luckysheet getAllSheets() JSON → xlsx Buffer（2026-09-07 老板方案B：像表格一样编辑模板底稿） */
export function luckysheetToXlsx(sheets: LsSheet[]): Buffer {
  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const ws: XLSX.WorkSheet = {}
    const cols: XLSX.ColInfo[] = []
    for (const [k, px] of Object.entries(sheet.config?.columnlen ?? {})) {
      cols[Number(k)] = { wch: Math.max(2, Math.round(Number(px) / 7)) }
    }
    if (cols.length > 0) ws['!cols'] = cols
    const rows: XLSX.RowInfo[] = []
    for (const [k, px] of Object.entries(sheet.config?.rowlen ?? {})) {
      rows[Number(k)] = { hpt: Math.max(10, Math.round(Number(px) * 0.75)) }
    }
    if (rows.length > 0) ws['!rows'] = rows
    const merges: XLSX.Range[] = []
    for (const m of Object.values(sheet.config?.merge ?? {})) {
      if (m.rs > 1 || m.cs > 1) merges.push({ s: { r: m.r, c: m.c }, e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 } })
    }
    if (merges.length > 0) ws['!merges'] = merges
    const cells: Array<{ r: number; c: number; cell: LsCell }> = []
    if (Array.isArray(sheet.celldata)) {
      const flat = sheet.celldata as unknown[]
      if (flat.length > 0 && flat[0] != null && typeof flat[0] === 'object' && !Array.isArray(flat[0]) && (flat[0] as LsCell).r != null) {
        for (const item of flat as LsCell[]) if (item) cells.push({ r: item.r ?? 0, c: item.c ?? 0, cell: item })
      } else {
        for (let r = 0; r < flat.length; r++) {
          const row = (flat[r] ?? []) as Array<LsCell | null>
          if (!Array.isArray(row)) continue
          for (let c = 0; c < row.length; c++) {
            const cell = row[c]
            if (cell) cells.push({ r, c, cell })
          }
        }
      }
    }
    for (const { r, c, cell } of cells) {
      const val = cellValue(cell)
      if (val == null || val === '') continue
      const addr = XLSX.utils.encode_cell({ r, c })
      ws[addr] = { v: val, s: cellStyle(cell) }
    }
    // SheetJS 手工建表必须给 !ref，否则写出文件没有单元格
    let minR = cells.length > 0 ? Math.min(...cells.map((x) => x.r)) : 0
    let minC = cells.length > 0 ? Math.min(...cells.map((x) => x.c)) : 0
    let maxR = Math.max(...cells.map((x) => x.r), ...merges.map((m) => m.e.r), 0)
    let maxC = Math.max(...cells.map((x) => x.c), ...merges.map((m) => m.e.c), 0)
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } })
    XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Sheet1')
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
