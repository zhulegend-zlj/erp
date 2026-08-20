import { message } from 'antd'

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
const STATUS_FLOW: Record<string, string> = {
  draft: 'confirmed',
  confirmed: 'in_production',
  in_production: 'ready',
  ready: 'shipped',
  shipped: 'completed',
}

export function nextStatus(status: string): string | null {
  return STATUS_FLOW[status] ?? null
}
