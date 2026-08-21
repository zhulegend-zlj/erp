import type { FastifyInstance } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { requireRole } from '../auth/guard'

const UPLOAD_DIR = resolve(process.cwd(), 'uploads')

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

export function uploadRoutes(app: FastifyInstance) {
  app.post('/api/uploads', { preHandler: requireRole('boss', 'purchase', 'warehouse') }, async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '未收到文件' })

    const ext = EXT_BY_MIME[file.mimetype]
    if (!ext) return reply.code(400).send({ error: '仅支持 jpg/png/webp/gif/svg 图片' })

    const filename = randomUUID() + ext
    await mkdir(UPLOAD_DIR, { recursive: true })
    const filePath = resolve(UPLOAD_DIR, filename)
    await pipeline(file.file, createWriteStream(filePath))

    return { url: '/uploads/' + filename }
  })
}
