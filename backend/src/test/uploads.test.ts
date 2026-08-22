import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'
import { UPLOAD_DIR } from '../uploads-store'

// 上传产生的文件/目录清理清单（测试结束后删除）
const created: string[] = []

function multipart(filename: string, contentType: string, content: Buffer, fields: Record<string, string> = {}): Buffer {
  const boundary = '----erptestboundary'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'))
  }
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  ))
  parts.push(content)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

describe('uploads', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('测试上传目录与真实 uploads 隔离', () => {
    expect(UPLOAD_DIR).not.toBe(resolve(process.cwd(), 'uploads'))
  })

  afterAll(async () => {
    // 整个测试上传目录位于系统临时目录，直接整体删除即可，不会碰真实 uploads
    await rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => {})
  })

  async function upload(
    app: ReturnType<typeof buildApp>,
    cookie: string,
    filename: string,
    contentType: string,
    content: Buffer,
    fields: Record<string, string> = {},
  ) {
    const body = multipart(filename, contentType, content, fields)
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        cookie,
        'content-type': 'multipart/form-data; boundary=----erptestboundary',
      },
      payload: body,
    })
    return res
  }

  it('上传 pdf 图档成功并可通过静态服务访问', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, '图纸-A.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test', 'utf8'))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.url).toMatch(/^\/uploads\/.+\.pdf$/i)
    created.push(join(process.cwd(), body.url))

    const served = await app.inject({ method: 'GET', url: body.url, headers: { cookie } })
    expect(served.statusCode).toBe(200)
    // 未登录不可访问上传文件
    const anon = await app.inject({ method: 'GET', url: body.url })
    expect(anon.statusCode).toBe(401)
  })

  it('上传 dwg 图档（octet-stream）成功', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, '模具图.DWG', 'application/octet-stream', Buffer.from([0x41, 0x43, 0x31, 0x30, 0x31, 0x35]))
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toMatch(/^\/uploads\/.+\.dwg$/i)
    created.push(join(process.cwd(), res.json().url))
  })

  it('上传 zip/xlsx/step 图档成功', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    for (const [name, type] of [['归档.zip', 'application/zip'], ['价格表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['模型.STEP', 'application/octet-stream']] as const) {
      const res = await upload(app, cookie, name, type, Buffer.from('binary', 'utf8'))
      expect(res.statusCode).toBe(200)
      created.push(join(process.cwd(), res.json().url))
    }
  })

  it('非法扩展名返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, '病毒.exe', 'application/octet-stream', Buffer.from('MZ'))
    expect(res.statusCode).toBe(400)
  })

  it('图片上传仍可用', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await upload(app, cookie, 'photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toMatch(/^\/uploads\/.+\.png$/i)
    created.push(join(process.cwd(), res.json().url))
  })

  it('sales 无权上传（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')
    const res = await upload(app, cookie, 'x.pdf', 'application/pdf', Buffer.from('pdf'))
    expect(res.statusCode).toBe(403)
  })

  it('零件图片按 成品SKU/零件SKU-名称/图片.ext 组织（挂 1 个成品）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const prod = await prisma.product.create({ data: { sku: 'ORG-P1', name: '成品P1' } })
    const part = await prisma.part.create({ data: { sku: 'ORG-001', name: '轴' } })
    await prisma.bom.create({ data: { productId: prod.id, partId: part.id, qty: 2 } })

    const res = await upload(app, cookie, 'photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      partSku: 'ORG-001', partName: '轴', kind: 'image',
    })
    expect(res.statusCode).toBe(200)
    const url = res.json().url
    expect(url).toBe('/uploads/ORG-P1/ORG-001-轴/ORG-001-轴.png')
    created.push(join(process.cwd(), url))
  })

  it('未挂 BOM 的零件文件进 _未分类；挂多个成品进 _共用', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const part = await prisma.part.create({ data: { sku: 'ORG-002', name: '螺丝' } })

    const uncat = await upload(app, cookie, 'a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      partSku: 'ORG-002', partName: '螺丝', kind: 'image',
    })
    expect(uncat.statusCode).toBe(200)
    expect(uncat.json().url).toBe('/uploads/_未分类/ORG-002-螺丝/ORG-002-螺丝.png')
    created.push(join(process.cwd(), uncat.json().url))

    const p1 = await prisma.product.create({ data: { sku: 'ORG-P1', name: '成品P1' } })
    const p2 = await prisma.product.create({ data: { sku: 'ORG-P2', name: '成品P2' } })
    await prisma.bom.createMany({
      data: [
        { productId: p1.id, partId: part.id, qty: 1 },
        { productId: p2.id, partId: part.id, qty: 1 },
      ],
    })
    const shared = await upload(app, cookie, 'b.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      partSku: 'ORG-002', partName: '螺丝', kind: 'drawing',
    })
    expect(shared.statusCode).toBe(200)
    expect(shared.json().url).toBe('/uploads/_共用/ORG-002-螺丝/ORG-002-螺丝-图档.png')
    created.push(join(process.cwd(), shared.json().url))
  })

  it('保存 BOM 后自动把 _未分类 的零件文件归位到成品目录并更新 URL', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const part = await prisma.part.create({ data: { sku: 'ORG-003', name: '活块' } })
    const prod = await prisma.product.create({ data: { sku: 'ORG-P1', name: '成品P1' } })

    const up = await upload(app, cookie, 'a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      partSku: 'ORG-003', partName: '活块', kind: 'image',
    })
    expect(up.statusCode).toBe(200)
    expect(up.json().url).toBe('/uploads/_未分类/ORG-003-活块/ORG-003-活块.png')

    const bom = await app.inject({
      method: 'PUT', url: '/api/products/' + prod.id + '/bom', headers: { cookie },
      payload: [{ partId: part.id, qty: 4 }],
    })
    expect(bom.statusCode).toBe(200)

    const updated = await prisma.part.findUnique({ where: { id: part.id } })
    expect(updated?.imageUrl).toBe('/uploads/ORG-P1/ORG-003-活块/ORG-003-活块.png')
    created.push(join(process.cwd(), '/uploads/ORG-P1/ORG-003-活块/ORG-003-活块.png'))
    created.push(join(process.cwd(), '/uploads/_未分类/ORG-003-活块/ORG-003-活块.png'))
  })

  it('保存 BOM 时把根目录 uuid 文件也归位到零件文件夹', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const part = await prisma.part.create({
      data: { sku: 'ORG-005', name: '旧图零件', imageUrl: '/uploads/fixed-uuid-1234567890.png' },
    })
    const prod = await prisma.product.create({ data: { sku: 'ORG-P1', name: '成品P1' } })
    // 模拟旧版兜底：文件躺在 uploads 根目录（测试隔离目录）
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(UPLOAD_DIR, { recursive: true })
    const rootFile = resolve(UPLOAD_DIR, 'fixed-uuid-1234567890.png')
    await writeFile(rootFile, 'png')
    created.push(rootFile)

    const bom = await app.inject({
      method: 'PUT', url: '/api/products/' + prod.id + '/bom', headers: { cookie },
      payload: [{ partId: part.id, qty: 2 }],
    })
    expect(bom.statusCode).toBe(200)

    const updated = await prisma.part.findUnique({ where: { id: part.id } })
    expect(updated?.imageUrl).toBe('/uploads/ORG-P1/ORG-005-旧图零件/ORG-005-旧图零件.png')
    const { stat } = await import('node:fs/promises')
    const moved = await stat(resolve(UPLOAD_DIR, 'ORG-P1', 'ORG-005-旧图零件', 'ORG-005-旧图零件.png')).then(() => true).catch(() => false)
    expect(moved).toBe(true)
    created.push(resolve(UPLOAD_DIR, 'ORG-P1', 'ORG-005-旧图零件', 'ORG-005-旧图零件.png'))
  })

  it('成品图片按 成品SKU/成品SKU-成品名.ext 命名', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, 'p.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      kind: 'product-image', productSku: 'ORG-P1', productName: '成品P1',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toBe('/uploads/ORG-P1/ORG-P1-成品P1.png')
    created.push(join(process.cwd(), res.json().url))
  })

  it('删除零件时删除其文件目录；改名时移动目录并更新 URL', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const part = await prisma.part.create({ data: { sku: 'ORG-004', name: '旧名' } })
    const up = await upload(app, cookie, 'a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      partSku: 'ORG-004', partName: '旧名', kind: 'image',
    })
    expect(up.statusCode).toBe(200)
    const oldUrl = up.json().url
    created.push(join(process.cwd(), oldUrl))

    const renamed = await app.inject({
      method: 'PUT', url: '/api/parts/' + part.id, headers: { cookie },
      payload: { sku: 'ORG-004', name: '新名', unit: '个' },
    })
    expect(renamed.statusCode).toBe(200)
    const renamedPart = await prisma.part.findUnique({ where: { id: part.id } })
    expect(renamedPart?.imageUrl).toBe('/uploads/_未分类/ORG-004-新名/ORG-004-新名.png')
    created.push(join(process.cwd(), '/uploads/_未分类/ORG-004-新名/ORG-004-新名.png'))

    const del = await app.inject({ method: 'DELETE', url: '/api/parts/' + part.id, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    const { stat } = await import('node:fs/promises')
    const still = await stat(join(process.cwd(), 'uploads', '_未分类', 'ORG-004-新名')).then(() => true).catch(() => false)
    expect(still).toBe(false)
  })

  it('SVG 上传被拒绝（防存储型 XSS）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, '恶意.svg', 'image/svg+xml', Buffer.from('<svg><script>alert(1)</script></svg>'))
    expect(res.statusCode).toBe(400)
  })

  it('伪装成 png 的非图片内容被拒绝', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, '假图.png', 'image/png', Buffer.from('<script>alert(1)</script>'))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('不符')
  })

  it('kind 不合法返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await upload(app, cookie, 'a.pdf', 'application/pdf', Buffer.from('%PDF-1.4'), { kind: 'bogus' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('kind')
  })
})

