// 生成《ERP 对照手册》：给工程明天精细对照用（V3/V3I 两张对照 + 图档对照 + 待办清单）。
// 数据来源：V3/V3I 源表格、老板复核后的 V3I 对照表、两个图档 rar、ERP 数据库现状。
// 输出：D:/AI/erp-backups/ERP对照手册-20260825.xlsx（可用 BUILD_OUT 环境变量覆盖路径）
import { PrismaClient } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

const prisma = new PrismaClient()
const V3_FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3清单_物料明细.xlsx'
const V3I_FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3I清单-螺丝物料表.xlsx'
const V3I_TABLE = 'D:/AI/erp-backups/CSP-V3I-SKU对照表.xlsx'
const RAR_V3 = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3_2D PDF.rar'
const CSS_FILE = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ黑色+USB清单-物料明细.xlsx'
const RAR_CSS = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSS_SQ 2D PDF.rar'
const RAR_V3I = 'C:/Users/zhulianghong/xwechat_files/wxid_cfbx0uckwvyn22_cf17/msg/file/2026-08/CSP_V3i_2D PDF.rar'
const UNRAR = 'C:/Program Files/WinRAR/UnRAR.exe'
const OUT = process.env.BUILD_OUT || 'D:/AI/erp-backups/ERP对照手册-20260825.xlsx'

