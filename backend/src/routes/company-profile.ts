import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'

// 公司抬头/银行/VAT 等出单资料：所有登录角色可读（销售出单需要），仅老板可改。
const profileSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  contact: z.string().optional(),
  email: z.string().optional(),
  vatNo: z.string().optional(),
  taxRate: z.string().optional(),
  bankName: z.string().optional(),
  bankPhone: z.string().optional(),
  bankAddress: z.string().optional(),
  swift: z.string().optional(),
  accountName: z.string().optional(),
  accountNo: z.string().optional(),
})

function parseBody(schema: z.ZodTypeAny, body: unknown, reply: FastifyReply): Record<string, string> | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    reply.code(400).send({ error: result.error.issues.map((i) => i.message).join('；') })
    return null
  }
  return result.data as Record<string, string>
}

async function getOrCreateProfile() {
  const existing = await prisma.companyProfile.findFirst()
  if (existing) return existing
  return prisma.companyProfile.create({ data: {} })
}

export function companyProfileRoutes(app: FastifyInstance) {
  app.get('/api/company-profile', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer') }, async () => {
    return getOrCreateProfile()
  })

  app.put('/api/company-profile', { preHandler: requireRole('boss') }, async (req, reply) => {
    const data = parseBody(profileSchema, req.body, reply)
    if (data === null) return
    const profile = await getOrCreateProfile()
    const updated = await prisma.companyProfile.update({ where: { id: profile.id }, data })
    return reply.code(200).send(updated)
  })
}
