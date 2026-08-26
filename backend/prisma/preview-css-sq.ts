// CSS_SQ 导入前对照审查表（带图片、公用置顶、按原物料编号排序）
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { UPLOAD_DIR } from '../src/uploads-store'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ黑色+USB清单-物料明细.xlsx'
const RAR = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ 2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const TAR = 'C:/Windows/System32/tar.exe'
const TMP = resolve(process.cwd(), 'tmp-css-sq-xlsx')
const OUT = process.env.PREVIEW_OUT || 'D:/AI/erp-backups/CSS_SQ-SKU对照表.xlsx'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
function nf(s: string): string {
  return s.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫').replace(/[門]/g, '门').replace(/[線]/g, '线')
}
function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
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
  if (name.includes('盘头')) return size + (name.includes('自攻') ? '-盘头自攻' : '-盘头')
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
function rarFiles(): string[] {
  const buf = execFileSync(UNRAR, ['lb', RAR], { maxBuffer: 64 * 1024 * 1024 })
  return new TextDecoder('gbk').decode(buf).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => s.toLowerCase().endsWith('.pdf'))
}
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
    if (col === undefined || row === undefined || rid === undefined || +col !== 2) continue
    if (map.has(+row)) continue
    const rel = (relMap[rid] ?? '').replace(/^\.\.\//, '').replace(/\\/g, '/')
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
  const pdfs = rarFiles()
  const pdfByKey = new Map<string, string[]>()
  for (const f of pdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(css-\d+[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = pdfByKey.get(k) ?? []
      list.push(base.trim())
      pdfByKey.set(k, list)
    }
  }
  const v3Parts = new Map<string, { name: string; imageUrl: string | null }>()
  for (const p of await prisma.part.findMany({ select: { sku: true, name: true, imageUrl: true } })) v3Parts.set(p.sku, { name: p.name, imageUrl: p.imageUrl })

  interface Rec { seq: string; id: string; sku: string; name: string; qty: number; rel: string; v3Sku: string; drawing: string; note: string; imgPath: string | null }
  const recs: Rec[] = []
  let miscSeq = 100
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

    if (/^CSS-/i.test(idRaw)) {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) { rel = '公用'; v3Sku = sku }
      if (name.includes('磁铁') && idRaw === 'CSS-095') note = '磁铁1：官方料号 CSS-095（与无料号磁铁行不同规格，分开建）'
    } else if (idRaw === 'xzzx') {
      sku = 'xzzx'
    } else if (isFastener) {
      sku = screwSku(name, dims)
      const v3 = v3Parts.get(sku)
      if (v3) { rel = '公用'; v3Sku = sku }
    } else if (idRaw === '' || idRaw === '-') {
      // 磁铁行按老板确认：与 CSS-095 分开建（不按名称共用 V3 CSP-058）
      if (name === '磁铁') {
        miscSeq++
        sku = 'CSS-' + miscSeq
        rel = '新零件（磁铁2：与CSS-095分开）'
      } else {
        const v3Same = [...v3Parts.entries()].find(([k, v]) => nf(v.name) === nf(name) && (k.startsWith('CSP-') || k.startsWith('CSS-')))
        if (v3Same) { sku = v3Same[0]; rel = '公用（同名）'; v3Sku = sku }
        else { miscSeq++; sku = 'CSS-' + miscSeq; rel = '新零件（杂项 CSS-1xx）' }
      }
    } else {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) { rel = '公用'; v3Sku = sku }
    }
    if (sku === 'CSS-062') note = (note ? note + '；' : '') + '与 V3 CSP-060 PU泡棉 同名，老板确认按官方料号独立建'
    if (name === '插销') note = (note ? note + '；' : '') + '插销（两行不同规格，按老板确认分开建料号）'
    if (name === 'CS_USB_A') note = (note ? note + '；' : '') + '按老板确认归入 CSS-1xx 编号'
    if (seq === '55' && name.includes('棉绳')) note = (note ? note + '；' : '') + '表内序号与第55行重复（M2.5x5螺丝），按物理行处理'
    if (vendorRaw) {
      const real = ['雄浩', '森逸（樟洋）', '伟升', '鑫中源', '金邦', '亚科', '信博', '玖丰', '林洲', '鹏飞'].includes(vendorRaw.split('/')[0]!.trim())
      if (!real) note = (note ? note + '；' : '') + '供应商列「' + vendorRaw + '」为备注，跳过'
    }

    const files = pdfByKey.get(idKey(idRaw)) ?? []
    const drawing = files.length > 0 ? '有（' + files.length + '个）' : ''

    const img = sheetImgs.get(ri) ?? null
    let imgPath = img
    if (!imgPath) {
      const v3img = v3Parts.get(sku)?.imageUrl
      if (v3img) {
        imgPath = resolve(UPLOAD_DIR, v3img.replace(/^\/uploads\//, ''))
        if (!existsSync(imgPath)) imgPath = null
      }
    }
    recs.push({ seq, id: idRaw || '-', sku, name, qty: amount, rel, v3Sku, drawing, note, imgPath })
  }

  for (const [k, files] of pdfByKey) {
    const hasRow = data.some((raw) => idKey(clean(raw[1]).replace(/^['"]+/, '')) === k)
    if (!hasRow) extraDrawings.push('表内无行: ' + k + ' → ' + files.join(' / '))
  }

  const sharedFirst = (r: Rec) => (r.rel.includes('公用') ? 0 : 1)
  const idCmp = (a: string, b: string) => {
    const na = a === '-' ? 2 : 0
    const nb = b === '-' ? 2 : 0
    if (na !== nb) return na - nb
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
  }
  recs.sort((a, b) => sharedFirst(a) - sharedFirst(b) || idCmp(a.id, b.id) || Number(a.seq) - Number(b.seq))

  const wbOut = new ExcelJS.Workbook()
  const ws = wbOut.addWorksheet('CSS_SQ对照', { views: [{ state: 'frozen', ySplit: 1 }] })
  const header = ['表内序号', '图片', '原表料号', '建议新SKU', '中文名称', '用量', '与已有零件关系', '共用已有料号', 'V3i图档', '备注']
  ws.columns = header.map((h, i) => ({ header: h, key: 'c' + i, width: [8, 12, 16, 16, 26, 6, 20, 14, 12, 60][i] }))
  const hr = ws.getRow(1)
  hr.height = 24
  hr.eachCell((cell) => {
    cell.font = { bold: true, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
  })
  recs.forEach((r, i) => {
    const row = ws.addRow([r.seq, '', r.id, r.sku, r.name, r.qty, r.rel, r.v3Sku, r.drawing, r.note])
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
  ws.autoFilter = { from: 'A1', to: 'J' + (recs.length + 1) }
  if (extraDrawings.length > 0) {
    const ws2 = wbOut.addWorksheet('表外图档')
    ws2.addRow(['rar 内有图档但表内无对应行'])
    ws2.getRow(1).font = { bold: true }
    for (const e of extraDrawings) ws2.addRow([e])
    ws2.getColumn(1).width = 90
  }
  let finalOut = OUT
  for (const suffix of ['', '-v2', '-v3']) {
    const candidate = suffix ? OUT.replace('.xlsx', suffix + '.xlsx') : OUT
    try { await wbOut.xlsx.writeFile(candidate); finalOut = candidate; break }
    catch (e) { if (String(e).includes('EBUSY')) continue; throw e }
  }
  const shared = recs.filter((r) => r.rel.includes('公用')).length
  console.log('数据行:', data.length, '；共用:', shared, '；新建:', recs.length - shared, '；表外图档:', extraDrawings.length, '；带图行:', recs.filter((r) => r.imgPath).length)
  console.log('已输出:', finalOut)
  rmSync(TMP, { recursive: true, force: true })
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
