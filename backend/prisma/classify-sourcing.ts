
import { PrismaClient } from '@prisma/client'
import XLSX from 'xlsx'

const p = new PrismaClient()
const parts = await p.part.findMany({
  select: { sku: true, name: true, price: true, priceInclTax: true, supplierId: true, supplier: { select: { name: true } }, sourcing: true, priceBundleId: true },
  orderBy: { sku: 'asc' },
})

// 建议规则（老板过目后修正）：
// 1) 供应商名称含「自己打印」→ 自制
// 2) 无供应商且无价格：名称含 标签/贴纸/吊牌/序列号/打印/说明书/手册/序列号 类 → 自制；
//    名称含 胶水/油/干燥剂/扎线带/防氧化 耗材类 → 自购；其余 → 外购（默认）
// 3) 有供应商或有价格 → 外购（默认）
function suggest(sku: string, name: string, hasSup: boolean, hasPrice: boolean, supName: string): { s: string; why: string } {
  if (/自己打印|自制/.test(supName)) return { s: 'selfmade', why: '供应商为「自己打印」' }
  const LABEL = /标签|贴纸|吊牌|序列号|打印|说明书|手册|纸卡|卡片|隔纸|防锈|油纸|棉绳|无纺布|泡棉|珍珠棉|包装袋|PE袋|气泡袋|吸塑|彩卡/
  const CONSUM = /胶水|润滑|锂基|防氧化|干燥剂|扎线带|线扣|胶带/
  if (!hasSup && !hasPrice) {
    if (LABEL.test(name)) return { s: 'selfmade', why: '无供应商无价格+标签/包装耗材类，疑似自己打印' }
    if (CONSUM.test(name)) return { s: 'selfbuy', why: '无供应商无价格+耗材类，疑似自己买' }
    return { s: 'purchased', why: '默认外购（请确认）' }
  }
  return { s: 'purchased', why: '有供应商或有价格' }
}

const rows = parts.map((x) => {
  const hasSup = x.supplierId != null
  const hasPrice = x.price != null || x.priceInclTax != null
  const g = suggest(x.sku, x.name, hasSup, hasPrice, x.supplier?.name ?? '')
  return {
    SKU: x.sku,
    名称: x.name,
    现供应商: x.supplier?.name ?? '',
    不含税: x.price == null ? '' : Number(x.price),
    含税: x.priceInclTax == null ? '' : Number(x.priceInclTax),
    建议采购方式: g.s === 'purchased' ? '外购' : g.s === 'selfbuy' ? '自购' : '自制',
    建议依据: g.why,
    您确认采购方式: '',
    备注: '',
  }
})
const wb = XLSX.utils.book_new()
const ws = XLSX.utils.json_to_sheet(rows)
ws['!cols'] = [{ wch: 22 }, { wch: 30 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 20 }]
XLSX.utils.book_append_sheet(wb, ws, '零件分类')
const outPath = 'D:/AI/采购/零件采购方式清单-20260901.xlsx'
XLSX.writeFile(wb, outPath)
const cnt: Record<string, number> = { 外购: 0, 自购: 0, 自制: 0 }
for (const r of rows) cnt[r.建议采购方式] = (cnt[r.建议采购方式] ?? 0) + 1
console.log('总数:', rows.length)
console.log('建议 外购:', cnt['外购'], ' 自购:', cnt['自购'], ' 自制:', cnt['自制'])
console.log('OUT:', outPath)
await p.$disconnect()
