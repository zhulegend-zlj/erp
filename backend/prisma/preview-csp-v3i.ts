// CSP_V3I 对照审查表（v2）：嵌入图片、公用在前、按原物料编号排序。
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { UPLOAD_DIR } from '../src/uploads-store'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3I清单-螺丝物料表.xlsx'
const RAR_V3I = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3i_2D PDF.rar'
const RAR_V3 = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3_2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const TAR = 'C:/Windows/System32/tar.exe'
const OUT = process.env.PREVIEW_OUT || 'D:/AI/erp-backups/CSP-V3I-SKU对照表.xlsx'
const TMP = resolve(process.cwd(), 'tmp-v3i-xlsx')

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
function nf(s: string): string {
  return s.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫').replace(/[門]/g, '门').replace(/[線]/g, '线')
}
function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}

function screwSku(name: string, dims: string): string {
  const nameNorm = name.replace(/\*/g, 'x')
  const fromName = nameNorm.match(/M\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?/i)?.[0]
  const raw = (fromName || dims).replace(/\s+/g, '').replace(/\*/g, 'x')
  const m = raw.match(/M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?/i)
  const size = m ? 'M' + m[1] + (m[2] ? 'x' + m[2] : '') : raw
  if (name.includes('直纹') && name.includes('杯头')) return size + '-杯头直纹'
  if (name.includes('杯头')) return size + '-杯头'
  if (name.includes('扁头')) return size + '-扁头'
  if (name.includes('十字')) return size + '-十字'
  if (name.includes('沉头')) return size + '-平头'
  if (name.includes('平头')) return size + '-平头'
  if (name.includes('半圆头')) return size + '-半圆头'
  if (name.includes('紧定') || name.includes('机米')) return size + '-机米'
  if (name.includes('盖帽') || name.includes('盖型')) return size + '-盖型螺母'
  if (name.includes('螺母')) return size + '-螺母'
  if (name.includes('垫片')) return size + '-垫片'
  return name
}

function rarFiles(rarPath: string): string[] {
  const buf = execFileSync(UNRAR, ['lb', rarPath], { maxBuffer: 64 * 1024 * 1024 })
  return new TextDecoder('gbk').decode(buf).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => s.toLowerCase().endsWith('.pdf'))
}
function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
}

/** 提取 V3I 表格内嵌图片：行号(1..147 数据行) → 媒体文件绝对路径 */
function extractSheetImages(): Map<number, string> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  execFileSync(TAR, ['-xf', FILE, '-C', TMP], { stdio: 'ignore' })
  const xml = readFileSync(resolve(TMP, 'xl/drawings/drawing1.xml'), 'utf8')
  const rels = readFileSync(resolve(TMP, 'xl/drawings/_rels/drawing1.xml.rels'), 'utf8')
  const relMap: Record<string, string> = {}
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2] ?? ''
  const map = new Map<number, string>()
  const segRe = /<xdr:(twoCellAnchor|oneCellAnchor)([\s\S]*?)(?:<\/xdr:\1>)/g
  let m
  while ((m = segRe.exec(xml))) {
    const seg = m[0]
    const col = /<xdr:col>(\d+)<\/xdr:col>/.exec(seg)?.[1]
    const row = /<xdr:row>(\d+)<\/xdr:row>/.exec(seg)?.[1]
    const rid = /r:embed="(rId\d+)"/.exec(seg)?.[1]
    if (col === undefined || row === undefined || rid === undefined) continue
    if (+col !== 2) continue // 只取「图片」列
    if (map.has(+row)) continue
    const target = relMap[rid] ?? ''
    const rel = target.replace(/^\.\.\//, '').replace(/\\/g, '/')
    const p = resolve(TMP, 'xl', rel)
    if (rel && existsSync(p)) map.set(+row, p)
  }
  return map
}

