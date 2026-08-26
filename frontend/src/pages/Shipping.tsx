import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  message,
} from 'antd'
import { CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateTimeStr, notifyError, statusLabel } from './common'
import type { Paged } from './common'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
  customerPoNo?: string | null
  customer?: { name: string }
  items?: OrderItem[]
}

interface OrderItem {
  id: number
  productId: number
  qty: number
  unitPrice?: string
  product: { id: number; sku: string; name: string; nameEn?: string | null }
}

interface ProductOption {
  id: number
  sku: string
  name: string
}

interface Hub {
  id: number
  name: string
}

interface ScheduleRow {
  id: number
  salesOrderId: number
  productId: number
  qty: number
  hubId: number
  status: string
  needByDate: string
  promisedDate: string
  salesOrder: {
    id: number
    orderNo: string
    customerPoNo: string | null
    paymentTerms?: string | null
    customer: { name: string; defaultIncoterm?: string | null; defaultMark?: string | null; defaultTaxRate?: string | null }
  }
  product: { id: number; sku: string; name: string }
  hub: { id: number; name: string }
}

interface ShipmentLeg {
  id: number
  shipmentId: number
  node: string
  at: string
  note: string | null
}

interface ShipmentLine {
  id: number
  productId: number
  qty: number
  unitPrice: string
  customerPoNo: string | null
  lotNo: string | null
  cartons: number | null
  netWeight: string | null
  grossWeight: string | null
  cbm: string | null
  containerNo: string | null
  sealNo: string | null
  hblNo: string | null
  remark: string | null
  product: { id: number; sku: string; name: string; nameEn?: string | null }
}

interface Shipment {
  id: number
  salesOrderId: number
  shippedAt: string
  deliveryNote: string | null
  signer: string | null
  remark: string | null
  invoiceNo: string | null
  paymentTerms: string | null
  incoterm: string | null
  mark: string | null
  origin: string | null
  hsCode: string | null
  taxRate: string | null
  vesselVoyage: string | null
  etd: string | null
  eta: string | null
  shippingInstructions: string | null
  hub?: { id: number; name: string } | null
  legs: ShipmentLeg[]
  lines: ShipmentLine[]
  salesOrder?: { orderNo: string; customer: { name: string } }
}

interface LineRow {
  key: number
  productId?: number
  qty?: number | null
  unitPrice?: number | null
  customerPoNo?: string
  lotNo?: string
  cartons?: number | null
  netWeight?: number | null
  grossWeight?: number | null
  cbm?: number | null
  containerNo?: string
  sealNo?: string
  hblNo?: string
  remark?: string
}

const NODE_OPTIONS = ['备货', '装柜', '开船', '到港', '清关'].map((n) => ({ value: n, label: n }))
const INCOTERM_OPTIONS = ['FCA', 'FOB', 'CIF', 'DDP', 'DAP', 'EXW'].map((n) => ({ value: n, label: n }))

let rowKeySeq = 1
function newRowKey() {
  return rowKeySeq++
}

function toLineRow(l: ShipmentLine): LineRow {
  return {
    key: newRowKey(),
    productId: l.productId,
    qty: l.qty,
    unitPrice: Number(l.unitPrice),
    customerPoNo: l.customerPoNo ?? undefined,
    lotNo: l.lotNo ?? undefined,
    cartons: l.cartons,
    netWeight: l.netWeight ? Number(l.netWeight) : undefined,
    grossWeight: l.grossWeight ? Number(l.grossWeight) : undefined,
    cbm: l.cbm ? Number(l.cbm) : undefined,
    containerNo: l.containerNo ?? undefined,
    sealNo: l.sealNo ?? undefined,
    hblNo: l.hblNo ?? undefined,
    remark: l.remark ?? undefined,
  }
}

