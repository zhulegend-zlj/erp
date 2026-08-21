import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { signToken } from '../auth/token'
import { requireRole } from '../auth/guard'

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body as any
    const uname = typeof username === 'string' ? username.trim() : ''
    const user = await prisma.user.findUnique({ where: { username: uname } })
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: '用户名或密码错误' })
    }
    const token = signToken({ id: user.id, role: user.role })
    reply.setCookie('token', token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge: 60 * 60 * 12 })
    return { id: user.id, username: user.username, name: user.name, role: user.role }
  })
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie('token', { path: '/' })
    return { ok: true }
  })
  app.get('/api/auth/me', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance') }, async (req) => {
    const { userId } = (req as any).user
    const user = await prisma.user.findUnique({ where: { id: userId } })
    return { id: user!.id, username: user!.username, name: user!.name, role: user!.role }
  })

  // 修改本人密码：所有已登录角色可操作
  app.post('/api/auth/change-password', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance') }, async (req, reply) => {
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
