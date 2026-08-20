import { describe, it, expect } from 'vitest'
import { buildApp } from '../server'

describe('health', () => {
  it('GET /api/health 返回 ok', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
