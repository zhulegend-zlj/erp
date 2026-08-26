import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { buildApp } from '../server'

export type TestRole = 'boss' | 'purchase' | 'warehouse' | 'sales' | 'finance' | 'engineer'

export function createTestApp(): FastifyInstance {
  return buildApp()
}

/**
 * 按外键依赖顺序清空所有业务表，保证集成测试在共享 PostgreSQL 上互相隔离。
 * 注意：user 表不动，loginCookie 依赖对测试账号的 upsert。
 */
export async function resetDb(): Promise<void> {
  // 防呆：仅允许在独立测试库上清库，防止误连开发库 erp 清空真实数据
  const url = process.env.DATABASE_URL ?? ''
  if (!url.includes('erp_test')) {
    throw new Error('resetDb 仅允许在 erp_test 数据库上运行，当前 DATABASE_URL=' + url)
  }
  await prisma.shipmentLeg.deleteMany()
  await prisma.shipment.deleteMany()
  await prisma.customerPayment.deleteMany()
  await prisma.supplierPayment.deleteMany()
  await prisma.companyProfile.deleteMany()
  await prisma.receipt.deleteMany()
  await prisma.issue.deleteMany()
  await prisma.productionEntry.deleteMany()
  await prisma.purchaseOrderItem.deleteMany()
  await prisma.purchaseOrder.deleteMany()
  await prisma.salesOrderItem.deleteMany()
  await prisma.salesOrder.deleteMany()
  await prisma.bom.deleteMany()
  await prisma.stock.deleteMany()
  await prisma.inventoryLedger.deleteMany()
  await prisma.returnReplenish.deleteMany()
  await prisma.part.deleteMany()
  await prisma.product.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.supplier.deleteMany()
}

/**
 * 为 5 个角色之一 upsert 测试用户（username = role，密码统一 88888888），
 * 登录后返回可直接用于后续请求的 cookie 字符串（如 "token=..."）。
 */
export async function loginCookie(app: FastifyInstance, role: TestRole): Promise<string> {
  const passwordHash = await bcrypt.hash('88888888', 10)
  await prisma.user.upsert({
    where: { username: role },
    update: { passwordHash, name: role, role },
    create: { username: role, passwordHash, name: role, role },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: role, password: '88888888' },
  })
  if (res.statusCode !== 200) {
    throw new Error(`登录失败（${role}）: ${res.statusCode} ${res.body}`)
  }

  const setCookie = res.headers['set-cookie']
  const rawCookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : [])
  const tokenCookie = rawCookies.find((c) => c.includes('token='))
  if (!tokenCookie) {
    throw new Error(`登录响应缺少 token cookie（${role}）`)
  }
  // 去掉 "; Path=/; HttpOnly; ..." 等尾随属性，只保留 "token=..."
  return tokenCookie.split(';')[0]!
}
