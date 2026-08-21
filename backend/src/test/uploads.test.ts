import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'

// 上传产生的文件清理清单（测试结束后删除）
const created: string[] = []

function multipart(filename: string, contentType: string, content: Buffer): Buffer {
  const boundary = '----erptestboundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return Buffer.concat([head, content, tail])
}

describe('uploads', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    for (const f of created) {
      try {
        await unlink(f)
      } catch {
        /* 忽略 */
      }
    }
  })

  async function upload(app: ReturnType<typeof buildApp>, cookie: string, filename: string, contentType: string, content: Buffer) {
    const body = multipart(filename, contentType, content)
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

    const served = await app.inject({ method: 'GET', url: body.url })
    expect(served.statusCode).toBe(200)
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
})

