// 从工程 BOM Excel 提取「图片」列内嵌图片，按文件行号归位到零件并写回 imageUrl。
// 用法：cd backend && PRODUCT='P_APM-ENDOR金' FILE='D:/AI/工程/成品bom数据/APM/P_APM出货Endor_BOM_20241015.xlsx' npx tsx prisma/import-bom-images.ts
// 说明：图片经 drawing1.xml 两格锚点（col=2 即「图片」列）按行号定位，行号=对照表「文件行号」列（0基物理行）；
// 同一零件多张图只取第一张；已有 imageUrl 的零件不覆盖；其他列/表外游离图片跳过。
import ExcelJS from 'exceljs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prisma } from '../src/db'
import { UPLOAD_DIR, partDirName, placePartFile } from '../src/uploads-store'

const PRODUCT = process.env.PRODUCT ?? ''
const FILE = process.env.FILE ?? ''
const SRC = process.env.SRC ?? 'D:/AI/工程/成品BOM-汇总对照表-20260831-v3.xlsx'
const TMP = resolve(process.cwd(), 'tmp-xlsx-img')
const TAR = 'C:/Windows/System32/tar.exe'
if (!PRODUCT || !FILE) { console.log('缺少 PRODUCT/FILE'); process.exit(1) }

// 1) 对照表：文件行号 → SKU
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(SRC)
const ws = wb.getWorksheet(PRODUCT)
if (!ws) { console.log('对照表无 ' + PRODUCT); process.exit(1) }
const rowSku = new Map<number, string>()
ws.eachRow((row, i) => {
  if (i === 1) return
  const sku = String(row.getCell(4).value ?? '')
  const fileRow = Number(row.getCell(20).value ?? -1)
  if (sku && Number.isInteger(fileRow) && fileRow >= 0) rowSku.set(fileRow, sku)
})
console.log('行号→SKU 映射 ' + rowSku.size + ' 行')

// 2) 解包取 drawings/media
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
execFileSync(TAR, ['-xf', FILE, '-C', TMP], { stdio: 'ignore' })

// 3) 锚点解析（col=2 图片列）
const drawingFile = resolve(TMP, 'xl/drawings/drawing1.xml')
if (!existsSync(drawingFile)) { console.log('该文件没有 drawing1.xml（无内嵌图片）'); process.exit(0) }
const xml = readFileSync(drawingFile, 'utf8')
const anchors: Array<{ col: number | null; row: number | null; rid: string | null }> = []
const segRe = /<xdr:(twoCellAnchor|oneCellAnchor)([\s\S]*?)(?:<\/xdr:\1>)/g
let m: RegExpExecArray | null
while ((m = segRe.exec(xml))) {
  const seg = m[0]
  const col = /<xdr:col>(\d+)<\/xdr:col>/.exec(seg)?.[1]
  const row = /<xdr:row>(\d+)<\/xdr:row>/.exec(seg)?.[1]
  const rid = /r:embed="(rId\d+)"/.exec(seg)?.[1]
  anchors.push({ col: col === undefined ? null : +col, row: row === undefined ? null : +row, rid: rid ?? null })
}
const relsXml = readFileSync(resolve(TMP, 'xl/drawings/_rels/drawing1.xml.rels'), 'utf8')
const relMap: Record<string, string> = {}
for (const mm of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[mm[1]!] = mm[2] ?? ''

const rowRids = new Map<number, string[]>()
let skippedAnchors = 0
for (const a of anchors) {
  if (a.col !== 2 || a.row === null || a.rid === null || !rowSku.has(a.row)) { if (a.rid) skippedAnchors++; continue }
  const list = rowRids.get(a.row) ?? []
  list.push(a.rid)
  rowRids.set(a.row, list)
}

// 4) 归位
let imported = 0, existed = 0, noImage = 0, multiSkipped = 0
const log: string[] = []
for (const [row, sku] of [...rowSku.entries()].sort((a, b) => a[0] - b[0])) {
  const part = await prisma.part.findUnique({ where: { sku } })
  if (!part) { log.push('行' + row + ' ' + sku + ' 库里不存在'); continue }
  const rids = rowRids.get(row) ?? []
  if (rids.length === 0) { noImage++; continue }
  if (part.imageUrl) { existed++; continue }
  if (rids.length > 1) multiSkipped += rids.length - 1
  const target = relMap[rids[0]!] ?? ''
  const mediaRel = target.replace(/^\.\.\//, '').replace(/\\/g, '/')
  const mediaPath = resolve(TMP, 'xl', mediaRel)
  if (!mediaRel || !existsSync(mediaPath)) { log.push('行' + row + ' ' + sku + ' 图片缺失:' + target); continue }
  const ext = mediaRel.toLowerCase().endsWith('.png') ? '.png' : '.jpeg'
  const tmpName = 'imgimp-' + Date.now() + '-' + row + ext
  writeFileSync(resolve(UPLOAD_DIR, tmpName), readFileSync(mediaPath))
  const productSkus = (await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })).map((b) => b.product.sku)
  const url = await placePartFile(tmpName, productSkus, partDirName(part.sku, part.name), 'image', ext)
  await prisma.part.update({ where: { id: part.id }, data: { imageUrl: url } })
  imported++
}

console.log('--- ' + PRODUCT + ' 图片归位完成 ---')
console.log('已归位 ' + imported + '；已有图跳过 ' + existed + '；表内无图 ' + noImage + '；多图取第一张 ' + multiSkipped + '；游离锚点 ' + skippedAnchors)
for (const l of log) console.log(' *', l)
rmSync(TMP, { recursive: true, force: true })
process.exit(0)