async function main() {
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')
  const sheetImgs = extractSheetImages()

  const v3iPdfs = rarFiles(RAR_V3I)
  const v3Pdfs = rarFiles(RAR_V3)
  const v3Set = new Set(v3Pdfs.map((f) => f.split(/[\\/]/).pop()!.toLowerCase()))
  const v3iByKey = new Map<string, string[]>()
  for (const f of v3iPdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = v3iByKey.get(k) ?? []
      list.push(base)
      v3iByKey.set(k, list)
    }
  }

  const v3Parts = new Map<string, { name: string; drawingsUrl: string | null; imageUrl: string | null }>()
  for (const p of await prisma.part.findMany({ select: { sku: true, name: true, drawingsUrl: true, imageUrl: true } })) {
    v3Parts.set(p.sku, { name: p.name, drawingsUrl: p.drawingsUrl, imageUrl: p.imageUrl })
  }
  const v3Suppliers = new Set((await prisma.supplier.findMany({ select: { name: true } })).map((s) => s.name))

  interface RowRec { seq: string; id: string; sku: string; name: string; qty: number; rel: string; v3Sku: string; vendor: string; drawing: string; drawingShared: string; note: string; imgPath: string | null }
  const recs: RowRec[] = []
  let csp13Seq = 7
  const csp13ByLen = new Map<string, string>()
  let miscSeq = 300
  const extraDrawings: string[] = []

  let ri = 0
  for (const raw of data) {
    ri++
    const seq = clean(raw[0])
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const dims = clean(raw[9])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    const vendorRaw = clean(raw[19])
    if (!name) continue

    const isFastener = /螺丝|螺母|垫片|机米|螺钉/.test(name)
    let sku = ''
    let rel = '新零件'
    let v3Sku = ''
    let note = ''

    if (/^CSP-013$/i.test(idRaw)) {
      const lenM = name.match(/20\s*[*x]\s*(\d+(?:\.\d+)?)/i)
      const lenKey = lenM ? String(Number(lenM[1])) : name
      if (lenKey === '10') { sku = 'CSP-013-7'; rel = '公用'; v3Sku = 'CSP-013-7' }
      else if (csp13ByLen.has(lenKey)) { sku = csp13ByLen.get(lenKey)!; rel = '新零件（同长度合并）' }
      else { csp13Seq++; sku = 'CSP-013-' + csp13Seq; csp13ByLen.set(lenKey, sku); rel = '新零件（铝套管新长度）' }
    } else if (/^CSP-005$/i.test(idRaw)) {
      sku = 'CSP-005-深灰'; rel = '颜色区分（新建）'; v3Sku = 'CSP-005'
      note = '与V3同料号但颜色不同（V3红色/V3I深灰色），按老板要求分开'
    } else if (/^CSP-033$/i.test(idRaw)) {
      sku = 'CSP-033-灰色'; rel = '颜色区分（新建）'; v3Sku = 'CSP-033'
      note = '与V3同料号但颜色不同（V3原色/V3I灰色），按老板要求分开'
    } else if (/^CSP-/.test(idRaw)) {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'; v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理，请核对'
        if (/黑|灰|红|白/.test(name)) note += '；V3I名称含颜色：' + name
      }
    } else if (isFastener) {
      sku = screwSku(name, dims)
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'; v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理'
        if (/黑|白|灰|红/.test(name)) note += '；V3I名称含颜色：' + name
      }
    } else if (idRaw === '' || idRaw === '-') {
      const v3Same = [...v3Parts.entries()].find(([k, v]) => nf(v.name) === nf(name) && k.startsWith('CSP-2'))
      if (v3Same) { sku = v3Same[0]; rel = '公用（同名杂项）'; v3Sku = sku }
      else { miscSeq++; sku = 'CSP-' + miscSeq; rel = '新零件（杂项 CSP-3xx）' }
    } else {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'; v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理，请核对'
      }
    }
    if (rel === '新零件') {
      const sameName = [...v3Parts.entries()].find(([k, v]) => nf(v.name) === nf(name))
      if (sameName) note = (note ? note + '；' : '') + '同名V3已有料号 ' + sameName[0] + '，请确认是否同一件（按料号新建）'
    }
    if (seq === '7') note = (note ? note + '；' : '') + '表内料号 M6x16 与名称 M6x28 不一致，按名称 M6x28-平头（与V3共用）'
    if (seq === '31') note = (note ? note + '；' : '') + '与V3称重传感器（CSP-204，线长260）类似但线长不同（482），按新零件，请确认'
    if (seq === '90') note = (note ? note + '；' : '') + 'V3仅有 CSP-032-3（PA小黑块内垫），本行料号 CSP-032、图档名与V3相同（spring_guide），请确认两者关系'
    if (seq === '141') note = (note ? note + '；' : '') + '与V3 CSP-220「彩盒、外箱序列号标签」名称近似（本表多EAN字样），暂按新零件，请确认是否同一件'
    if (seq === '135') note = (note ? note + '；' : '') + 'V3名称「电缆夹」，V3I「电线固定扣」，按共用处理请核对'

    const vendorName = vendorRaw && v3Suppliers.has(vendorRaw.split('/')[0]!.trim()) ? vendorRaw.split('/')[0]!.trim() : ''
    if (vendorRaw && !vendorName) note = (note ? note + '；' : '') + '供应商列值「' + vendorRaw + '」视为用途备注/非供应商，跳过'

    const files = v3iByKey.get(idKey(idRaw)) ?? []
    let drawing = ''
    let drawingShared = ''
    if (files.length > 0) {
      const sameInV3 = files.filter((f) => v3Set.has(f.toLowerCase()))
      const v3Has = v3Parts.get(sku)?.drawingsUrl
      if (sameInV3.length === files.length && v3Has) { drawing = files.length + ' 个'; drawingShared = '是（与V3同文件，V3已挂）' }
      else if (v3Has) { drawing = files.length + ' 个'; drawingShared = '共用零件（V3已挂图，V3i为新版本，导入时可更新）' }
      else { drawing = files.length + ' 个'; drawingShared = '否（新挂）' }
    } else {
      drawing = ''
      drawingShared = v3Parts.get(sku)?.drawingsUrl ? '共用（V3已挂图）' : ''
    }

    // 图片：优先 V3I 表内嵌图（物理行号 = 数据行号 + 1），否则共用零件用 V3 已上传图片
    let imgPath = sheetImgs.get(ri) ?? null
    let imgFrom = ''
    if (!imgPath) {
      const v3img = v3Parts.get(sku)?.imageUrl
      if (v3img) {
        imgPath = resolve(UPLOAD_DIR, v3img.replace(/^\/uploads\//, ''))
        if (!existsSync(imgPath)) imgPath = null
        else imgFrom = '（图=V3图片）'
      }
    }
    if (imgFrom) note = (note ? note + '；' : '') + imgFrom

    recs.push({ seq, id: idRaw || '-', sku, name, qty: amount, rel, v3Sku, vendor: vendorName, drawing, drawingShared, note, imgPath })
  }

  for (const [k, files] of v3iByKey) {
    const hasRow = data.some((raw) => idKey(clean(raw[1]).replace(/^['"]+/, '')) === k)
    if (!hasRow) extraDrawings.push('表内无行: ' + k + ' → ' + files.join(' / '))
  }

  // 排序：公用在前；组内按原物料编号（'-' 排最后，数字自然序）
  const sharedFirst = (r: RowRec) => (r.rel.includes('公用') ? 0 : 1)
  const idCmp = (a: string, b: string) => {
    const na = a === '-' ? 2 : 0
    const nb = b === '-' ? 2 : 0
    if (na !== nb) return na - nb
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
  }
  recs.sort((a, b) => sharedFirst(a) - sharedFirst(b) || idCmp(a.id, b.id) || Number(a.seq) - Number(b.seq))

  // 输出 exceljs：嵌入图片 + 表头样式 + 冻结 + 筛选
  const wbOut = new ExcelJS.Workbook()
  wbOut.creator = 'erp'
  const ws = wbOut.addWorksheet('CSP-V3I对照', { views: [{ state: 'frozen', ySplit: 1 }] })
  const header = ['表内序号', '图片', '原表料号', '建议新SKU', 'V3I中文名称', '用量', '与V3关系', 'V3对应料号', '导入供应商', 'V3i图档', '图档是否与V3共用', '备注/颜色标注']
  ws.columns = header.map((h, i) => ({ header: h, key: 'c' + i, width: [8, 12, 18, 16, 30, 6, 22, 14, 14, 10, 26, 70][i] }))
  const hr = ws.getRow(1)
  hr.height = 24
  hr.eachCell((cell) => {
    cell.font = { bold: true, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
  })
  recs.forEach((r, i) => {
    const row = ws.addRow([r.seq, '', r.id, r.sku, r.name, r.qty, r.rel, r.v3Sku, r.vendor, r.drawing, r.drawingShared, r.note])
    row.eachCell((cell) => {
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      cell.alignment = { vertical: 'middle', wrapText: true }
    })
    if (r.rel.includes('公用')) row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F9EB' } }
    if (r.imgPath) {
      const raw = readFileSync(r.imgPath)
      const ext = /\.png$/i.test(r.imgPath) ? 'png' : 'jpeg'
      const imageId = wbOut.addImage({ base64: raw.toString('base64'), extension: ext })
      const dims = imageSize(raw)
      const h = 44
      const w = dims && dims.h > 0 ? Math.min(80, Math.round((dims.w / dims.h) * h)) : 60
      ws.addImage(imageId, { tl: { col: 1.15, row: i + 1.08 }, ext: { width: w, height: h } })
      row.height = 52
    }
  })
  ws.autoFilter = { from: 'A1', to: 'L' + (recs.length + 1) }
  if (extraDrawings.length > 0) {
    const ws2 = wbOut.addWorksheet('表外图档')
    ws2.addRow(['rar 内有图档但表内无对应行'])
    ws2.getRow(1).font = { bold: true }
    for (const e of extraDrawings) ws2.addRow([e])
    ws2.getColumn(1).width = 90
  }
  // 原文件被 Excel 打开时（EBUSY）依次回退到 -v2 / -v3 文件名
  let finalOut = OUT
  for (const suffix of ['', '-v2', '-v3']) {
    const candidate = suffix ? OUT.replace('.xlsx', suffix + '.xlsx') : OUT
    try {
      await wbOut.xlsx.writeFile(candidate)
      finalOut = candidate
      break
    } catch (e) {
      if (String(e).includes('EBUSY')) continue
      throw e
    }
  }
  const shared = recs.filter((r) => r.rel.includes('公用')).length
  console.log('数据行:', data.length, '；共用:', shared, '；新建:', recs.length - shared, '；表外图档:', extraDrawings.length, '；带图行:', recs.filter((r) => r.imgPath).length)
  console.log('已输出:', finalOut)
  rmSync(TMP, { recursive: true, force: true })
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
