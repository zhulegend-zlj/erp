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
})
