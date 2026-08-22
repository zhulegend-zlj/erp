import { message } from 'antd'

// 后端分页响应统一形状 { items, total, page, pageSize, totalPages }
export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// 后端错误统一返回 { error: string }，这里提取给 message.error 展示
export function errMsg(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e?.response?.data?.error ?? '操作失败，请稍后重试'
}

export function notifyError(err: unknown): void {
  message.error(errMsg(err))
}

// 金额展示：后端 Decimal 字段以字符串序列化，兼容 number/string
export function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '0.00'
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function dateStr(v: number | string | Date | null | undefined): string {
  if (v === null || v === undefined || v === '') return '-'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function dateTimeStr(v: number | string | Date | null | undefined): string {
  if (v === null || v === undefined || v === '') return '-'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return `${dateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  in_production: '生产中',
  ready: '待出货',
  shipped: '已出货',
  completed: '已完成',
}

export function statusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status
}

// 订单阶段标签：采购中/生产中可同时存在；确认后未开工显示「已确认」，
// 进入运作环节后「已确认」隐藏（看板/订单/仓库统一口径）
export function orderPhaseLabel(o: { status: string; purchasing?: boolean; producing?: boolean }): string {
  if (o.status === 'draft') return '草稿'
  if (o.status === 'ready') return '待出货'
  if (o.status === 'shipped') return '已出货'
  if (o.status === 'completed') return '已完成'
  if (o.purchasing && o.producing) return '采购中 + 生产中'
  if (o.purchasing) return '采购中'
  if (o.producing) return '生产中'
  return statusLabel(o.status)
}

// 阶段标签颜色（与订单列表/看板一致）
export function phaseTagColor(o: { status: string; purchasing?: boolean; producing?: boolean }): string {
  if (o.status === 'ready') return 'warning'
  if (o.status === 'shipped') return 'cyan'
  if (o.status === 'completed') return 'success'
  if (o.status === 'draft') return 'default'
  if (o.purchasing || o.producing) return 'processing'
  return 'blue'
}

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    draft: 'default',
    confirmed: 'blue',
    in_production: 'processing',
    ready: 'warning',
    shipped: 'cyan',
    completed: 'success',
  }
  return map[status] ?? 'default'
}

// 订单状态机：draft → confirmed → in_production → ready → shipped → completed
// ready → shipped 只能通过「出货」页完成（后端已禁止 PATCH 直达），订单页不再提供该按钮
const STATUS_FLOW: Record<string, string> = {
  draft: 'confirmed',
  confirmed: 'in_production',
  in_production: 'ready',
  shipped: 'completed',
}

// 未出货前允许回退一步
const PREV_STATUS: Record<string, string> = {
  confirmed: 'draft',
  in_production: 'confirmed',
  ready: 'in_production',
}

export function nextStatus(status: string): string | null {
  return STATUS_FLOW[status] ?? null
}

export function prevStatus(status: string): string | null {
  return PREV_STATUS[status] ?? null
}