function LinesEditor({
  lines,
  setLines,
  products,
}: {
  lines: LineRow[]
  setLines: React.Dispatch<React.SetStateAction<LineRow[]>>
  products: ProductOption[]
}) {
  function patch(key: number, p: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)))
  }
  const num = (v: number | null | undefined) => (typeof v === 'number' ? v : undefined)
  const columns = [
    {
      title: '成品', key: 'product', width: 220,
      render: (_: unknown, r: LineRow) => (
        <Select
          showSearch optionFilterProp="label" placeholder="选择成品" style={{ width: '100%' }}
          value={r.productId}
          onChange={(v) => patch(r.key, { productId: v })}
          options={products.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
        />
      ),
    },
    { title: '数量', key: 'qty', width: 90, render: (_: unknown, r: LineRow) => <InputNumber min={1} precision={0} value={r.qty ?? undefined} onChange={(v) => patch(r.key, { qty: v })} style={{ width: '100%' }} /> },
    { title: '单价', key: 'unitPrice', width: 100, render: (_: unknown, r: LineRow) => <InputNumber min={0} precision={2} value={r.unitPrice ?? undefined} onChange={(v) => patch(r.key, { unitPrice: v })} style={{ width: '100%' }} /> },
    { title: '客户PO', key: 'customerPoNo', width: 110, render: (_: unknown, r: LineRow) => <Input value={r.customerPoNo ?? ''} onChange={(e) => patch(r.key, { customerPoNo: e.target.value })} /> },
    { title: 'Lot', key: 'lotNo', width: 110, render: (_: unknown, r: LineRow) => <Input value={r.lotNo ?? ''} onChange={(e) => patch(r.key, { lotNo: e.target.value })} /> },
    { title: '箱数', key: 'cartons', width: 80, render: (_: unknown, r: LineRow) => <InputNumber min={0} precision={0} value={num(r.cartons)} onChange={(v) => patch(r.key, { cartons: v })} style={{ width: '100%' }} /> },
    { title: '净重(kg)', key: 'netWeight', width: 90, render: (_: unknown, r: LineRow) => <InputNumber min={0} precision={3} value={num(r.netWeight)} onChange={(v) => patch(r.key, { netWeight: v })} style={{ width: '100%' }} /> },
    { title: '毛重(kg)', key: 'grossWeight', width: 90, render: (_: unknown, r: LineRow) => <InputNumber min={0} precision={3} value={num(r.grossWeight)} onChange={(v) => patch(r.key, { grossWeight: v })} style={{ width: '100%' }} /> },
    { title: 'CBM', key: 'cbm', width: 90, render: (_: unknown, r: LineRow) => <InputNumber min={0} precision={4} value={num(r.cbm)} onChange={(v) => patch(r.key, { cbm: v })} style={{ width: '100%' }} /> },
    { title: '柜号', key: 'containerNo', width: 130, render: (_: unknown, r: LineRow) => <Input value={r.containerNo ?? ''} onChange={(e) => patch(r.key, { containerNo: e.target.value })} /> },
    { title: '封条', key: 'sealNo', width: 110, render: (_: unknown, r: LineRow) => <Input value={r.sealNo ?? ''} onChange={(e) => patch(r.key, { sealNo: e.target.value })} /> },
    { title: 'HBL', key: 'hblNo', width: 120, render: (_: unknown, r: LineRow) => <Input value={r.hblNo ?? ''} onChange={(e) => patch(r.key, { hblNo: e.target.value })} /> },
    { title: '备注', key: 'remark', width: 110, render: (_: unknown, r: LineRow) => <Input value={r.remark ?? ''} onChange={(e) => patch(r.key, { remark: e.target.value })} /> },
    {
      title: '操作', key: 'action', width: 120,
      render: (_: unknown, r: LineRow) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<CopyOutlined />} title="拆行"
            onClick={() => {
              const idx = lines.findIndex((l) => l.key === r.key)
              const copy = { ...r, key: newRowKey(), qty: 1 }
              setLines((prev) => [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)])
            }}
          />
          <Button size="small" type="text" danger icon={<DeleteOutlined />}
            onClick={() => setLines((prev) => prev.filter((l) => l.key !== r.key))}
          />
        </Space>
      ),
    },
  ]
  return (
    <Table<LineRow>
      rowKey="key" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 1700 }}
      footer={() => (
        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setLines((prev) => [...prev, { key: newRowKey(), qty: 1 }])}>
          添加行
        </Button>
      )}
    />
  )
}

function linePayload(lines: LineRow[]) {
  return lines.map((l) => ({
    productId: Number(l.productId ?? 0),
    qty: Number(l.qty ?? 0),
    unitPrice: Number(l.unitPrice ?? 0),
    customerPoNo: l.customerPoNo || null,
    lotNo: l.lotNo || null,
    cartons: typeof l.cartons === 'number' ? l.cartons : null,
    netWeight: typeof l.netWeight === 'number' ? l.netWeight : null,
    grossWeight: typeof l.grossWeight === 'number' ? l.grossWeight : null,
    cbm: typeof l.cbm === 'number' ? l.cbm : null,
    containerNo: l.containerNo || null,
    sealNo: l.sealNo || null,
    hblNo: l.hblNo || null,
    remark: l.remark || null,
  }))
}