function clean(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
function idKey(id: string): string {
  return id.replace(/^['"]+/, '').trim().toLowerCase()
}
function rarFiles(rarPath: string): string[] {
  const buf = execFileSync(UNRAR, ['lb', rarPath], { maxBuffer: 64 * 1024 * 1024 })
  return new TextDecoder('gbk').decode(buf).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => s.toLowerCase().endsWith('.pdf'))
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
  if (name.includes('盘头')) return size + (name.includes('自攻') ? '-盘头自攻' : '-盘头')
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

async function main() {
  const [v3Pdfs, v3iPdfs] = [rarFiles(RAR_V3), rarFiles(RAR_V3I)]
  const v3Set = new Set(v3Pdfs.map((f) => f.split(/[\\/]/).pop()!.trim().toLowerCase()))
  const v3iByKey = new Map<string, string[]>()
  for (const f of v3iPdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = v3iByKey.get(k) ?? []
      list.push(base.trim())
      v3iByKey.set(k, list)
    }
  }

  const parts = await prisma.part.findMany({ include: { supplier: { select: { name: true } } } })
  const partMap = new Map(parts.map((p) => [p.sku, p]))
  const boms = await prisma.bom.findMany({ include: { product: { select: { sku: true } } } })
  const bomQty = new Map<string, number>()
  for (const b of boms) {
    const p = parts.find((x) => x.id === b.partId)
    if (!p) continue
    const key = b.product.sku + '|' + p.sku
    bomQty.set(key, (bomQty.get(key) ?? 0) + b.qty)
  }

  // ===== V3 对照 =====
  const wb3 = XLSX.read(readFileSync(V3_FILE), { type: 'buffer' })
  const v3rows = XLSX.utils.sheet_to_json(wb3.Sheets[wb3.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const v3data = v3rows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')
  let mSeq = 0
  const v3Sheet: unknown[][] = [['表内序号', '原表料号', 'ERP料号', '中文名称', '用量', '图片', '图档', '供应商', '备注']]
  for (const raw of v3data) {
    const seq = clean(raw[0])
    const id = clean(raw[1])
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const dims = clean(raw[9])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    if (!name) continue
    const isFastener = /螺丝|螺母|垫片|机米/.test(name)
    let sku = ''
    let note = ''
    if (/^CSP-013$/i.test(id)) {
      const lenM = name.match(/20\s*[*x]\s*(\d+(?:\.\d+)?)/i)
      sku = 'CSP-013-' + (lenM ? String(Number(lenM[1])) : '?')
      note = '铝套管按尺寸命名（老板已在 ERP 改名）'
    } else if (/^CSP-216$/i.test(id)) {
      sku = 'CSP-216-V3'
      note = '与 V3I 的 CSP-216-v3i 区分'
    } else if (/^CSP-/.test(id)) {
      sku = id
    } else if (isFastener) {
      sku = screwSku(name, dims)
    } else if (id === '' || id === '-') {
      mSeq++
      sku = 'CSP-' + (200 + mSeq)
      if (name === '包装泡棉') { sku = 'CSP-216-V3'; note = '与 V3I 的 CSP-216-v3i 区分' }
    } else {
      sku = id
    }
    if (seq === '9') note = (note ? note + '；' : '') + '表内用量空，按 1 处理'
    const p = partMap.get(sku)
    const vendor = p?.supplier?.name ?? ''
    const img = p?.imageUrl ? '有' : '无'
    const dwg = p?.drawingsUrl ? '有' : '无'
    // V3i 有更高版本图档且已更新过的三个
    if (sku === 'CSP-003' || sku === 'CSP-048' || sku === 'CSP-039') note = (note ? note + '；' : '') + '图档已更新为 V3i 新版本（旧版 -图档2.pdf 留档）'
    v3Sheet.push([seq, id || '-', sku, name, amount, img, dwg, vendor, note])
  }

  // ===== V3I 对照（以老板复核后的对照表为口径 + 导入时的覆盖） =====
  const wbT = XLSX.read(readFileSync(V3I_TABLE), { type: 'buffer' })
  const trows = XLSX.utils.sheet_to_json(wbT.Sheets['CSP-V3I对照'], { header: 1, defval: '', raw: false }) as unknown[][]
  const v3iSheet: unknown[][] = [['表内序号', '原表料号', 'ERP料号', '中文名称', '用量', '与V3关系', '图片', '图档', '供应商', '备注']]
  const overrides: Record<string, string> = {}
  for (const r of trows.slice(1)) {
    let sku = clean(r[3])
    const name = clean(r[4])
    if (!sku || !name) continue
    if (name.includes('铝套管20*39.5')) sku = 'CSP-013-39.5'
    if (name.includes('铝套管20*45.5')) sku = 'CSP-013-45.5'
    if (name.includes('3M胶贴')) sku = 'CSP-321'
    if (name.includes('扎线带')) sku = 'CSP-322'
    if (name.includes('无纺布袋')) sku = 'CSP-323'
    overrides[name] = sku
    // 三件与 V3 不共用的杂项：关系列同步改为不共用，避免误导
    let rel = clean(r[6])
    if (sku === 'CSP-321' || sku === 'CSP-322' || sku === 'CSP-323') rel = '不共用（V3I独立料号）'
    const p = partMap.get(sku)
    v3iSheet.push([
      clean(r[0]), clean(r[2]).replace(/^['"]+/, '').trim() || '-', sku, name, Number(r[5]) || 1,
      clean(r[6]), p?.imageUrl ? '有' : '无', p?.drawingsUrl ? '有' : '无',
      p?.supplier?.name ?? '', clean(r[11]),
    ])
  }

  // ===== 图档对照 =====
  const dwgSheet: unknown[][] = [['rar包', 'PDF 文件名', '对应料号', 'ERP零件', '状态']]
  const v3ByKey = new Map<string, string[]>()
  for (const f of v3Pdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = v3ByKey.get(k) ?? []
      list.push(base.trim())
      v3ByKey.set(k, list)
    }
  }
  const v3iIds = new Set<string>()
  for (const r of trows.slice(1)) {
    const id = clean(r[2]).replace(/^['"]+/, '').trim()
    if (id) v3iIds.add(idKey(id))
  }
  for (const f of v3iPdfs) {
    const base = f.split(/[\\/]/).pop()!.trim()
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    const k = m ? idKey(m[1]) : ''
    const inSheet = v3iIds.has(k)
    // 找到挂载零件：CSP-013 家族 → 新长度各料号；CSP-005 → CSP-005-深灰；CSP-033 → CSP-033-灰色
    let target = ''
    if (k === 'csp-013') target = 'CSP-013-3/12/39.5/45.5/87/91/126.5/130（新长度）+ CSP-013-10（共用，版本相同保持）'
    else if (k === 'csp-005') target = 'CSP-005-深灰'
    else if (k === 'csp-033') target = 'CSP-033-灰色'
    else if (k === 'csp-017') target = 'CSP-017-v3i（老板备注：待图纸，暂不挂）'
    else if (inSheet && partMap.has(k.toUpperCase()) === false && k.startsWith('csp-')) target = k.toUpperCase() + '（新零件已挂）'
    else if (partMap.has(k.toUpperCase())) target = k.toUpperCase()
    let status = inSheet ? '已挂到对应零件' : '表内无此行（未挂）'
    if (k === 'csp-017') status = '待图纸（老板备注）'
    dwgSheet.push(['V3i', base, k || '-', target || '-', status])
  }
  for (const f of v3Pdfs) {
    const base = f.split(/[\\/]/).pop()!.trim()
    const m = base.match(/^(csp-\d+(?:-\d+)?[a-z]?)/i)
    const k = m ? idKey(m[1]) : ''
    const sameInV3I = v3Set.has(base.toLowerCase())
    dwgSheet.push(['V3', base, k || '-', '-', sameInV3I ? '与 V3i 包内同文件' : 'V3 版本'])
  }

  // ===== CSS_SQ 对照 =====
  const wbCss = XLSX.read(readFileSync(CSS_FILE), { type: 'buffer' })
  const cssRows = XLSX.utils.sheet_to_json(wbCss.Sheets[wbCss.SheetNames[0]!], { header: 1, defval: '', raw: false }) as unknown[][]
  const cssData = cssRows.slice(1).filter((r) => (r[0] ?? '') !== '' || (r[5] ?? '') !== '')
  const cssPdfs = rarFiles(RAR_CSS)
  const cssPdfByKey = new Map<string, string[]>()
  for (const f of cssPdfs) {
    const base = f.split(/[\\/]/).pop()!
    const m = base.match(/^(css-\d+[a-z]?)/i)
    if (m) {
      const k = idKey(m[1])
      const list = cssPdfByKey.get(k) ?? []
      list.push(base.trim())
      cssPdfByKey.set(k, list)
    }
  }
  const partProducts = new Map<number, string[]>()
  for (const b of boms) {
    const arr = partProducts.get(b.partId) ?? []
    arr.push(b.product.sku)
    partProducts.set(b.partId, arr)
  }
  const cssSheet: unknown[][] = [['表内序号', '原表料号', 'ERP料号', '中文名称', '用量', '与已有零件关系', '图片', '图档', '供应商', '备注']]
  let cssMiscSeq = 100
  const cssByName = new Map<string, string>()
  for (const p of parts) {
    const key = p.name.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫')
    if (p.sku.startsWith('CSP-') && !cssByName.has(key)) cssByName.set(key, p.sku)
  }
  for (const raw of cssData) {
    const seq = clean(raw[0])
    const idRaw = clean(raw[1]).replace(/^['"]+/, '').trim()
    const name = clean(raw[5]) || clean(raw[4]) || clean(raw[3])
    const dims = clean(raw[9])
    const amountRaw = raw[11]
    const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === '' ? 1 : Number(amountRaw)
    if (!name) continue
    const isFastener = /螺丝|螺母|垫片|机米|螺钉/.test(name)
    let sku = ''
    let rel = '新零件'
    let note = ''
    if (/^CSS-/i.test(idRaw)) {
      sku = idRaw
      if (name.includes('磁铁')) note = '磁铁1（官方料号，与磁铁2分开）'
      if (sku === 'CSS-062') note = '与 V3 CSP-060 PU泡棉 同名，老板确认独立建'
    } else if (idRaw === 'xzzx') {
      sku = 'xzzx'
    } else if (isFastener) {
      sku = screwSku(name, dims)
    } else if (idRaw === '' || idRaw === '-') {
      if (name === '磁铁') {
        cssMiscSeq++
        sku = 'CSS-' + cssMiscSeq
        note = '磁铁2（与 CSS-095 不同规格，分开建）'
      } else {
        const same = cssByName.get(name.replace(/[腳]/g, '脚').replace(/[墊]/g, '垫'))
        if (same) { sku = same }
        else { cssMiscSeq++; sku = 'CSS-' + cssMiscSeq }
      }
    } else {
      sku = idRaw
    }
    if (name === '插销') note = (note ? note + '；' : '') + '插销两行不同规格，分开建料号'
    if (name === 'CS_USB_A') note = (note ? note + '；' : '') + '按老板确认归入 CSS-1xx'
    if (seq === '55' && name.includes('棉绳')) note = (note ? note + '；' : '') + '表内序号与第55行重复，按物理行处理'
    const p = partMap.get(sku)
    const prods = p ? (partProducts.get(p.id) ?? []) : []
    rel = prods.length > 1 ? '公用（与V3/V3I共用）' : '新零件'
    cssSheet.push([seq, idRaw || '-', sku, name, amount, rel, p?.imageUrl ? '有' : '无', p?.drawingsUrl ? '有' : '无', p?.supplier?.name ?? '', note])
  }

  // CSS_SQ 图档对照（并入图档对照表）
  const cssIds = new Set(cssData.map((r) => idKey(clean(r[1]).replace(/^['"]+/, ''))))
  for (const f of cssPdfs) {
    const base = f.split(/[\\/]/).pop()!.trim()
    const m = base.match(/^(css-\d+[a-z]?)/i)
    const k = m ? idKey(m[1]) : ''
    const target = k && partMap.has(k.toUpperCase()) ? k.toUpperCase() : '-'
    dwgSheet.push(['CSS', base, k || '-', target, cssIds.has(k) ? '已挂到对应零件' : '表内无此行（未挂）'])
  }

  // ===== 待办与待确认 =====
  const todoSheet: unknown[][] = [['类别', '内容']]
  const todos: [string, string][] = [
    ['待确认-同名不同料号', '左前承座：V3=CSP-023 / V3I=CSP-128；右前承座：V3=CSP-024 / V3I=CSP-127 —— 请确认是否同一件'],
    ['待确认-同名不同料号', '离合连接杆双头牙：V3=CSP-036 / V3I=CSP-109；离合连接件：V3=CSP-038 / V3I=CSP-121 —— 请确认是否同一件'],
    ['待确认-近似', 'CSP-032（V3I 尼龙+纤胶塞）与 V3 的 CSP-032-3（PA小黑块内垫）图档同名，请确认关系'],
    ['待确认-近似', 'V3I 传感器(线长482)=CSP-303 与 V3 称重传感器(线长260)=CSP-204 长度不同，已分开建料号，请确认'],
    ['待确认-近似', 'V3I 彩盒外箱EAN序列号标签=CSP-317 与 V3 CSP-220 名称近似，已分开建料号，请确认'],
    ['待确认-名称差异(已共用)', 'CSP-050：V3「电缆夹」/ V3I「电线固定扣」，已共用 CSP-050；CSP-011：V3「刹车支架」/ V3I「刹车活动架」，已共用；CSP-060：V3「PU泡棉」/ V3I「泡棉」，已共用'],
    ['待图纸', 'CSP-017-v3i 脚踏板限制棒（V3i 少两个孔的新版本）——图档待工程提供'],
    ['缺图片-V3', 'CSP-203 扎线带（V3 表内无图）；V3I 的扎线带 CSP-322 已有图'],
    ['缺图片-V3I', 'CSP-013-45.5 铝套管（表内无此行图片）；CSP-310~313（塑料提手/提手卡片/两边卡片/底部卡片）'],
    ['缺图档-V3', 'CSP-027 电路板主板 / CSP-058 磁铁 / CSP-060 PU泡棉 / 49-002769 产品安全手册 / F LOGO / Lithium Grease / 大部分螺丝螺母（V3 rar 内无对应 PDF）'],
    ['表外图档', 'V3i rar 内有 8 个 PDF 表内无行：CSP-007、CSP-071（V3 专用件）、CSP-108/110/111/112/122/124（两边表格都没有）'],
    ['表内瑕疵-序号', 'V3 表序号列缺 30、序号 67 出现两次（3M胶贴物理位置第53行）'],
    ['表内瑕疵-重量', 'V3 序号84/85 重量列写的是「线长确认/线长未确认」备注，已按原样录入'],
    ['表内瑕疵-料号名称', 'V3I 序号7 料号写 M6x16 但名称是 M6x28，已按名称 M6x28-平头 与 V3 共用'],
    ['待补图纸-CSS_SQ', 'CSS-016 输出电子壳 / CSS-058 开关把手 / CSS-HMC-V3 滚动电子（表内无对应图档）'],
    ['缺图片-CSS_SQ', 'CSS-114 包装袋、CSS-115 CS_USB_A（表内无图）'],
    ['表内瑕疵-CSS_SQ', '序号 72 缺失；序号 55 出现两次（M2.5x5 螺丝 与 棉绳）'],
    ['口径说明-CSS_SQ', '磁铁两行分开（CSS-095 / CSS-104）、插销两行分开（CSS-101/CSS-102）、PU泡棉 CSS-062 独立建、新杂项 CSS-101 起编'],
  ]
  for (const [c, t] of todos) todoSheet.push([c, t])

  // ===== 说明 =====
  const guideSheet: unknown[][] = [
    ['《ERP 对照手册》使用说明（2026-08-25，给工程精细对照用）'],
    [''],
    ['一、命名规则（V3 定稿口径，V3I 已向 V3 靠拢）'],
    ['1. 官方料号照抄：CSP-xxx、F LOGO、Lithium Grease、49-002769、47_008450、48_016016、48-016017'],
    ['2. 铝套管按尺寸命名：CSP-013-<长度>（如 20*10→CSP-013-10、20*77.8→CSP-013-77.8）；V3 原 CSP-013-1~7 已在 ERP 中按尺寸改名'],
    ['3. 螺丝统一口径：沉头=平头、紧定螺钉=机米、盖帽=盖型；命名=规格+类型（如 M6x12-平头、M5x8-机米、M6-盖型螺母），跨机型共用'],
    ['4. 无编号杂项：V3 段 CSP-201~221；V3I 新增段 CSP-301~319；与 V3 不共用的三件：3M胶贴=CSP-321、扎线带=CSP-322、无纺布袋=CSP-323'],
    ['5. 颜色/版本区分：CSP-005（V3红色）与 CSP-005-深灰；CSP-033（V3原色）与 CSP-033-灰色；包装泡棉 V3=CSP-216-V3、V3I=CSP-216-v3i'],
    [''],
    ['二、ERP 修改分工'],
    ['- 工程账号：维护零件资料（料号/名称/图片/图档/重量/版本/材质/尺寸规格/表面处理）与 BOM 用量'],
    ['- 采购账号：维护供应商挂接与价格（零件页「供应商/价格」按钮）'],
    ['- 料号全局唯一；改料号会自动同步移动上传文件夹，图片/图档不丢'],
    [''],
    ['三、如何对照'],
    ['1. 打开本手册 V3对照 / V3I对照 页，逐行对照 ERP（基础资料→零件页，顶部「成品」下拉可只看某成品）'],
    ['2. 图片/图档状态看「图片」「图档」列（有/无）；具体图档版本看「图档对照」页'],
    ['3. 有出入直接在 ERP 里改（工程改零件/BOM，采购改供应商/价格），改完告诉我，我重新生成手册核对'],
    [''],
    ['四、ERP 当前数据概况'],
    ['- 成品：CSP-V3（CSP V3 挂档器，107 零件/107 BOM 行）、CSP-V3I（CSP V3I 脚踏板，146 BOM 行，67 个与 V3 共用）、CSS-SQ（CSS_SQ 挂档器（黑色+USB），82 BOM 行，8 个与已有零件共用）'],
    ['- 零件总数 261；CSS_SQ 新杂项编号从 CSS-101 起编（老板确认）'],
    ['- CSS_SQ 特殊口径：磁铁两行分开（CSS-095/CSS-104）、插销两行分开（CSS-101/CSS-102）、CS_USB_A=CSS-115、PU泡棉 CSS-062 独立建'],
  ]
  guideSheet.push()

  const wbOut = XLSX.utils.book_new()
  const append = (name: string, rows: unknown[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths.map((wch) => ({ wch }))
    XLSX.utils.book_append_sheet(wbOut, ws, name)
  }
  append('说明', guideSheet, [90])
  append('V3对照', v3Sheet, [8, 18, 16, 28, 6, 6, 6, 14, 46])
  append('V3I对照', v3iSheet, [8, 18, 16, 28, 6, 18, 6, 6, 14, 60])
  append('CSS-SQ对照', cssSheet, [8, 16, 16, 26, 6, 14, 6, 6, 14, 50])
  append('图档对照', dwgSheet, [6, 60, 12, 34, 26])
  append('待办与待确认', todoSheet, [22, 100])
  let finalOut = OUT
  for (const suffix of ['', '-v2', '-v3']) {
    const candidate = suffix ? OUT.replace('.xlsx', suffix + '.xlsx') : OUT
    try { XLSX.writeFile(wbOut, candidate); finalOut = candidate; break }
    catch (e) { if (String(e).includes('EBUSY')) continue; throw e }
  }
  console.log('V3 行:', v3Sheet.length - 1, '；V3I 行:', v3iSheet.length - 1, '；图档对照:', dwgSheet.length - 1, '；待办:', todoSheet.length - 1)
  console.log('已输出:', finalOut)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
