import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

// 创建/更新 5 个角色初始账号（初始密码统一 secret123，上线后请修改）
// 用法：cd backend && npx tsx --env-file=.env prisma/seed.ts

const prisma = new PrismaClient()

const users = [
  { username: 'boss', name: '老板', role: 'boss' },
  { username: 'purchase', name: '采购', role: 'purchase' },
  { username: 'warehouse', name: '仓库', role: 'warehouse' },
  { username: 'sales', name: '销售', role: 'sales' },
  { username: 'finance', name: '财务', role: 'finance' },
] as const

async function main() {
  for (const u of users) {
    const passwordHash = await bcrypt.hash('secret123', 10)
    await prisma.user.upsert({
      where: { username: u.username },
      update: { name: u.name, role: u.role, passwordHash },
      create: { username: u.username, name: u.name, role: u.role, passwordHash },
    })
    console.log(`已创建/更新用户 ${u.username}（初始密码 secret123）`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