const META_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(160px, 1fr))',
  gap: '0 12px',
}

export default function Shipping() {
  const { user } = useAuth()
  const role = user?.role
  const canOperate = role === 'sales'
  const canExport = role === 'sales' || role === 'boss'

  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [hubs, setHubs] = useState<Hub[]>([])
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  // 排程出货
  const [scheduleForm] = Form.useForm<Record<string, string | number>>()
  const [hubId, setHubId] = useState<number | undefined>()
  const [picked, setPicked] = useState<Record<number, number>>({}) // scheduleId -> qty
  const [shipping, setShipping] = useState(false)

  // 手工出货（无排程）
  const [shipForm] = Form.useForm<Record<string, string | number>>()
  const [lines, setLines] = useState<LineRow[]>([])
  const [selectedOrder, setSelectedOrder] = useState<SalesOrder | null>(null)

  const [editTarget, setEditTarget] = useState<Shipment | null>(null)
  const [editForm] = Form.useForm<Record<string, string | number>>()
  const [editLines, setEditLines] = useState<LineRow[]>([])
  const [editSaving, setEditSaving] = useState(false)

  const [legShipment, setLegShipment] = useState<Shipment | null>(null)
  const [legForm] = Form.useForm<{ node?: string; at?: string; note?: string }>()
  const [legSubmitting, setLegSubmitting] = useState(false)

  async function load(targetPage = page, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const [o, p, h, s, sh] = await Promise.all([
        api.get<SalesOrder[]>('/orders'),
        api.get<ProductOption[]>('/products'),
        api.get<Hub[]>('/hubs'),
        api.get<ScheduleRow[]>('/schedules', { params: { status: 'picked' } }),
        api.get<Paged<Shipment>>('/shipments', { params: { page: targetPage, pageSize: ps } }),
      ])
      setOrders(o.data)
      setProducts(p.data)
      setHubs(h.data)
      setSchedules(s.data)
      setShipments(sh.data.items)
      setTotal(sh.data.total)
      setPage(sh.data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hubSchedules = hubId ? schedules.filter((s) => s.hubId === hubId) : []

  // 选到货仓后：把第一个排程的订单付款条件与客户默认单证值带出（可改）
  useEffect(() => {
    const first = hubSchedules[0]
    if (first) {
      scheduleForm.setFieldsValue({
        paymentTerms: first.salesOrder.paymentTerms ?? '',
        incoterm: first.salesOrder.customer.defaultIncoterm ?? '',
        mark: first.salesOrder.customer.defaultMark ?? '',
        taxRate: first.salesOrder.customer.defaultTaxRate ?? '0',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubId])

  async function shipFromSchedules(values: Record<string, string | number>) {
    if (!hubId) {
      message.warning('请选择到货仓')
      return
    }
    const items = hubSchedules
      .map((s) => ({ id: s.id, qty: picked[s.id] ?? 0 }))
      .filter((x) => x.qty > 0)
    if (items.length === 0) {
      message.warning('请在下方表格填写出货数量')
      return
    }
    setShipping(true)
    try {
      await api.post('/shipments', {
        hubId,
        schedules: items,
        shippedAt: values.shippedAt || undefined,
        deliveryNote: values.deliveryNote || null,
        signer: values.signer || null,
        remark: values.remark || null,
        invoiceNo: values.invoiceNo || null,
        paymentTerms: values.paymentTerms || null,
        incoterm: values.incoterm || null,
        mark: values.mark || null,
        origin: values.origin || null,
        hsCode: values.hsCode || null,
        taxRate: values.taxRate || null,
        vesselVoyage: values.vesselVoyage || null,
        etd: values.etd || undefined,
        eta: values.eta || undefined,
        shippingInstructions: values.shippingInstructions || null,
      })
      message.success('出货成功，订单状态已更新')
      scheduleForm.resetFields()
      setHubId(undefined)
      setPicked({})
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setShipping(false)
    }
  }

  async function handleOrderSelect(orderId: number) {
    try {
      const { data } = await api.get<SalesOrder>('/orders/' + orderId)
      setSelectedOrder(data)
      setLines(
        (data.items ?? []).map((it) => ({
          key: newRowKey(),
          productId: it.productId,
          qty: it.qty,
          unitPrice: it.unitPrice !== undefined ? Number(it.unitPrice) : undefined,
        })),
      )
    } catch (err) {
      notifyError(err)
    }
  }

  async function handleShipManual(values: Record<string, string | number>) {
    if (!values.salesOrderId) {
      message.warning('请选择订单')
      return
    }
    const bad = lines.filter((l) => !l.productId || !l.qty || l.qty <= 0 || l.unitPrice === undefined || l.unitPrice === null)
    if (lines.length === 0 || bad.length > 0) {
      message.warning('明细行不完整：每行需选择成品并填写数量与单价')
      return
    }
    setShipping(true)
    try {
      await api.post('/shipments', {
        salesOrderId: values.salesOrderId,
        shippedAt: values.shippedAt || undefined,
        deliveryNote: values.deliveryNote || null,
        signer: values.signer || null,
        remark: values.remark || null,
        invoiceNo: values.invoiceNo || null,
        paymentTerms: values.paymentTerms || null,
        incoterm: values.incoterm || null,
        mark: values.mark || null,
        origin: values.origin || null,
        hsCode: values.hsCode || null,
        taxRate: values.taxRate || null,
        vesselVoyage: values.vesselVoyage || null,
        etd: values.etd || undefined,
        eta: values.eta || undefined,
        shippingInstructions: values.shippingInstructions || null,
        lines: linePayload(lines),
      })
      message.success('出货成功')
      shipForm.resetFields()
      setLines([])
      setSelectedOrder(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setShipping(false)
    }
  }

  function openEdit(s: Shipment) {
    setEditTarget(s)
    editForm.setFieldsValue({
      invoiceNo: s.invoiceNo ?? '',
      paymentTerms: s.paymentTerms ?? '',
      incoterm: s.incoterm ?? '',
      mark: s.mark ?? '',
      origin: s.origin ?? 'China',
      hsCode: s.hsCode ?? '',
      taxRate: s.taxRate ?? '0',
      vesselVoyage: s.vesselVoyage ?? '',
      etd: s.etd ? s.etd.slice(0, 10) : '',
      eta: s.eta ? s.eta.slice(0, 10) : '',
      shippingInstructions: s.shippingInstructions ?? '',
      deliveryNote: s.deliveryNote ?? '',
      signer: s.signer ?? '',
      remark: s.remark ?? '',
      shippedAt: s.shippedAt ? s.shippedAt.slice(0, 10) : '',
    })
    setEditLines(s.lines.map(toLineRow))
  }

  async function saveEdit(values: Record<string, string | number>) {
    if (!editTarget) return
    const bad = editLines.filter((l) => !l.productId || !l.qty || l.qty <= 0 || l.unitPrice === undefined || l.unitPrice === null)
    if (editLines.length === 0 || bad.length > 0) {
      message.warning('明细行不完整')
      return
    }
    setEditSaving(true)
    try {
      await api.patch('/shipments/' + editTarget.id, {
        ...values,
        shippedAt: values.shippedAt || undefined,
        etd: values.etd || undefined,
        eta: values.eta || undefined,
        lines: linePayload(editLines),
      })
      message.success('出货单已更新')
      setEditTarget(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setEditSaving(false)
    }
  }

  async function exportDoc(shipmentId: number, type: 'official' | 'commercial' | 'packing') {
    try {
      const res = await api.get('/shipments/' + shipmentId + '/export', { params: { type }, responseType: 'blob' })
      const cd = (res.headers as Record<string, unknown>)['content-disposition'] as string | undefined
      const m = cd && /filename\*=UTF-8''([^;]+)/.exec(cd)
      const name = m ? decodeURIComponent(m[1] ?? '') : 'erp-shipment-doc.xlsx'
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      notifyError(err)
    }
  }

  async function handleAddLeg(values: { node?: string; at?: string; note?: string }) {
    if (!legShipment) return
    setLegSubmitting(true)
    try {
      await api.post('/shipments/' + legShipment.id + '/legs', {
        node: values.node,
        at: values.at,
        note: values.note,
      })
      message.success('运输节点已添加')
      setLegShipment(null)
      legForm.resetFields()
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setLegSubmitting(false)
    }
  }

  const scheduleColumns = [
    { title: '订单号', key: 'orderNo', render: (_: unknown, r: ScheduleRow) => r.salesOrder.orderNo },
    { title: '客户PO', key: 'po', render: (_: unknown, r: ScheduleRow) => r.salesOrder.customerPoNo ?? '-' },
    { title: '成品', key: 'product', render: (_: unknown, r: ScheduleRow) => r.product.sku + ' ' + r.product.name },
    { title: '排程剩余', dataIndex: 'qty', key: 'qty', width: 90 },
    { title: '承诺日', dataIndex: 'promisedDate', key: 'promisedDate', render: (v: string) => (v ? String(v).slice(0, 10) : '-') },
    {
      title: '本次出货数量', key: 'pick', width: 150,
      render: (_: unknown, r: ScheduleRow) => (
        <InputNumber
          min={0}
          max={r.qty}
          precision={0}
          value={picked[r.id] ?? 0}
          onChange={(v) => setPicked((prev) => ({ ...prev, [r.id]: typeof v === 'number' ? v : 0 }))}
          style={{ width: '100%' }}
        />
      ),
    },
  ]

  const columns = [
    { title: '出货单 ID', dataIndex: 'id', key: 'id', width: 90 },
    { title: '订单号', key: 'orderNo', render: (_: unknown, r: Shipment) => r.salesOrder?.orderNo ?? '-' },
    { title: '到货仓', key: 'hub', width: 110, render: (_: unknown, r: Shipment) => r.hub?.name ?? '-' },
    { title: '发票号', dataIndex: 'invoiceNo', key: 'invoiceNo', render: (v: string | null) => v || '-' },
    { title: '送货单号', dataIndex: 'deliveryNote', key: 'deliveryNote', render: (v: string | null) => v || '-' },
    { title: '出货时间', dataIndex: 'shippedAt', key: 'shippedAt', render: dateTimeStr },
    { title: '签收人', dataIndex: 'signer', key: 'signer', render: (v: string | null) => v || '-' },
    { title: '运输节点数', key: 'legs', width: 90, render: (_: unknown, r: Shipment) => r.legs.length },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_: unknown, r: Shipment) => {
        if (!canOperate && !canExport) return null
        return (
          <Space>
            {canOperate ? (
              <>
                <Button size="small" onClick={() => { legForm.resetFields(); setLegShipment(r) }}>
                  添加节点
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                  编辑单证
                </Button>
              </>
            ) : null}
            {canExport ? (
              <Dropdown
                menu={{
                  items: [
                    { key: 'official', label: '收款发票（Official Invoice）' },
                    { key: 'commercial', label: '商业发票（Commercial Invoice）' },
                    { key: 'packing', label: '装箱单（Packing List）' },
                  ],
                  onClick: ({ key }) => void exportDoc(r.id, key as 'official' | 'commercial' | 'packing'),
                }}
              >
                <Button size="small" icon={<DownloadOutlined />}>
                  导出单证
                </Button>
              </Dropdown>
            ) : null}
          </Space>
        )
      },
    },
  ]

  return (
    <div>
      {canOperate ? (
        <Card title="① 从排程出货（推荐：按客户 OPO 排程拼票）" style={{ marginBottom: 16 }}>
          <Form form={scheduleForm} layout="vertical" onFinish={shipFromSchedules}>
            <div style={META_GRID}>
              <Form.Item label="到货仓" required>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择到货仓（已备好的排程）"
                  value={hubId}
                  onChange={(v) => { setHubId(v); setPicked({}) }}
                  options={hubs.map((h) => ({ value: h.id, label: h.name }))}
                />
              </Form.Item>
              <Form.Item name="shippedAt" label="出货时间"><Input type="date" /></Form.Item>
              <Form.Item name="invoiceNo" label="发票号"><Input placeholder="如 ZRH20260814006" /></Form.Item>
              <Form.Item name="deliveryNote" label="送货单号"><Input placeholder="送货单号" /></Form.Item>
              <Form.Item name="paymentTerms" label="付款条件"><Input placeholder="如 NET 60" /></Form.Item>
              <Form.Item name="incoterm" label="贸易条款"><Select allowClear placeholder="如 FCA" options={INCOTERM_OPTIONS} /></Form.Item>
              <Form.Item name="mark" label="唛头"><Input placeholder="如 FANATEC" /></Form.Item>
              <Form.Item name="signer" label="签收人"><Input placeholder="签收人" /></Form.Item>
              <Form.Item name="origin" label="原产地" initialValue="China"><Input placeholder="China" /></Form.Item>
              <Form.Item name="hsCode" label="海关编码"><Input placeholder="如 9504 50 0000" /></Form.Item>
              <Form.Item name="taxRate" label="税率" initialValue="0"><Input placeholder="0" /></Form.Item>
              <Form.Item name="vesselVoyage" label="船名/航次"><Input placeholder="如 CMA CGM ZHENG HE / 0FMMMW1MA" /></Form.Item>
              <Form.Item name="etd" label="ETD"><Input type="date" /></Form.Item>
              <Form.Item name="eta" label="ETA"><Input type="date" /></Form.Item>
              <Form.Item name="shippingInstructions" label="运费说明"><Input placeholder="如 ALU 1264 pcs" /></Form.Item>
              <Form.Item name="remark" label="备注"><Input placeholder="备注" /></Form.Item>
            </div>
          </Form>
          {hubId ? (
            <>
              <Table<ScheduleRow>
                rowKey="id"
                size="small"
                columns={scheduleColumns}
                dataSource={hubSchedules}
                pagination={false}
                locale={{ emptyText: '该仓没有「已备好」的排程——去 出货排程 页让仓库标记备好，或销售直接建排程' }}
              />
              <Button type="primary" icon={<SendOutlined />} loading={shipping} style={{ marginTop: 12 }} onClick={() => scheduleForm.submit()}>
                出货
              </Button>
            </>
          ) : null}
        </Card>
      ) : null}

      {canOperate ? (
        <Card title="② 无排程直接出货（整单/部分，从订单选）" style={{ marginBottom: 16 }}>
          <Form form={shipForm} layout="vertical" onFinish={handleShipManual}>
            <div style={META_GRID}>
              <Form.Item name="salesOrderId" label="订单" rules={[{ required: true, message: '选择订单' }]}>
                <Select
                  showSearch optionFilterProp="label" placeholder="选择订单（已确认）"
                  onChange={(v) => void handleOrderSelect(v)}
                  options={orders
                    .filter((o) => ['confirmed', 'in_production', 'ready'].includes(o.status))
                    .map((o) => ({ value: o.id, label: o.orderNo + '（' + statusLabel(o.status) + '）' }))}
                />
              </Form.Item>
              <Form.Item name="shippedAt" label="出货时间"><Input type="date" /></Form.Item>
              <Form.Item name="invoiceNo" label="发票号"><Input placeholder="如 ZRH20260814006" /></Form.Item>
              <Form.Item name="deliveryNote" label="送货单号"><Input placeholder="送货单号" /></Form.Item>
              <Form.Item name="paymentTerms" label="付款条件"><Input placeholder="如 NET 60" /></Form.Item>
              <Form.Item name="incoterm" label="贸易条款"><Select allowClear placeholder="如 FCA" options={INCOTERM_OPTIONS} /></Form.Item>
              <Form.Item name="mark" label="唛头"><Input placeholder="如 FANATEC" /></Form.Item>
              <Form.Item name="signer" label="签收人"><Input placeholder="签收人" /></Form.Item>
              <Form.Item name="origin" label="原产地" initialValue="China"><Input placeholder="China" /></Form.Item>
              <Form.Item name="hsCode" label="海关编码"><Input placeholder="如 9504 50 0000" /></Form.Item>
              <Form.Item name="taxRate" label="税率" initialValue="0"><Input placeholder="0" /></Form.Item>
              <Form.Item name="vesselVoyage" label="船名/航次"><Input placeholder="如 CMA CGM ZHENG HE / 0FMMMW1MA" /></Form.Item>
              <Form.Item name="etd" label="ETD"><Input type="date" /></Form.Item>
              <Form.Item name="eta" label="ETA"><Input type="date" /></Form.Item>
              <Form.Item name="shippingInstructions" label="运费说明"><Input placeholder="如 ALU 1264 pcs" /></Form.Item>
              <Form.Item name="remark" label="备注"><Input placeholder="备注" /></Form.Item>
            </div>
          </Form>
          {selectedOrder ? (
            <p style={{ marginBottom: 8 }}>
              客户：<b>{selectedOrder.customer?.name ?? '-'}</b>　订单 {selectedOrder.orderNo}　共{' '}
              {(selectedOrder.items ?? []).reduce((s, it) => s + it.qty, 0)} 台（
              {(selectedOrder.items ?? []).map((it) => it.product.name + '×' + it.qty).join('、')}）——可部分出货，同一成品可「拆行」
            </p>
          ) : null}
          <LinesEditor lines={lines} setLines={setLines} products={products} />
          <Button type="primary" onClick={() => shipForm.submit()} loading={shipping} style={{ marginTop: 12 }}>
            出货
          </Button>
        </Card>
      ) : (
        <p>当前账号为只读（{role === 'boss' ? '老板' : '非销售'}），仅可查看出货单、运输节点与导出单证。</p>
      )}

      <Card title="出货单与运输节点">
        <Table<Shipment>
          rowKey="id"
          loading={loading}
          dataSource={shipments}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            onChange: (p, s) => {
              if (s !== pageSize) {
                setPageSize(s)
                void load(1, s)
              } else {
                void load(p)
              }
            },
          }}
          columns={columns}
          expandable={{
            expandedRowRender: (r: Shipment) => {
              const legs = [...r.legs].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
              return (
                <div>
                  {r.lines && r.lines.length > 0 ? (
                    <div style={{ marginBottom: 12 }}>
                      <b>出货明细：</b>
                      {r.lines.map((l, idx) => (
                        <div key={idx}>
                          {l.product.name}（{l.product.sku}）× {l.qty}
                          {l.customerPoNo ? '　PO ' + l.customerPoNo : ''}
                          {l.lotNo ? '　Lot ' + l.lotNo : ''}
                          {l.cartons !== null && l.cartons !== undefined ? '　' + l.cartons + ' 箱' : ''}
                          {l.containerNo ? '　柜 ' + l.containerNo : ''}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {legs.length === 0 ? (
                    <span>暂无运输节点</span>
                  ) : (
                    <Steps
                      direction="vertical"
                      size="small"
                      items={legs.map((leg) => ({
                        title: leg.node,
                        description: dateTimeStr(leg.at) + (leg.note ? '　' + leg.note : ''),
                      }))}
                    />
                  )}
                </div>
              )
            },
          }}
        />
      </Card>

      <Modal
        title={'编辑单证：' + (editTarget?.salesOrder?.orderNo ?? '') + (editTarget?.invoiceNo ? '（' + editTarget.invoiceNo + '）' : '')}
        open={editTarget !== null}
        onCancel={() => setEditTarget(null)}
        onOk={() => editForm.submit()}
        confirmLoading={editSaving}
        width={1000}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={saveEdit}>
          <div style={META_GRID}>
            <Form.Item name="shippedAt" label="出货时间"><Input type="date" /></Form.Item>
            <Form.Item name="deliveryNote" label="送货单号"><Input /></Form.Item>
            <Form.Item name="signer" label="签收人"><Input /></Form.Item>
            <Form.Item name="invoiceNo" label="发票号"><Input /></Form.Item>
            <Form.Item name="paymentTerms" label="付款条件"><Input /></Form.Item>
            <Form.Item name="incoterm" label="贸易条款"><Select allowClear options={INCOTERM_OPTIONS} /></Form.Item>
            <Form.Item name="mark" label="唛头"><Input /></Form.Item>
            <Form.Item name="origin" label="原产地"><Input /></Form.Item>
            <Form.Item name="hsCode" label="海关编码"><Input /></Form.Item>
            <Form.Item name="taxRate" label="税率"><Input /></Form.Item>
            <Form.Item name="vesselVoyage" label="船名/航次"><Input /></Form.Item>
            <Form.Item name="etd" label="ETD"><Input type="date" /></Form.Item>
            <Form.Item name="eta" label="ETA"><Input type="date" /></Form.Item>
            <Form.Item name="shippingInstructions" label="运费说明"><Input /></Form.Item>
            <Form.Item name="remark" label="备注"><Input /></Form.Item>
          </div>
        </Form>
        <LinesEditor lines={editLines} setLines={setEditLines} products={products} />
      </Modal>

      <Modal
        title="添加运输节点"
        open={legShipment !== null}
        onCancel={() => setLegShipment(null)}
        onOk={() => legForm.submit()}
        confirmLoading={legSubmitting}
        destroyOnClose
      >
        <Form form={legForm} layout="vertical" onFinish={handleAddLeg}>
          <Form.Item name="node" label="节点" rules={[{ required: true, message: '请选择或输入节点' }]}>
            <Select placeholder="选择节点" options={NODE_OPTIONS} />
          </Form.Item>
          <Form.Item name="at" label="节点时间">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
