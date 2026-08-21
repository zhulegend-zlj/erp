import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

// 创建/更新 6 个角色初始账号（初始密码统一 88888888，上线后请修改）
// 用法：cd backend && npx tsx --env-file=.env prisma/seed.ts

const prisma = new PrismaClient()

const users = [
  { username: '老板', name: '老板', role: 'boss' },
  { username: '采购', name: '采购', role: 'purchase' },
  { username: '仓库', name: '仓库', role: 'warehouse' },
  { username: '销售', name: '销售', role: 'sales' },
  { username: '财务', name: '财务', role: 'finance' },
  { username: '工程', name: '工程', role: 'engineer' },
] as const

async function main() {
  for (const u of users) {
    const passwordHash = await bcrypt.hash('88888888', 10)
    await prisma.user.upsert({
      where: { username: u.username },
      update: { name: u.name, role: u.role, passwordHash },
      create: { username: u.username, name: u.name, role: u.role, passwordHash },
    })
    console.log(`已创建/更新用户 ${u.username}（初始密码 88888888）`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
