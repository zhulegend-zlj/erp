// 清空全部业务数据（保留用户账号），用于工程开始精准录入前重置开发库。
// 用法：cd backend && npx tsx --env-file=.env prisma/clear-all-data.ts
// 注意：只对当前 DATABASE_URL 生效，执行前已手动备份（pg_dump）。
import { PrismaClient } from '@prisma/client'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const prisma = new PrismaClient()

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  console.log('当前数据库：', url.replace(/:[^:@]+@/, ':****@'))
  const ok = await prisma.$transaction([
    prisma.shipmentLeg.deleteMany(),
    prisma.shipment.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.supplierPayment.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.issue.deleteMany(),
    prisma.productionEntry.deleteMany(),
    prisma.returnReplenish.deleteMany(),
    prisma.purchaseOrderItem.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.salesOrderItem.deleteMany(),
    prisma.salesOrder.deleteMany(),
    prisma.inventoryLedger.deleteMany(),
    prisma.stock.deleteMany(),
    prisma.bom.deleteMany(),
    prisma.part.deleteMany(),
    prisma.product.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.supplier.deleteMany(),
  ])
  console.log('业务数据已清空（保留用户账号）')

  // 清空上传文件目录（工程将重新上传精准图片/图档）
  const uploadDir = resolve(process.cwd(), 'uploads')
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {})
  const { mkdir } = await import('node:fs/promises')
  await mkdir(uploadDir, { recursive: true })
  console.log('uploads 目录已清空并重建：', uploadDir)

  const users = await prisma.user.findMany({ select: { username: true, role: true } })
  console.log('保留账号：', users.map((u) => u.username + '(' + u.role + ')').join('、'))
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
