import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { parsePositiveInt, routeError } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
import { buildFromTemplate } from '../domain/shipment-docs-template'
import {
  buildCommercialInvoice,
  buildOfficialInvoice,
  buildPackingList,
  type DocCompany,
  type DocCustomer,
  type DocLine,
  type DocPayment,
  type ShipmentDocData,
} from '../domain/shipment-docs'

const ALL_ROLES = ['boss', 'purchase', 'warehouse', 'sales', 'finance'] as const

const optionalText = z.string().nullable().optional()
const optionalDate = z
  .string({ error: '时间必须为字符串' })
  .refine((v) => !Number.isNaN(Date.parse(v)), '时间必须为合法日期')
  .optional()

const shipmentLineSchema = z.object({
  productId: z.number({ error: '成品必填' }).int().positive({ error: '成品必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int().positive({ error: '数量必须为正整数' }).max(2147483647),
  unitPrice: z.number({ error: '单价必填' }).nonnegative().max(9999999999.99),
  customerPoNo: optionalText,
  lineNo: z.string().trim().max(20, 'Line# 过长').nullable().optional(),
  lotNo: optionalText,
  cartons: z.number().int().nonnegative().nullable().optional(),
  netWeight: z.number().nonnegative().nullable().optional(),
  grossWeight: z.number().nonnegative().nullable().optional(),
  cbm: z.number().nonnegative().nullable().optional(),
  containerNo: optionalText,
  sealNo: optionalText,
  hblNo: optionalText,
  remark: optionalText,
})

const scheduleQtySchema = z.object({
  id: z.number({ error: '排程必填' }).int().positive({ error: '排程必须为正整数' }),
  qty: z.number({ error: '数量必填' }).int().positive({ error: '数量必须为正整数' }).max(2147483647),
})

const createShipmentSchema = z.object({
  salesOrderId: z.number().int().positive().optional(), // 手工模式必填；排程模式可不传
  hubId: z.number().int().positive().optional(),
  shippedAt: optionalDate,
  deliveryNote: optionalText,
  signer: optionalText,
  remark: optionalText,
  invoiceNo: optionalText,
  paymentTerms: optionalText,
  incoterm: optionalText,
  mark: optionalText,
  origin: optionalText,
  hsCode: optionalText,
  taxRate: optionalText,
  vesselVoyage: optionalText,
  etd: optionalDate,
  eta: optionalDate,
  shippingInstructions: optionalText,
  schedules: z.array(scheduleQtySchema).optional(),
  lines: z.array(shipmentLineSchema).optional(),
})

const patchShipmentSchema = z.object({
  shippedAt: optionalDate,
  deliveryNote: optionalText,
  signer: optionalText,
  remark: optionalText,
  invoiceNo: optionalText,
  paymentTerms: optionalText,
  incoterm: optionalText,
  mark: optionalText,
  origin: optionalText,
  hsCode: optionalText,
  taxRate: optionalText,
  vesselVoyage: optionalText,
  etd: optionalDate,
  eta: optionalDate,
  shippingInstructions: optionalText,
  lines: z.array(shipmentLineSchema).optional(),
})

const createLegSchema = z.object({
  node: z.string({ error: '运输节点必填' }).min(1, '运输节点必填'),
  at: optionalDate,
  note: z.string().optional(),
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

const LEGS_INCLUDE = {
  legs: { orderBy: { at: 'desc' as const } },
} as const

const LINES_INCLUDE = {
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: { product: { select: { id: true, sku: true, name: true, nameEn: true, hsCode: true } } },
  },
} as const

const HUB_INCLUDE = {
  hub: { select: { id: true, name: true } },
} as const

interface LineToCreate {
  productId: number
  qty: number
  unitPrice: number
  customerPoNo: string | null
  lineNo: string | null
  salesOrderId: number
  scheduleId: number | null
  lotNo: string | null
  cartons: number | null
  netWeight: number | null
  grossWeight: number | null
  cbm: number | null
  containerNo: string | null
  sealNo: string | null
  hblNo: string | null
  remark: string | null
}

export function shippingRoutes(app: FastifyInstance) {
  // 出货：仅 sales。两种模式：
  // ① 排程模式（schedules 非空）：同一到货仓、可跨订单拼一票，数量按排程剩余（部分出货）；
  // ② 手工模式：选订单直接出（默认整单数量，可部分）。共同规则：订单已确认、库存够、出满自动 shipped。
  app.post('/api/shipments', { preHandler: requireRole('sales') }, async (req, reply) => {
    const data = parseBody(createShipmentSchema, req.body, reply)
    if (data === null) return

    try {
      const shipment = await prisma.$transaction(async (tx) => {
        let hubId: number | null = data.hubId ?? null
        const linesToCreate: LineToCreate[] = []
        const orderIds = new Set<number>()
        const scheduleRows = new Map<number, { id: number; qty: number; productId: number; hubId: number; salesOrderId: number; customerPoNo: string | null; unitPrice: number }>()

        if (data.schedules && data.schedules.length > 0) {
          // ===== 排程模式 =====
          // 并发防护（BUG-03）：先锁排程行，再读——并发出货串行化，剩余/上限校验不再竞态
          for (const sid of [...new Set(data.schedules.map((s) => s.id))].sort((a, b) => a - b)) {
            await tx.$queryRaw`SELECT id FROM "ShipmentSchedule" WHERE id = ${sid} FOR UPDATE`
          }
          const rows = await tx.shipmentSchedule.findMany({
            where: { id: { in: data.schedules.map((s) => s.id) } },
            include: { salesOrder: { select: { id: true, status: true, customerPoNo: true } }, product: { select: { id: true, sku: true } } },
          })
          if (rows.length !== data.schedules.length) throw new Error('排程不存在')
          // 锁涉及订单行（按 id 排序防死锁）
          for (const oid of [...new Set(rows.map((r) => r.salesOrder.id))].sort((a, b) => a - b)) {
            await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${oid} FOR UPDATE`
          }
          for (const r of rows) {
            scheduleRows.set(r.id, { id: r.id, qty: r.qty, productId: r.productId, hubId: r.hubId, salesOrderId: r.salesOrder.id, customerPoNo: r.salesOrder.customerPoNo, unitPrice: 0 })
          }
          for (const s of data.schedules) {
            const row = scheduleRows.get(s.id)!
            const full = await tx.shipmentSchedule.findUniqueOrThrow({ where: { id: s.id }, include: { salesOrder: { include: { items: true } } } })
            if (full.status !== 'picked') throw new Error('排程（' + full.productId + '）尚未备好，请仓库先标记「已备好」')
            if (s.qty > row.qty) throw new Error('排程出货数量超出剩余')
            const order = full.salesOrder
            if (order.status === 'shipped' || order.status === 'completed') throw new Error('订单已出货')
            if (order.status === 'draft') throw new Error('订单未确认，不能出货')
            const item = order.items.find((it) => it.productId === full.productId)
            if (!item) throw new Error('排程成品不在订单明细中')
            if (hubId === null) hubId = full.hubId
            else if (hubId !== full.hubId) throw new Error('同一出货单只能一个到货仓')
            linesToCreate.push({
              productId: full.productId,
              qty: s.qty,
              unitPrice: Number(item.unitPrice),
              customerPoNo: order.customerPoNo,
              // Line# 随订单明细行带出（销售按客户OPO表录入，打印到 Official Invoice）
              lineNo: item.lineNo ?? null,
              salesOrderId: order.id,
              scheduleId: full.id,
              lotNo: null,
              cartons: null,
              netWeight: null,
              grossWeight: null,
              cbm: null,
              containerNo: null,
              sealNo: null,
              hblNo: null,
              remark: null,
            })
            orderIds.add(order.id)
          }
        } else {
          // ===== 手工模式（BUG-06：已停用）=====
          throw new Error('无排程直接出货已停用，请先到「出货排程」页建排程，仓库备好后从这里出货')
        }

        if (linesToCreate.length === 0) throw new Error('出货明细为空')
        // 出库上限双保险（BUG-03）：每订单每成品 已出+本批 ≤ 订单数量（订单行已锁，无竞态）
        {
          const perOrder = new Map<number, Map<number, number>>()
          for (const l of linesToCreate) {
            const m = perOrder.get(l.salesOrderId) ?? new Map<number, number>()
            m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty)
            perOrder.set(l.salesOrderId, m)
          }
          for (const [oid, m] of perOrder) {
            const order = await tx.salesOrder.findUnique({ where: { id: oid }, include: { items: true } })
            if (!order) throw new Error('订单不存在')
            if (order.status === 'draft') throw new Error('订单未确认，不能出货')
            if (order.status === 'shipped' || order.status === 'completed') throw new Error('订单已出货')
            const shippedAgg = await tx.shipmentLine.groupBy({
              by: ['productId'],
              where: { salesOrderId: oid },
              _sum: { qty: true },
            })
            const shipped = new Map(shippedAgg.map((g) => [g.productId, g._sum.qty ?? 0]))
            for (const it of order.items) {
              const sum = (m.get(it.productId) ?? 0) + (shipped.get(it.productId) ?? 0)
              if (sum > it.qty) {
                throw new Error('明细行数量超过订单数量（成品 ' + it.productId + ' 已出+本批 ' + sum + ' > 订单 ' + it.qty + '）')
              }
            }
          }
        }
        // 库存检查（按成品合计）
        const qtyByProduct = new Map<number, number>()
        for (const l of linesToCreate) qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) ?? 0) + l.qty)
        for (const [pid, qty] of qtyByProduct) {
          const stock = await tx.stock.findUnique({ where: { itemType_itemId: { itemType: 'product', itemId: pid } } })
          if ((stock?.qtyOnHand ?? 0) < qty) throw new Error('库存不足')
        }

        const meta = {
          ...(data.shippedAt ? { shippedAt: new Date(data.shippedAt) } : {}),
          deliveryNote: data.deliveryNote || null,
          signer: data.signer || null,
          remark: data.remark || null,
          invoiceNo: data.invoiceNo || null,
          paymentTerms: data.paymentTerms || null,
          incoterm: data.incoterm || null,
          mark: data.mark || null,
          origin: data.origin || null,
          hsCode: data.hsCode || null,
          taxRate: data.taxRate || null,
          vesselVoyage: data.vesselVoyage || null,
          ...(data.etd ? { etd: new Date(data.etd) } : {}),
          ...(data.eta ? { eta: new Date(data.eta) } : {}),
          shippingInstructions: data.shippingInstructions || null,
        }
        const primaryOrderId = linesToCreate[0]!.salesOrderId
        const created = await tx.shipment.create({ data: { salesOrderId: primaryOrderId, ...meta, hubId } })
        await tx.shipmentLine.createMany({
          data: linesToCreate.map((l, i) => ({
            shipmentId: created.id,
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            customerPoNo: l.customerPoNo,
            lineNo: l.lineNo,
            salesOrderId: l.salesOrderId,
            scheduleId: l.scheduleId,
            lotNo: l.lotNo,
            cartons: l.cartons,
            netWeight: l.netWeight,
            grossWeight: l.grossWeight,
            cbm: l.cbm,
            containerNo: l.containerNo,
            sealNo: l.sealNo,
            hblNo: l.hblNo,
            remark: l.remark,
            sortOrder: i,
          })),
        })
        for (const l of linesToCreate) {
          await applyStockChange(tx, 'product', l.productId, -l.qty, 'shipment', created.id, l.salesOrderId)
        }
        // 排程扣减：出完置 shipped，未出完保持 picked
        if (data.schedules && data.schedules.length > 0) {
          for (const s of data.schedules) {
            const row = await tx.shipmentSchedule.findUniqueOrThrow({ where: { id: s.id } })
            const remain = row.qty - s.qty
            await tx.shipmentSchedule.update({
              where: { id: s.id },
              data: {
                qty: remain,
                status: remain === 0 ? 'shipped' : 'picked',
                ...(remain === 0 ? { shipmentId: created.id } : {}),
              },
            })
          }
        }
        // 订单状态：出满自动 shipped
        for (const oid of orderIds) {
          const order = await tx.salesOrder.findUnique({ where: { id: oid }, include: { items: true } })
          if (!order) continue
          const shippedAgg = await tx.shipmentLine.aggregate({ where: { salesOrderId: oid }, _sum: { qty: true } })
          const total = order.items.reduce((s, it) => s + it.qty, 0)
          if ((shippedAgg._sum.qty ?? 0) >= total && order.status !== 'shipped' && order.status !== 'completed') {
            await tx.salesOrder.updateMany({
              where: { id: oid, status: { in: ['confirmed', 'in_production', 'ready'] } },
              data: { status: 'shipped' },
            })
          }
        }
        return tx.shipment.findUniqueOrThrow({
          where: { id: created.id },
          include: { ...LEGS_INCLUDE, ...LINES_INCLUDE, ...HUB_INCLUDE },
        })
      })
      return reply.code(200).send(shipment)
    } catch (err) {
      const e = routeError(err, ['订单不存在', '排程不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 出货后补录/修改单证资料（发票号/柜号/明细行等）：仅 sales；只改单据信息，不动库存。
  // 明细行替换时按原顺序保留 行所属订单/来源排程（避免跨订单关联丢失）。
  app.patch('/api/shipments/:id', { preHandler: requireRole('sales') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '出货单 ID 必须为正整数' })
    const data = parseBody(patchShipmentSchema, req.body, reply)
    if (data === null) return

    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: '出货单不存在' })

    const textKeys = ['deliveryNote', 'signer', 'remark', 'invoiceNo', 'paymentTerms', 'incoterm', 'mark', 'origin', 'hsCode', 'taxRate', 'vesselVoyage', 'shippingInstructions'] as const
    const update: Record<string, string | Date | null> = {}
    for (const k of textKeys) {
      if (k in data) update[k] = data[k] || null
    }
    if (data.shippedAt !== undefined) update.shippedAt = data.shippedAt ? new Date(data.shippedAt) : shipment.shippedAt
    if (data.etd !== undefined) update.etd = data.etd ? new Date(data.etd) : null
    if (data.eta !== undefined) update.eta = data.eta ? new Date(data.eta) : null

    try {
      await prisma.$transaction(async (tx) => {
        if (Object.keys(update).length > 0) {
          await tx.shipment.update({ where: { id }, data: update })
        }
        if (data.lines !== undefined) {
          const existing = await tx.shipmentLine.findMany({ where: { shipmentId: id }, orderBy: { sortOrder: 'asc' as const } })
          // 账实一致性（BUG-04）：出货后禁止增删行、改成品/数量/单价，仅可补录单证文字
          if (data.lines.length !== existing.length) {
            throw new Error('出货后不能增删明细行，仅可补录单证信息（如要改数量请先撤销出货）')
          }
          for (let i = 0; i < data.lines.length; i++) {
            const a = data.lines[i]
            const b = existing[i]
            if (!a || !b || a.productId !== b.productId || a.qty !== b.qty || Number(a.unitPrice) !== Number(b.unitPrice)) {
              throw new Error('出货后不能修改明细行的成品/数量/单价，仅可补录单证信息（箱数/毛净重/CBM/柜号/HBL 等）')
            }
          }
          await tx.shipmentLine.deleteMany({ where: { shipmentId: id } })
          if (data.lines.length > 0) {
            await tx.shipmentLine.createMany({
              data: data.lines.map((l, i) => ({
                shipmentId: id,
                productId: l.productId,
                qty: l.qty,
                unitPrice: l.unitPrice,
                // 保留原行的订单/排程关联（按原顺序）
                salesOrderId: existing[i]?.salesOrderId ?? shipment.salesOrderId,
                scheduleId: existing[i]?.scheduleId ?? null,
                customerPoNo: l.customerPoNo || null,
                lineNo: l.lineNo || null,
                lotNo: l.lotNo || null,
                cartons: l.cartons ?? null,
                netWeight: l.netWeight ?? null,
                grossWeight: l.grossWeight ?? null,
                cbm: l.cbm ?? null,
                containerNo: l.containerNo || null,
                sealNo: l.sealNo || null,
                hblNo: l.hblNo || null,
                remark: l.remark || null,
                sortOrder: i,
              })),
            })
          }
        }
      })
      const refreshed = await prisma.shipment.findUniqueOrThrow({
        where: { id },
        include: { ...LEGS_INCLUDE, ...LINES_INCLUDE, ...HUB_INCLUDE },
      })
      return reply.code(200).send(refreshed)
    } catch (err) {
      const e = routeError(err, ['出货单不存在'])
      return reply.code(e.status).send({ error: e.message })
    }
  })

  // 追加运输节点：仅 sales
  app.post('/api/shipments/:id/legs', { preHandler: requireRole('sales') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '出货单 ID 必须为正整数' })
    const data = parseBody(createLegSchema, req.body, reply)
    if (data === null) return

    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: '出货单不存在' })

    const leg = await prisma.shipmentLeg.create({
      data: {
        shipmentId: id,
        node: data.node,
        ...(data.at ? { at: new Date(data.at) } : {}),
        ...(data.note !== undefined && data.note !== '' ? { note: data.note } : {}),
      },
    })
    return reply.code(200).send(leg)
  })

  // 出货单列表：5 角色均可查，可选按订单过滤，legs 按 at 倒序；非销售/老板不返回销售单价
  app.get('/api/shipments', { preHandler: requireRole(...ALL_ROLES) }, async (req, reply) => {
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const raw = (req.query as { orderId?: string }).orderId
    let where: { salesOrderId?: number } = {}
    if (raw !== undefined) {
      const orderId = Number(raw)
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return reply.code(400).send({ error: 'orderId 必须为正整数' })
      }
      where = { salesOrderId: orderId }
    }
    const pagination = parsePagination(req.query as Record<string, unknown>)
    if (pagination.kind === 'error') return reply.code(400).send({ error: pagination.message })
    const include = {
      ...LEGS_INCLUDE,
      ...LINES_INCLUDE,
      ...HUB_INCLUDE,
      salesOrder: {
        include: {
          customer: { select: { name: true } },
          items: { include: { product: { select: { sku: true, name: true } } } },
        },
      },
    } as const
    const orderBy = { id: 'desc' as const }
    const hidePrice = role !== 'sales' && role !== 'boss'
    const toRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...row }
      const salesOrder = row.salesOrder as { items?: Array<Record<string, unknown>> } | undefined
      if (hidePrice) {
        out.salesOrder = salesOrder
          ? { ...salesOrder, items: salesOrder.items?.map((it) => ({ ...it, unitPrice: undefined })) }
          : salesOrder
        out.lines = (row.lines as Array<Record<string, unknown>> | undefined)?.map((l) => ({ ...l, unitPrice: undefined }))
      }
      return out
    }
    if (pagination.kind === 'none') {
      const rows = await prisma.shipment.findMany({ where, orderBy, include })
      return rows.map((r) => toRow(r as unknown as Record<string, unknown>))
    }
    const page = pagination.page
    const [rows, total] = await Promise.all([
      prisma.shipment.findMany({
        where,
        orderBy,
        include,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.shipment.count({ where }),
    ])
    return pagedResult(
      rows.map((r) => toRow(r as unknown as Record<string, unknown>)),
      total,
      page,
    )
  })

  // 三份单证一键导出：仅 sales/boss
  app.get('/api/shipments/:id/export', { preHandler: requireRole('sales', 'boss') }, async (req, reply) => {
    const id = parsePositiveInt((req.params as { id: string }).id)
    if (id === null) return reply.code(400).send({ error: '出货单 ID 必须为正整数' })
    const typeRaw = (req.query as { type?: string }).type
    if (typeRaw !== 'official' && typeRaw !== 'commercial' && typeRaw !== 'packing') {
      return reply.code(400).send({ error: 'type 必须为 official / commercial / packing' })
    }

    const shipment = await prisma.shipment.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { sortOrder: 'asc' as const },
          include: { product: { select: { sku: true, name: true, nameEn: true, hsCode: true } } },
        },
        salesOrder: {
          include: {
            customer: true,
          },
        },
      },
    })
    if (!shipment) return reply.code(404).send({ error: '出货单不存在' })

    const companyRow = await prisma.companyProfile.findFirst()
    const company: DocCompany = companyRow
      ? (companyRow as unknown as DocCompany)
      : { name: '', address: '', contact: '', email: '', vatNo: '', taxRate: '0', bankName: '', bankPhone: '', bankAddress: '', swift: '', accountName: '', accountNo: '' }
    const customer = shipment.salesOrder.customer
    // 收款记录：聚合本票涉及的全部订单（跨订单拼票时）
    const involvedOrderIds = [...new Set(shipment.lines.map((l) => l.salesOrderId).filter((v): v is number => v !== null))]
    const payments = await prisma.customerPayment.findMany({
      where: { salesOrderId: { in: involvedOrderIds.length > 0 ? involvedOrderIds : [shipment.salesOrderId] } },
      orderBy: { receivedAt: 'asc' as const },
    })
    const doc: ShipmentDocData = {
      company,
      customer: {
        name: customer.name,
        country: customer.country,
        contact: customer.contact,
        address: customer.address,
        vatNo: customer.vatNo,
        eori: customer.eori,
        notifyParty: customer.notifyParty,
      } satisfies DocCustomer,
      orderNo: shipment.salesOrder.orderNo,
      shipment: {
        invoiceNo: shipment.invoiceNo,
        paymentTerms: shipment.paymentTerms,
        incoterm: shipment.incoterm,
        mark: shipment.mark,
        origin: shipment.origin,
        hsCode: shipment.hsCode,
        taxRate: shipment.taxRate,
        vesselVoyage: shipment.vesselVoyage,
        etd: shipment.etd,
        eta: shipment.eta,
        shippingInstructions: shipment.shippingInstructions,
        shippedAt: shipment.shippedAt,
      },
      lines: shipment.lines.map(
        (l) =>
          ({
            product: l.product,
            qty: l.qty,
            unitPrice: l.unitPrice.toString(),
            customerPoNo: l.customerPoNo,
            lineNo: l.lineNo,
            lotNo: l.lotNo,
            cartons: l.cartons,
            netWeight: l.netWeight?.toString() ?? null,
            grossWeight: l.grossWeight?.toString() ?? null,
            cbm: l.cbm?.toString() ?? null,
            containerNo: l.containerNo,
            sealNo: l.sealNo,
            hblNo: l.hblNo,
            remark: l.remark,
          }) satisfies DocLine,
      ),
      payments: payments.map((p) => ({ amount: p.amount.toString(), paidAt: p.receivedAt }) satisfies DocPayment),
    }

    // 优先：以微信原始模板为基础填写（样式/合并/列宽 100% 保真）；模板缺失时回退生成器
    const templateBuf = await buildFromTemplate(typeRaw, doc)
    let buf: Buffer
    if (templateBuf) {
      buf = templateBuf
    } else {
      const builders = {
        official: buildOfficialInvoice,
        commercial: buildCommercialInvoice,
        packing: buildPackingList,
      } as const
      buf = Buffer.from(await builders[typeRaw](doc).xlsx.writeBuffer())
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const userId = (req as { user?: { userId?: number; role?: string } }).user?.userId
    const role = (req as { user?: { role?: string } }).user?.role ?? ''
    const exporter = userId != null
      ? ((await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || role)
      : role
    const typeName = { official: 'Official-Invoice', commercial: 'Commercial-Invoice', packing: 'Packing-List' }[typeRaw]
    const base = shipment.invoiceNo ? shipment.invoiceNo : 'shipment-' + id
    const fileName = 'erp-' + base + '-' + typeName + '-' + date + '-' + exporter + '.xlsx'
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName) + '; filename="erp-shipment-doc.xlsx"')
    reply.send(buf)
  })
}
