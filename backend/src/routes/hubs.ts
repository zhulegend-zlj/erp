import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { parsePositiveInt } from '../errors'

// 到货仓（Ship-To Hub）字典：所有角色可读；销售/老板可维护（手填新仓后保存即进字典）
const hubSchema = z.object({
  name: z.string({ error: '到货仓必填' }).min(1, '到货仓必填').max(60, '到货仓名称过长'),
})

export function hubRoutes(app: FastifyInstance) {
  const read = requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer')
  const write = requireRole('sales', 'boss')

  app.get('/api/hubs', { preHandler: read }, async () => {
    return prisma.shipToHub.findMany({ orderBy: { id: 'asc' } })
  })

  app.post('/api/hubs', { preHandler: write }, async (req, reply) => {
    const result = hubSchema.safeParse(req.body)
    if (!result.success) return reply.code(400).send({ error: result.error.issues.map((i) => i.message).join('；') })
    const existing = await prisma.shipToHub.findUnique({ where: { name: result.data.name } })
    if (existing) return reply.code(200).send(existing) // 幂等：同名返回已有
    const hub = await prisma.shipToHub.create({ data: { name: result.data.name } })
    return reply.code(200).send(hub)
  })

  app.put('/api/hubs/:id', { preHandler: write }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '到货仓 ID 必须为正整数' })
    const result = hubSchema.safeParse(req.body)
    if (!result.success) return reply.code(400).send({ error: result.error.issues.map((i) => i.message).join('；') })
    const hub = await prisma.shipToHub.findUnique({ where: { id } })
    if (!hub) return reply.code(404).send({ error: '到货仓不存在' })
    const updated = await prisma.shipToHub.update({ where: { id }, data: { name: result.data.name } })
    return reply.code(200).send(updated)
  })

  app.delete('/api/hubs/:id', { preHandler: write }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '到货仓 ID 必须为正整数' })
    const hub = await prisma.shipToHub.findUnique({ where: { id } })
    if (!hub) return reply.code(404).send({ error: '到货仓不存在' })
    const used = await prisma.shipmentSchedule.count({ where: { hubId: id } })
    if (used > 0) return reply.code(400).send({ error: '该到货仓已有排程使用，不能删除' })
    await prisma.shipToHub.delete({ where: { id } })
    return reply.code(200).send({ ok: true })
  })
}
