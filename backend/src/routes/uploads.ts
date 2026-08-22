import type { FastifyInstance } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
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

// 图片仅允许位图/照片格式；不支持 SVG（同源静态托管下 SVG 可执行脚本，存在存储型 XSS 风险）
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

// 图档/图纸格式：CAD 与压缩包等文件浏览器常以 octet-stream 上报，故按扩展名校验
const DRAWING_EXTS = new Set(['pdf', 'dwg', 'dxf', 'step', 'stp', 'igs', 'zip', 'xlsx'])
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

// 图片魔数校验：MIME/扩展名由客户端上报，可伪造；按文件头真实内容再校验一次
async function validateImageMagic(filePath: string, ext: string): Promise<boolean> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(12)
    const { bytesRead } = await fh.read(buf, 0, 12, 0)
    const head = buf.subarray(0, bytesRead)
    if (ext === '.png') {
      return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    }
    if (ext === '.jpg') {
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    }
    if (ext === '.gif') {
      return head.length >= 4 && head.toString('latin1', 0, 4) === 'GIF8'
    }
    if (ext === '.webp') {
      return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
    }
    return true
  } finally {
    await fh.close()
  }
}

export function uploadRoutes(app: FastifyInstance) {
  app.post('/api/uploads', { preHandler: requireRole('boss', 'purchase', 'warehouse', 'engineer') }, async (req, reply) => {
    // 用 req.parts() 顺序解析：同时拿到文本字段（partSku/partName/kind 等）与文件
    const fields: Record<string, string> = {}
    let tmpName: string | null = null
    let originalName = ''
    try {
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
                return reply.code(400).send({ error: '仅支持 jpg/png/webp/gif 图片' })
              }
            } else if (!DRAWING_EXTS.has(extName)) {
              return reply.code(400).send({ error: '仅支持 pdf/dwg/dxf/step/stp/igs/zip/xlsx 图档或 jpg/png/webp/gif 图片' })
            }
            const ext = extName === 'jpeg' ? '.jpg' : '.' + extName
            tmpName = randomUUID() + ext
            originalName = filename || tmpName
            await mkdir(UPLOAD_DIR, { recursive: true })
            await pipeline(part.file!, createWriteStream(resolve(UPLOAD_DIR, tmpName)))
            // 图片内容魔数校验：内容与扩展名不符则拒绝并删除临时文件
            if (isImage && !(await validateImageMagic(resolve(UPLOAD_DIR, tmpName), ext))) {
              await rm(resolve(UPLOAD_DIR, tmpName), { force: true }).catch(() => {})
              return reply.code(400).send({ error: '图片内容与扩展名不符，请重新上传' })
            }
          } else {
            part.file?.resume()
          }
        } else if (part.fieldname !== undefined) {
          fields[part.fieldname] = String(part.value ?? '')
        }
      }
    } catch (err) {
      // 失败清理临时文件；超限错误映射为 413
      if (tmpName) await rm(resolve(UPLOAD_DIR, tmpName), { force: true }).catch(() => {})
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: '文件超过 20MB 限制' })
      }
      throw err
    }
    if (!tmpName) return reply.code(400).send({ error: '未收到文件' })
    const ext = '.' + (tmpName.split('.').pop() ?? '')

    // kind 枚举校验：避免未知 kind 落入 uuid 兜底路径堆积根目录文件
    const kind = fields.kind
    if (kind && kind !== 'product-image' && kind !== 'image' && kind !== 'drawing') {
      await rm(resolve(UPLOAD_DIR, tmpName), { force: true }).catch(() => {})
      return reply.code(400).send({ error: 'kind 不合法' })
    }

    // 目录组织：按上传上下文把文件归位到 成品/零件 目录；无上下文则保持 uuid 命名（兼容旧调用）
    try {
      if (kind === 'product-image' && fields.productSku) {
        const url = await placeProductImage(tmpName, fields.productSku, fields.productName ?? '', ext)
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
