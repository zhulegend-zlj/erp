import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { bomExplode, computePurchasePlan, usageDisplay } from '../domain/bom'
import { mergeBase, nextLetterForBase, nextSpareNo, nextTwoLetterForBase } from '../domain/po-numbering'
import { applyStockChange } from '../domain/inventory'
import { outstandingQty, recordReceipt } from '../domain/receipt'
import { markPurchasingStarted, refreshPurchasingPhase, refreshPurchasingPhaseAfterUndo } from '../domain/order-phase'
import { parsePositiveInt, prismaErrorInfo, routeError } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
import { markDirectRenderEnd, markDirectRenderStart, renderPoToFiles, renderKey } from '../domain/po-render'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const PO_TEMPLATE_DIR = resolve(process.cwd(), 'templates')

const purchaseItemSchema = z.object({
  partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
  qty: z
    .number({ error: '数量必填' })
    .int({ error: '数量必须为整数' })
    .positive({ error: '数量必须为正整数' })
    .max(2147483647, { error: '数量超出允许范围' }),
  unitPrice: z
    .number({ error: '单价必填' })
    .nonnegative({ error: '单价必须为非负数' })
    .max(9999999999.99, { error: '单价超出允许范围' }),
  // 重构新增（全部可选，旧请求体原样可用）
  unitPriceInclTax: z.number({ error: '含税单价必须为数字' }).nonnegative().max(9999999999.99).nullable().optional(),
  usage: z.number({ error: '用量必须为数字' }).positive().max(9999.9999, { error: '用量超出允许范围' }).nullable().optional(),
  note: z.string().max(500, { error: '备注超长' }).nullable().optional(),
  supplierReplyDate: z.coerce.date().nullable().optional(),
  splitNo: z.number({ error: '批次号必须为整数' }).int().nonnegative().optional(), // 拆单：同供应商同零件不同批次生成多张单
})

const createPurchaseOrderSchema = z.object({
  supplierId: z.number({ error: '供应商必填' }).int({ error: '供应商必须为整数' }).positive({ error: '供应商必须为正整数' }),
  salesOrderId: z.number().int().positive().optional(),
  salesOrderIds: z.array(z.number().int().positive(), { error: '关联订单必须为正整数数组' }).max(50).optional(),
  poStatus: z.enum(['pending', 'sent', 'printed', 'confirmed']).optional(),
  poType: z.enum(['normal', 'spare', 'selfbuy']).optional(),
  orderDate: z.coerce.date().nullable().optional(),
  expectedDeliveryDate: z.string().max(200).nullable().optional(), // 预计交货时间（文本，如 2026.03.01开始每周交1000套）
  paymentTerms: z.string().max(100).nullable().optional(),
  termsNote: z.string().max(1000).nullable().optional(),
  headerName: z.string().max(100).nullable().optional(),
  taxPoint: z.number({ error: '加税点必须为数字' }).min(0).max(100).nullable().optional(),
  manualOrderNo: z.string().min(1).max(100).optional(), // 手工编号（覆盖自动编号）
  items: z.array(purchaseItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
})

// 批量生成允许行级供应商覆盖（未挂供应商的零件可在弹窗里现选，不强制先写回零件资料）
const batchItemSchema = purchaseItemSchema.extend({
  supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
  // 自购件：不出给供应商，自动归「自购」采购单（供应商 shortName=自购）
  selfBuy: z.boolean().optional(),
})
const batchPurchaseOrderSchema = createPurchaseOrderSchema
  .omit({ supplierId: true })
  .extend({
    items: z.array(batchItemSchema, { error: '明细必填' }).min(1, '采购单至少包含一个明细'),
  })

const receiptItemSchema = z
  .object({
    partId: z.number({ error: '零件必填' }).int({ error: '零件必须为整数' }).positive({ error: '零件必须为正整数' }),
    qty: z
      .number({ error: '数量必填' })
      .int({ error: '数量必须为整数' })
      .positive({ error: '数量必须为正整数' })
      .max(2147483647, { error: '数量超出允许范围' }),
    lotNo: z.string().nullable().optional(),
    qcStatus: z.string().nullable().optional(),
    defectiveQty: z.number({ error: '不良品数量必须为整数' }).int().nonnegative().nullable().optional(),
    // 自购买（无采购单）时可选挂供应商便于追溯
    supplierId: z.number({ error: '供应商必须为整数' }).int().positive().nullable().optional(),
  })
  .refine((v) => (v.defectiveQty ?? 0) <= v.qty, {
    message: '不良品数量不能大于收货数量',
  })

// 收货两种模式：有采购单（校验归属/不超量/推进状态）或自购买（purchaseOrderId 不传）
const receiptSchema = z.object({
  purchaseOrderId: z.number({ error: '采购单必须为整数' }).int().positive().nullable().optional(),
  // 超收放行：前端确认「已超收 X，确认继续？」后传 true（老板口径：供应商多送要记录）
  allowOverQty: z.boolean().optional(),
  // 送货单日期（采购照送货单录；不传则视为录入时间）
  deliveryDate: z.coerce.date().nullable().optional(),
  items: z.array(receiptItemSchema, { error: '明细必填' }).min(1, '收货至少包含一个明细'),
})

// 收货记录修改：仓库 QC 补录（lotNo/qcStatus/defectiveQty）+ 采购跟进改交货数量/送货日期
// （改数量会同步库存、重算采购单状态，并写 DeliveryEditLog 留痕）
const patchReceiptSchema = z.object({
  lotNo: z.string().max(100, '来料单号过长').nullable().optional(),
  qcStatus: z.string().nullable().optional(),
  defectiveQty: z.number({ error: '不良品数量必须为整数' }).int().nonnegative().optional(),
  qty: z.number({ error: '数量必须为整数' }).int().positive().max(2147483647).optional(),
  deliveryDate: z.coerce.date().nullable().optional(),
  allowOverQty: z.boolean().optional(),
})

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('；')
    reply.code(400).send({ error: message })
    return null
  }
  return result.data
}

const READ_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const PURCHASE_ORDER_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  salesOrder: { select: { id: true, orderNo: true } },
  salesOrders: { include: { salesOrder: { select: { id: true, orderNo: true } } } },
  items: {
    include: { part: { select: { id: true, sku: true, name: true, unit: true, sourcing: true } } },
    orderBy: { id: 'asc' as const },
  },
  payments: true,
} as const

function utcDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

// 采购单号规则（2026-08-29 老板拍板，字母口径，引擎在 domain/po-numbering.ts）：
// 1) 挂 1 个销售订单：订单号（=客户PO号）+ 字母 A→Z 跳 I/O，订单内递增（如 259203A）
// 2) 挂多个销售订单（合并）：<首PO>-<末PO后3位>+字母（如 259283-288E），合并组内递增
// 3) 自购/现金（无订单）：PO-YYYYMMDD-AA/AB/AC…（当天递增，两位字母组合跳 I/O）
// 4) 手工编号 manualOrderNo 优先（调用方做唯一性预检）
async function nextPurchaseOrderNo(
  salesOrderIds: number[] | null,
  tx: Prisma.TransactionClient,
  manualOrderNo?: string,
  poType: 'normal' | 'spare' | 'selfbuy' = 'normal',
): Promise<string> {
  if (manualOrderNo) return manualOrderNo
  // 免费备品单：<订单号>备品（重复加 -2/-3）；不挂订单的备品单必须手工编号
  if (poType === 'spare') {
    if (salesOrderIds === null || salesOrderIds.length === 0) {
      throw new Error('不挂订单的免费备品单请手工输入编号')
    }
    const orders = await tx.salesOrder.findMany({
      where: { id: { in: salesOrderIds } },
      select: { orderNo: true },
      orderBy: { id: 'asc' as const },
    })
    const rows = await tx.purchaseOrder.findMany({ select: { orderNo: true } })
    const no = nextSpareNo(rows.map((r) => r.orderNo), orders[0]?.orderNo ?? null)
    if (!no) throw new Error('免费备品单编号已用完，请手工输入编号')
    return no
  }
  // 自购单：<订单号>-自购（重复加 -2/-3）；不挂订单 = PO-YYYYMMDD-自购
  if (poType === 'selfbuy') {
    const firstOrder = salesOrderIds?.length
      ? await tx.salesOrder.findFirst({ where: { id: salesOrderIds[0]! }, select: { orderNo: true } })
      : null
    const base = (firstOrder?.orderNo ?? 'PO-' + utcDateStamp()) + '-自购'
    const rows = await tx.purchaseOrder.findMany({ where: { orderNo: { startsWith: base } }, select: { orderNo: true } })
    const exists = new Set(rows.map((r) => r.orderNo))
    let no = base
    let i = 2
    while (exists.has(no)) {
      no = base + '-' + i
      i++
    }
    return no
  }
  if (salesOrderIds === null || salesOrderIds.length === 0) {
    const base = `PO-${utcDateStamp()}-`
    const rows = await tx.purchaseOrder.findMany({ where: { orderNo: { startsWith: base } }, select: { orderNo: true } })
    const two = nextTwoLetterForBase(rows.map((r) => r.orderNo), base)
    if (!two) throw new Error('当天自购采购单编号已用完，请手工输入编号')
    return base + two
  }
  const orders = await tx.salesOrder.findMany({
    where: { id: { in: salesOrderIds } },
    select: { orderNo: true },
    orderBy: { id: 'asc' as const },
  })
  if (orders.length !== salesOrderIds.length) throw new Error('关联订单不存在')
  const base = orders.length === 1 ? orders[0]!.orderNo : mergeBase(orders.map((o) => o.orderNo))
  const rows = await tx.purchaseOrder.findMany({ where: { orderNo: { startsWith: base } }, select: { orderNo: true } })
  const letter = nextLetterForBase(rows.map((r) => r.orderNo), base)
  if (!letter) throw new Error('该订单采购单字母编号已用完，请手工输入编号')
  return base + letter
}

