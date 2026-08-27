// 客户截图一键建单：调 modlens（多模态视觉引擎，本机配置 gemini-api）读图，
// 再把模型输出解析成订单明细行。图片读不出时返回 ok=false，由调用方提示转人工
// （有视觉能力的智能代理）再读。
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ParsedOrderLine {
  sku: string
  qty: number
  unitPrice: number
  needByDate?: string
}

export interface ParsedOrderImage {
  po: string | null
  lines: ParsedOrderLine[]
}

// 把 OCR 全文解析成订单明细行。OCR 输出形如（每行一张订单行，空格分词）：
//   270993 1 Dongguan Zhiruiheng Electronic Co., Ltd CN VUC DFW 100 SP-CSS_T-SLOT_NUTS SP-CSS T-Slot nuts 30 2026/8/22 Ocean 7 210
// 列：PO、Line、供应商、国家、到货仓、仓位置、SKU、描述、Density、Qty、Need-by 日期、运输方式、Unit Cost、PO Cost。
// 用锚点解析（不依赖固定列位，仓库名可能带空格）：
//   SKU = 第一个含 _ 或 - 的字母数字串；日期 = yyyy/m/d 或 m/d；
//   数量 = 日期前最后一个数字；单价 = 日期后（跳过运输方式单词）第一个数字；
//   没日期时退化为「后两个数字 = 数量、单价」（简单两列表格）。
// 也兼容简单列表格式（一行 = SKU 数量 单价）。
const SKU_RE = /^[A-Za-z0-9]+[_-][A-Za-z0-9_-]*$/
const DATE_RE = /^(\d{4}[\/]\d{1,2}[\/]\d{1,2}|\d{1,2}[\/]\d{1,2})$/
const NUM_RE = /^-?\d+(\.\d+)?$/
const SUPPLIER_RE = /^Dongguan/i

function parseRow(tokens: string[]): { po: string | null; line: ParsedOrderLine | null } {
  let start = 0
  let po: string | null = null
  // 客户 PO 表行首：<PO号≥4位数字> <行号1..99> <Dongguan...>
  if (
    tokens.length >= 3 &&
    /^\d{4,}$/.test(tokens[0] ?? '') &&
    /^\d{1,2}$/.test(tokens[1] ?? '') &&
    SUPPLIER_RE.test(tokens[2] ?? '')
  ) {
    po = tokens[0] ?? null
    start = 3
  }
  const skuIdx = tokens.findIndex((t, i) => i >= start && SKU_RE.test(t))
  if (skuIdx === -1) return { po, line: null }
  const sku = tokens[skuIdx] ?? ''
  if (!sku) return { po, line: null }
  const after = tokens.slice(skuIdx + 1)

  // 日期锚点（含年份优先）
  let dateIdx = after.findIndex((t) => DATE_RE.test(t))
  if (dateIdx !== -1 && !/^\d{4}[\/]/.test(after[dateIdx] ?? '')) {
    const withYear = after.findIndex((t) => /^\d{4}[\/]\d{1,2}[\/]\d{1,2}$/.test(t))
    if (withYear !== -1) dateIdx = withYear
  }

  const numsBeforeDate: number[] = []
  const numsAfterDate: number[] = []
  for (let i = 0; i < after.length; i++) {
    if (i === dateIdx) continue
    if (!NUM_RE.test(after[i] ?? '')) continue
    if (dateIdx !== -1 && i > dateIdx) numsAfterDate.push(Number(after[i]))
    else numsBeforeDate.push(Number(after[i]))
  }

  let qty = 0
  let unitPrice = 0
  let needByDate: string | undefined
  if (dateIdx !== -1) {
    needByDate = after[dateIdx] ?? undefined
    // 数量 = 日期前最后一个数字（跳过描述里的数字噪音时仍尽量对）
    const q = numsBeforeDate[numsBeforeDate.length - 1]
    // 单价 = 日期后第一个数字（运输方式 Ocean 是单词被跳过）；必要时跳过 PO Cost
    const p = numsAfterDate[0]
    if (q === undefined || p === undefined) return { po, line: null }
    qty = q
    unitPrice = p
  } else {
    // 无日期：后两个数字 = 数量、单价（简单列表：SKU 数量 单价）
    if (numsBeforeDate.length < 2) return { po, line: null }
    qty = numsBeforeDate[numsBeforeDate.length - 2] ?? 0
    unitPrice = numsBeforeDate[numsBeforeDate.length - 1] ?? 0
  }

  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
    return { po, line: null }
  }
  return { po, line: { sku, qty: Math.round(qty), unitPrice, ...(needByDate !== undefined ? { needByDate } : {}) } }
}

export function parseOrderImageText(text: string): ParsedOrderImage {
  const lines: ParsedOrderLine[] = []
  let po: string | null = null
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const tokens = raw.split(/\s+/).filter(Boolean)
    if (tokens.length < 3) continue
    const { po: rowPo, line } = parseRow(tokens)
    if (!line) continue
    if (rowPo && po === null) po = rowPo
    // 同一 SKU 重复出现（多仓拆行）允许保留，但完全相同的 SKU+数量+单价行去重（OCR 重复行）
    const key = line.sku + '|' + line.qty + '|' + line.unitPrice
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line)
  }
  return { po, lines }
}

export interface ModlensOutcome {
  ok: boolean
  error?: string
  rawText: string
}

export async function readOrderImageWithModlens(imagePath: string, timeoutMs = 150000): Promise<ModlensOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'erp-orderimg-'))
  const outPath = join(dir, 'result.json')
  // 注意：Windows 下不能直接 spawn .cmd（Node 20+ 抛 EINVAL），走 cmd.exe /d /s /c；
  // prompt 里不能用 双引号/竖线/& 等 cmd 特殊字符，故用单引号与 / 分隔。
  const prompt = [
    'This is a screenshot of a customer purchase order table.',
    '1) If you can find a PO number, output a line starting with PO: followed by the number.',
    '2) For EVERY table row, output ONE line exactly in this format:',
    '   ROW: <item SKU code> / <qty> / <unit cost> / <need-by date if visible>',
    'Do not include any other rows, explanations or markdown. Only PO: and ROW: lines.',
  ].join('; ')
  try {
    await new Promise<void>((resolveP, rejectP) => {
      execFile(
        'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          'npx',
          '--yes',
          '@liustack/modlens',
          'analyze',
          '-i',
          imagePath,
          '-p',
          'gemini-api',
          '--prompt',
          prompt,
          '--timeout',
          String(timeoutMs),
          '-o',
          outPath,
        ],
        { windowsHide: true, timeout: timeoutMs + 30000, maxBuffer: 10 * 1024 * 1024 },
        (err) => (err ? rejectP(err) : resolveP()),
      )
    })
    const result = JSON.parse(await readFile(outPath, 'utf8')) as {
      result?: {
        summary?: string
        ocr?: { full_text?: string; lines?: Array<{ text?: string }> }
        layout?: { regions?: Array<{ text?: string }> }
      }
    }
    const inner = result.result ?? {}
    const text = [
      inner.summary ?? '',
      inner.ocr?.full_text ?? '',
      (inner.ocr?.lines ?? []).map((l) => l.text ?? '').join('\n'),
      (inner.layout?.regions ?? []).map((r) => r.text ?? '').join('\n'),
    ]
      .filter(Boolean)
      .join('\n')
    return { ok: true, rawText: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '识别失败', rawText: '' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
