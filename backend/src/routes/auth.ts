import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { signToken } from '../auth/token'
import { requireRole } from '../auth/guard'

// 简易失败限流：按 IP+用户名，连续失败 5 次锁定 5 分钟（防弱密码爆破）
const FAIL_LIMIT = 5
const LOCK_MS = 5 * 60 * 1000
const loginFails = new Map<string, { count: number; lockedUntil: number | null }>()

/** 仅测试用：清空限流计数 */
export function __resetLoginRateLimit(): void {
  loginFails.clear()
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown }
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) {
      return reply.code(401).send({ error: '用户名或密码错误' })
    }
    const key = req.ip + ':' + username
    const state = loginFails.get(key)
    if (state && state.lockedUntil !== null && state.lockedUntil > Date.now()) {
      return reply.code(429).send({ error: '尝试次数过多，请 5 分钟后再试' })
    }
    const user = await prisma.user.findUnique({ where: { username } })
    const ok = !!user && (await bcrypt.compare(password, user.passwordHash))
    if (!ok) {
      const now = Date.now()
      const current = loginFails.get(key)
      const expired = !!current && current.lockedUntil !== null && current.lockedUntil <= now
      const count = (current && !expired ? current.count : 0) + 1
      if (count >= FAIL_LIMIT) {
        loginFails.set(key, { count, lockedUntil: now + LOCK_MS })
        return reply.code(429).send({ error: '尝试次数过多，请 5 分钟后再试' })
      }
      loginFails.set(key, { count, lockedUntil: null })
      return reply.code(401).send({ error: '用户名或密码错误' })
    }
    loginFails.delete(key)
    const token = signToken({ id: user.id, role: user.role })
    reply.setCookie('token', token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge: 60 * 60 * 12 })
    return { id: user.id, username: user.username, name: user.name, role: user.role }
  })
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie('token', { path: '/' })
    return { ok: true }
  })
  app.get('/api/auth/me', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer') }, async (req, reply) => {
    const { userId } = (req as any).user
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(401).send({ error: '用户不存在或已删除' })
    return { id: user.id, username: user.username, name: user.name, role: user.role }
  })

  // 修改本人密码：所有已登录角色可操作
  app.post('/api/auth/change-password', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer') }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body as { oldPassword?: unknown; newPassword?: unknown }
    if (typeof oldPassword !== 'string' || oldPassword.length === 0) {
      return reply.code(400).send({ error: '请输入原密码' })
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return reply.code(400).send({ error: '新密码至少 6 位' })
    }

    const { userId } = (req as any).user as { userId: number }
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: '用户不存在' })
    if (!(await bcrypt.compare(oldPassword, user.passwordHash))) {
      return reply.code(400).send({ error: '原密码不正确' })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } })
    return { ok: true }
  })
}
