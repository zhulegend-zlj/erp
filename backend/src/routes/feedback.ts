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

// 与当前 ERP 页面一一对应（前端下拉同表）
export const FEEDBACK_MODULES = [
  '首页',
  '看板',
  '订单',
  '采购',
  '库存',
  '出货排程',
  '出货',
  '财务',
  '基础资料',
  '账号登录',
  '其他',
] as const

// 各角色只能给自己有权限的模块提反馈（与左侧菜单权限一致）
export const ROLE_FEEDBACK_MODULES: Record<string, readonly string[]> = {
  boss: FEEDBACK_MODULES,
  sales: ['首页', '订单', '出货排程', '出货', '基础资料', '账号登录', '其他'],
  purchase: ['首页', '采购', '基础资料', '账号登录', '其他'],
  warehouse: ['首页', '库存', '出货排程', '账号登录', '其他'],
  engineer: ['首页', '基础资料', '账号登录', '其他'],
  finance: ['首页', '财务', '账号登录', '其他'],
}

const feedbackSchema = z.object({
  content: z.string({ error: '反馈内容必填' }).trim().min(1, '反馈内容必填').max(2000, '反馈内容过长（最多 2000 字）'),
  module: z.enum(FEEDBACK_MODULES).optional(),
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

      // 角色-模块校验：只能给自己有权限的模块提反馈（与左侧菜单一致）
      const role = (req as { user?: { role?: string } }).user?.role ?? ''
      const allowed = ROLE_FEEDBACK_MODULES[role] ?? ['其他']
      if (!allowed.includes(data.module)) {
        return reply.code(400).send({ error: '该模块不属于你账号的权限范围，请选择你角色对应的模块' })
      }

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
