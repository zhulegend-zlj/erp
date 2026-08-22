// 从 CSP_V3_2D PDF.rar 批量导入零件图档（2D PDF）并挂到零件 drawingsUrl。
// 用法：cd backend && npx tsx --env-file=.env prisma/import-csp-v3-drawings.ts
// 口径（老板确认）：
// - 文件名前缀解析料号：CSP-xxx / CSP-xxx-y / iso_10642_-_m6_x_12 等 → 映射到系统 SKU（M6x12-平头…）；
// - CSP-013 一张图挂到 CSP-013-1 ~ CSP-013-7 七个料号；
// - 同编号多个版本（CSP-011/CSP-071）挂最新版到图档，旧版以 <零件目录>-图档2.pdf 留档；
// - CSP-063 表内无此零件，跳过并记录；
// - 已有 drawingsUrl 的零件不覆盖。
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { UPLOAD_DIR, partDirName, partTargetRelDir, placePartFile } from '../src/uploads-store'

const prisma = new PrismaClient()
const RAR = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3_2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const TMP = resolve(process.cwd(), 'tmp-rar-drawings')

function walk(d: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = resolve(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (extname(e.name).toLowerCase() === '.pdf') out.push(p)
  }
  return out
}

/** 文件名 → 系统 SKU（可能多个，如 CSP-013 → 7 个） */
function skuCandidates(name: string): string[] {
  const n = name.trim()
  const csp = n.match(/^csp-(\d+)(?:-(\d+))?/i)
  if (csp) {
    const base = 'CSP-' + csp[1] + (csp[2] ? '-' + csp[2] : '')
    if (base === 'CSP-013') return ['CSP-013-1', 'CSP-013-2', 'CSP-013-3', 'CSP-013-4', 'CSP-013-5', 'CSP-013-6', 'CSP-013-7']
    return [base]
  }
  const iso = n.match(/^iso_?10642_?-?_?m(\d+)_?x_?(\d+)/i)
  if (iso) return ['M' + iso[1] + 'x' + iso[2] + '-平头']
  return []
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  execFileSync(UNRAR, ['x', '-o+', '-inul', RAR, TMP + '/'])
  const files = walk(TMP).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) // 新的在前
  console.log('解包 PDF 数：', files.length)

  const bySku = new Map<string, string[]>()
  const unmatched: string[] = []
  for (const f of files) {
    const skus = skuCandidates(basename(f))
    if (skus.length === 0) {
      unmatched.push(basename(f))
      continue
    }
    for (const sku of skus) {
      const list = bySku.get(sku) ?? []
      list.push(f)
      bySku.set(sku, list)
    }
  }

  let attached = 0
  let archived = 0
  let skippedExisting = 0
  const log: string[] = []
  for (const [sku, list] of bySku) {
    const part = await prisma.part.findUnique({ where: { sku } })
    if (!part) {
      log.push(sku + ' 库里不存在，跳过：' + list.map((f) => basename(f)).join(' | '))
      continue
    }
    if (part.drawingsUrl) {
      skippedExisting++
      continue
    }
    const productSkus = (
      await prisma.bom.findMany({ where: { partId: part.id }, select: { product: { select: { sku: true } } } })
    ).map((b) => b.product.sku)
    const partDir = partDirName(part.sku, part.name)
    const main = list[0]! // 已按时间倒序：最新在前
    const tmpName = 'dwgimp-' + Date.now() + '-' + part.id + '.pdf'
    copyFileSync(main, resolve(UPLOAD_DIR, tmpName))
    const url = await placePartFile(tmpName, productSkus, partDir, 'drawing', '.pdf')
    await prisma.part.update({ where: { id: part.id }, data: { drawingsUrl: url } })
    attached++
    // 旧版本留档：<partDir>-图档2.pdf
    for (const old of list.slice(1)) {
      const relDir = partTargetRelDir(productSkus, partDir)
      mkdirSync(resolve(UPLOAD_DIR, relDir), { recursive: true })
      copyFileSync(old, resolve(UPLOAD_DIR, relDir, partDir + '-图档2.pdf'))
      archived++
      log.push(sku + ' 旧版留档：' + basename(old))
    }
  }

  const withDrawings = await prisma.part.count({ where: { drawingsUrl: { not: null } } })
  console.log('--- 图档导入完成 ---')
  console.log('挂图零件：', attached, '；旧版留档：', archived, '个；已有图档跳过：', skippedExisting)
  console.log('库内有图档零件总数：', withDrawings)
  console.log('--- 未匹配/未挂 ---')
  for (const u of unmatched) console.log(' * 未匹配文件名:', u)
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
