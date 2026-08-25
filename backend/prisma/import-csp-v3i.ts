// CSP_V3I 导入：以老板复核后的对照表为口径（SKU/公用关系/供应商/备注），
// 明细字段（英文名/重量/版本/材质/尺寸/表面处理/图号）取自源表格，图片取源表内嵌图，图档取 V3i rar。
// 决策（老板确认）：铝套管按尺寸命名（39.5→CSP-013-39.5、45.5→CSP-013-45.5）；
// 3M胶贴→CSP-321（两行合并用量6）、扎线带→CSP-322、无纺布袋→CSP-323（不与V3共用）；
// 共用零件图档：V3i 版本号更高则更新（旧版留档 -图档2.pdf），相同/更低保持V3；CSP-017-v3i 待图纸不挂。
// 用法：cd backend && npx tsx --env-file=.env prisma/import-csp-v3i.ts
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { UPLOAD_DIR, findPartFolder, partDirName, partTargetRelDir, placePartFile, rehomePartFolder, urlFor } from '../src/uploads-store'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3I清单-螺丝物料表.xlsx'
const TABLE = 'D:/AI/erp-backups/CSP-V3I-SKU对照表.xlsx'
const RAR_V3I = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3i_2D PDF.rar'
const RAR_V3 = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3_2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const TAR = 'C:/Windows/System32/tar.exe'
const TMP = resolve(process.cwd(), 'tmp-v3i-import')
const PRODUCT_SKU = 'CSP-V3I'
const PRODUCT_NAME = 'CSP V3I 挂档器'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
}
function rarFiles(rarPath: string): string[] {
  const buf = execFileSync(UNRAR, ['lb', rarPath], { maxBuffer: 64 * 1024 * 1024 })
  return new TextDecoder('gbk').decode(buf).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => s.toLowerCase().endsWith('.pdf'))
}
/** 文件名主版本号：取扩展名前最后一个 _数字 段（如 _006.pdf→6、_002(JMC).pdf→2） */
function revOf(name: string): number {
  const m = name.match(/[_-](\d+)(?=[^0-9]*\.[a-z0-9]+$)/i)
  return m ? Number(m[1]) : 0
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  // 1) 成品
  const product = (await prisma.product.findUnique({ where: { sku: PRODUCT_SKU } })) ??
    (await prisma.product.create({ data: { sku: PRODUCT_SKU, name: PRODUCT_NAME, unit: '件' } }))
  console.log('成品:', product.sku, product.name)

  // 2) 复核后对照表（口径）
  const wbT = XLSX.read(readFileSync(TABLE), { type: 'buffer' })
  const tableRows = XLSX.utils.sheet_to_json(wbT.Sheets['CSP-V3I对照'], { header: 1, defval: '', raw: false }) as unknown[][]
  const recs: { seq: string; id: string; sku: string; name: string; qty: number; rel: string; vendor: string; note: string }[] = []
  for (const r of tableRows.slice(1)) {
    const sku = clean(r[3])
    const name = clean(r[4])
    if (!sku || !name) continue
    recs.push({ seq: clean(r[0]), id: clean(r[2]).replace(/^['"]+/, '').trim(), sku, name, qty: Number(r[5]) || 1, rel: clean(r[6]), vendor: clean(r[8]), note: clean(r[11]) })
  }
  // 老板确认的覆盖
  for (const r of recs) {
    if (r.name.includes('铝套管20*39.5')) r.sku = 'CSP-013-39.5'
    if (r.name.includes('铝套管20*45.5')) r.sku = 'CSP-013-45.5'
    if (r.name.includes('3M胶贴')) r.sku = 'CSP-321'
    if (r.name.includes('扎线带')) r.sku = 'CSP-322'
    if (r.name.includes('无纺布袋')) r.sku = 'CSP-323'
  }
  console.log('对照表行:', recs.length)

  // 3) 源表格明细（按 序号|名称 匹配）
  const wbS = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const sheetRows = XLSX.utils.sheet_to_json(wbS.Sheets[wbS.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const detailByKey = new Map<string, { rowIdx: number; nameEn: string; weight: string; revision: string; material: string; dims: string; finish: string; artId: string }>()
  for (let i = 0; i < sheetRows.length; i++) {
    const v = sheetRows[i]
    if (i === 0) continue
    const seq = clean(v[0])
    const name = clean(v[5])
    if (!name) continue
    detailByKey.set(seq + '|' + name, {
      rowIdx: i,
      nameEn: clean(v[4]),
      weight: clean(v[6]),
      revision: clean(v[7]),
      material: clean(v[8]),
      dims: clean(v[9]),
      finish: clean(v[10]),
      artId: clean(v[18]),
    })
  }

  // 4) 图档清单
  const v3iPdfs = rarFiles(RAR_V3I)
  const v3Pdfs = rarFiles(RAR_V3)
  const filesByKey = new Map<string, string[]>()
  for (const f of v3iPdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (!m) continue
    const k = idKey(m[1])
    const list = filesByKey.get(k) ?? []
    list.push(base)
    filesByKey.set(k, list)
  }
  const v3ByKey = new Map<string, string[]>()
  for (const f of v3Pdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (!m) continue
    const k = idKey(m[1])
    const list = v3ByKey.get(k) ?? []
    list.push(base)
    v3ByKey.set(k, list)
  }

  // 5) 源表内嵌图片（行号→文件路径）
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

  // 6) 清空本成品旧 BOM，按对照表逐行 upsert 零件
  await prisma.bom.deleteMany({ where: { productId: product.id } })
  const existingSkus = new Set((await prisma.part.findMany({ select: { sku: true } })).map((p) => p.sku))
  const suppliers = new Map((await prisma.supplier.findMany()).map((s) => [s.name, s.id]))
  const bomQty = new Map<number, number>()
  let created = 0
  let sharedCount = 0
  const noDetail: string[] = []
  const imgSrcByPartId = new Map<number, string>()

  for (const r of recs) {
    const key = r.seq + '|' + r.name
    const d = detailByKey.get(key)
    if (!d) noDetail.push(r.seq + ' ' + r.name)
    let part = await prisma.part.findUnique({ where: { sku: r.sku } })
    if (!part) {
      // 新建零件：明细来自源表格（无明细的行给最小字段）
      let supplierId: number | null = null
      if (r.vendor && suppliers.has(r.vendor)) supplierId = suppliers.get(r.vendor)!
      part = await prisma.part.create({
        data: {
          sku: r.sku,
          name: r.name.slice(0, 80),
          nameEn: d?.nameEn || null,
          unit: '个',
          weight: d?.weight || null,
          revision: d?.revision || null,
          material: d?.material || null,
          dimensions: d ? d.dims || null : r.name.includes('铝套管20*45.5') ? '20*45.5' : null,
          finish: d?.finish || null,
          artId: d?.artId || null,
          spec: d ? [d.material, d.dims, d.finish].filter(Boolean).join('｜').slice(0, 200) || null : null,
          supplierId,
        },
      })
      created++
    } else {
      sharedCount++
    }
    bomQty.set(part.id, (bomQty.get(part.id) ?? 0) + r.qty)
    if (d) imgSrcByPartId.set(part.id, imgByRow.get(d.rowIdx) ?? '')
  }
  for (const [partId, qty] of bomQty) {
    await prisma.bom.create({ data: { productId: product.id, partId, qty } })
  }
  console.log('新建零件:', created, '；共用V3零件:', sharedCount, '；BOM行:', bomQty.size)
  if (noDetail.length) console.log('源表无明细行（仅名称）:', noDetail.join(', '))

  // 7) 图片：新零件从源表取图（共用零件保留V3已有图片）
  let imgSet = 0
  const imgSkipped: string[] = []
  for (const [partId, src] of imgSrcByPartId) {
    const part = await prisma.part.findUnique({ where: { id: partId } })
    if (!part || part.imageUrl) continue
    if (!src) { imgSkipped.push(part.sku + '（源表无图）'); continue }
    const ext = /\.png$/i.test(src) ? '.png' : '.jpeg'
    const tmpName = 'imgimp-v3i-' + partId + ext
    copyFileSync(src, resolve(UPLOAD_DIR, tmpName))
    const productSkus = ['CSP-V3I']
    const url = await placePartFile(tmpName, productSkus, partDirName(part.sku, part.name), 'image', ext)
    await prisma.part.update({ where: { id: part.id }, data: { imageUrl: url } })
    imgSet++
  }
  console.log('新零件挂图片:', imgSet, '；无图:', imgSkipped.length ? imgSkipped.join(', ') : '(无)')

  // 8) 图档：整包解压一次，按文件名（trim 后）建索引
  mkdirSync(resolve(TMP, 'rarout'), { recursive: true })
  execFileSync(UNRAR, ['x', '-o+', '-inul', RAR_V3I, TMP + '/rarout/'], { stdio: 'ignore' })
  const rarIndex = new Map<string, string>()
  const walkDir = (d: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name)
      if (e.isDirectory()) out.push(...walkDir(p))
      else out.push(p)
    }
    return out
  }
  for (const p of walkDir(resolve(TMP, 'rarout'))) {
    const base = p.split(/[\\/]/).pop()!.trim().toLowerCase()
    if (base.endsWith('.pdf')) rarIndex.set(base, p)
  }
  let drawingNew = 0
  let drawingUpdated = 0
  const drawingSkipped: string[] = []
  for (const r of recs) {
    const part = await prisma.part.findUnique({ where: { sku: r.sku } })
    if (!part) continue
    // 共用判定（幂等）：该零件挂在 V3 成品 BOM 上 = V3共用零件
    const wasShared = (await prisma.bom.count({ where: { partId: part.id, product: { sku: 'CSP-V3' } } })) > 0
    // 原表料号从源表行取
    const d = detailByKey.get(r.seq + '|' + r.name)
    const srcId = d ? clean(sheetRows[d.rowIdx][1]).replace(/^['"]+/, '').trim() : r.id
    const k = idKey(srcId)
    const files = filesByKey.get(k) ?? []
    if (files.length === 0) { if (wasShared) drawingSkipped.push(r.sku + '（V3i无图档，保持V3）'); continue }
    if (!wasShared) {
      if (part.drawingsUrl) { drawingSkipped.push(r.sku + '（已有图档，跳过）'); continue }
      // 新零件：挂 V3i 图档（CSP-017-v3i 除外：待增加图纸）
      if (r.sku === 'CSP-017-v3i') { drawingSkipped.push(r.sku + '（老板备注：待增加图纸）'); continue }
      const f = files[0]!
      const found = rarIndex.get(f.trim().toLowerCase())
      if (!found) { drawingSkipped.push(r.sku + '（rar 文件未找到: ' + f + '）'); continue }
      const tmpName = 'dwgimp-v3i-' + part.id + '.pdf'
      copyFileSync(found, resolve(UPLOAD_DIR, tmpName))
      const url = await placePartFile(tmpName, ['CSP-V3I'], partDirName(part.sku, part.name), 'drawing', '.pdf')
      await prisma.part.update({ where: { id: part.id }, data: { drawingsUrl: url } })
      drawingNew++
    } else {
      // 共用零件：V3i 版本更高才更新（旧版留档 -图档2.pdf），相同/更低保持V3
      const v3Files = v3ByKey.get(k) ?? []
      const v3Rev = Math.max(0, ...v3Files.map(revOf))
      const v3iRev = Math.max(0, ...files.map(revOf))
      if (v3iRev > v3Rev && part.drawingsUrl) {
        const partDir = partDirName(part.sku, part.name)
        const folderAbs = (await findPartFolder(partDir)) ?? resolve(UPLOAD_DIR, partTargetRelDir(['CSP-V3', 'CSP-V3I'], partDir))
        const absDir = folderAbs
        const relDir = folderAbs.slice(UPLOAD_DIR.length + 1).replace(/\\/g, '/')
        const oldMain = resolve(absDir, partDir + '-图档.pdf')
        const newFile = files[0]!
        const foundNew = rarIndex.get(newFile.trim().toLowerCase())
        if (!foundNew) { drawingSkipped.push(r.sku + '（rar 文件未找到: ' + newFile + '）'); continue }
        mkdirSync(absDir, { recursive: true })
        try {
          if (existsSync(oldMain)) {
            copyFileSync(oldMain, resolve(absDir, partDir + '-图档2.pdf'))
            rmSync(oldMain, { force: true })
          }
          copyFileSync(foundNew, oldMain)
          await prisma.part.update({ where: { id: part.id }, data: { drawingsUrl: urlFor(relDir, partDir + '-图档.pdf') } })
          drawingUpdated++
        } catch (e) {
          drawingSkipped.push(r.sku + '（文件夹被占用，图档未更新: ' + String(e).slice(0, 40) + '）')
        }
      } else {
        drawingSkipped.push(r.sku + '（版本相同或V3更高，保持V3）')
      }
    }
  }
  console.log('新挂图档:', drawingNew, '；更新图档:', drawingUpdated)
  if (drawingSkipped.length) console.log('保持/未挂:', drawingSkipped.join(', '))

  // 9) 归位共用零件文件夹（BOM 已含 V3+V3i → _共用），并同步 URL
  let rehomed = 0
  for (const r of recs) {
    const part = await prisma.part.findUnique({ where: { sku: r.sku } })
    if (!part) continue
    const boms = await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })
    const productSkus = boms.map((b) => b.product.sku)
    const partDir = partDirName(part.sku, part.name)
    let result
    try {
      result = await rehomePartFolder(partDir, productSkus)
    } catch (e) {
      console.log('  ⚠ 文件夹被占用，保持原位:', partDir, String(e).slice(0, 60))
      continue
    }
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
    rehomed++
  }
  console.log('归位检查零件数:', rehomed)

  // 10) 汇总
  const [partsTotal, bomsTotal, withImg, withDwg] = await Promise.all([
    prisma.part.count(),
    prisma.bom.count({ where: { productId: product.id } }),
    prisma.part.count({ where: { imageUrl: { not: null } } }),
    prisma.part.count({ where: { drawingsUrl: { not: null } } }),
  ])
  console.log('--- 导入完成 ---')
  console.log('库内零件总数:', partsTotal, '；CSP-V3I BOM 行数:', bomsTotal, '；有图片零件:', withImg, '；有图档零件:', withDwg)
  rmSync(TMP, { recursive: true, force: true })
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
