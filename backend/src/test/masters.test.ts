import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { buildApp } from '../server'
import { prisma } from '../db'
import { UPLOAD_DIR, partDirName } from '../uploads-store'
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

  it('价格由采购维护，工程不可填写/修改价格', async () => {
    const app = buildApp()
    const engineerCookie = await loginCookie(app, 'engineer')
    const purchaseCookie = await loginCookie(app, 'purchase')

    // 工程新建零件不带价格 → 200，price 为 null
    const created = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: engineerCookie },
      payload: { sku: 'P-PRICE', name: '价格零件', unit: '个' }
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().price).toBeNull()
    const partId = created.json().id

    // 工程新建带价格 → 400
    const withPrice = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie: engineerCookie },
      payload: { sku: 'P-PRICE2', name: '价格零件2', unit: '个', price: 1.5 }
    })
    expect(withPrice.statusCode).toBe(400)
    expect(withPrice.json().error).toMatch(/价格/)

    // 采购设置供应商 + 价格 → 200
    const supplier = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie: purchaseCookie },
      payload: { name: '供应商价格' }
    })
    expect(supplier.statusCode).toBe(200)
    const supplierId = supplier.json().id
    const setPrice = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: purchaseCookie },
      payload: { supplierId, price: 4.97 }
    })
    expect(setPrice.statusCode).toBe(200)
    expect(setPrice.json().supplierId).toBe(supplierId)
    expect(setPrice.json().price).toBe('4.97')

    // 采购只改价格 → 200
    const onlyPrice = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: purchaseCookie },
      payload: { price: 5.5 }
    })
    expect(onlyPrice.statusCode).toBe(200)
    expect(onlyPrice.json().price).toBe('5.5')

    // 工程改价格 → 400
    const engineerPrice = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: engineerCookie },
      payload: { price: 9.9 }
    })
    expect(engineerPrice.statusCode).toBe(400)
    expect(engineerPrice.json().error).toMatch(/价格/)

    // 工程改名称（表单完整提交）→ 200，价格保持采购所填
    const engineerName = await app.inject({
      method: 'PUT', url: '/api/parts/' + partId, headers: { cookie: engineerCookie },
      payload: { sku: 'P-PRICE', name: '价格零件改名', unit: '个' }
    })
    expect(engineerName.statusCode).toBe(200)
    expect(engineerName.json().name).toBe('价格零件改名')
    expect(engineerName.json().price).toBe('5.5')
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

  it('零件搜索：料号/中文名/英文名不区分大小写，分页总数同步过滤', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const seed = [
      { sku: 'CSP-013-1', name: '铝套管20*77.8', nameEn: 'aluminium sleeve 77' },
      { sku: 'M3x13-杯头', name: '杯头内六角螺丝', nameEn: 'socket screw' },
      { sku: 'P-AAA', name: '弹簧', nameEn: 'spring' },
    ]
    for (const p of seed) {
      const res = await app.inject({
        method: 'POST', url: '/api/parts', headers: { cookie },
        payload: { ...p, unit: '个' }
      })
      expect(res.statusCode).toBe(200)
    }
    // 料号模糊 + 大小写不敏感
    const bySku = await app.inject({ method: 'GET', url: '/api/parts?search=csp-013', headers: { cookie } })
    expect(bySku.statusCode).toBe(200)
    expect((bySku.json() as { sku: string }[]).map((p) => p.sku)).toEqual(['CSP-013-1'])
    // 中文名称
    const byName = await app.inject({ method: 'GET', url: '/api/parts?search=' + encodeURIComponent('铝套管'), headers: { cookie } })
    expect((byName.json() as { sku: string }[]).map((p) => p.sku)).toEqual(['CSP-013-1'])
    // 英文品名
    const byEn = await app.inject({ method: 'GET', url: '/api/parts?search=SPRING', headers: { cookie } })
    expect((byEn.json() as { sku: string }[]).map((p) => p.sku)).toEqual(['P-AAA'])
    // 分页 total 同步过滤
    const paged = await app.inject({ method: 'GET', url: '/api/parts?search=' + encodeURIComponent('螺丝') + '&page=1&pageSize=2', headers: { cookie } })
    expect(paged.statusCode).toBe(200)
    expect(paged.json().total).toBe(1)
    expect((paged.json().items as { sku: string }[]).map((p) => p.sku)).toEqual(['M3x13-杯头'])
    // LIKE 特殊字符不报错、不误匹配
    const special = await app.inject({ method: 'GET', url: '/api/parts?search=%25_', headers: { cookie } })
    expect(special.statusCode).toBe(200)
    expect((special.json() as unknown[]).length).toBe(0)
    // 非字符串参数 → 400
    const bad = await app.inject({ method: 'GET', url: '/api/parts?search=1&search=2', headers: { cookie } })
    expect(bad.statusCode).toBe(400)
  })

  it('零件搜索支持供应商/表面处理，且支持按成品过滤', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'warehouse')
    const sup = await prisma.supplier.create({ data: { name: '晨鑫五金' } })
    const p1 = await prisma.part.create({ data: { sku: 'P-SF1', name: '垫片A', finish: '电镀黑镍', supplierId: sup.id } })
    await prisma.part.create({ data: { sku: 'P-SF2', name: '螺丝B', finish: '红色阳极', supplierId: sup.id } })
    const p3 = await prisma.part.create({ data: { sku: 'P-SF3', name: '套管C', finish: '黑色阳极' } })
    // 供应商搜索
    const bySup = await app.inject({ method: 'GET', url: '/api/parts?search=' + encodeURIComponent('晨鑫'), headers: { cookie } })
    expect(bySup.statusCode).toBe(200)
    expect((bySup.json() as { sku: string }[]).map((p) => p.sku).sort()).toEqual(['P-SF1', 'P-SF2'])
    // 表面处理搜索
    const byFinish = await app.inject({ method: 'GET', url: '/api/parts?search=' + encodeURIComponent('电镀黑镍'), headers: { cookie } })
    expect((byFinish.json() as { sku: string }[]).map((p) => p.sku)).toEqual(['P-SF1'])
    // 按成品过滤：只返回该成品 BOM 内的零件
    const prod = await prisma.product.create({ data: { sku: 'F-FILT', name: '成品FILT' } })
    await prisma.bom.create({ data: { productId: prod.id, partId: p1.id, qty: 2 } })
    await prisma.bom.create({ data: { productId: prod.id, partId: p3.id, qty: 3 } })
    const filtered = await app.inject({ method: 'GET', url: '/api/parts?productId=' + prod.id, headers: { cookie } })
    expect(filtered.statusCode).toBe(200)
    expect((filtered.json() as { sku: string }[]).map((p) => p.sku).sort()).toEqual(['P-SF1', 'P-SF3'])
    // 成品过滤 + 搜索组合 + 分页
    const combo = await app.inject({
      method: 'GET', url: '/api/parts?productId=' + prod.id + '&search=' + encodeURIComponent('套管') + '&page=1&pageSize=5', headers: { cookie }
    })
    expect(combo.statusCode).toBe(200)
    expect(combo.json().total).toBe(1)
    expect((combo.json().items as { sku: string }[]).map((p) => p.sku)).toEqual(['P-SF3'])
    // 不存在的成品 → 404；非法 productId → 400
    expect((await app.inject({ method: 'GET', url: '/api/parts?productId=999999', headers: { cookie } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/parts?productId=abc', headers: { cookie } })).statusCode).toBe(400)
  })

  it('BOM 一键导出：xlsx + erp 文件名 + 每列筛选 + 嵌入图片', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const prod = await prisma.product.create({ data: { sku: 'F-EXP', name: '成品EXP' } })
    const part = await prisma.part.create({
      data: { sku: 'P-EXP', name: '零件EXP', nameEn: 'part EXP', weight: '12g', revision: '1', material: 'AL', dimensions: '10x10', finish: '黑色阳极', price: 3.25 },
    })
    // 给零件一个真实图片（测试环境 UPLOAD_DIR 为临时目录）
    const partDir = partDirName(part.sku, part.name)
    const folder = resolve(UPLOAD_DIR, '_未分类', partDir)
    mkdirSync(folder, { recursive: true })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(resolve(folder, partDir + '.png'), png)
    await prisma.part.update({ where: { id: part.id }, data: { imageUrl: '/uploads/_未分类/' + partDir + '/' + partDir + '.png' } })
    await prisma.bom.create({ data: { productId: prod.id, partId: part.id, qty: 5 } })

    const res = await app.inject({ method: 'GET', url: '/api/products/' + prod.id + '/bom/export', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml')
    expect(res.headers['content-disposition']).toContain('erp-F-EXP-BOM-')
    expect(res.headers['content-disposition']).toContain('-engineer.xlsx') // 文件名带导出身份（测试账号 username=engineer；生产环境为中文账号如 工程）
    const buf = res.rawPayload as Buffer
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    // 用 exceljs 读回验证：自动筛选 + 嵌入图片 + 20 列表头
    const wb = new ExcelJS.Workbook()
    // exceljs 自带类型与 @types/node 的泛型 Buffer 不兼容，测试内强制转换
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    expect(ws).toBeTruthy()
    expect(ws!.autoFilter).toBeTruthy()
    // 工程导出：13 列、无价格列
    expect(ws!.columnCount).toBe(13)
    expect(ws!.rowCount).toBe(2) // 表头 + 1 行数据
    expect(ws!.getImages().length).toBe(1)
    expect(String(ws!.getRow(1).getCell(13).value ?? '')).not.toContain('价格')

    // 采购导出：14 列，含价格列且值为 3.25
    const purchaseCookie = await loginCookie(app, 'purchase')
    const resP = await app.inject({ method: 'GET', url: '/api/products/' + prod.id + '/bom/export', headers: { cookie: purchaseCookie } })
    expect(resP.statusCode).toBe(200)
    const wbP = new ExcelJS.Workbook()
    await wbP.xlsx.load(resP.rawPayload as never)
    const wsP = wbP.worksheets[0]
    expect(wsP!.columnCount).toBe(14)
    expect(String(wsP!.getRow(1).getCell(13).value ?? '')).toContain('价格')
    expect(Number(wsP!.getRow(2).getCell(13).value)).toBe(3.25)

    // 不存在的成品 → 404
    expect((await app.inject({ method: 'GET', url: '/api/products/999999/bom/export', headers: { cookie } })).statusCode).toBe(404)
  })

  it('保存 BOM 归位时，-图档2.pdf 旧版留档不会被误认成图片', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    // 成品 + 零件（挂在成品下），零件文件夹放 图片 + 主图档 + 旧版图档2
    const product = await prisma.product.create({ data: { sku: 'F-SYNC', name: '成品SYNC' } })
    const part = await prisma.part.create({ data: { sku: 'P-SYNC', name: '弹簧SYNC' } })
    const partDir = partDirName(part.sku, part.name)
    const folder = resolve(UPLOAD_DIR, '_未分类', partDir)
    mkdirSync(folder, { recursive: true })
    writeFileSync(resolve(folder, partDir + '.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    writeFileSync(resolve(folder, partDir + '-图档.pdf'), Buffer.from('%PDF-1.4'))
    writeFileSync(resolve(folder, partDir + '-图档2.pdf'), Buffer.from('%PDF-1.4 old'))
    const imageUrl = '/uploads/_未分类/' + partDir + '/' + partDir + '.jpeg'
    const drawingsUrl = '/uploads/_未分类/' + partDir + '/' + partDir + '-图档.pdf'
    await prisma.part.update({ where: { id: part.id }, data: { imageUrl, drawingsUrl } })

    // 保存 BOM（触发归位 + 同步 URL）
    const save = await app.inject({
      method: 'PUT', url: '/api/products/' + product.id + '/bom', headers: { cookie },
      payload: [{ partId: part.id, qty: 2 }]
    })
    expect(save.statusCode).toBe(200)

    const after = await prisma.part.findUnique({ where: { id: part.id } })
    expect(after?.imageUrl).toBe('/uploads/F-SYNC/' + partDir + '/' + partDir + '.jpeg')
    expect(after?.drawingsUrl).toBe('/uploads/F-SYNC/' + partDir + '/' + partDir + '-图档.pdf')
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

  it('零件支持表格口径新字段（英文品名/重量/版本/材质/尺寸/表面处理/图号）', async () => {
    const app = buildApp()
    const cookie = await loginCookie(app, 'engineer')
    const payload = {
      sku: 'P-SHEET',
      name: '连接活动架',
      nameEn: 'pedal arm upper link 2',
      unit: '个',
      weight: '45.6',
      revision: '004',
      material: 'electroplated steel',
      dimensions: 'D15*50',
      finish: '喷砂黑色阳极',
      artId: 'ART-001',
    }
    const created = await app.inject({
      method: 'POST', url: '/api/parts', headers: { cookie }, payload
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().nameEn).toBe('pedal arm upper link 2')
    expect(created.json().weight).toBe('45.6')
    expect(created.json().revision).toBe('004')
    expect(created.json().material).toBe('electroplated steel')
    expect(created.json().dimensions).toBe('D15*50')
    expect(created.json().finish).toBe('喷砂黑色阳极')
    expect(created.json().artId).toBe('ART-001')

    const list = await app.inject({ method: 'GET', url: '/api/parts', headers: { cookie } })
    const found = (list.json() as { sku: string; nameEn?: string | null; dimensions?: string | null }[]).find((p) => p.sku === 'P-SHEET')
    expect(found).toBeTruthy()
    expect(found!.nameEn).toBe('pedal arm upper link 2')
    expect(found!.dimensions).toBe('D15*50')

    // 清空可选字段（PUT 仍需带 sku/name 必填项）
    const cleared = await app.inject({
      method: 'PUT', url: '/api/parts/' + created.json().id, headers: { cookie },
      payload: { sku: 'P-SHEET', name: '连接活动架', nameEn: '', weight: '', revision: '', material: '', dimensions: '', finish: '', artId: '' }
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().nameEn).toBeNull()
    expect(cleared.json().artId).toBeNull()
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
