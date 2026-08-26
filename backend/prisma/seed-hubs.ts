// 到货仓预置 6 个（来自客户 OPO 表）。幂等：按名称 upsert。
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const HUBS = ['VPC-MEL.', 'VPC-TYO.', 'VUC-DFW.', 'VEC-ALU.', 'VAM-TOR.', 'QWC-QWC']

async function main() {
  for (const name of HUBS) {
    const existing = await prisma.shipToHub.findUnique({ where: { name } })
    if (!existing) {
      const hub = await prisma.shipToHub.create({ data: { name } })
      console.log('已建到货仓：', hub.name)
    } else {
      console.log('已存在：', name)
    }
  }
  const all = await prisma.shipToHub.findMany({ orderBy: { id: 'asc' } })
  console.log('当前到货仓：', all.map((h) => h.name).join(' / '))
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
