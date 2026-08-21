import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../server'
import { prisma } from '../db'
import bcrypt from 'bcryptjs'
import { loginCookie } from './helpers'

describe('auth', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { username: 'boss' },
      update: {},
      create: { username: 'boss', passwordHash: await bcrypt.hash('88888888', 10), name: '老板', role: 'boss' }
    })
  })

  it('登录成功返回 cookie 且 /me 返回角色', async () => {
    const app = buildApp()
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: '88888888' } })
    expect(login.statusCode).toBe(200)
    const cookie = login.headers['set-cookie'] as unknown as string
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().role).toBe('boss')
  })

  it('engineer 可登录且 /me 返回 engineer 角色', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().role).toBe('engineer')
  })

  it('密码错误返回 401', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'boss', password: 'wrong' } })
    expect(res.statusCode).toBe(401)
  })

  it('可修改本人密码，旧密码失效、新密码可登录', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'sales')

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: '88888888', newPassword: '99999999' }
    })
    expect(change.statusCode).toBe(200)

    const oldLogin = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { username: 'sales', password: '88888888' }
    })
    expect(oldLogin.statusCode).toBe(401)

    const newLogin = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { username: 'sales', password: '99999999' }
    })
    expect(newLogin.statusCode).toBe(200)
  })

  it('原密码错误或新密码过短返回 400', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'finance')

    const wrongOld = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'wrong', newPassword: '123456' }
    })
    expect(wrongOld.statusCode).toBe(400)
    expect(wrongOld.json().error).toContain('原密码')

    const shortNew = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: '88888888', newPassword: '123' }
    })
    expect(shortNew.statusCode).toBe(400)
    expect(shortNew.json().error).toContain('6 位')
  })
})
