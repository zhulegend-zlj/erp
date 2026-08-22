// 上传文件的目录组织策略：
// uploads/
// ├── <成品SKU>/<零件SKU>-<零件名>/图片.png|图档.pdf   ← 挂在单个成品下的零件
// ├── _共用/<零件SKU>-<零件名>/...                       ← 挂在多个成品下的共用零件
// └── _未分类/<零件SKU>-<零件名>/...                     ← 尚未挂 BOM 的零件（保存 BOM 后自动归位）
// 成品图片：uploads/<成品SKU>/图片.ext
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// 测试环境通过 UPLOAD_DIR 环境变量隔离到临时目录，避免测试清理误删真实上传文件
export const UPLOAD_DIR = process.env.UPLOAD_DIR ? resolve(process.env.UPLOAD_DIR) : resolve(process.cwd(), 'uploads')
export const UNCATEGORIZED = '_未分类'
export const SHARED = '_共用'

export function slugify(s: string): string {
  const clean = (s ?? '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return clean || ''
}

/** 零件文件夹名：SKU-名称（中文安全 slug） */
export function partDirName(sku: string, name: string): string {
  const parts = [slugify(sku), slugify(name)].filter(Boolean)
  return parts.join('-') || 'part'
}

/** 零件文件固定文件名：图片.ext / 图档.ext */
export function partFileName(kind: 'image' | 'drawing', ext: string): string {
  return (kind === 'image' ? '图片' : '图档') + ext
}

/** 根据零件当前挂载的成品决定归属目录（相对 uploads） */
export function partTargetRelDir(productSkus: string[], partDir: string): string {
  if (productSkus.length === 0) return UNCATEGORIZED + '/' + partDir
  if (productSkus.length === 1) return slugify(productSkus[0] ?? '') + '/' + partDir
  return SHARED + '/' + partDir
}

export function urlFor(relDir: string, fileName: string): string {
  return '/uploads/' + relDir.replace(/\\/g, '/') + '/' + fileName
}

/** 把已写入 uploads 根目录的临时文件移动到零件目标位置（覆盖同名旧文件） */
export async function placePartFile(
  tmpName: string,
  productSkus: string[],
  partDir: string,
  kind: 'image' | 'drawing',
  ext: string,
): Promise<string> {
  const relDir = partTargetRelDir(productSkus, partDir)
  const fileName = partFileName(kind, ext)
  await mkdir(resolve(UPLOAD_DIR, relDir), { recursive: true })
  await rename(resolve(UPLOAD_DIR, tmpName), resolve(UPLOAD_DIR, relDir, fileName))
  return urlFor(relDir, fileName)
}

/** 成品图片：uploads/<成品SKU>/图片.ext */
export async function placeProductImage(tmpName: string, productSku: string, ext: string): Promise<string> {
  const relDir = slugify(productSku)
  await mkdir(resolve(UPLOAD_DIR, relDir), { recursive: true })
  await rename(resolve(UPLOAD_DIR, tmpName), resolve(UPLOAD_DIR, relDir, '图片' + ext))
  return urlFor(relDir, '图片' + ext)
}

/** 在 uploads 下查找零件文件夹（未分类/共用/各成品目录） */
export async function findPartFolder(partDir: string): Promise<string | null> {
  const exists = async (p: string) => stat(p).then(() => true).catch(() => false)
  for (const base of [UNCATEGORIZED, SHARED]) {
    const p = resolve(UPLOAD_DIR, base, partDir)
    if (await exists(p)) return p
  }
  const entries = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue
    const p = resolve(UPLOAD_DIR, e.name, partDir)
    if (await exists(p)) return p
  }
  return null
}

/** 把零件文件夹归位到当前应属目录；返回 { relDir, files }（files=文件夹内文件名列表） */
export async function rehomePartFolder(
  partDir: string,
  productSkus: string[],
): Promise<{ relDir: string; files: string[] }> {
  const newRelDir = partTargetRelDir(productSkus, partDir)
  const current = await findPartFolder(partDir)
  if (!current) return { relDir: newRelDir, files: [] }
  const target = resolve(UPLOAD_DIR, newRelDir)
  if (current !== target) {
    await mkdir(dirname(target), { recursive: true })
    await rename(current, target)
  }
  const files = await readdir(target).catch(() => [])
  return { relDir: newRelDir, files }
}

/** 零件改名/改 SKU 后移动文件夹 */
export async function movePartFolder(
  oldPartDir: string,
  newPartDir: string,
  productSkus: string[],
): Promise<{ relDir: string; files: string[] }> {
  const current = await findPartFolder(oldPartDir)
  const newRelDir = partTargetRelDir(productSkus, newPartDir)
  if (!current) return { relDir: newRelDir, files: [] }
  const target = resolve(UPLOAD_DIR, newRelDir)
  if (current !== target) {
    await mkdir(dirname(target), { recursive: true })
    await rename(current, target)
  }
  const files = await readdir(target).catch(() => [])
  return { relDir: newRelDir, files }
}

/** 删除零件文件夹（删除零件时调用，尽力而为） */
export async function removePartFolder(partDir: string): Promise<void> {
  const current = await findPartFolder(partDir)
  if (current) await rm(current, { recursive: true, force: true }).catch(() => {})
}

/** 旧版兜底文件（根目录 uuid 命名）归位到零件文件夹；返回新 URL，不匹配/不存在返回 null */
export async function placeRootFileIntoPartFolder(
  url: string | null | undefined,
  relDir: string,
  kind: 'image' | 'drawing',
): Promise<string | null> {
  if (!url) return null
  // 仅处理 uploads 根目录下的旧版兜底文件（无子目录、带扩展名）
  const m = url.match(/^\/uploads\/([^/]+)$/)
  const name = m?.[1] ?? ''
  if (!name || !name.includes('.')) return null
  const ext = '.' + (url.split('.').pop() ?? '')
  const src = resolve(UPLOAD_DIR, name)
  if (!(await stat(src).then(() => true).catch(() => false))) return null
  const fileName = partFileName(kind, ext)
  await mkdir(resolve(UPLOAD_DIR, relDir), { recursive: true })
  await rename(src, resolve(UPLOAD_DIR, relDir, fileName))
  return urlFor(relDir, fileName)
}

/** 成品 SKU 改名后移动成品目录（含其中零件文件夹） */
export async function moveProductFolder(oldSku: string, newSku: string): Promise<{ moved: boolean }> {
  const oldDir = resolve(UPLOAD_DIR, slugify(oldSku))
  if (!(await stat(oldDir).then(() => true).catch(() => false))) return { moved: false }
  const newDir = resolve(UPLOAD_DIR, slugify(newSku))
  if (oldDir === newDir) return { moved: false }
  await mkdir(dirname(newDir), { recursive: true })
  await rename(oldDir, newDir)
  return { moved: true }
}