export function purchasingRoutes(app: FastifyInstance) {
  // 需求计算：purchase / boss 可查；支持单订单（orderId，兼容旧前端）与多订单合并（orderIds）
  app.get('/api/purchasing/requirements', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const q = req.query as { orderId?: string; orderIds?: string }
    const orderIds: number[] = []
    if (q.orderIds) {
      for (const part of String(q.orderIds).split(',')) {
        const n = Number(part.trim())
        if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'orderIds 必须为正整数列表' })
        orderIds.push(n)
      }
    }
    if (q.orderId) {
      const n = Number(q.orderId)
      if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'orderId 必填且为正整数' })
      if (!orderIds.includes(n)) orderIds.push(n)
    }
    if (orderIds.length === 0) {
      return reply.code(400).send({ error: 'orderId 或 orderIds 必填' })
    }

    const orders = await prisma.salesOrder.findMany({
      where: { id: { in: orderIds } },
      include: { items: true },
    })
    if (orders.length !== new Set(orderIds).size) {
      return reply.code(404).send({ error: '存在不存在的订单' })
    }
    const allItems = orders.flatMap((o) => o.items)
    const productIds = [...new Set(allItems.map((item) => item.productId))]
    const boms = await prisma.bom.findMany({ where: { productId: { in: productIds } } })

    // 跨所有订单明细累加同一零件的 requiredQty（多订单合并口径）
    const requiredMap = new Map<number, number>()
    for (const item of allItems) {
      for (const r of bomExplode(item.productId, item.qty, boms)) {
        requiredMap.set(r.partId, (requiredMap.get(r.partId) ?? 0) + r.requiredQty)
      }
    }
    const requirements = [...requiredMap.entries()].map(([partId, requiredQty]) => ({ partId, requiredQty }))
    const partIds = requirements.map((r) => r.partId)

    // 零件 → 各成品 BOM 用量明细（用于「用量/台」显示：单一用量显示整数，多成品不同用量显示明细）
    const usageByPart = new Map<number, Map<number, number>>()
    for (const b of boms) {
      const m = usageByPart.get(b.partId) ?? new Map<number, number>()
      m.set(b.productId, (m.get(b.productId) ?? 0) + Number(b.qty))
      usageByPart.set(b.partId, m)
    }
    // 共用料识别：同一零件挂在 ≥2 个不同成品 BOM 里
    const productsByPart = new Map<number, Set<number>>()
    for (const b of boms) {
      const set = productsByPart.get(b.partId) ?? new Set<number>()
      set.add(b.productId)
      productsByPart.set(b.partId, set)
    }

    const [parts, stocks, products] = await Promise.all([
      prisma.part.findMany({
        where: { id: { in: partIds } },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      prisma.stock.findMany({ where: { itemType: 'part', itemId: { in: partIds } } }),
      prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }),
    ])
    const productSkuMap = new Map(products.map((p) => [p.id, p.sku]))
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const stockMap = new Map(stocks.map((s) => [s.itemId, s.qtyOnHand]))
    const safetyStockMap = new Map(
      parts.filter((p) => p.safetyStock != null).map((p) => [p.id, p.safetyStock as number]),
    )
    const planMap = new Map(
      computePurchasePlan(requirements, stockMap, safetyStockMap).map((g) => [g.partId, g]),
    )

    return requirements.map((r) => {
      const part = partMap.get(r.partId)
      const onHand = stockMap.get(r.partId) ?? 0
      const usage = usageDisplay(usageByPart.get(r.partId), productSkuMap)
      const plan = planMap.get(r.partId)
      // 采购方式口径（2026-09-01 老板设计）：外购总进采购单；自购仅库存不足时带入（提醒采购）；
      // 自制永远不进采购单。需求表仍返回全部零件（前端标灰/标记）。
      const sourcing = part?.sourcing ?? 'purchased'
      const gapQty = plan?.gapQty ?? 0
      let includeInPo = true
      let excluded = false
      let excludedReason = ''
      if (sourcing === 'selfmade') {
        includeInPo = false
        excluded = true
        excludedReason = '自制（工厂打印）'
      } else if (sourcing === 'selfbuy' && gapQty <= 0) {
        includeInPo = false
        excluded = true
        excludedReason = '自购·库存充足'
      }
      return {
        partId: r.partId,
        sku: part?.sku ?? '',
        partName: part?.name ?? '',
        supplierId: part?.supplierId ?? null,
        supplierName: part?.supplier?.name ?? '',
        price: part?.price != null ? part.price.toNumber() : null,
        priceInclTax: part?.priceInclTax != null ? part.priceInclTax.toNumber() : null,
        moq: part?.moq ?? null,
        leadTime: part?.leadTime ?? null,
        safetyStock: part?.safetyStock ?? null,
        isCommonPart: (productsByPart.get(r.partId)?.size ?? 0) >= 2,
        sourcing,
        // 自购件库存不足被带入采购单时标记（前端橙色行 + 顶部横幅提醒）
        isSelfBuy: sourcing === 'selfbuy',
        includeInPo,
        excluded,
        excludedReason,
        ...usage,
        requiredQty: r.requiredQty,
        onHand,
        gapQty,
        // 建议采购量：安全库存补货后的数量（未触发时 = gapQty）
        suggestedQty: plan?.suggestedQty ?? 0,
      }
    })
  })

  // 采购单列表：5 角色均可查，可选按状态/供应商/销售订单过滤，sort=orderNo 时按编号排序
  app.get('/api/purchase-orders', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const query = req.query as { status?: string; supplierId?: string; salesOrderId?: string; sort?: string }
    const where: Prisma.PurchaseOrderWhereInput = {}
    if (query.status) where.status = query.status
    if (query.supplierId) {
      const supplierId = Number(query.supplierId)
      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return reply.code(400).send({ error: 'supplierId 必须为正整数' })
      }
      where.supplierId = supplierId
    }
    if (query.salesOrderId) {
      const salesOrderId = Number(query.salesOrderId)
      if (!Number.isInteger(salesOrderId) || salesOrderId <= 0) {
        return reply.code(400).send({ error: 'salesOrderId 必须为正整数' })
      }
      // 主订单 + 关联中间表都匹配：合并下单的单子按任一关联订单都能筛出来（老板反馈 2026-08-31）
      where.OR = [{ salesOrderId }, { salesOrders: { some: { salesOrderId } } }]
    }

    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })

    // 采购单价口径（BUG-09）：与零件价格一致——仅 采购/老板/财务 可见，销售/仓库/工程剥离
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const hidePrice = ['sales', 'warehouse', 'engineer'].includes(role)
    const toRow = (po: Prisma.PurchaseOrderGetPayload<{ include: typeof PURCHASE_ORDER_INCLUDE }>, receivedQty: number) => {
      const totalAmount = po.items.reduce((sum, it) => sum + it.qty * it.unitPrice.toNumber(), 0)
      const paidAmount = po.payments.reduce((sum, p) => sum + p.amount.toNumber(), 0)
      const orderedQty = po.items.reduce((sum, it) => sum + it.qty, 0)
      return {
        id: po.id,
        orderNo: po.orderNo,
        status: po.status,
        poStatus: po.poStatus,
        poType: po.poType,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        paymentTerms: po.paymentTerms,
        termsNote: po.termsNote,
        headerName: po.headerName,
        taxPoint: po.taxPoint != null ? po.taxPoint.toNumber() : null,
        supplierId: po.supplierId,
        supplierName: po.supplier.name,
        salesOrderId: po.salesOrderId,
        salesOrderNo: po.salesOrder?.orderNo ?? '',
        salesOrders: po.salesOrders.map((l) => ({ id: l.salesOrder.id, orderNo: l.salesOrder.orderNo })),
        createdAt: po.createdAt,
        totalAmount,
        paidAmount,
        outstanding: Math.max(0, totalAmount - paidAmount),
        // 收货进度：仓库收货下拉里显示「已收 X/Y」（反馈）
        orderedQty,
        receivedQty,
        items: po.items.map((it) => ({
          id: it.id,
          partId: it.partId,
          sku: it.part.sku,
          name: it.part.name,
          unit: it.part.unit,
          sourcing: it.part.sourcing,
          qty: it.qty,
          usage: it.usage?.toNumber() ?? null,
          note: it.note,
          supplierReplyDate: it.supplierReplyDate,
          ...(hidePrice ? {} : { unitPrice: it.unitPrice.toNumber(), unitPriceInclTax: it.unitPriceInclTax?.toNumber() ?? null }),
        })),
      }
    }

    // 批量附带每张采购单的已收数量
    const enrich = async (rows: Array<Prisma.PurchaseOrderGetPayload<{ include: typeof PURCHASE_ORDER_INCLUDE }>>) => {
      if (rows.length === 0) return []
      const groups = await prisma.receipt.groupBy({
        by: ['purchaseOrderId'],
        where: { purchaseOrderId: { in: rows.map((r) => r.id) } },
        _sum: { qty: true },
      })
      const receivedMap = new Map<number, number>()
      groups.forEach((g) => {
        if (g.purchaseOrderId !== null) receivedMap.set(g.purchaseOrderId, g._sum.qty ?? 0)
      })
      return rows.map((r) => toRow(r, receivedMap.get(r.id) ?? 0))
    }

    // 默认新单在前；sort=orderNo 时按编号升序（A、B、C…，老板反馈 2026-08-31）
    const orderBy = query.sort === 'orderNo' ? { orderNo: 'asc' as const } : { id: 'desc' as const }
    if (pagination.kind === 'none') {
      const rows = await prisma.purchaseOrder.findMany({ where, orderBy, include: PURCHASE_ORDER_INCLUDE })
      return enrich(rows)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        orderBy,
        include: PURCHASE_ORDER_INCLUDE,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.purchaseOrder.count({ where }),
    ])
    return pagedResult(await enrich(rows), total, page)
  })

  // 解析关联订单：salesOrderIds（多单合并）优先，兼容旧 salesOrderId
  // 校验草稿订单拦截 + 唯一性预检
  async function prepareOrders(
    data: { salesOrderId?: number | undefined; salesOrderIds?: number[] | undefined; manualOrderNo?: string | undefined },
  ): Promise<{ salesOrderIds: number[] | null; manualOrderNo: string | undefined }> {
    const ids: number[] = []
    if (data.salesOrderIds && data.salesOrderIds.length > 0) ids.push(...data.salesOrderIds)
    if (data.salesOrderId != null && !ids.includes(data.salesOrderId)) ids.push(data.salesOrderId)
    // 草稿订单不能生成采购单：需先提醒销售确认（老板口径 2026-08-26）
    if (ids.length > 0) {
      const draft = await prisma.salesOrder.findMany({
        where: { id: { in: ids }, status: 'draft' },
        select: { orderNo: true },
      })
      if (draft.length > 0) {
        throw new Error('销售还未确认订单「' + draft.map((d) => d.orderNo).join('、') + '」（草稿状态），请提醒销售确认后再生成采购单')
      }
    }
    // 手工编号唯一性预检（orderNo 是退补货/财务/台账的关联键，必须全局唯一）
    if (data.manualOrderNo) {
      const exists = await prisma.purchaseOrder.findUnique({ where: { orderNo: data.manualOrderNo } })
      if (exists) throw new Error('采购单编号「' + data.manualOrderNo + '」已存在，请换一个编号')
    }
    return { salesOrderIds: ids.length > 0 ? ids : null, manualOrderNo: data.manualOrderNo }
  }

  // 公共字段（新增字段全部可空，旧请求体不传则为 null/默认）
  function poFields(data: {
    poStatus?: string | undefined
    poType?: string | undefined
    orderDate?: Date | null | undefined
    expectedDeliveryDate?: string | null | undefined
    paymentTerms?: string | null | undefined
    termsNote?: string | null | undefined
    headerName?: string | null | undefined
    taxPoint?: number | null | undefined
  }) {
    return {
      poStatus: data.poStatus ?? 'pending',
      poType: data.poType ?? 'normal',
      orderDate: data.orderDate ?? new Date(),
      expectedDeliveryDate: data.expectedDeliveryDate ?? null,
      paymentTerms: data.paymentTerms ?? null,
      termsNote: data.termsNote ?? null,
      headerName: data.headerName ?? null,
      taxPoint: data.taxPoint ?? null,
    }
  }

  function itemData(item: {
    partId: number
    qty: number
    unitPrice: number
    unitPriceInclTax?: number | null | undefined
    usage?: number | null | undefined
    note?: string | null | undefined
    supplierReplyDate?: Date | null | undefined
  }, fallbackUsage?: number | null) {
    return {
      partId: item.partId,
      qty: item.qty,
      unitPrice: item.unitPrice,
      unitPriceInclTax: item.unitPriceInclTax ?? null,
      usage: item.usage ?? fallbackUsage ?? null,
      note: item.note ?? null,
      supplierReplyDate: item.supplierReplyDate ?? null,
    }
  }

  /** 用量兜底：明细未带用量时按关联订单成品 BOM 计算（2026-09-08 老板发现 265443E 导出无用量） */
  async function bomUsageFallback(
    salesOrderIds: number[] | undefined,
    items: Array<{ partId: number }>,
  ): Promise<Map<number, number | null>> {
    const out = new Map<number, number | null>()
    if (!salesOrderIds || salesOrderIds.length === 0) return out
    const soItems = await prisma.salesOrderItem.findMany({
      where: { orderId: { in: salesOrderIds } },
      select: { productId: true },
    })
    const productIds = [...new Set(soItems.map((i) => i.productId))]
    if (productIds.length === 0) return out
    const boms = await prisma.bom.findMany({ where: { productId: { in: productIds } } })
    const byPart = new Map<number, Map<number, number>>()
    for (const b of boms) {
      const m = byPart.get(b.partId) ?? new Map<number, number>()
      m.set(b.productId, (m.get(b.productId) ?? 0) + Number(b.qty))
      byPart.set(b.partId, m)
    }
    for (const it of items) {
      const m = byPart.get(it.partId)
      const values = m ? [...new Set(m.values())] : []
      out.set(it.partId, values.length === 1 ? (values[0] ?? null) : null)
    }
    return out
  }

  // —— 采购单流转状态（poStatus）：pending→sent→printed→confirmed 单向，采购/老板改；与收货进度 status 完全分离
  app.patch('/api/purchase-orders/:id/status', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    const body = (req.body ?? {}) as { poStatus?: unknown }
    const seq = ['pending', 'sent', 'printed', 'confirmed']
    if (typeof body.poStatus !== 'string' || !seq.includes(body.poStatus)) {
      return reply.code(400).send({ error: 'poStatus 必须是 pending/sent/printed/confirmed' })
    }
    const po = await prisma.purchaseOrder.findUnique({ where: { id } })
    if (!po) return reply.code(404).send({ error: '采购单不存在' })
    if (seq.indexOf(body.poStatus) !== seq.indexOf(po.poStatus) + 1) {
      return reply.code(400).send({ error: '状态只能按顺序向后流转（未下单→已下单→已打印→已回签）' })
    }
    const updated = await prisma.purchaseOrder.update({ where: { id }, data: { poStatus: body.poStatus } })
    return reply.code(200).send(updated)
  })

  // —— 采购单编辑改单（留历史）：未收货（无收货/付款/退补货记录）才可改；before/after 快照进 EditLog
  app.patch('/api/purchase-orders/:id', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: { include: { part: { select: { id: true, sku: true } } } } },
    })
    if (!po) return reply.code(404).send({ error: '采购单不存在' })
    // 锁定：有业务痕迹（收货/付款/退补货）不能再改（老板口径：未收货前可改，改动留历史）
    const [receipts, payments, rrs] = await Promise.all([
      prisma.receipt.count({ where: { purchaseOrderId: id } }),
      prisma.supplierPayment.count({ where: { purchaseOrderId: id } }),
      prisma.returnReplenish.count({ where: { purchaseOrderNo: po.orderNo } }),
    ])
    if (receipts > 0 || payments > 0 || rrs > 0) {
      return reply.code(400).send({ error: '该采购单已有收货/付款/退补货记录，不能再编辑' })
    }
    const body = (req.body ?? {}) as {
      orderNo?: unknown
      expectedDeliveryDate?: unknown
      paymentTerms?: unknown
      termsNote?: unknown
      headerName?: unknown
      taxPoint?: unknown
      orderDate?: unknown
      items?: unknown
    }
    const data: Record<string, unknown> = {}
    if ('orderNo' in body) {
      if (typeof body.orderNo !== 'string' || body.orderNo.trim() === '' || body.orderNo.length > 100) {
        return reply.code(400).send({ error: '采购单编号必须为非空字符串' })
      }
      const trimmed = body.orderNo.trim()
      if (trimmed !== po.orderNo) {
        const exists = await prisma.purchaseOrder.findUnique({ where: { orderNo: trimmed } })
        if (exists) return reply.code(400).send({ error: '采购单编号「' + trimmed + '」已存在' })
        data.orderNo = trimmed
      }
    }
    if ('expectedDeliveryDate' in body) data.expectedDeliveryDate = typeof body.expectedDeliveryDate === 'string' && body.expectedDeliveryDate !== '' ? body.expectedDeliveryDate : null
    if ('paymentTerms' in body) data.paymentTerms = typeof body.paymentTerms === 'string' && body.paymentTerms !== '' ? body.paymentTerms : null
    if ('termsNote' in body) data.termsNote = typeof body.termsNote === 'string' && body.termsNote !== '' ? body.termsNote : null
    if ('headerName' in body) data.headerName = typeof body.headerName === 'string' && body.headerName !== '' ? body.headerName : null
    if ('taxPoint' in body) {
      const t = body.taxPoint
      if (t === null) data.taxPoint = null
      else if (typeof t === 'number' && t >= 0 && t <= 100) data.taxPoint = t
      else return reply.code(400).send({ error: '加税点必须为 0-100 的数字' })
    }
    if ('orderDate' in body) {
      const d = body.orderDate
      if (d === null || d === '') data.orderDate = null
      else {
        const parsed = new Date(String(d))
        if (Number.isNaN(parsed.getTime())) return reply.code(400).send({ error: '下单日期格式不正确' })
        data.orderDate = parsed
      }
    }
    const beforeJson = JSON.stringify({
      orderNo: po.orderNo,
      expectedDeliveryDate: po.expectedDeliveryDate,
      paymentTerms: po.paymentTerms,
      termsNote: po.termsNote,
      headerName: po.headerName,
      taxPoint: po.taxPoint?.toNumber() ?? null,
      items: po.items.map((it) => ({ partId: it.partId, sku: it.part.sku, qty: it.qty, unitPrice: it.unitPrice.toNumber(), unitPriceInclTax: it.unitPriceInclTax?.toNumber() ?? null, usage: it.usage, note: it.note, supplierReplyDate: it.supplierReplyDate })),
    })
    let itemsToSet: Array<Record<string, unknown>> | null = null
    if ('items' in body) {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return reply.code(400).send({ error: '采购单至少包含一个明细' })
      }
      const rows = body.items as Array<{ partId?: unknown; qty?: unknown; unitPrice?: unknown; unitPriceInclTax?: unknown; usage?: unknown; note?: unknown; supplierReplyDate?: unknown }>
      const partIds = rows.map((it) => Number(it.partId))
      if (partIds.some((n) => !Number.isInteger(n) || n <= 0)) return reply.code(400).send({ error: '明细零件不合法' })
      if (new Set(partIds).size !== partIds.length) return reply.code(400).send({ error: '采购单明细不能重复' })
      itemsToSet = rows.map((it, i) => ({
        partId: partIds[i],
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        unitPriceInclTax: it.unitPriceInclTax == null ? null : Number(it.unitPriceInclTax),
        usage: it.usage == null ? null : Number(it.usage),
        note: it.note == null ? null : String(it.note),
        supplierReplyDate: it.supplierReplyDate == null ? null : new Date(String(it.supplierReplyDate)),
      }))
    }
    const user = (req as { user?: { name?: string } }).user?.name ?? 'purchase'
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.purchaseOrder.update({ where: { id }, data })
      if (itemsToSet) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } })
        for (const it of itemsToSet) {
          await tx.purchaseOrderItem.create({
            data: {
              purchaseOrderId: id,
              partId: it.partId as number,
              qty: it.qty as number,
              unitPrice: it.unitPrice as number,
              unitPriceInclTax: it.unitPriceInclTax as number | null,
              usage: it.usage as number | null,
              note: it.note as string | null,
              supplierReplyDate: it.supplierReplyDate as Date | null,
            },
          })
        }
      }
      await tx.purchaseOrderEditLog.create({
        data: { purchaseOrderId: id, beforeJson, afterJson: JSON.stringify(data), editedBy: user },
      })
      return saved
    })
    return reply.code(200).send(updated)
  })

  // —— 回签件附件（供应商回签扫描件/照片归档）
  app.get('/api/purchase-orders/:id/attachments', { preHandler: requireRole(...READ_ROLES) }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    const list = await prisma.purchaseOrderAttachment.findMany({
      where: { purchaseOrderId: id },
      orderBy: { id: 'desc' as const },
    })
    return list
  })

  app.post('/api/purchase-orders/:id/attachments', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    const body = (req.body ?? {}) as { url?: unknown; name?: unknown }
    const url = typeof body.url === 'string' && body.url !== '' ? body.url : null
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : '回签件'
    if (!url) return reply.code(400).send({ error: '附件 URL 必填（先经 /api/uploads 上传）' })
    const po = await prisma.purchaseOrder.findUnique({ where: { id } })
    if (!po) return reply.code(404).send({ error: '采购单不存在' })
    const created = await prisma.purchaseOrderAttachment.create({
      data: { purchaseOrderId: id, url, name },
    })
    return reply.code(200).send(created)
  })

  app.delete('/api/purchase-orders/:id/attachments/:attId', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    const attId = parsePositiveInt((req.params as { attId: string }).attId)
    if (id === null || attId === null) return reply.code(400).send({ error: '参数不合法' })
    const att = await prisma.purchaseOrderAttachment.findFirst({ where: { id: attId, purchaseOrderId: id } })
    if (!att) return reply.code(404).send({ error: '附件不存在' })
    await prisma.purchaseOrderAttachment.delete({ where: { id: attId } })
    return reply.code(200).send({ ok: true })
  })

  // —— 采购单预览/导出（两套模板：智锐恒=含税、锦名诚=不含税；采购/老板导出，其余角色可预览结构）
  async function poDocData(id: number): Promise<import('../domain/purchase-doc').PoDocData> {
    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: {
        supplier: true,
        salesOrders: { include: { salesOrder: { include: { items: { include: { product: { select: { sku: true } } } } } } } },
        items: { include: { part: true }, orderBy: { id: 'asc' as const } },
      },
    })
    const modelSkus = new Set<string>()
    for (const l of po.salesOrders) {
      for (const it of l.salesOrder.items) modelSkus.add(it.product.sku)
    }
    return {
      headerName: po.headerName ?? '东莞市智锐恒电子有限公司',
      orderNo: po.orderNo,
      orderDate: po.orderDate?.toISOString() ?? new Date().toISOString(),
      supplier: {
        name: po.supplier.name,
        contactPerson: po.supplier.contactPerson ?? po.supplier.contact ?? null,
        phone: po.supplier.phone ?? null,
        fax: po.supplier.fax ?? null,
        email: po.supplier.email ?? null,
      },
      model: [...modelSkus].join(' / '),
      paymentTerms: po.paymentTerms,
      termsNote: po.termsNote,
      expectedDeliveryDate: po.expectedDeliveryDate,
      taxPoint: po.taxPoint != null ? po.taxPoint.toNumber() : null,
      lines: po.items.map((it) => ({
        sku: it.part.sku,
        name: it.part.name,
        spec: it.part.dimensions ?? it.part.spec ?? null,
        material: it.part.material ?? null,
        finish: it.part.finish ?? null,
        unit: it.part.unit,
        usage: it.usage?.toNumber() ?? null,
        qty: it.qty,
        unitPrice: it.unitPrice.toNumber(),
        unitPriceInclTax: it.unitPriceInclTax?.toNumber() ?? null,
        note: it.note,
        sourcing: it.part.sourcing,
      })),
    }
  }

  // 预览：xlsx 标准模板 → 真渲染（Excel→PDF→PNG，预览=打印）；模型模板 → 模型 HTML
  app.get('/api/purchase-orders/:id/preview', { preHandler: requireRole('purchase', 'boss', 'warehouse') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    try {
      const data = await poDocData(id)
      const po = await prisma.purchaseOrder.findUnique({ where: { id } })
      if (!po) return reply.code(404).send({ error: '采购单不存在' })
      const { buildPoMimicHtml } = await import('../domain/purchase-doc')
      const html = buildPoMimicHtml(data)
      return { data, html, templateName: null, render: 'xlsx' as const, renderV: '' }
    } catch (err) {
      const e = routeError(err, ['不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 打印页：xlsx 标准模板 → 仿照表格 HTML（浏览器打印，可另存为 PDF）；模型模板 → 模型 HTML
  app.get('/api/purchase-orders/:id/print', { preHandler: requireRole('purchase', 'boss', 'warehouse') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    try {
      const data = await poDocData(id)
      const po = await prisma.purchaseOrder.findUnique({ where: { id } })
      if (!po) return reply.code(404).send({ error: '采购单不存在' })
      const { buildPoMimicHtml } = await import('../domain/purchase-doc')
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(buildPoMimicHtml(data, { autoPrint: true }))
    } catch (err) {
      const e = routeError(err, ['不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  app.get('/api/purchase-orders/:id/export', { preHandler: requireRole('purchase', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    try {
      const data = await poDocData(id)
      const po = await prisma.purchaseOrder.findUnique({ where: { id } })
      if (!po) return reply.code(404).send({ error: '采购单不存在' })
      const { buildPoTemplate, poDocFileName } = await import('../domain/purchase-doc')
      const buffer = await buildPoTemplate(data, null, null)
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', 'attachment; filename="' + encodeURIComponent(poDocFileName(data.orderNo)) + '"')
        .send(buffer)
      return
    } catch (err) {
      const e = routeError(err, ['不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // —— 真渲染（2026-09-07 老板：预览=打印效果。Excel COM → PDF → PNG，串行 + 落盘缓存）——
  async function renderPoFile(id: number, opts?: { warm?: boolean }): Promise<{ pdfPath: string; pngPath: string }> {
    // 直连预览优先：预热渲染期间用户主动预览时，预热循环会暂停让路
    if (!opts?.warm) markDirectRenderStart()
    try {
      const data = await poDocData(id)
      const po = await prisma.purchaseOrder.findUnique({ where: { id } })
      if (!po) throw new Error('采购单不存在')
      const { buildPoTemplate, builtinPrintArea } = await import('../domain/purchase-doc')
      const buffer = await buildPoTemplate(data, null, null)
      const builtinFile = resolve(PO_TEMPLATE_DIR, 'PurchaseOrder-STD.xlsx')
      const builtinStamp = existsSync(builtinFile) ? statSync(builtinFile).mtimeMs : 0
      const cacheKey = 'po-' + id + '-' + renderKey([data, null, 0, builtinStamp])
      // 内置标准模板显式传打印区域，避免 Excel 把右侧空列算进页面
      const printArea = builtinPrintArea(data.lines.length)
      // 预览图 110dpi：屏幕清晰度足够，光栅化更快（2026-09-08 老板嫌预览慢）
      return renderPoToFiles(buffer, cacheKey, { orientation: 'portrait', dpi: 110, printArea })
    } finally {
      if (!opts?.warm) markDirectRenderEnd()
    }
  }

  app.get('/api/purchase-orders/:id/render-preview', { preHandler: requireRole('purchase', 'boss', 'warehouse') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    try {
      const { pngPath } = await renderPoFile(id)
      reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-cache').send(readFileSync(pngPath))
      return
    } catch (err) {
      console.error('[render-preview]', err)
      const e = routeError(err, ['不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  app.get('/api/purchase-orders/:id/render-pdf', { preHandler: requireRole('purchase', 'boss', 'warehouse') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '采购单 ID 必须为正整数' })
    try {
      const data = await poDocData(id)
      const { pdfPath } = await renderPoFile(id)
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline; filename="PO-' + data.orderNo + '.pdf"')
        .send(readFileSync(pdfPath))
      return
    } catch (err) {
      console.error('[render-pdf]', err)
      const e = routeError(err, ['不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  app.post('/api/purchase-orders', { preHandler: requireRole('purchase') }, async (req, reply) => {
    const data = parseBody(createPurchaseOrderSchema, req.body, reply)
    if (data === null) return

    // 用量兜底（2026-09-08）：明细没带用量时按关联订单成品 BOM 自动补
    const usageFallback = await bomUsageFallback(data.salesOrderIds ?? (data.salesOrderId != null ? [data.salesOrderId] : undefined), data.items)
    // 明细去重 + 零件必须属于所选供应商（与批量按供应商分组的口径一致，防发错供应商）
    const partIds = [...new Set(data.items.map((item) => item.partId))]
    if (partIds.length !== data.items.length) {
      return reply.code(400).send({ error: '采购单明细不能重复' })
    }
    const parts = await prisma.part.findMany({
      where: { id: { in: partIds } },
      select: { id: true, name: true, supplierId: true },
    })
    const partMap = new Map(parts.map((p) => [p.id, p]))
    const missing = data.items.filter((item) => !partMap.has(item.partId))
    if (missing.length > 0) {
      return reply.code(400).send({ error: '采购单包含不存在的零件' })
    }
    if (data.poType !== 'spare' && data.poType !== 'selfbuy') {
      const mismatched = data.items.filter((item) => partMap.get(item.partId)!.supplierId !== data.supplierId)
      if (mismatched.length > 0) {
        const names = mismatched.map((item) => partMap.get(item.partId)!.name || String(item.partId)).join('、')
        return reply.code(400).send({ error: '零件「' + names + '」的供应商不是所选供应商，请先在零件资料中挂好供应商' })
      }
    } else {
      // 免费备品单：单价必须为 0，不挂销售订单（老板第 4 轮口径）
      const priced = data.items.filter((item) => item.unitPrice > 0)
      if (priced.length > 0) {
        return reply.code(400).send({ error: '免费备品单的单价必须为 0' })
      }
    }

    try {
      const prepared = await prepareOrders(data)
      const orderNo = await nextPurchaseOrderNo(prepared.salesOrderIds, prisma, prepared.manualOrderNo, data.poType)
      const order = await prisma.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: {
            orderNo,
            supplierId: data.supplierId,
            salesOrderId: prepared.salesOrderIds?.[0] ?? null, // 主订单（领料/相位/列表兼容）
            ...poFields(data),
          },
        })
        for (const item of data.items) {
          await tx.purchaseOrderItem.create({
            data: { purchaseOrderId: created.id, ...itemData(item, usageFallback.get(item.partId)) },
          })
        }
        if (prepared.salesOrderIds) {
          for (const soId of prepared.salesOrderIds) {
            await tx.purchaseOrderSalesOrder.create({ data: { purchaseOrderId: created.id, salesOrderId: soId } })
            await markPurchasingStarted(tx, soId)
          }
        }
        return tx.purchaseOrder.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            items: {
              include: { part: { select: { id: true, sku: true, name: true } } },
              orderBy: { id: 'asc' as const },
            },
          },
        })
      })
      return reply.code(200).send(order)
    } catch (err) {
      const e = routeError(err, [])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 批量生成采购单：按零件供应商自动分组（拆单行按 splitNo 拆到不同单），每组一张采购单
  app.post('/api/purchase-orders/batch', { preHandler: requireRole('purchase') }, async (req, reply) => {
    const data = parseBody(batchPurchaseOrderSchema, req.body, reply)
    if (data === null) return

    // 用量兜底（2026-09-08）：明细没带用量时按关联订单成品 BOM 自动补
    const usageFallback = await bomUsageFallback(data.salesOrderIds, data.items)
    const partIds = [...new Set(data.items.map((item) => item.partId))]
    const parts = await prisma.part.findMany({
      where: { id: { in: partIds } },
      include: { supplier: { select: { id: true, name: true } } },
    })
    const partMap = new Map(parts.map((p) => [p.id, p]))

    // 自购件：不出给供应商，自动归「自购」供应商（shortName=自购，缺失时自动创建）
    let selfBuySupplier = await prisma.supplier.findFirst({ where: { shortName: '自购' } })
    if (!selfBuySupplier) {
      selfBuySupplier = await prisma.supplier.create({
        data: { name: '自购（老板自己买）', shortName: '自购', contact: '老板', defaultHeaderName: '东莞市智锐恒电子有限公司' },
      })
    }
    const effSelfBuy = (item: (typeof data.items)[number]) => item.selfBuy === true

    // 供应商来源：行级覆盖 > 零件资料；自购件缺省用「自购」供应商；两者都没有才报错
    const missingSupplier = data.items.filter((item) => {
      if (effSelfBuy(item)) return false
      const part = partMap.get(item.partId)
      return !(item.supplierId ?? part?.supplierId)
    })
    if (missingSupplier.length > 0) {
      const names = missingSupplier
        .map((item) => partMap.get(item.partId)?.name ?? String(item.partId))
        .join('、')
      return reply.code(400).send({ error: '零件「' + names + '」未设置供应商，不能生成采购单' })
    }
    if (data.poType === 'spare') {
      const priced = data.items.filter((item) => item.unitPrice > 0)
      if (priced.length > 0) {
        return reply.code(400).send({ error: '免费备品单的单价必须为 0' })
      }
    }

    try {
      const prepared = await prepareOrders(data)
      // 分组键 = 供应商 + 拆单批次：同供应商同零件不同 splitNo 生成多张单（拆单，老板第 4 轮口径）
      const groups = new Map<string, typeof data.items>()
      for (const item of data.items) {
        const isSb = effSelfBuy(item)
        const supplierId = isSb
          ? (item.supplierId ?? selfBuySupplier.id)
          : (item.supplierId ?? partMap.get(item.partId)!.supplierId!)
        const key = supplierId + '|' + (item.splitNo ?? 0)
        const list = groups.get(key) ?? []
        list.push(item)
        groups.set(key, list)
      }

      const orders = await prisma.$transaction(async (tx) => {
        const createdOrders: any[] = []
        for (const items of groups.values()) {
          const first = items[0]!
          const isSbGroup = items.every((it) => effSelfBuy(it))
          const groupPoType = isSbGroup ? 'selfbuy' : (data.poType ?? 'normal')
          const supplierId = isSbGroup
            ? (first.supplierId ?? selfBuySupplier.id)
            : (first.supplierId ?? partMap.get(first.partId)!.supplierId!)
          const orderNo = await nextPurchaseOrderNo(prepared.salesOrderIds, tx, prepared.manualOrderNo, groupPoType)
          const created = await tx.purchaseOrder.create({
            data: {
              orderNo,
              supplierId,
              salesOrderId: prepared.salesOrderIds?.[0] ?? null,
              ...poFields({ ...data, poType: groupPoType }),
            },
          })
          for (const item of items) {
            await tx.purchaseOrderItem.create({
              data: { purchaseOrderId: created.id, ...itemData(item, usageFallback.get(item.partId)) },
            })
          }
          if (prepared.salesOrderIds) {
            for (const soId of prepared.salesOrderIds) {
              await tx.purchaseOrderSalesOrder.create({ data: { purchaseOrderId: created.id, salesOrderId: soId } })
            }
          }
          createdOrders.push(
            await tx.purchaseOrder.findUniqueOrThrow({
              where: { id: created.id },
              include: {
                supplier: { select: { id: true, name: true } },
                items: {
                  include: { part: { select: { id: true, sku: true, name: true } } },
                  orderBy: { id: 'asc' as const },
                },
              },
            }),
          )
        }
        if (prepared.salesOrderIds) {
          for (const soId of prepared.salesOrderIds) {
            await markPurchasingStarted(tx, soId)
          }
        }
        return createdOrders
      })
      return reply.code(200).send(orders)
    } catch (err) {
      const e = routeError(err, [])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 收货：仅 warehouse 可操作（采购跟进补录走 /api/purchasing/follow-up/:itemId/delivery，
  // 两者共用 domain/receipt.ts 的 recordReceipt，口径完全一致）。两种模式：
  // 1) 有采购单：校验零件归属/累计不超订购量（allowOverQty 显式确认后放行超收），
  //    更新采购单状态并刷新订单「采购中」；
  // 2) 自购买（purchaseOrderId 不传）：直接按零件入库，可挂供应商追溯。
  app.post('/api/receipts', { preHandler: requireRole('warehouse') }, async (req, reply) => {
    const data = parseBody(receiptSchema, req.body, reply)
    if (data === null) return

    try {
      const result = await prisma.$transaction((tx) =>
        recordReceipt(tx, {
          purchaseOrderId: data.purchaseOrderId ?? null,
          lines: data.items.map((it) => ({
            partId: it.partId,
            qty: it.qty,
            lotNo: it.lotNo,
            qcStatus: it.qcStatus,
            defectiveQty: it.defectiveQty ?? 0,
            supplierId: it.supplierId,
            deliveryDate: data.deliveryDate ?? null,
          })),
          allowOverQty: data.allowOverQty ?? false,
          source: 'warehouse',
          operatorId: (req as { user?: { id?: number } }).user?.id ?? null,
        }),
      )
      return reply.code(200).send({ ok: true, overQty: result.overQty })
    } catch (err) {
      const e = routeError(err, ['采购单不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 收货记录列表：仓库 QC 补录用（可按时收倒序、按采购单过滤、分页）
  app.get('/api/receipts', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const query = req.query as { purchaseOrderId?: string }
    const where: { purchaseOrderId?: number } = {}
    if (query.purchaseOrderId !== undefined && query.purchaseOrderId !== '') {
      const poId = parsePositiveInt(query.purchaseOrderId)
      if (poId === null) return reply.code(400).send({ error: 'purchaseOrderId 必须为正整数' })
      where.purchaseOrderId = poId
    }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      part: { select: { id: true, sku: true, name: true } },
      purchaseOrder: { select: { id: true, orderNo: true } },
      supplier: { select: { id: true, name: true } },
    } as const
    const orderBy = [{ receivedAt: 'desc' as const }, { id: 'desc' as const }]
    const toRow = (r: Prisma.ReceiptGetPayload<{ include: typeof include }>) => ({
      id: r.id,
      purchaseOrderId: r.purchaseOrderId,
      purchaseOrderNo: r.purchaseOrder?.orderNo ?? '',
      partId: r.partId,
      sku: r.part.sku,
      partName: r.part.name,
      supplierId: r.supplierId,
      supplierName: r.supplier?.name ?? '',
      qty: r.qty,
      lotNo: r.lotNo,
      qcStatus: r.qcStatus,
      defectiveQty: r.defectiveQty,
      receivedAt: r.receivedAt,
    })
    if (pagination.kind === 'none') {
      const rows = await prisma.receipt.findMany({ where, include, orderBy })
      return rows.map(toRow)
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.receipt.findMany({
        where,
        include,
        orderBy,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.receipt.count({ where }),
    ])
    return pagedResult(rows.map(toRow), total, page)
  })

  // 收货记录修改：
  // - 仓库/老板：QC 补录（lotNo/qcStatus/defectiveQty）+ 改交货数量/送货日期；
  // - 采购：只能改交货数量/送货日期（老板口径：采购可改，但必须留痕）。
  // 改数量会按差额同步库存（原流水保留，新增一条 receipt 差额流水）、重算采购单收货进度与
  // 订单「采购中」阶段，并写 DeliveryEditLog 留痕（谁在什么时候把 X 改成 Y）。
  app.patch('/api/receipts/:id', { preHandler: requireRole('warehouse', 'boss', 'purchase') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '收货记录 ID 必须为正整数' })
    const body = parseBody(patchReceiptSchema, req.body, reply)
    if (body === null) return

    const actor = (req as { user?: { id?: number; role?: string; name?: string; username?: string } }).user
    const role = actor?.role ?? ''
    const operatorName = actor?.name || actor?.username || role
    if (role === 'purchase' && (body.lotNo !== undefined || body.qcStatus !== undefined || body.defectiveQty !== undefined)) {
      return reply.code(403).send({ error: 'QC 状态与不良品数量由仓库维护' })
    }

    try {
      await prisma.$transaction(async (tx) => {
        const receipt = await tx.receipt.findUnique({ where: { id } })
        if (!receipt) throw new Error('收货记录不存在')

        const nextQty = body.qty ?? receipt.qty
        if (body.defectiveQty !== undefined && body.defectiveQty > nextQty) {
          throw new Error('不良品数量不能大于收货数量')
        }

        const changes: { field: string; before: string | null; after: string | null }[] = []
        const data: Prisma.ReceiptUpdateInput = { updatedById: actor?.id ?? null }
        if (body.lotNo !== undefined) data.lotNo = body.lotNo
        if (body.qcStatus !== undefined) data.qcStatus = body.qcStatus
        if (body.defectiveQty !== undefined) data.defectiveQty = body.defectiveQty
        if (body.deliveryDate !== undefined) {
          changes.push({
            field: 'deliveryDate',
            before: receipt.deliveryDate ? receipt.deliveryDate.toISOString().slice(0, 10) : null,
            after: body.deliveryDate ? body.deliveryDate.toISOString().slice(0, 10) : null,
          })
          data.deliveryDate = body.deliveryDate
        }

        if (body.qty !== undefined && body.qty !== receipt.qty) {
          // 挂采购单时：改后累计收货超订购量需显式确认（与登记送货同一口径）
          if (receipt.purchaseOrderId != null) {
            const po = await tx.purchaseOrder.findUnique({
              where: { id: receipt.purchaseOrderId },
              select: { id: true, items: { select: { partId: true, qty: true } } },
            })
            if (po) {
              const orderedQty = po.items.find((i) => i.partId === receipt.partId)?.qty ?? 0
              const groups = await tx.receipt.groupBy({
                by: ['partId'],
                where: { purchaseOrderId: po.id, partId: receipt.partId },
                _sum: { qty: true },
              })
              const received = groups[0]?._sum.qty ?? 0
              const after = received - receipt.qty + body.qty
              if (after > orderedQty && !body.allowOverQty) {
                throw new Error(
                  '改后累计收货超过订购数量（订购 ' +
                    orderedQty +
                    '、改后累计 ' +
                    after +
                    '，超收 ' +
                    (after - orderedQty) +
                    '），请确认超收',
                )
              }
            }
          }
          const delta = body.qty - receipt.qty
          if (delta !== 0) {
            await applyStockChange(tx, 'part', receipt.partId, delta, 'receipt', receipt.id, null)
          }
          changes.push({ field: 'qty', before: String(receipt.qty), after: String(body.qty) })
          data.qty = body.qty
        }

        await tx.receipt.update({ where: { id }, data })

        for (const c of changes) {
          await tx.deliveryEditLog.create({
            data: {
              receiptId: receipt.id,
              purchaseOrderId: receipt.purchaseOrderId,
              partId: receipt.partId,
              field: c.field,
              beforeVal: c.before,
              afterVal: c.after,
              editedBy: operatorName,
            },
          })
        }

        // 改数量后重算采购单收货进度 + 订单「采购中」阶段
        if (body.qty !== undefined && body.qty !== receipt.qty && receipt.purchaseOrderId != null) {
          const po = await tx.purchaseOrder.findUnique({
            where: { id: receipt.purchaseOrderId },
            select: { id: true, salesOrderId: true, items: { select: { partId: true, qty: true } } },
          })
          if (po) {
            const groups = await tx.receipt.groupBy({
              by: ['partId'],
              where: { purchaseOrderId: po.id },
              _sum: { qty: true },
            })
            const map = new Map(groups.map((g) => [g.partId, g._sum.qty ?? 0]))
            const allReceived = po.items.every((i) => (map.get(i.partId) ?? 0) >= i.qty)
            const anyReceived = po.items.some((i) => (map.get(i.partId) ?? 0) > 0)
            await tx.purchaseOrder.update({
              where: { id: po.id },
              data: { status: allReceived ? 'received' : anyReceived ? 'partial' : 'open' },
            })
            await refreshPurchasingPhase(tx, po.salesOrderId)
          }
        }
      })
    } catch (err) {
      const e = routeError(err, ['收货记录不存在'])
      return reply.code(e.status).send({ error: e.message })
    }

    const updated = await prisma.receipt.findUnique({ where: { id } })
    return reply.code(200).send(updated)
  })

  // 撤销收货：库存反向扣回，原流水保留，新增 void 冲销流水
  app.delete('/api/receipts/:id', { preHandler: requireRole('warehouse', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '收货记录 ID 必须为正整数' })
    try {
      await prisma.$transaction(async (tx) => {
        const record = await tx.receipt.findUnique({ where: { id } })
        if (!record) throw new Error('收货记录不存在')
        const po = record.purchaseOrderId != null
          ? await tx.purchaseOrder.findUnique({
              where: { id: record.purchaseOrderId },
              select: { id: true, salesOrderId: true, items: { select: { partId: true, qty: true } } },
            })
          : null
        await applyStockChange(tx, 'part', record.partId, -record.qty, 'void', id, po?.salesOrderId ?? null)
        await tx.receipt.delete({ where: { id } })
        if (po) {
          // 撤销后按剩余收货重算采购单状态（收齐→received / 部分→partial / 无→open），并回退订单「采购中」标志
          const groups = await tx.receipt.groupBy({
            by: ['partId'],
            where: { purchaseOrderId: po.id },
            _sum: { qty: true },
          })
          const receivedMap = new Map(groups.map((g) => [g.partId, g._sum.qty ?? 0]))
          const allReceived = po.items.every((i) => (receivedMap.get(i.partId) ?? 0) >= i.qty)
          const anyReceived = po.items.some((i) => (receivedMap.get(i.partId) ?? 0) > 0)
          const status = allReceived ? 'received' : anyReceived ? 'partial' : 'open'
          await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } })
          await refreshPurchasingPhaseAfterUndo(tx, po.salesOrderId)
        }
      })
      return reply.code(200).send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '撤销收货失败'
      if (message.includes('收货记录不存在')) return reply.code(404).send({ error: message })
      if (message.includes('库存不足')) return reply.code(400).send({ error: '该记录已被后续领用/使用，无法撤销' })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '撤销收货失败，请稍后重试' })
    }
  })

  // ===== 采购跟进（2026-09-09，老板口径：复刻采购日常跟单表「订单跟进明细」）=====
  // 一行 = 一个采购单明细行；未交 = 订购 − 累计收货 − 累计补货 + 累计退货；
  // 收齐双条件：未交 ≤ 0 且采购已点「已收齐」（deliveryConfirmedAt）。

  const followDeliverySchema = z.object({
    qty: z
      .number({ error: '送货数量必须为数字' })
      .int({ error: '送货数量必须为整数' })
      .positive({ error: '送货数量必须为正整数' })
      .max(2147483647, { error: '送货数量超出允许范围' }),
    deliveryDate: z.coerce.date().nullable().optional(),
    lotNo: z.string().max(100, '来料单号过长').nullable().optional(),
    allowOverQty: z.boolean().optional(),
  })

  const followConfirmSchema = z.object({ confirmed: z.boolean().optional() })

  // 汇总某采购单明细行的收货/退货（采购跟进列表与「已收齐」校验共用）
  async function itemFollowAggregate(purchaseOrderId: number, partId: number, orderNo: string) {
    const [rec, rr] = await Promise.all([
      prisma.receipt.aggregate({
        where: { purchaseOrderId, partId },
        _sum: { qty: true },
        _max: { deliveryDate: true, receivedAt: true },
      }),
      prisma.returnReplenish.findMany({
        where: { partId, OR: [{ purchaseOrderId }, { purchaseOrderNo: orderNo }] },
        select: { returnQty: true, replenishQty: true },
      }),
    ])
    return {
      receivedQty: rec._sum.qty ?? 0,
      lastDeliveryDate: rec._max.deliveryDate ?? rec._max.receivedAt ?? null,
      returnQty: rr.reduce((s, r) => s + r.returnQty, 0),
      replenishQty: rr.reduce((s, r) => s + r.replenishQty, 0),
    }
  }

  app.get(
    '/api/purchasing/follow-up',
    { preHandler: requireRole('purchase', 'boss', 'warehouse', 'finance') },
    async (req, reply) => {
      const query = req.query as Record<string, string | undefined>
      const where: Prisma.PurchaseOrderItemWhereInput = {}
      const poWhere: Prisma.PurchaseOrderWhereInput = {}

      if (query.purchaseOrderId) {
        const poId = parsePositiveInt(query.purchaseOrderId)
        if (poId === null) return reply.code(400).send({ error: 'purchaseOrderId 必须为正整数' })
        poWhere.id = poId
      }
      if (query.supplierId) {
        const sid = parsePositiveInt(query.supplierId)
        if (sid === null) return reply.code(400).send({ error: 'supplierId 必须为正整数' })
        poWhere.supplierId = sid
      }
      if (query.salesOrderId) {
        const soId = parsePositiveInt(query.salesOrderId)
        if (soId === null) return reply.code(400).send({ error: 'salesOrderId 必须为正整数' })
        poWhere.OR = [{ salesOrderId: soId }, { salesOrders: { some: { salesOrderId: soId } } }]
      }
      if (query.poStatus) poWhere.poStatus = query.poStatus
      if (Object.keys(poWhere).length > 0) where.purchaseOrder = poWhere

      const keyword = (query.search ?? '').trim()
      if (keyword) {
        where.OR = [
          { part: { sku: { contains: keyword, mode: 'insensitive' } } },
          { part: { name: { contains: keyword, mode: 'insensitive' } } },
          { purchaseOrder: { orderNo: { contains: keyword, mode: 'insensitive' } } },
          { purchaseOrder: { supplier: { name: { contains: keyword, mode: 'insensitive' } } } },
        ]
      }

      const role = (req as { user?: { role?: string } }).user?.role ?? ''
      const hidePrice = ['sales', 'warehouse', 'engineer'].includes(role)

      const items = await prisma.purchaseOrderItem.findMany({
        where,
        include: {
          part: { select: { id: true, sku: true, name: true, spec: true, unit: true } },
          purchaseOrder: {
            select: {
              id: true,
              orderNo: true,
              status: true,
              poStatus: true,
              poType: true,
              orderDate: true,
              expectedDeliveryDate: true,
              headerName: true,
              supplier: { select: { id: true, name: true } },
              salesOrder: {
                select: {
                  id: true,
                  orderNo: true,
                  items: {
                    select: { qty: true, product: { select: { sku: true, name: true } } },
                    orderBy: { id: 'asc' as const },
                  },
                },
              },
              salesOrders: { select: { salesOrder: { select: { id: true, orderNo: true } } } },
            },
          },
        },
        orderBy: [{ purchaseOrderId: 'desc' as const }, { id: 'asc' as const }],
      })

      const poIds = [...new Set(items.map((i) => i.purchaseOrderId))]
      const receiptGroups = poIds.length
        ? await prisma.receipt.groupBy({
            by: ['purchaseOrderId', 'partId'],
            where: { purchaseOrderId: { in: poIds } },
            _sum: { qty: true },
            _max: { deliveryDate: true, receivedAt: true },
          })
        : []
      const receiptMap = new Map<string, { qty: number; last: Date | null }>()
      for (const g of receiptGroups) {
        if (g.purchaseOrderId == null) continue
        receiptMap.set(g.purchaseOrderId + '#' + g.partId, {
          qty: g._sum.qty ?? 0,
          last: g._max.deliveryDate ?? g._max.receivedAt ?? null,
        })
      }

      const poNos = [...new Set(items.map((i) => i.purchaseOrder.orderNo))]
      const idByPoNo = new Map(items.map((i) => [i.purchaseOrder.orderNo, i.purchaseOrder.id]))
      const rrRows = poNos.length
        ? await prisma.returnReplenish.findMany({
            where: { OR: [{ purchaseOrderId: { in: poIds } }, { purchaseOrderNo: { in: poNos } }] },
            select: {
              purchaseOrderId: true,
              purchaseOrderNo: true,
              partId: true,
              returnQty: true,
              replenishQty: true,
            },
          })
        : []
      const rrMap = new Map<string, { returnQty: number; replenishQty: number }>()
      for (const r of rrRows) {
        const poId = r.purchaseOrderId ?? (r.purchaseOrderNo ? idByPoNo.get(r.purchaseOrderNo) : undefined)
        if (!poId) continue
        const key = poId + '#' + r.partId
        const cur = rrMap.get(key) ?? { returnQty: 0, replenishQty: 0 }
        cur.returnQty += r.returnQty
        cur.replenishQty += r.replenishQty
        rrMap.set(key, cur)
      }

      const rows = items.map((it) => {
        const key = it.purchaseOrderId + '#' + it.partId
        const rec = receiptMap.get(key)
        const rr = rrMap.get(key) ?? { returnQty: 0, replenishQty: 0 }
        const receivedQty = rec?.qty ?? 0
        const outstanding = outstandingQty({
          orderedQty: it.qty,
          receivedQty,
          replenishQty: rr.replenishQty,
          returnQty: rr.returnQty,
        })
        const confirmed = it.deliveryConfirmedAt != null
        const so = it.purchaseOrder.salesOrder
        const soItem = so?.items[0]
        const unitPrice = it.unitPrice.toNumber()
        return {
          id: it.id,
          purchaseOrderId: it.purchaseOrderId,
          purchaseOrderNo: it.purchaseOrder.orderNo,
          poStatus: it.purchaseOrder.poStatus,
          poType: it.purchaseOrder.poType,
          receiveStatus: it.purchaseOrder.status,
          headerName: it.purchaseOrder.headerName,
          supplierId: it.purchaseOrder.supplier.id,
          supplierName: it.purchaseOrder.supplier.name,
          salesOrderId: so?.id ?? null,
          salesOrderNo: so?.orderNo ?? '',
          salesOrderNos: it.purchaseOrder.salesOrders.map((l) => l.salesOrder.orderNo),
          productModel: soItem?.product.sku ?? '',
          productName: soItem?.product.name ?? '',
          orderQty: soItem?.qty ?? null,
          partId: it.partId,
          sku: it.part.sku,
          partName: it.part.name,
          spec: it.part.spec,
          unit: it.part.unit,
          usage: it.usage?.toNumber() ?? null,
          qty: it.qty,
          ...(hidePrice
            ? {}
            : {
                unitPrice,
                unitPriceInclTax: it.unitPriceInclTax?.toNumber() ?? null,
                amount: Number((it.qty * unitPrice).toFixed(2)),
              }),
          orderDate: it.purchaseOrder.orderDate,
          expectedDeliveryDate: it.purchaseOrder.expectedDeliveryDate,
          supplierReplyDate: it.supplierReplyDate,
          lastDeliveryDate: rec?.last ?? null,
          receivedQty,
          returnQty: rr.returnQty,
          replenishQty: rr.replenishQty,
          outstandingQty: outstanding,
          confirmed,
          deliveryConfirmedAt: it.deliveryConfirmedAt,
          done: outstanding <= 0 && confirmed,
        }
      })

      // 默认只看未收齐（老板口径：筛选就知道哪些还没交齐）；onlyOutstanding=false 看全部
      const onlyOutstanding = query.onlyOutstanding !== 'false'
      const filtered = onlyOutstanding ? rows.filter((r) => !r.done) : rows

      const pagination = parsePagination(req.query as Record<string, unknown>)
      if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
      if (pagination.kind === 'none') return filtered
      const page = pagination.page
      const start = (page.page - 1) * page.pageSize
      return pagedResult(filtered.slice(start, start + page.pageSize), filtered.length, page)
    },
  )

  // 采购登记本次送货量（系统自动累加累计已交；超收需显式确认）
  app.post(
    '/api/purchasing/follow-up/:itemId/delivery',
    { preHandler: requireRole('purchase') },
    async (req, reply) => {
      const itemId = parsePositiveInt((req.params as { itemId: string }).itemId)
      if (itemId === null) return reply.code(400).send({ error: '明细 ID 必须为正整数' })
      const body = parseBody(followDeliverySchema, req.body, reply)
      if (body === null) return

      const item = await prisma.purchaseOrderItem.findUnique({
        where: { id: itemId },
        select: { id: true, purchaseOrderId: true, partId: true },
      })
      if (!item) return reply.code(404).send({ error: '采购单明细不存在' })

      try {
        const result = await prisma.$transaction((tx) =>
          recordReceipt(tx, {
            purchaseOrderId: item.purchaseOrderId,
            itemId,
            lines: [
              {
                partId: item.partId,
                qty: body.qty,
                lotNo: body.lotNo ?? null,
                deliveryDate: body.deliveryDate ?? new Date(),
              },
            ],
            allowOverQty: body.allowOverQty ?? false,
            source: 'purchase',
            operatorId: (req as { user?: { id?: number } }).user?.id ?? null,
          }),
        )
        return reply.code(200).send({ ok: true, overQty: result.overQty })
      } catch (err) {
        const e = routeError(err, ['采购单不存在', '采购单明细不存在'])
        return reply.code(e.status).send({ error: e.message })
      }
    },
  )

  // 采购标记「已收齐」（未交必须 ≤ 0，与仓库收货构成收齐双条件）
  app.patch(
    '/api/purchasing/follow-up/:itemId/confirm',
    { preHandler: requireRole('purchase') },
    async (req, reply) => {
      const itemId = parsePositiveInt((req.params as { itemId: string }).itemId)
      if (itemId === null) return reply.code(400).send({ error: '明细 ID 必须为正整数' })
      const body = parseBody(followConfirmSchema, req.body, reply)
      if (body === null) return
      const confirmed = body.confirmed !== false

      const item = await prisma.purchaseOrderItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          qty: true,
          partId: true,
          purchaseOrderId: true,
          deliveryConfirmedAt: true,
          purchaseOrder: { select: { orderNo: true } },
        },
      })
      if (!item) return reply.code(404).send({ error: '采购单明细不存在' })

      if (confirmed) {
        const agg = await itemFollowAggregate(item.purchaseOrderId, item.partId, item.purchaseOrder.orderNo)
        const outstanding = outstandingQty({
          orderedQty: item.qty,
          receivedQty: agg.receivedQty,
          replenishQty: agg.replenishQty,
          returnQty: agg.returnQty,
        })
        if (outstanding > 0) {
          return reply.code(400).send({ error: '该明细还有 ' + outstanding + ' 未交，不能标已收齐' })
        }
      }

      const actor = (req as { user?: { id?: number; name?: string; username?: string } }).user
      const operatorName = actor?.name || actor?.username || 'purchase'
      await prisma.$transaction(async (tx) => {
        await tx.purchaseOrderItem.update({
          where: { id: itemId },
          data: {
            deliveryConfirmedAt: confirmed ? new Date() : null,
            deliveryConfirmedBy: confirmed ? (actor?.id ?? null) : null,
          },
        })
        await tx.deliveryEditLog.create({
          data: {
            purchaseOrderId: item.purchaseOrderId,
            partId: item.partId,
            field: 'confirm',
            beforeVal: item.deliveryConfirmedAt ? '已收齐' : '未收齐',
            afterVal: confirmed ? '已收齐' : '未收齐',
            editedBy: operatorName,
          },
        })
      })
      return reply.code(200).send({ ok: true, confirmed })
    },
  )

  // 采购跟进·改动历史（谁在什么时候把交货数量/送货日期改成什么）
  app.get(
    '/api/purchasing/follow-up/:itemId/history',
    { preHandler: requireRole('purchase', 'boss', 'warehouse', 'finance') },
    async (req, reply) => {
      const itemId = parsePositiveInt((req.params as { itemId: string }).itemId)
      if (itemId === null) return reply.code(400).send({ error: '明细 ID 必须为正整数' })
      const item = await prisma.purchaseOrderItem.findUnique({
        where: { id: itemId },
        select: { id: true, partId: true, purchaseOrderId: true },
      })
      if (!item) return reply.code(404).send({ error: '采购单明细不存在' })
      return prisma.deliveryEditLog.findMany({
        where: { purchaseOrderId: item.purchaseOrderId, partId: item.partId },
        orderBy: { editedAt: 'desc' },
        take: 100,
      })
    },
  )
}
