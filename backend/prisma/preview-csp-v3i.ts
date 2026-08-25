// 修正版对照表生成（星号规格/简繁归一/GBK图档名/特例标注）
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

const prisma = new PrismaClient()
const FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3I清单-螺丝物料表.xlsx'
const RAR_V3I = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3i_2D PDF.rar'
const RAR_V3 = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3_2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const OUT = 'D:/AI/erp-backups/CSP-V3I-SKU对照表.xlsx'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

function nf(s: string): string {
  return s.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫').replace(/[門]/g, '门').replace(/[線]/g, '线')
}

function screwSku(name: string, dims: string): string {
  const nameNorm = name.replace(/\*/g, 'x')
  const fromName = nameNorm.match(/M\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?/i)?.[0]
  const raw = (fromName || dims).replace(/\s+/g, '').replace(/\*/g, 'x')
  const m = raw.match(/M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?/i)
  const size = m ? 'M' + m[1] + (m[2] ? 'x' + m[2] : '') : raw
  if (name.includes('直纹') && name.includes('杯头')) return size + '-杯头直纹'
  if (name.includes('杯头')) return size + '-杯头'
  if (name.includes('扁头')) return size + '-扁头'
  if (name.includes('十字')) return size + '-十字'
  if (name.includes('沉头')) return size + '-平头'
  if (name.includes('平头')) return size + '-平头'
  if (name.includes('半圆头')) return size + '-半圆头'
  if (name.includes('紧定') || name.includes('机米')) return size + '-机米'
  if (name.includes('盖帽') || name.includes('盖型')) return size + '-盖型螺母'
  if (name.includes('螺母')) return size + '-螺母'
  if (name.includes('垫片')) return size + '-垫片'
  return name
}

function rarFiles(rarPath: string): string[] {
  const buf = execFileSync(UNRAR, ['lb', rarPath], { maxBuffer: 64 * 1024 * 1024 })
  return new TextDecoder('gbk').decode(buf).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => s.toLowerCase().endsWith('.pdf'))
}

function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
}

