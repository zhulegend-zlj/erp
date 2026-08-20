import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db'
import { signToken } from '../auth/token'
import { requireRole } from '../auth/guard'

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body as any
    const user = await prisma.user.findUnique({ where: { username } })
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
}
