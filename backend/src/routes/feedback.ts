import { appendFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth/guard'

// 项目根 FEEDBACK.md：backend/src/routes -> backend -> 项目根
// 测试环境可通过 FEEDBACK_PATH 环境变量隔离到临时文件（见 src/test/setup-env.ts）
export const FEEDBACK_PATH = process.env.FEEDBACK_PATH
  ? resolve(process.env.FEEDBACK_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../../FEEDBACK.md')

const feedbackSchema = z.object({
  content: z.string({ error: '反馈内容必填' }).trim().min(1, '反馈内容必填'),
  module: z.string().optional(),
  priority: z.string().optional(),
})

function localDateStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseFeedback(body: unknown, reply: FastifyReply) {
  const result = feedbackSchema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return {
    content: result.data.content,
    module: result.data.module?.trim() || '其他',
    priority: result.data.priority?.trim() || '中',
  }
}

export function feedbackRoutes(app: FastifyInstance) {
  app.post(
    '/api/feedback',
    { preHandler: requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer') },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const data = parseFeedback(req.body, reply)
      if (!data) return

      // 追加格式：块前一个空行分隔，块后跟一个空行
      const entry = `\n### [待处理]\n- 日期：${localDateStamp()}\n- 模块：${data.module}\n- 反馈：${data.content}\n- 优先级：${data.priority}\n\n`

      try {
        await appendFile(FEEDBACK_PATH, entry, 'utf8')
      } catch (err) {
        req.log.error({ err }, '写入 FEEDBACK.md 失败')
        return reply.code(500).send({ error: '反馈写入失败，请稍后重试' })
      }
      return reply.code(200).send({ ok: true })
    },
  )
}
