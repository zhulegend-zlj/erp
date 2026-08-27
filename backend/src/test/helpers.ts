import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { buildApp } from '../server'

export type TestRole = 'boss' | 'purchase' | 'warehouse' | 'sales' | 'finance' | 'engineer'

export function createTestApp(): FastifyInstance {
  return buildApp()
}

/**
 * 走正式出货路径：建排程 → 仓库备好 → 从排程出货（无排程手工出货已停用）。
 * 返回 POST /api/shipments 的响应（失败时返回对应 4xx 响应，供用例断言）。
 */
export async function shipViaSchedule(
  app: FastifyInstance,
  cookie: string,
  orderId: number,
  productId: number,
  qty: number,
  opts: { hubName?: string } = {},
) {
  const hub = await prisma.shipToHub.create({
    data: { name: opts.hubName ?? 'TEST-HUB-' + orderId + '-' + Math.random().toString(36).slice(2, 8) },
  })
  const sched = await app.inject({
    method: 'POST',
    url: '/api/schedules',
    headers: { cookie },
    payload: {
      salesOrderId: orderId,
      productId,
      qty,
      hubId: hub.id,
      needByDate: '2026-09-30',
      promisedDate: '2026-09-30',
    },
  })
  if (sched.statusCode !== 200) return sched
  const schedId = sched.json().id as number
  const wh = await loginCookie(app, 'warehouse')
  const pick = await app.inject({
    method: 'PATCH',
    url: '/api/schedules/' + schedId,
    headers: { cookie: wh },
    payload: { status: 'picked' },
  })
  if (pick.statusCode !== 200) return pick
  return app.inject({
    method: 'POST',
    url: '/api/shipments',
    headers: { cookie },
    payload: { hubId: hub.id, schedules: [{ id: schedId, qty }] },
  })
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
  await prisma.shipmentSchedule.deleteMany()
  await prisma.shipToHub.deleteMany()
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
