import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'

describe('masters', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('purchase 可创建零件', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const res = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie },
      payload: { sku: 'P001', name: '螺丝', unit: '个' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().sku).toBe('P001')
  })

  it('warehouse 无权创建零件（403）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const res = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie },
      payload: { sku: 'P002', name: '螺母', unit: '个' }
    })
    expect(res.statusCode).toBe(403)
  })

  it('重复 SKU 返回 400 + 中文提示', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')
    const payload = { sku: 'P-DUP', name: '重复零件', unit: '个' }
    const first = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie }, payload
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie }, payload
    })
    expect(second.statusCode).toBe(400)
    expect(second.json().error).toMatch(/已存在|重复/)
  })

  it('修改/删除不存在的记录返回 404', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'purchase')

    const put = await app.inject({
      method: 'PUT', url: '/api/parts/999999', headers: { cookie },
      payload: { sku: 'P-NO', name: '不存在', unit: '个' }
    })
    expect(put.statusCode).toBe(404)
    expect(put.json().error).toMatch(/不存在/)

    const del = await app.inject({
      method: 'DELETE', url: '/api/parts/999999', headers: { cookie }
    })
    expect(del.statusCode).toBe(404)
    expect(del.json().error).toMatch(/不存在/)
  })
})
