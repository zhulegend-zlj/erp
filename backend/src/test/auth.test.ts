import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../server'
import { prisma } from '../db'
import bcrypt from 'bcryptjs'

describe('auth', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { username: 'boss' },
      update: {},
      create: { username: 'boss', passwordHash: await bcrypt.hash('secret123', 10), name: '老板', role: 'boss' }
    })
  })

  it('登录成功返回 cookie 且 /me 返回角色', async () => {
    const app = buildApp()
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: 'secret123' } })
    expect(login.statusCode).toBe(200)
    const cookie = login.headers['set-cookie'] as unknown as string
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().role).toBe('boss')
  })

  it('密码错误返回 401', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: 'wrong' } })
    expect(res.statusCode).toBe(401)
  })
})
