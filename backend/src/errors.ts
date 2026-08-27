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

// Prisma 表名 → 业务中文名（用于 P2003 外键提示，让老板能看懂）
const MODEL_LABELS: Record<string, string> = {
  SalesOrder: '销售订单',
  SalesOrderItem: '订单明细',
  PurchaseOrder: '采购单',
  PurchaseOrderItem: '采购明细',
  Customer: '客户',
  CustomerPayment: '收款记录',
  Supplier: '供应商',
  SupplierPayment: '付款记录',
  Product: '成品',
  Part: '零件',
  Bom: 'BOM 记录',
  Receipt: '收货记录',
  Issue: '领料记录',
  ProductionEntry: '成品入库',
  Shipment: '出货单',
  ShipmentLine: '出货明细',
  ShipmentSchedule: '出货排程',
  ShipmentLeg: '运输节点',
  ReturnReplenish: '退补货记录',
  InventoryLedger: '库存流水',
  Stock: '库存',
  ShipToHub: '到货仓',
  CompanyProfile: '公司资料',
  User: '账号',
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
    // 两种方向：①新增/修改时引用了不存在的记录（ID 不存在）；②删除/修改时被关联单据引用而受阻。
    const modelName = (e.meta as { modelName?: string } | undefined)?.modelName
    const label = modelName ? MODEL_LABELS[modelName] ?? modelName : '其他单据'
    return {
      status: 400,
      message: `关联数据阻止了操作：引用的记录不存在，或该记录已被单据引用无法删除（涉及：${label}）`,
    }
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

/**
 * 路由 catch 统一出口：业务错误（我们主动 throw 的中文消息）按语义返回 400/404；
 * 其余（Prisma 校验/连接器等内部错误）一律 500 且不回显内部细节——防止路径/源码/SQL 泄漏。
 * notFoundKeys：命中这些关键词的业务错误返回 404（如 不存在），默认 400。
 */
export function routeError(err: unknown, notFoundKeys: string[] = []): { status: number; message: string } {
  if (!(err instanceof Error)) return { status: 500, message: '服务器错误，请稍后重试' }
  const message = err.message
  const isBusiness = /[\u4e00-\u9fa5]/.test(message)
  if (isBusiness) {
    const status = notFoundKeys.some((k) => message.includes(k)) ? 404 : 400
    return { status, message }
  }
  const info = prismaErrorInfo(err)
  if (info) return { status: info.status, message: info.message }
  return { status: 500, message: '服务器错误，请稍后重试' }
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
