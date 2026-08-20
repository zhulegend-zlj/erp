import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { buildApp } from '../server'

export type TestRole = 'boss' | 'purchase' | 'warehouse' | 'sales' | 'finance'

export function createTestApp(): FastifyInstance {
  return buildApp()
}

/**
 * 为 5 个角色之一 upsert 测试用户（username = role，密码统一 secret123），
 * 登录后返回可直接用于后续请求的 cookie 字符串（如 "token=..."）。
 */
export async function loginCookie(app: FastifyInstance, role: TestRole): Promise<string> {
  const passwordHash = await bcrypt.hash('secret123', 10)
  await prisma.user.upsert({
    where: { username: role },
    update: { passwordHash, name: role, role },
    create: { username: role, passwordHash, name: role, role },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: role, password: 'secret123' },
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
