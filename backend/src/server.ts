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
import { prismaErrorInfo } from './errors'

export function buildApp() {
  const app = Fastify({ logger: true })
  app.setErrorHandler((error, _request, reply) => {
    const info = prismaErrorInfo(error)
    if (info) {
      return reply.code(info.status).send({ error: info.message })
    }
    const message = (error as { message?: string }).message ?? '未知错误'
    return reply.code(500).send({ error: '服务器错误：' + message })
  })
  app.register(cookie)
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } })

  const uploadDir = resolve(process.cwd(), 'uploads')
  mkdirSync(uploadDir, { recursive: true })
  app.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/' })

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