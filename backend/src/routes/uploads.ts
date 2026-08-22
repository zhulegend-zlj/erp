import type { FastifyInstance } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { requireRole } from '../auth/guard'
import { prisma } from '../db'
import { partDirName, placePartFile, placeProductImage, UPLOAD_DIR } from '../uploads-store'

async function productSkusForPart(partId: number): Promise<string[]> {
  const boms = await prisma.bom.findMany({
    where: { partId },
    include: { product: { select: { sku: true } } },
  })
  return boms.map((b) => b.product.sku)
}

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
    // 用 req.parts() 顺序解析：同时拿到文本字段（partSku/partName/kind 等）与文件
    const fields: Record<string, string> = {}
    let tmpName: string | null = null
    let originalName = ''
    for await (const raw of req.parts()) {
      const part = raw as { type: string; fieldname?: string; value?: unknown; filename?: string; mimetype?: string; file?: NodeJS.ReadableStream }
      if (part.type === 'file') {
        if (tmpName === null) {
          const filename = part.filename ?? ''
          const mimetype = part.mimetype ?? ''
          const extMatch = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
          const extName = extMatch?.[1] ?? ''
          const isImage = IMAGE_EXTS.has(extName)
          if (isImage) {
            // 图片按 MIME 白名单校验（防止伪造扩展名）
            if (!IMAGE_EXT_BY_MIME[mimetype]) {
              return reply.code(400).send({ error: '仅支持 jpg/png/webp/gif/svg 图片' })
            }
          } else if (!DRAWING_EXTS.has(extName)) {
            return reply.code(400).send({ error: '仅支持 pdf/dwg/dxf/step/stp/igs/zip/xlsx 图档或 jpg/png/webp/gif/svg 图片' })
          }
          const ext = extName === 'jpeg' ? '.jpg' : '.' + extName
          tmpName = randomUUID() + ext
          originalName = filename || tmpName
          await mkdir(UPLOAD_DIR, { recursive: true })
          await pipeline(part.file!, createWriteStream(resolve(UPLOAD_DIR, tmpName)))
        } else {
          part.file?.resume()
        }
      } else if (part.fieldname !== undefined) {
        fields[part.fieldname] = String(part.value ?? '')
      }
    }
    if (!tmpName) return reply.code(400).send({ error: '未收到文件' })
    const ext = '.' + (tmpName.split('.').pop() ?? '')

    // 目录组织：按上传上下文把文件归位到 成品/零件 目录；无上下文则保持 uuid 命名（兼容旧调用）
    const kind = fields.kind
    try {
      if (kind === 'product-image' && fields.productSku) {
        const url = await placeProductImage(tmpName, fields.productSku, ext)
        return { url, name: originalName }
      }
      if ((kind === 'image' || kind === 'drawing') && fields.partSku && fields.partName) {
        const part = await prisma.part.findUnique({ where: { sku: fields.partSku } })
        const productSkus = part ? await productSkusForPart(part.id) : []
        const url = await placePartFile(tmpName, productSkus, partDirName(fields.partSku, fields.partName), kind, ext)
        return { url, name: originalName }
      }
    } catch (err) {
      // 归位失败不影响已保存的临时文件，回退为 uuid 路径
      req.log.error({ err }, '上传文件归位失败，回退 uuid 路径')
    }
    return { url: '/uploads/' + tmpName, name: originalName }
  })
}
