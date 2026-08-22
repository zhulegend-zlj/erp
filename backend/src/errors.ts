// 统一把 Prisma 常见错误映射为 HTTP 4xx + 中文提示，避免录入非法数据时返回 500。
// 说明：
// - P2002：唯一约束冲突（重复 SKU / 重复 orderNo 等）
// - P2003：外键约束失败（客户/供应商/零件/成品/订单等 ID 不存在）
// - P2025：update/delete 目标记录不存在
// - P2023：传入的值与列类型不匹配（例如 id 传了非数字）
export interface ErrorInfo {
  status: number
  message: string
}

export function prismaErrorInfo(err: unknown): ErrorInfo | null {
  if (err === null || typeof err !== 'object') return null
  const e = err as { code?: unknown; meta?: { target?: unknown } }
  const code = typeof e.code === 'string' ? e.code : null
  if (!code) return null

  if (code === 'P2002') {
    const target = e.meta?.target
    const field = Array.isArray(target) ? target.join('、') : target ? String(target) : '唯一字段'
    return { status: 400, message: field + ' 已存在，不能重复' }
  }
  if (code === 'P2003') {
    return { status: 400, message: '关联的数据不存在，请检查客户/供应商/零件/成品/订单等 ID' }
  }
  if (code === 'P2025') {
    return { status: 404, message: '记录不存在或已被删除' }
  }
  if (code === 'P2023') {
    return { status: 400, message: '输入数据格式不正确' }
  }
  if (code === 'P2000' || code === 'P2020') {
    return { status: 400, message: '数值超出允许范围' }
  }
  return null
}

/** 判断一个值是否可作为正整数 ID。 */
export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}
