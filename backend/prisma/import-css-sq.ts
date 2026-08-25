// CSS_SQ 导入：官方料号照抄（CSS-xxx/xzzx/48_/47_/49-）、螺丝规格+类型（与V3/V3I同规格共用）、
// 无编号杂项 CSS-101 起编（老板确认：从100之后开始）；磁铁两行分开、插销两行分开、CS_USB_A 入杂项号。
// 明细字段/图片取源表格（内嵌图），图档取 CSS_SQ 2D PDF.rar（38 个 CSS 系列）。
// 与已有零件同名（干燥剂/备件Logo贴纸/彩盒外箱标签/外箱主标签/产品安全手册）自动共用已有料号。
// 用法：cd backend && npx tsx --env-file=.env prisma/import-css-sq.ts（可重复执行，幂等）
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { UPLOAD_DIR, findPartFolder, partDirName, partTargetRelDir, placePartFile, rehomePartFolder, urlFor } from '../src/uploads-store'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ黑色+USB清单-物料明细.xlsx'
const RAR = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ 2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const TAR = 'C:/Windows/System32/tar.exe'
const TMP = resolve(process.cwd(), 'tmp-css-sq-import')
const PRODUCT_SKU = 'CSS-SQ'
const PRODUCT_NAME = 'CSS_SQ 挂档器（黑色+USB）'
const REAL_VENDORS = ['雄浩', '森逸（樟洋）', '伟升', '鑫中源', '金邦', '亚科', '信博', '玖丰', '林洲', '鹏飞']

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
function nf(s: string): string {
  return s.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫').replace(/[門]/g, '门').replace(/[線]/g, '线')
}
function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
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

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  // 成品
  const product = (await prisma.product.findUnique({ where: { sku: PRODUCT_SKU } })) ??
    (await prisma.product.create({ data: { sku: PRODUCT_SKU, name: PRODUCT_NAME, unit: '件' } }))
  console.log('成品:', product.sku, product.name)

  // 源表
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  // 图档清单（整包解压 + 索引）
  mkdirSync(resolve(TMP, 'rarout'), { recursive: true })
  execFileSync(UNRAR, ['x', '-o+', '-inul', RAR, TMP + '/rarout/'], { stdio: 'ignore' })
  const walkDir = (d: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name)
      if (e.isDirectory()) out.push(...walkDir(p))
      else out.push(p)
    }
    return out
  }
  const rarIndex = new Map<string, string>()
  const pdfByKey = new Map<string, string[]>()
  for (const p of walkDir(resolve(TMP, 'rarout'))) {
    const base = p.split(/[\\/]/).pop()!.trim()
    if (base.toLowerCase().endsWith('.pdf')) rarIndex.set(base.toLowerCase(), p)
    const m = base.match(/^(css-\d+[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = pdfByKey.get(k) ?? []
      list.push(base)
      pdfByKey.set(k, list)
    }
  }

  // 源表内嵌图片（图片列）
  execFileSync(TAR, ['-xf', FILE, '-C', TMP], { stdio: 'ignore' })
  const xml = readFileSync(resolve(TMP, 'xl/drawings/drawing1.xml'), 'utf8')
  const rels = readFileSync(resolve(TMP, 'xl/drawings/_rels/drawing1.xml.rels'), 'utf8')
  const relMap: Record<string, string> = {}
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2] ?? ''
  const imgByRow = new Map<number, string>()
  const segRe = /<xdr:(twoCellAnchor|oneCellAnchor)([\s\S]*?)(?:<\/xdr:\1>)/g
  let m
  while ((m = segRe.exec(xml))) {
    const seg = m[0]
    const col = /<xdr:col>(\d+)<\/xdr:col>/.exec(seg)?.[1]
    const row = /<xdr:row>(\d+)<\/xdr:row>/.exec(seg)?.[1]
    const rid = /r:embed="(rId\d+)"/.exec(seg)?.[1]
    if (col === undefined || row === undefined || rid === undefined || +col !== 2) continue
    if (imgByRow.has(+row)) continue
    const rel = (relMap[rid] ?? '').replace(/^\.\.\//, '').replace(/\\/g, '/')
    const p = resolve(TMP, 'xl', rel)
    if (rel && /\.(png|jpe?g)$/i.test(rel) && existsSync(p)) imgByRow.set(+row, p)
  }

  // 已有零件
  const allParts = await prisma.part.findMany({ select: { id: true, sku: true, name: true } })
  const partByName = new Map<string, { id: number; sku: string }>()
  for (const p of allParts) {
    const key = nf(p.name)
    if (!partByName.has(key)) partByName.set(key, { id: p.id, sku: p.sku })
  }
  const suppliers = new Map((await prisma.supplier.findMany()).map((s) => [s.name, s.id]))

  // 清空旧 BOM，逐行 upsert
  await prisma.bom.deleteMany({ where: { productId: product.id } })
  const bomQty = new Map<number, number>()
  const createdSkus: string[] = []
  let miscSeq = 100 // 老板确认：新编号从 100 之后开始（CSS-101+）
  let created = 0
  let shared = 0

  let ri = 0
  for (const raw of data) {
    ri++
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const nameEn = clean(raw[4])
    const weight = clean(raw[6])
    const revision = clean(raw[7])
    const material = clean(raw[8])
    const dims = clean(raw[9])
    const finish = clean(raw[10])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    const artId = clean(raw[18])
    const vendorRaw = clean(raw[19])
    if (!name) continue

    const isFastener = /螺丝|螺母|垫片|机米|螺钉/.test(name)
    let sku = ''
    if (/^CSS-/i.test(idRaw)) {
      sku = idRaw
    } else if (idRaw === 'xzzx') {
      sku = 'xzzx'
    } else if (isFastener) {
      sku = screwSku(name, dims)
    } else if (idRaw === '' || idRaw === '-') {
      if (name === '磁铁') {
        // 与 CSS-095 不同规格，分开建（不按名称共用 V3 CSP-058）
        miscSeq++
        sku = 'CSS-' + miscSeq
      } else {
        const same = partByName.get(nf(name))
        if (same && same.sku.startsWith('CSP-')) {
          sku = same.sku
        } else {
          miscSeq++
          sku = 'CSS-' + miscSeq
        }
      }
    } else {
      sku = idRaw
    }

    let part = await prisma.part.findUnique({ where: { sku } })
    if (!part) {
      let supplierId: number | null = null
      const vendorName = vendorRaw && REAL_VENDORS.includes(vendorRaw.split('/')[0]!.trim()) ? vendorRaw.split('/')[0]!.trim() : ''
      if (vendorName && suppliers.has(vendorName)) supplierId = suppliers.get(vendorName)!
      part = await prisma.part.create({
        data: {
          sku,
          name: name.slice(0, 80),
          nameEn: nameEn || null,
          unit: '个',
          weight: weight || null,
          revision: revision || null,
          material: material || null,
          dimensions: dims || null,
          finish: finish || null,
          artId: artId || null,
          spec: [material, dims, finish].filter(Boolean).join('｜').slice(0, 200) || null,
          supplierId,
        },
      })
      created++
      createdSkus.push(sku)
    } else {
      shared++
    }
    bomQty.set(part.id, (bomQty.get(part.id) ?? 0) + amount)
  }
  for (const [partId, qty] of bomQty) {
    await prisma.bom.create({ data: { productId: product.id, partId, qty } })
  }
  console.log('新建零件:', created, '；共用:', shared, '；BOM行:', bomQty.size)

  // 图片：新零件从源表取图（共用零件保留已有图片）
  let imgSet = 0
  const noImg: string[] = []
  ri = 0
  miscSeq = 100 // 重置编号游标，与第一轮 SKU 计算保持一致
  for (const raw of data) {
    ri++
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    if (!name) continue
    const isFastener = /螺丝|螺母|垫片|机米|螺钉/.test(name)
    let sku = ''
    if (/^CSS-/i.test(idRaw)) sku = idRaw
    else if (idRaw === 'xzzx') sku = 'xzzx'
    else if (isFastener) sku = screwSku(name, clean(raw[9]))
    else if (idRaw === '' || idRaw === '-') {
      if (name === '磁铁') { miscSeq++; sku = 'CSS-' + miscSeq }
      else {
        const same = partByName.get(nf(name))
        sku = same && same.sku.startsWith('CSP-') ? same.sku : 'CSS-' + (++miscSeq)
      }
    } else sku = idRaw
    const part = await prisma.part.findUnique({ where: { sku } })
    if (!part || part.imageUrl) continue
    const src = imgByRow.get(ri) ?? ''
    if (!src) { noImg.push(sku); continue }
    const ext = /\.png$/i.test(src) ? '.png' : '.jpeg'
    const tmpName = 'imgimp-css-' + part.id + ext
    copyFileSync(src, resolve(UPLOAD_DIR, tmpName))
    const url = await placePartFile(tmpName, ['CSS-SQ'], partDirName(part.sku, part.name), 'image', ext)
    await prisma.part.update({ where: { id: part.id }, data: { imageUrl: url } })
    imgSet++
  }
  console.log('新零件挂图片:', imgSet, '；源表无图:', noImg.length ? noImg.join(', ') : '(无)')

  // 图档：官方 CSS 料号挂对应 PDF
  let dwgSet = 0
  const dwgMiss: string[] = []
  for (const raw of data) {
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    if (!name) continue
    if (!/^CSS-/i.test(idRaw)) continue
    const sku = idRaw
    const part = await prisma.part.findUnique({ where: { sku } })
    if (!part) continue
    if (part.drawingsUrl) continue
    const files = pdfByKey.get(idKey(idRaw)) ?? []
    if (files.length === 0) { dwgMiss.push(sku); continue }
    const found = rarIndex.get(files[0]!.trim().toLowerCase())
    if (!found) { dwgMiss.push(sku + '（rar未找到）'); continue }
    const tmpName = 'dwgimp-css-' + part.id + '.pdf'
    copyFileSync(found, resolve(UPLOAD_DIR, tmpName))
    const url = await placePartFile(tmpName, ['CSS-SQ'], partDirName(part.sku, part.name), 'drawing', '.pdf')
    await prisma.part.update({ where: { id: part.id }, data: { drawingsUrl: url } })
    dwgSet++
  }
  console.log('新挂图档:', dwgSet, '；表内无对应图档:', dwgMiss.length ? dwgMiss.join(', ') : '(无)')

  // 归位共用零件文件夹（多成品 → _共用）
  for (const r of [...new Set(createdSkus)]) {
    const part = await prisma.part.findUnique({ where: { sku: r } })
    if (!part) continue
    const boms = await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })
    const productSkus = boms.map((b) => b.product.sku)
    const partDir = partDirName(part.sku, part.name)
    try {
      const result = await rehomePartFolder(partDir, productSkus)
      if (result.files.length > 0) {
        const drawingFile = result.files.find((f) => /-图档\.[^.]+$/i.test(f))
        const imageFile = result.files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && !f.includes('图档'))
        const newImage = imageFile ? urlFor(result.relDir, imageFile) : null
        const newDrawing = drawingFile ? urlFor(result.relDir, drawingFile) : null
        if (newImage !== (part.imageUrl ?? null) || newDrawing !== (part.drawingsUrl ?? null)) {
          await prisma.part.update({
            where: { id: part.id },
            data: { ...(newImage && newImage !== part.imageUrl ? { imageUrl: newImage } : {}), ...(newDrawing && newDrawing !== part.drawingsUrl ? { drawingsUrl: newDrawing } : {}) },
          })
        }
      }
    } catch (e) {
      console.log('  ⚠ 文件夹被占用，保持原位:', partDir, String(e).slice(0, 50))
    }
  }
  // 共用零件（螺丝等）也要归位（它们挂在 V3/V3I + CSS-SQ）
  const sharedSkus = ['M4x10-平头', 'M4x10-杯头', 'M3x8-杯头', 'CSP-217', 'CSP-219', 'CSP-220', 'CSP-221', '49-002769']
  for (const sku of sharedSkus) {
    const part = await prisma.part.findUnique({ where: { sku } })
    if (!part) continue
    const boms = await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })
    const productSkus = boms.map((b) => b.product.sku)
    const partDir = partDirName(part.sku, part.name)
    try {
      const result = await rehomePartFolder(partDir, productSkus)
      if (result.files.length > 0) {
        const drawingFile = result.files.find((f) => /-图档\.[^.]+$/i.test(f))
        const imageFile = result.files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && !f.includes('图档'))
        const newImage = imageFile ? urlFor(result.relDir, imageFile) : null
        const newDrawing = drawingFile ? urlFor(result.relDir, drawingFile) : null
        if (newImage !== (part.imageUrl ?? null) || newDrawing !== (part.drawingsUrl ?? null)) {
          await prisma.part.update({
            where: { id: part.id },
            data: { ...(newImage && newImage !== part.imageUrl ? { imageUrl: newImage } : {}), ...(newDrawing && newDrawing !== part.drawingsUrl ? { drawingsUrl: newDrawing } : {}) },
          })
        }
      }
    } catch (e) {
      console.log('  ⚠ 文件夹被占用，保持原位:', partDir, String(e).slice(0, 50))
    }
  }

  const [partsTotal, bomsTotal] = await Promise.all([
    prisma.part.count(),
    prisma.bom.count({ where: { productId: product.id } }),
  ])
  console.log('--- 导入完成 ---')
  console.log('库内零件总数:', partsTotal, '；CSS-SQ BOM 行数:', bomsTotal)
  rmSync(TMP, { recursive: true, force: true })
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
