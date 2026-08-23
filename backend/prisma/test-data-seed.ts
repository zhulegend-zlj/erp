// 生成手动测试数据：3 个成品 A/B/C，每个 10-30 个零件（A01/A02...），20 个供应商（甲乙丙丁...），随机价格与用量
// 用法：cd backend && npx tsx --env-file=.env prisma/test-data-seed.ts
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const TIAN_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉']

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function randPrice(): number {
  return Math.round((0.5 + Math.random() * 299.5) * 100) / 100
}

async function main() {
  // 1. 供应商：20 个（天干 + 地支）
  const suppliers: { id: number; name: string }[] = []
  for (const n of [...TIAN_GAN, ...DI_ZHI]) {
    const s = await prisma.supplier.create({ data: { name: n + '供应商' } })
    suppliers.push({ id: s.id, name: s.name })
  }
  console.log('供应商 ' + suppliers.length + ' 个：' + suppliers.map((s) => s.name).join('、'))

  // 2. 成品 A/B/C + 各自零件 + BOM
  let totalParts = 0
  let totalBoms = 0
  for (const p of ['A', 'B', 'C']) {
    const product = await prisma.product.create({ data: { sku: p, name: '成品' + p, unit: '件' } })
    const partCount = rand(10, 30)
    for (let i = 1; i <= partCount; i++) {
      const sku = p + String(i).padStart(2, '0') // A01、A02...
      const supplier = suppliers[rand(0, suppliers.length - 1)]!
      const price = randPrice()
      const part = await prisma.part.create({
        data: { sku, name: sku, unit: '个', price, supplierId: supplier.id },
      })
      const qty = rand(1, 10)
      await prisma.bom.create({ data: { productId: product.id, partId: part.id, qty } })
      totalParts++
      totalBoms++
    }
    console.log('成品 ' + p + '（SKU=' + p + '）：' + partCount + ' 个零件')
  }

  const [pc, ptc, bc, sc] = await Promise.all([
    prisma.product.count(),
    prisma.part.count(),
    prisma.bom.count(),
    prisma.supplier.count(),
  ])
  console.log('完成：成品 ' + pc + '、零件 ' + ptc + '、BOM ' + bc + '、供应商 ' + sc)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
