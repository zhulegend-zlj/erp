import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyToken } from './token'
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers.cookie
    const cookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '')
    const m = cookie.match(/(?:^|;\s*)token=([^;]+)/)
    if (!m) return reply.code(401).send({ error: '未登录' })
    const token = m[1]
    if (!token) return reply.code(401).send({ error: '未登录' })
    const payload = verifyToken(token)
    if (!payload) return reply.code(401).send({ error: '登录已过期' })
    if (!roles.includes(payload.role)) return reply.code(403).send({ error: '无权限' })
    ;(req as any).user = payload
  }
}
