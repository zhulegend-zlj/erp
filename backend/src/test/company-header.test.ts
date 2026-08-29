import { describe, expect, it } from 'vitest'
import { buildApp } from '../server'
import { loginCookie, resetDb } from './helpers'
import { prisma } from '../db'

describe('公司抬头 CompanyHeader（采购单 FROM，多抬头）', () => {
  it('CRUD：老板建/改/删，全员可查，重复名称拦截', async () => {
    await resetDb()
    const app = buildApp()
    const boss = await loginCookie(app, 'boss')
    const purchase = await loginCookie(app, 'purchase')
    const warehouse = await loginCookie(app, 'warehouse')

    const created = await app.inject({
      method: 'POST', url: '/api/company-headers', headers: { cookie: boss },
      payload: { name: '东莞市智锐恒电子有限公司', address: '常平镇桥沥马屋村捷安科技园C栋202号', tel: '0769-87187030' },
    })
    expect(created.statusCode).toBe(200)
    const id = (created.json() as { id: number }).id

    const dup = await app.inject({
      method: 'POST', url: '/api/company-headers', headers: { cookie: purchase },
      payload: { name: '东莞市智锐恒电子有限公司' },
    })
    expect(dup.statusCode).toBe(400)

    const updated = await app.inject({
      method: 'PUT', url: '/api/company-headers/' + id, headers: { cookie: purchase },
      payload: { name: '东莞市锦名诚电子有限公司', fax: '0769-87187029' },
    })
    expect(updated.statusCode).toBe(200)
    expect((updated.json() as { name: string }).name).toBe('东莞市锦名诚电子有限公司')

    const list = await app.inject({ method: 'GET', url: '/api/company-headers', headers: { cookie: warehouse } })
    expect(list.statusCode).toBe(200)
    expect((list.json() as unknown[]).length).toBe(1)

    const del = await app.inject({ method: 'DELETE', url: '/api/company-headers/' + id, headers: { cookie: boss } })
    expect(del.statusCode).toBe(200)
  })

  it('供应商新字段：加税点/默认抬头/默认付款方式落库，生成采购单自动带出', async () => {
    await resetDb()
    const app = buildApp()
    const purchase = await loginCookie(app, 'purchase')
    const created = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie: purchase },
      payload: { name: '广祺', contactPerson: '郭先生', phone: '13712712664', defaultPaymentTerms: '月结', defaultHeaderName: '东莞市智锐恒电子有限公司', taxPoint: 7 },
    })
    expect(created.statusCode).toBe(200)
    const supplierId = (created.json() as { id: number }).id
    const saved = await prisma.supplier.findUnique({ where: { id: supplierId } })
    expect(saved?.taxPoint?.toNumber()).toBe(7)
    expect(saved?.defaultHeaderName).toBe('东莞市智锐恒电子有限公司')

    // 零件由工程建（不挂供应商），采购挂供应商（权限口径：供应商归采购）
    const engineer = await loginCookie(app, 'engineer')
    const part = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: engineer },
      payload: { sku: 'P-TP', name: '税点零件' },
    })
    expect(part.statusCode).toBe(200)
    const partId = (part.json() as { id: number }).id
    const linked = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: purchase },
      payload: { supplierId },
    })
    expect(linked.statusCode).toBe(200)

    const po = await app.inject({
      method: 'POST', url: '/api/purchase-orders', headers: { cookie: purchase },
      payload: {
        supplierId, headerName: '东莞市智锐恒电子有限公司', taxPoint: 7,
        items: [{ partId, qty: 10, unitPrice: 1, unitPriceInclTax: 1.07 }],
      },
    })
    expect(po.statusCode).toBe(200)
    const row = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { orderNo: (po.json() as { orderNo: string }).orderNo },
    })
    expect(row.taxPoint?.toNumber()).toBe(7)
    expect(row.headerName).toBe('东莞市智锐恒电子有限公司')
  })
})
