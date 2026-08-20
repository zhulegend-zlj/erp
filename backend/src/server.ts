import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRoutes } from './routes/auth'
import { mastersRoutes } from './routes/masters'
import { ordersRoutes } from './routes/orders'
import { purchasingRoutes } from './routes/purchasing'
import { inventoryRoutes } from './routes/inventory'
import { shippingRoutes } from './routes/shipping'

export function buildApp() {
  const app = Fastify({ logger: true })
  app.register(cookie)
  app.get('/api/health', async () => ({ status: 'ok' }))
  authRoutes(app)
  mastersRoutes(app)
  ordersRoutes(app)
  purchasingRoutes(app)
  inventoryRoutes(app)
  shippingRoutes(app)
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