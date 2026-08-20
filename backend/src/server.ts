import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRoutes } from './routes/auth'

export function buildApp() {
  const app = Fastify({ logger: true })
  app.register(cookie)
  app.get('/api/health', async () => ({ status: 'ok' }))
  authRoutes(app)
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
