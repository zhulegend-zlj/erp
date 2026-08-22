import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRoutes } from './routes/auth'
import { mastersRoutes } from './routes/masters'
import { ordersRoutes } from './routes/orders'
import { purchasingRoutes } from './routes/purchasing'
import { inventoryRoutes } from './routes/inventory'
import { shippingRoutes } from './routes/shipping'
import { financeRoutes } from './routes/finance'
import { dashboardRoutes } from './routes/dashboard'
import { feedbackRoutes } from './routes/feedback'
import { uploadRoutes } from './routes/uploads'
import { returnReplenishRoutes } from './routes/returnReplenish'
import { requireRole } from './auth/guard'
import { prismaErrorInfo } from './errors'
import { UPLOAD_DIR } from './uploads-store'

export function buildApp() {
  const app = Fastify({ logger: true })
  app.setErrorHandler((error, request, reply) => {
    const info = prismaErrorInfo(error)
    if (info) {
      return reply.code(info.status).send({ error: info.message })
    }
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: '文件超过 20MB 限制' })
    }
    // 未映射错误只记录日志，不向客户端回显内部细节（路径/SQL/连接串等）
    request.log.error({ err: error }, '未处理错误')
    return reply.code(500).send({ error: '服务器错误，请稍后重试' })
  })
  app.register(cookie)
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

  mkdirSync(UPLOAD_DIR, { recursive: true })
  // 上传文件仅对已登录用户开放（图纸/报价单等内部资料），并强制 nosniff 防 MIME 嗅探
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireRole('boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer'))
    scoped.register(fastifyStatic, {
      root: UPLOAD_DIR,
      prefix: '/uploads/',
      setHeaders(reply) {
        reply.header('X-Content-Type-Options', 'nosniff')
      },
    })
  })

  app.get('/api/health', async () => ({ status: 'ok' }))
  uploadRoutes(app)
  returnReplenishRoutes(app)
  authRoutes(app)
  mastersRoutes(app)
  ordersRoutes(app)
  purchasingRoutes(app)
  inventoryRoutes(app)
  shippingRoutes(app)
  financeRoutes(app)
  dashboardRoutes(app)
  feedbackRoutes(app)
  return app
}

async function main() {
  const { config } = await import('./config')
  const app = buildApp()
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()

if (isMain) {
  void main()
}