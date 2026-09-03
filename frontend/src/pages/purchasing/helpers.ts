// 双价自动算：含税价 = 不含税价 × (1 + 加税点数/100)
// 精度跟随输入的不含税价小数位（最少 2 位、最多 4 位，老板 2026-09-02：手输 4 位就按 4 位）
export function calcInclTax(price: number | null | undefined, taxPoint: number | null | undefined): number | null {
  if (price === null || price === undefined) return null
  const tp = Number(taxPoint ?? 0)
  const v = Number(price) * (1 + (Number.isNaN(tp) ? 0 : tp) / 100)
  const decStr = (Number(price).toString().split('.')[1] ?? '').length
  const prec = Math.min(4, Math.max(2, decStr))
  const m = Math.pow(10, prec)
  return Math.round(v * m) / m
}

// 字母编号：A→Z，跳过 I/O（两字母时前缀也跳过 I/O）
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export function poLetter(index: number): string {
  if (index < 0) return 'A'
  if (index < LETTERS.length) return LETTERS[index]
  const first = LETTERS[Math.floor(index / LETTERS.length) - 1] ?? 'A'
  const second = LETTERS[index % LETTERS.length]
  return first + second
}

export const PO_STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '未下单', color: 'default' },
  sent: { label: '已下单', color: 'blue' },
  printed: { label: '已打印', color: 'purple' },
  confirmed: { label: '已回签', color: 'green' },
}

const PO_STATUS_FLOW: Record<string, string> = {
  pending: 'sent',
  sent: 'printed',
  printed: 'confirmed',
}

export function nextPoStatus(poStatus: string): string | null {
  return PO_STATUS_FLOW[poStatus] ?? null
}

export const PO_STATUS_NEXT_LABEL: Record<string, string> = {
  pending: '标记已下单',
  sent: '标记已打印',
  printed: '标记已回签',
}

export const RECEIPT_STATUS_META: Record<string, { label: string; color: string }> = {
  open: { label: '待收货', color: 'orange' },
  partial: { label: '部分收货', color: 'blue' },
  received: { label: '已收货', color: 'green' },
}

export function poTypeLabel(poType: string): string {
  return poType === 'spare' ? '备品' : '正常'
}

export function poTypeColor(poType: string): string {
  return poType === 'spare' ? 'orange' : 'processing'
}
