import type { FastifyInstance } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { requireRole } from '../auth/guard'

const UPLOAD_DIR = resolve(process.cwd(), 'uploads')

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

// 图档/图纸格式：CAD 与压缩包等文件浏览器常以 octet-stream 上报，故按扩展名校验
const DRAWING_EXTS = new Set(['pdf', 'dwg', 'dxf', 'step', 'stp', 'igs', 'zip', 'xlsx'])
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'])

export function uploadRoutes(app: FastifyInstance) {
  app.post('/api/uploads', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'engineer') }, async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '未收到文件' })

    const extMatch = (file.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)
    const extName = extMatch?.[1] ?? ''
    const isImage = IMAGE_EXTS.has(extName)
    if (isImage) {
      // 图片按 MIME 白名单校验（防止伪造扩展名）
      if (!IMAGE_EXT_BY_MIME[file.mimetype ?? '']) {
        return reply.code(400).send({ error: '仅支持 jpg/png/webp/gif/svg 图片' })
      }
    } else if (!DRAWING_EXTS.has(extName)) {
      return reply.code(400).send({ error: '仅支持 pdf/dwg/dxf/step/stp/igs/zip/xlsx 图档或 jpg/png/webp/gif/svg 图片' })
    }
    const ext = extName === 'jpeg' ? '.jpg' : '.' + extName

    const filename = randomUUID() + ext
    await mkdir(UPLOAD_DIR, { recursive: true })
    const filePath = resolve(UPLOAD_DIR, filename)
    await pipeline(file.file, createWriteStream(filePath))

    return { url: '/uploads/' + filename, name: file.filename || filename }
  })
}
