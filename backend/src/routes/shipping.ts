import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db'
import { requireRole } from '../auth/guard'
import { applyStockChange } from '../domain/inventory'
import { prismaErrorInfo, parsePositiveInt } from '../errors'
import { parsePagination, pagedResult } from '../pagination'
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

type ShipmentLineInput = z.infer<typeof shipmentLineSchema>

interface LineToCreate {
  productId: number
  qty: number
  unitPrice: number
  customerPoNo: string | null
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
          const rows = await tx.shipmentSchedule.findMany({
            where: { id: { in: data.schedules.map((s) => s.id) } },
            include: { salesOrder: { select: { id: true, status: true, customerPoNo: true } }, product: { select: { id: true, sku: true } } },
          })
          if (rows.length !== data.schedules.length) throw new Error('排程不存在')
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
          // ===== 手工模式 =====
          if (data.salesOrderId === undefined) throw new Error('订单必填')
          const order = await tx.salesOrder.findUnique({
            where: { id: data.salesOrderId },
            include: { items: { include: { product: { select: { sku: true } } } } },
          })
          if (!order) throw new Error('订单不存在')
          if (order.status === 'shipped' || order.status === 'completed') throw new Error('订单已出货')
          if (order.status === 'draft') throw new Error('订单未确认，不能出货')

          const lines: ShipmentLineInput[] = data.lines && data.lines.length > 0
            ? data.lines
            : order.items.map((it) => ({ productId: it.productId, qty: it.qty, unitPrice: Number(it.unitPrice) }))
          const qtyByProduct = new Map<number, number>()
          for (const l of lines) {
            const item = order.items.find((it) => it.productId === l.productId)
            if (!item) throw new Error('明细行包含不属于该订单的成品')
            qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) ?? 0) + l.qty)
          }
          // 部分出货：本批合计 + 已出 不得超过订单数量
          const shippedAgg = await tx.shipmentLine.groupBy({
            by: ['productId'],
            where: { salesOrderId: order.id },
            _sum: { qty: true },
          })
          const shippedByProduct = new Map(shippedAgg.map((g) => [g.productId, g._sum.qty ?? 0]))
          for (const it of order.items) {
            const sum = (qtyByProduct.get(it.productId) ?? 0) + (shippedByProduct.get(it.productId) ?? 0)
            if (sum > it.qty) {
              throw new Error('明细行数量超过订单数量（' + it.product.sku + ' 已出+本批 ' + sum + ' > 订单 ' + it.qty + '）')
            }
          }
          for (const l of lines) {
            linesToCreate.push({
              productId: l.productId,
              qty: l.qty,
              unitPrice: l.unitPrice,
              customerPoNo: l.customerPoNo || order.customerPoNo,
              salesOrderId: order.id,
              scheduleId: null,
              lotNo: l.lotNo || null,
              cartons: l.cartons ?? null,
              netWeight: l.netWeight ?? null,
              grossWeight: l.grossWeight ?? null,
              cbm: l.cbm ?? null,
              containerNo: l.containerNo || null,
              sealNo: l.sealNo || null,
              hblNo: l.hblNo || null,
              remark: l.remark || null,
            })
          }
          orderIds.add(order.id)
        }

        if (linesToCreate.length === 0) throw new Error('出货明细为空')
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
      const message = err instanceof Error ? err.message : '出货失败'
      if (message.includes('库存不足')) return reply.code(400).send({ error: message })
      if (message.includes('尚未备好')) return reply.code(400).send({ error: message })
      if (message.includes('数量超出') || message.includes('数量超过')) return reply.code(400).send({ error: message })
      if (message.includes('订单已出货')) return reply.code(400).send({ error: message })
      if (message.includes('未确认')) return reply.code(400).send({ error: message })
      if (message.includes('订单必填')) return reply.code(400).send({ error: message })
      if (message.includes('订单不存在')) return reply.code(404).send({ error: message })
      if (message.includes('排程不存在')) return reply.code(404).send({ error: message })
      if (message.includes('排程成品')) return reply.code(400).send({ error: message })
      if (message.includes('到货仓')) return reply.code(400).send({ error: message })
      if (message.includes('明细行')) return reply.code(400).send({ error: message })
      if (message.includes('明细为空')) return reply.code(400).send({ error: message })
      const info = prismaErrorInfo(err)
      if (info) return reply.code(info.status).send({ error: info.message })
      return reply.code(500).send({ error: '出货失败，请稍后重试' })
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

    await prisma.$transaction(async (tx) => {
      if (Object.keys(update).length > 0) {
        await tx.shipment.update({ where: { id }, data: update })
      }
      if (data.lines !== undefined) {
        const existing = await tx.shipmentLine.findMany({ where: { shipmentId: id }, orderBy: { sortOrder: 'asc' as const } })
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

    const builders = {
      official: buildOfficialInvoice,
      commercial: buildCommercialInvoice,
      packing: buildPackingList,
    } as const
    const wb = builders[typeRaw](doc)
    const buf = await wb.xlsx.writeBuffer()

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
    reply.send(Buffer.from(buf))
  })
}
