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
})
