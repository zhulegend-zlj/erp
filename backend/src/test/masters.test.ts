import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'

describe('masters 权限（工程/采购分工）', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('engineer 可创建零件', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const res = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie },
      payload: { sku: 'P001', name: '螺丝', unit: '个' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().sku).toBe('P001')
  })

  it('engineer 可创建成品并维护 BOM，purchase 不可以', async () => {
    const app = buildApp()
    const engineerCookie = await loginCookie(app, 'engineer')
    const purchaseCookie = await loginCookie(app, 'purchase')

    const product = await app.inject({
      method: 'POST', url: '/api/products', headers: { cookie: engineerCookie },
      payload: { sku: 'F001', name: '成品A', unit: '件' }
    })
    expect(product.statusCode).toBe(200)
    const productId = product.json().id

    const part = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: engineerCookie },
      payload: { sku: 'P-BOM1', name: '零件1', unit: '个' }
    })
    expect(part.statusCode).toBe(200)
    const partId = part.json().id

    const bomOk = await app.inject({
      method: 'PUT', url: '/api/products/' + productId + '/bom', headers: { cookie: engineerCookie },
      payload: [{ partId, qty: 2 }]
    })
    expect(bomOk.statusCode).toBe(200)

    const purchaseProduct = await app.inject({
      method: 'POST', url: '/api/products', headers: { cookie: purchaseCookie },
      payload: { sku: 'F002', name: '成品B', unit: '件' }
    })
    expect(purchaseProduct.statusCode).toBe(403)

    const purchaseBom = await app.inject({
      method: 'PUT', url: '/api/products/' + productId + '/bom', headers: { cookie: purchaseCookie },
      payload: [{ partId, qty: 2 }]
    })
    expect(purchaseBom.statusCode).toBe(403)
  })

  it('purchase 无权新建零件，但可以给零件挂供应商', async () => {
    const app = buildApp()
    const engineerCookie = await loginCookie(app, 'engineer')
    const purchaseCookie = await loginCookie(app, 'purchase')

    const created = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: engineerCookie },
      payload: { sku: 'P-LINK', name: '待挂供应商零件', unit: '个' }
    })
    expect(created.statusCode).toBe(200)
    const partId = created.json().id

    const supplier = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie: purchaseCookie },
      payload: { name: '晨鑫五金' }
    })
    expect(supplier.statusCode).toBe(200)
    const supplierId = supplier.json().id

    // 采购新建零件 → 403
    const noCreate = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: purchaseCookie },
      payload: { sku: 'P-NO', name: '不该成功', unit: '个' }
    })
    expect(noCreate.statusCode).toBe(403)

    // 采购只能改 supplierId → 200
    const link = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: purchaseCookie },
      payload: { supplierId }
    })
    expect(link.statusCode).toBe(200)
    expect(link.json().supplierId).toBe(supplierId)

    // 采购改其他字段 → 400
    const noOther = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: purchaseCookie },
      payload: { name: '改名' }
    })
    expect(noOther.statusCode).toBe(400)
    expect(noOther.json().error).toMatch(/供应商/)

    // 采购删除零件 → 403
    const noDelete = await app.inject({
      method: 'DELETE', url: '/api/parts/' + partId, headers: { cookie: purchaseCookie }
    })
    expect(noDelete.statusCode).toBe(403)
  })

  it('供应商归 boss/purchase 维护，engineer 只读', async () => {
    const app = buildApp()
    const purchaseCookie = await loginCookie(app, 'purchase')
    const engineerCookie = await loginCookie(app, 'engineer')

    const supplier = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie: purchaseCookie },
      payload: { name: '晨鑫五金' }
    })
    expect(supplier.statusCode).toBe(200)

    const noCreate = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie: engineerCookie },
      payload: { name: '不该成功' }
    })
    expect(noCreate.statusCode).toBe(403)

    const noUpdate = await app.inject({
      method: 'PUT', url: '/api/suppliers/' + supplier.json().id, headers: { cookie: engineerCookie },
      payload: { name: '改名' }
    })
    expect(noUpdate.statusCode).toBe(403)

    const list = await app.inject({ method: 'GET', url: '/api/suppliers', headers: { cookie: engineerCookie } })
    expect(list.statusCode).toBe(200)
    expect(Array.isArray(list.json())).toBe(true)
  })

  it('零件列表按 SKU 前缀分组、组内数字升序排序', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    // 故意乱序创建：覆盖「同前缀数字升序（含非补零）」与「不同前缀分组」
    const skus = ['P1927-14873', 'CSS-012', 'CSS-1', 'CSS-014', 'P1927-14872', 'CSP-003', 'SUP-10345']
    for (const sku of skus) {
      const res = await app.inject({
        method: 'POST', url: '/api/parts', headers: { cookie },
        payload: { sku, name: '零件' + sku, unit: '个' }
      })
      expect(res.statusCode).toBe(200)
    }
    const list = await app.inject({ method: 'GET', url: '/api/parts', headers: { cookie } })
    expect(list.statusCode).toBe(200)
    const order = (list.json() as { sku: string }[]).map((p) => p.sku)
    // 前缀组按字母序：csp < css < p < sup；组内数字升序（1 < 12 < 14；14872 < 14873）
    expect(order).toEqual(['CSP-003', 'CSS-1', 'CSS-012', 'CSS-014', 'P1927-14872', 'P1927-14873', 'SUP-10345'])
  })

  it('零件列表分页时保持同一排序', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    for (const sku of ['CSS-2', 'CSS-1', 'CSS-3']) {
      const res = await app.inject({
        method: 'POST', url: '/api/parts', headers: { cookie },
        payload: { sku, name: '零件' + sku, unit: '个' }
      })
      expect(res.statusCode).toBe(200)
    }
    const page1 = await app.inject({ method: 'GET', url: '/api/parts?page=1&pageSize=2', headers: { cookie } })
    expect(page1.statusCode).toBe(200)
    expect((page1.json().items as { sku: string }[]).map((p) => p.sku)).toEqual(['CSS-1', 'CSS-2'])
    expect(page1.json().total).toBe(3)
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
    const cookie = await loginCookie(app, 'engineer')
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
    const cookie = await loginCookie(app, 'engineer')

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
