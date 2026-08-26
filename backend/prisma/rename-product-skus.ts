// 成品 SKU 改为客户料号：CSP_V3→CSP_V3、CSP_V3I→CSP_V3I、CSS_SQ→CSS_SQ（零件不动）
// 同步修正 成品图片/零件图片图档 URL 前缀。幂等：已是新料号则跳过。
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RENAMES: Array<[string, string]> = [
  ['CSP_V3', 'CSP_V3'],
  ['CSP_V3I', 'CSP_V3I'],
  ['CSS_SQ', 'CSS_SQ'],
]

async function main() {
  for (const [from, to] of RENAMES) {
    const product = await prisma.product.findUnique({ where: { sku: from } })
    if (!product) {
      // 旧 SKU 不存在：可能已改过（幂等），查新 SKU 是否在
      const already = await prisma.product.findUnique({ where: { sku: to } })
      console.log(from, '→', to, ':', already ? '（已是新料号，跳过）' : '（旧料号不存在，跳过）')
      continue
    }
    await prisma.product.update({ where: { id: product.id }, data: { sku: to } })
    console.log('已改名：', from, '→', to, '（成品 id', product.id, '）')
  }
  // URL 前缀修正：/uploads/<旧SKU>/ → /uploads/<新SKU>/（文件夹本身已是下划线命名，仅老数据可能带连字符前缀）
  for (const [from, to] of RENAMES) {
    const oldPrefix = '/uploads/' + from + '/'
    const newPrefix = '/uploads/' + to + '/'
    const products = await prisma.product.findMany({ where: { imageUrl: { startsWith: oldPrefix } }, select: { id: true, imageUrl: true } })
    for (const p of products) {
      await prisma.product.update({ where: { id: p.id }, data: { imageUrl: p.imageUrl!.replace(oldPrefix, newPrefix) } })
      console.log('成品图片前缀修正：', p.id)
    }
    const parts = await prisma.part.findMany({ where: { OR: [{ imageUrl: { startsWith: oldPrefix } }, { drawingsUrl: { startsWith: oldPrefix } }] }, select: { id: true, imageUrl: true, drawingsUrl: true } })
    for (const p of parts) {
      await prisma.part.update({
        where: { id: p.id },
        data: {
          ...(p.imageUrl?.startsWith(oldPrefix) ? { imageUrl: p.imageUrl.replace(oldPrefix, newPrefix) } : {}),
          ...(p.drawingsUrl?.startsWith(oldPrefix) ? { drawingsUrl: p.drawingsUrl.replace(oldPrefix, newPrefix) } : {}),
        },
      })
    }
    if (parts.length) console.log('零件图片/图档前缀修正：', parts.length, '条（', from, '）')
  }
  const all = await prisma.product.findMany({ select: { sku: true, name: true } })
  console.log('\n当前成品：')
  for (const p of all) console.log(' ', p.sku, '|', p.name)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
