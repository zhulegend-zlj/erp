import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { buildApp } from '../server'
import { loginCookie } from './helpers'
import { FEEDBACK_PATH } from '../routes/feedback'

describe('feedback', () => {
  it('boss 提交反馈返回 200 并追加到 FEEDBACK.md 末尾', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')
    const content = `测试反馈-${Date.now()}`

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie },
      payload: { content, module: '库存', priority: '高' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const text = await readFile(FEEDBACK_PATH, 'utf8')
    expect(text).toContain(content)
  })

  it('content 为空（纯空白）返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie },
      payload: { content: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('不存在的模块名返回 400（模块需匹配现有页面）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'boss')

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie },
      payload: { content: '测试', module: '不存在的模块', priority: '中' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('角色只能给自己有权限的模块提反馈（销售提交采购 → 400）', async () => {
    const app = buildApp()
    const sales = await loginCookie(app, 'sales')

    const denied = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: sales },
      payload: { content: '销售越权模块', module: '采购', priority: '中' },
    })
    expect(denied.statusCode).toBe(400)
    expect(denied.json().error).toContain('权限范围')

    const allowedRes = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: sales },
      payload: { content: '销售正常模块-' + Date.now(), module: '订单', priority: '中' },
    })
    expect(allowedRes.statusCode).toBe(200)
  })
})