async function main() {
  const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const data = rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')

  const v3iPdfs = rarFiles(RAR_V3I)
  const v3Pdfs = rarFiles(RAR_V3)
  const v3Set = new Set(v3Pdfs.map((f) => f.split(/[\\/]/).pop()!.toLowerCase()))
  const v3iByKey = new Map<string, string[]>()
  for (const f of v3iPdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = v3iByKey.get(k) ?? []
      list.push(base)
      v3iByKey.set(k, list)
    }
  }

  const v3Parts = new Map<string, { name: string; drawingsUrl: string | null }>()
  for (const p of await prisma.part.findMany({ select: { sku: true, name: true, drawingsUrl: true } })) {
    v3Parts.set(p.sku, { name: p.name, drawingsUrl: p.drawingsUrl })
  }
  const v3Suppliers = new Set((await prisma.supplier.findMany({ select: { name: true } })).map((s) => s.name))

  const header = ['表内序号', '原表料号', '建议新SKU', 'V3I中文名称', '用量', '与V3关系', 'V3对应料号', '导入供应商', 'V3i图档', '图档是否与V3共用', '备注/颜色标注']
  const out: unknown[][] = [header]
  let csp13Seq = 7
  const csp13ByLen = new Map<string, string>()
  let miscSeq = 300
  const extraDrawings: string[] = []

  for (const raw of data) {
    const seq = clean(raw[0])
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const dims = clean(raw[9])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    const vendorRaw = clean(raw[19])
    if (!name) continue

    const isFastener = /螺丝|螺母|垫片|机米|螺钉/.test(name)
    let sku = ''
    let rel = '新零件'
    let v3Sku = ''
    let note = ''

    if (/^CSP-013$/i.test(idRaw)) {
      const lenM = name.match(/20\s*[*x]\s*(\d+(?:\.\d+)?)/i)
      const lenKey = lenM ? String(Number(lenM[1])) : name
      if (lenKey === '10') {
        sku = 'CSP-013-7'
        rel = '公用'
        v3Sku = 'CSP-013-7'
      } else if (csp13ByLen.has(lenKey)) {
        sku = csp13ByLen.get(lenKey)!
        rel = '新零件（同长度合并）'
      } else {
        csp13Seq++
        sku = 'CSP-013-' + csp13Seq
        csp13ByLen.set(lenKey, sku)
        rel = '新零件（铝套管新长度）'
      }
    } else if (/^CSP-005$/i.test(idRaw)) {
      sku = 'CSP-005-深灰'
      rel = '颜色区分（新建）'
      v3Sku = 'CSP-005'
      note = '与V3同料号但颜色不同（V3红色/V3I深灰色），按老板要求分开'
    } else if (/^CSP-033$/i.test(idRaw)) {
      sku = 'CSP-033-灰色'
      rel = '颜色区分（新建）'
      v3Sku = 'CSP-033'
      note = '与V3同料号但颜色不同（V3原色/V3I灰色），按老板要求分开'
    } else if (/^CSP-/.test(idRaw)) {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'
        v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理，请核对'
        if (/黑|灰|红|白/.test(name)) note += '；V3I名称含颜色：' + name
      }
    } else if (isFastener) {
      sku = screwSku(name, dims)
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'
        v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理'
        if (/黑|白|灰|红/.test(name)) note += '；V3I名称含颜色：' + name
      }
    } else if (idRaw === '' || idRaw === '-') {
      const v3Same = [...v3Parts.entries()].find(([k, v]) => nf(v.name) === nf(name) && k.startsWith('CSP-2'))
      if (v3Same) {
        sku = v3Same[0]
        rel = '公用（同名杂项）'
        v3Sku = sku
      } else {
        miscSeq++
        sku = 'CSP-' + miscSeq
        rel = '新零件（杂项 CSP-3xx）'
      }
    } else {
      sku = idRaw
      const v3 = v3Parts.get(sku)
      if (v3) {
        rel = '公用'
        v3Sku = sku
        if (v3.name !== name) note = '名称与V3略异（V3: ' + v3.name + '），按共用处理，请核对'
      }
    }
    if (rel === '新零件') {
      const sameName = [...v3Parts.entries()].find(([k, v]) => nf(v.name) === nf(name))
      if (sameName) note = (note ? note + '；' : '') + '同名V3已有料号 ' + sameName[0] + '，请确认是否同一件（按料号新建）'
    }
    if (seq === '7') note = (note ? note + '；' : '') + '表内料号 M6x16 与名称 M6x28 不一致，按名称 M6x28-平头（与V3共用）'
    if (seq === '31') note = (note ? note + '；' : '') + '与V3称重传感器（CSP-204，线长260）类似但线长不同（482），按新零件，请确认'
    if (seq === '90') note = (note ? note + '；' : '') + 'V3仅有 CSP-032-3（PA小黑块内垫），本行料号 CSP-032、图档名与V3相同（spring_guide），请确认两者关系'
    if (seq === '141') note = (note ? note + '；' : '') + '与V3 CSP-220「彩盒、外箱序列号标签」名称近似（本表多EAN字样），暂按新零件，请确认是否同一件'
    if (seq === '135') note = (note ? note + '；' : '') + 'V3名称「电缆夹」，V3I「电线固定扣」，按共用处理请核对'

    const vendorName = vendorRaw && v3Suppliers.has(vendorRaw.split('/')[0]!.trim()) ? vendorRaw.split('/')[0]!.trim() : ''
    if (vendorRaw && !vendorName) note = (note ? note + '；' : '') + '供应商列值「' + vendorRaw + '」视为用途备注/非供应商，跳过'

    const files = v3iByKey.get(idKey(idRaw)) ?? []
    let drawing = ''
    let drawingShared = ''
    if (files.length > 0) {
      const sameInV3 = files.filter((f) => v3Set.has(f.toLowerCase()))
      const v3Has = v3Parts.get(sku)?.drawingsUrl
      if (sameInV3.length === files.length && v3Has) {
        drawing = files.length + ' 个'
        drawingShared = '是（与V3同文件，V3已挂）'
      } else if (v3Has) {
        drawing = files.length + ' 个'
        drawingShared = '共用零件（V3已挂图，V3i为新版本，导入时可更新）'
      } else {
        drawing = files.length + ' 个'
        drawingShared = '否（新挂）'
      }
    } else {
      drawing = ''
      drawingShared = v3Parts.get(sku)?.drawingsUrl ? '共用（V3已挂图）' : ''
    }

    out.push([seq, idRaw || '-', sku, name, amount, rel, v3Sku, vendorName, drawing, drawingShared, note])
  }

  for (const [k, files] of v3iByKey) {
    const hasRow = data.some((raw) => idKey(clean(raw[1]).replace(/^['"]+/, '')) === k)
    if (!hasRow) extraDrawings.push('表内无行: ' + k + ' → ' + files.join(' / '))
  }

  const ws = XLSX.utils.aoa_to_sheet(out)
  ws['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 16 }, { wch: 30 }, { wch: 6 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 22 }, { wch: 60 }]
  const wbOut = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wbOut, ws, 'CSP-V3I对照')
  if (extraDrawings.length > 0) {
    const ws2 = XLSX.utils.aoa_to_sheet([['rar 内有图档但表内无对应行'], ...extraDrawings.map((e) => [e])])
    ws2['!cols'] = [{ wch: 90 }]
    XLSX.utils.book_append_sheet(wbOut, ws2, '表外图档')
  }
  XLSX.writeFile(wbOut, OUT)
  const shared = out.slice(1).filter((r) => String(r[5]).includes('公用')).length
  const newParts = out.slice(1).filter((r) => !String(r[5]).includes('公用')).length
  console.log('数据行:', data.length, '；共用:', shared, '；新建:', newParts, '；表外图档:', extraDrawings.length)
  console.log('已输出:', OUT)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
