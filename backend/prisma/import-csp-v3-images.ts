// 从 CSP_V3 清单 Excel 提取「图片」列内嵌图片，批量归位到零件并写回 imageUrl。
// 用法：cd backend && npx tsx --env-file=.env prisma/import-csp-v3-images.ts
// 说明：
// - 图片通过 drawing1.xml 的两格锚点（col=2 即「图片」列）按行号定位，行号对应表格物理行序；
// - 行号 → SKU 用对照表 CSP-V3-SKU对照表.xlsx（与上次导入同一口径）映射；
// - 同一零件两张图时只取第一张（其余记录跳过清单）；表格外游离图片（其他列/表外行）跳过；
// - 已有 imageUrl 的零件不覆盖（尊重系统内手工上传）。
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { UPLOAD_DIR, partDirName, placePartFile } from '../src/uploads-store'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3清单_物料明细.xlsx'
const MAPPING = 'D:/AI/erp-backups/CSP-V3-SKU对照表.xlsx'
const TMP = resolve(process.cwd(), 'tmp-xlsx-img')
const TAR = 'C:/Windows/System32/tar.exe'

async function main() {
  // 1) 解包（仅取 drawings/media）
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  execFileSync(TAR, ['-xf', FILE, '-C', TMP], { stdio: 'ignore' })

  // 2) 解析锚点：col=2（图片列）且行号在数据区 1..107 内
  const xml = readFileSync(resolve(TMP, 'xl/drawings/drawing1.xml'), 'utf8')
  const anchors: { col: number | null; row: number | null; rid: string | null }[] = []
  const segRe = /<xdr:(twoCellAnchor|oneCellAnchor)([\s\S]*?)(?:<\/xdr:\1>)/g
  let m
  while ((m = segRe.exec(xml))) {
    const seg = m[0]
    const col = /<xdr:col>(\d+)<\/xdr:col>/.exec(seg)?.[1]
    const row = /<xdr:row>(\d+)<\/xdr:row>/.exec(seg)?.[1]
    const rid = /r:embed="(rId\d+)"/.exec(seg)?.[1]
    anchors.push({ col: col === undefined ? null : +col, row: row === undefined ? null : +row, rid: rid ?? null })
  }
  const relsXml = readFileSync(resolve(TMP, 'xl/drawings/_rels/drawing1.xml.rels'), 'utf8')
  const relMap: Record<string, string> = {}
  for (const mm of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[mm[1]] = mm[2] ?? ''

  const rowRids = new Map<number, string[]>()
  const skippedAnchors: string[] = []
  for (const a of anchors) {
    if (a.col !== 2 || a.row === null || a.rid === null || a.row < 1 || a.row > 107) {
      if (a.rid) skippedAnchors.push('col' + a.col + ' row' + a.row + ' ' + a.rid)
      continue
    }
    const list = rowRids.get(a.row) ?? []
    list.push(a.rid)
    rowRids.set(a.row, list)
  }

  // 3) 对照表：行号 → { sku, name }
  const wbMap = XLSX.read(readFileSync(MAPPING), { type: 'buffer' })
  const mapRows = XLSX.utils.sheet_to_json(wbMap.Sheets[wbMap.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const rowInfo = new Map<number, { sku: string; name: string }>()
  for (let i = 1; i < mapRows.length; i++) {
    const sku = String(mapRows[i]?.[2] ?? '').trim()
    const name = String(mapRows[i]?.[3] ?? '').trim()
    if (sku) rowInfo.set(i, { sku, name })
  }

  // 4) 归位图片
  let imported = 0
  let existed = 0
  let noImage = 0
  let multiSkipped = 0
  const log: string[] = []
  for (let row = 1; row <= 107; row++) {
    const info = rowInfo.get(row)
    if (!info) continue
    const part = await prisma.part.findUnique({ where: { sku: info.sku } })
    if (!part) {
      log.push('行' + row + ' SKU ' + info.sku + ' 库里不存在，跳过')
      continue
    }
    const rids = rowRids.get(row) ?? []
    if (rids.length === 0) {
      noImage++
      log.push('行' + row + ' ' + part.sku + ' ' + part.name + ' 表格内无图片')
      continue
    }
    if (part.imageUrl) {
      existed++
      continue
    }
    if (rids.length > 1) multiSkipped += rids.length - 1
    const target = relMap[rids[0]!] ?? ''
    const mediaRel = target.replace(/^\.\.\//, '').replace(/\\/g, '/') // ../media/x → media/x
    const mediaPath = resolve(TMP, 'xl', mediaRel)
    if (!mediaRel || !existsSync(mediaPath)) {
      log.push('行' + row + ' ' + part.sku + ' 图片文件缺失：' + target)
      continue
    }
    const ext = mediaRel.toLowerCase().endsWith('.png') ? '.png' : '.jpeg'
    const tmpName = 'imgimp-' + Date.now() + '-' + row + ext
    writeFileSync(resolve(UPLOAD_DIR, tmpName), readFileSync(mediaPath))
    const productSkus = (
      await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })
    ).map((b) => b.product.sku)
    const url = await placePartFile(tmpName, productSkus, partDirName(part.sku, part.name), 'image', ext)
    await prisma.part.update({ where: { id: part.id }, data: { imageUrl: url } })
    imported++
  }

  console.log('--- 图片导入完成 ---')
  console.log('已归位：', imported, '；已有图片跳过：', existed, '；表格内无图：', noImage, '；多图仅取第一张：', multiSkipped, '张')
  console.log('跳过游离锚点（表格外/其他列）：', skippedAnchors.length, '个')
  for (const l of log) console.log(' *', l)
  rmSync(TMP, { recursive: true, force: true })
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
