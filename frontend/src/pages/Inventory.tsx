import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Image,
  Input,
  AutoComplete,
  Col,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, dateTimeStr, notifyError, orderPhaseLabel } from './common'
import type { Paged } from './common'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
  purchasing?: boolean
  producing?: boolean
}

interface Part {
  id: number
  sku: string
  name: string
  unit: string
  supplierId?: number | null
}

interface Product {
  id: number
  sku: string
  name: string
  unit: string
}

interface StockRow {
  itemType: string
  itemId: number
  name: string
  sku: string
  imageUrl: string
  qtyOnHand: number
  defectiveQty?: number
  returnedQty?: number
  replenishedQty?: number
  pendingReplenishQty?: number
}

interface PurchaseOrderOption {
  id: number
  orderNo: string
  supplierName: string
  status: string
}

interface SupplierOption {
  id: number
  name: string
}

interface PoLedgerRow {
  partId: number
  sku: string
  name: string
  requiredQty: number
  receivedQty: number
  defectiveQty: number
  outstanding: number
  balance: number
}

interface ReceiptRow {
  partId?: number
  sku?: string
  name?: string
  supplierName?: string
  outstanding?: number
  qty?: number | null
  lotNo?: string
  supplierId?: number | null
}

interface ReceiptRecord {
  id: number
  purchaseOrderId: number | null
  purchaseOrderNo: string
  partId: number
  sku: string
  partName: string
  supplierId: number | null
  supplierName: string
  qty: number
  lotNo: string | null
  qcStatus: string | null
  defectiveQty: number
  receivedAt: string
}

interface IssueRecord {
  id: number
  partId: number
  sku: string
  name: string
  qty: number
  issuedBy: string
  orderNo: string
  issuedAt: string
}

interface ProductionEntryRecord {
  id: number
  productId: number
  sku: string
  name: string
  qty: number
  orderNo: string
  entryDate: string
}

function ReceiptForm({ parts, suppliers, onDone }: { parts: Part[]; suppliers: SupplierOption[]; onDone?: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderOption[]>([])
  const [poLedger, setPoLedger] = useState<{ purchaseOrderNo: string; supplierName: string; items: PoLedgerRow[] } | null>(null)
  const [poLoading, setPoLoading] = useState(false)
  const [form] = Form.useForm<{ purchaseOrderId?: number | 'self'; items?: ReceiptRow[] }>()

  useEffect(() => {
    api
      .get<PurchaseOrderOption[]>('/purchase-orders')
      .then(({ data }) => setPurchaseOrders(data))
      .catch(notifyError)
  }, [])

  const watchedPo = Form.useWatch('purchaseOrderId', form)
  const watchedItems = Form.useWatch('items', form) as ReceiptRow[] | undefined
  const isSelfBuy = watchedPo === 'self'

  async function onPoChange(v: number | 'self' | undefined) {
    form.setFieldsValue({ items: undefined })
    setPoLedger(null)
    if (typeof v === 'number') {
      const po = purchaseOrders.find((p) => p.id === v)
      if (!po) return
      setPoLoading(true)
      try {
        const { data } = await api.get<{ purchaseOrderNo: string; supplierName: string; items: PoLedgerRow[] }>(
          '/inventory/po-ledger',
          { params: { purchaseOrderNo: po.orderNo } },
        )
        setPoLedger(data)
        // 自动带出零件行：零件/供应商只读，数量默认填未收数量（可改，填 0 跳过提交）
        form.setFieldsValue({
          items: data.items.map((it) => ({
            partId: it.partId,
            sku: it.sku,
            name: it.name,
            supplierName: data.supplierName,
            outstanding: it.outstanding,
            qty: it.outstanding > 0 ? it.outstanding : undefined,
            lotNo: undefined,
          })),
        })
      } catch (err) {
        notifyError(err)
      } finally {
        setPoLoading(false)
      }
    } else if (v === 'self') {
      // 自购买：手工选零件，供应商选填
      form.setFieldsValue({ items: [{ qty: undefined, lotNo: undefined, supplierId: undefined }] })
    }
  }

  async function submit(values: { purchaseOrderId?: number | 'self'; items?: ReceiptRow[] }) {
    const rows = values.items ?? []
    const valid = rows.filter((r) => r.partId && r.qty && r.qty > 0)
    if (valid.length === 0) {
      message.warning('请至少填写一行数量大于 0 的收货明细（本批没到货的零件数量填 0 即可跳过）')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/receipts', {
        ...(isSelfBuy ? {} : { purchaseOrderId: values.purchaseOrderId }),
        items: valid.map((r) => ({
          partId: Number(r.partId),
          qty: Number(r.qty),
          lotNo: r.lotNo || null,
          ...(isSelfBuy ? { supplierId: r.supplierId ?? null } : {}),
        })),
      })
      message.success('收货入库成功')
      form.resetFields()
      setPoLedger(null)
      onDone?.()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="purchaseOrderId"
          label="采购单"
          rules={[{ required: true, message: '请选择采购单' }]}
        >
          <Select
            showSearch
            placeholder="选择采购单（或自购买）"
            style={{ width: 400 }}
            optionFilterProp="label"
            onChange={onPoChange}
            options={[
              ...purchaseOrders.map((po) => ({
                value: po.id,
                label: po.orderNo + '（' + po.supplierName + '）',
              })),
              { value: 'self', label: '自购买（无采购单）' },
            ]}
          />
        </Form.Item>

        {typeof watchedPo === 'number' && poLedger ? (
          <Card
            size="small"
            title={'采购单明细：' + poLedger.purchaseOrderNo + '（' + poLedger.supplierName + '）'}
            loading={poLoading}
            style={{ marginBottom: 16 }}
          >
            <Table<PoLedgerRow>
              rowKey="partId"
              size="small"
              pagination={false}
              dataSource={poLedger.items}
              columns={[
                { title: '零件', key: 'part', render: (_: unknown, r: PoLedgerRow) => r.sku + '　' + r.name },
                { title: '供应商', key: 'supplier', render: () => poLedger.supplierName },
                { title: '订购数量', dataIndex: 'requiredQty', key: 'requiredQty' },
                { title: '已收数量', dataIndex: 'receivedQty', key: 'receivedQty' },
                {
                  title: '未收数量',
                  dataIndex: 'outstanding',
                  key: 'outstanding',
                  render: (v: number) =>
                    v > 0 ? <Tag color="orange">{v}</Tag> : <Tag color="green">已收齐</Tag>,
                },
              ]}
            />
          </Card>
        ) : null}

        {isSelfBuy ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="自购买：手工选择零件与数量，供应商选填（便于追溯）"
          />
        ) : typeof watchedPo === 'number' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="零件与供应商已按采购单自动带出，仓库只需填写本批实收数量；没到货的零件数量填 0 即可跳过。"
          />
        ) : null}

        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field, index) => {
                const it = watchedItems?.[index]
                if (isSelfBuy) {
                  return (
                    <div key={field.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8 }}>
                      <Form.Item
                        name={[field.name, 'partId']}
                        rules={[{ required: true, message: '选择零件' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          style={{ width: 260 }}
                          placeholder="选择零件"
                          options={parts.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'supplierId']} style={{ marginBottom: 0 }}>
                        <Select
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          placeholder="供应商（选填）"
                          style={{ width: 180 }}
                          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'qty']}
                        rules={[{ required: true, message: '数量' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber min={1} precision={0} step={1} placeholder="数量" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'lotNo']} style={{ marginBottom: 0 }}>
                        <Input placeholder="来料单号（可选）" style={{ width: 160 }} />
                      </Form.Item>
                      <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                    </div>
                  )
                }
                return (
                  <div key={field.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8 }}>
                    <Form.Item name={[field.name, 'partId']} hidden>
                      <Input />
                    </Form.Item>
                    <div style={{ width: 240, lineHeight: '32px' }}>{it?.sku}　{it?.name}</div>
                    <div style={{ width: 160, lineHeight: '32px', color: '#8c8c8c' }}>{it?.supplierName ?? '-'}</div>
                    <div style={{ width: 100, lineHeight: '32px', color: '#8c8c8c' }}>未收 {it?.outstanding ?? 0}</div>
                    <Form.Item
                      name={[field.name, 'qty']}
                      rules={[{ required: true, message: '数量' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={0} precision={0} step={1} placeholder="本批实收" style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'lotNo']} style={{ marginBottom: 0 }}>
                      <Input placeholder="来料单号（可选）" style={{ width: 160 }} />
                    </Form.Item>
                    <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                  </div>
                )
              })}
              {isSelfBuy ? (
                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                  添加零件
                </Button>
              ) : null}
            </>
          )}
        </Form.List>
        <Button type="primary" htmlType="submit" loading={submitting} style={{ marginTop: 16 }}>
          提交收货
        </Button>
      </Form>
    </div>
  )
}


// 收货记录 QC 补录：收货入库后补充 QC 状态/不良品数量/来料单号（不良品仅作记录，不改库存）
function QcPanel({ refreshToken, onDone }: { refreshToken: number; onDone?: () => void }) {
  const { user } = useAuth()
  const [rows, setRows] = useState<ReceiptRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [editing, setEditing] = useState<ReceiptRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<{ qcStatus?: string; defectiveQty?: number; lotNo?: string }>()
  const [pageSize, setPageSize] = useState(10)
  const canVoid = user?.role === 'warehouse' || user?.role === 'boss'

  async function load(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<ReceiptRecord>>('/receipts', {
        params: { page: targetPage, pageSize: ps },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  function openEdit(r: ReceiptRecord) {
    setEditing(r)
    form.setFieldsValue({
      qcStatus: r.qcStatus ?? 'ok',
      defectiveQty: r.defectiveQty ?? 0,
      lotNo: r.lotNo ?? undefined,
    })
  }

  async function save() {
    if (!editing) return
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    setSaving(true)
    try {
      await api.patch('/receipts/' + editing.id, {
        qcStatus: values.qcStatus ?? null,
        defectiveQty: values.defectiveQty ?? 0,
        lotNo: values.lotNo ?? null,
      })
      message.success('QC 信息已更新')
      setEditing(null)
      await load(page)
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  async function onVoid(r: ReceiptRecord) {
    try {
      await api.delete('/receipts/' + r.id)
      message.success('已撤销')
      await load(page)
      onDone?.()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <Card title="收货记录（QC 补录）" style={{ marginTop: 16 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="收货入库后，可在这里补充 QC 状态与不良品数量（不良品仅作记录，不扣库存）。"
      />
      <Table<ReceiptRecord>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
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
        columns={[
          { title: '时间', dataIndex: 'receivedAt', key: 'receivedAt', render: dateTimeStr, width: 150 },
          {
            title: '采购单',
            dataIndex: 'purchaseOrderNo',
            key: 'purchaseOrderNo',
            render: (v: string) => v || <Tag color="purple">自购买</Tag>,
          },
          {
            title: '零件',
            key: 'part',
            render: (_: unknown, r: ReceiptRecord) => r.sku + '　' + r.partName,
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', render: (v: string) => v || '-' },
          { title: '数量', dataIndex: 'qty', key: 'qty' },
          { title: '来料单号', dataIndex: 'lotNo', key: 'lotNo', render: (v: string | null) => v ?? '-' },
          {
            title: 'QC',
            dataIndex: 'qcStatus',
            key: 'qcStatus',
            render: (v: string | null) => {
              if (!v) return <Tag>待检</Tag>
              const map: Record<string, { label: string; color: string }> = {
                ok: { label: 'OK', color: 'green' },
                pending: { label: '待检', color: 'default' },
                reject: { label: '不良', color: 'red' },
              }
              const item = map[v] ?? { label: v, color: 'default' }
              return <Tag color={item.color}>{item.label}</Tag>
            },
          },
          { title: '不良品', dataIndex: 'defectiveQty', key: 'defectiveQty' },
          {
            title: '操作',
            key: 'action',
            width: 180,
            render: (_: unknown, r: ReceiptRecord) => (
              <Space size={4}>
                <Button size="small" onClick={() => openEdit(r)}>
                  QC 补录
                </Button>
                {canVoid ? (
                  <Popconfirm
                    title="撤销这条收货？"
                    description="库存将扣回对应数量"
                    onConfirm={() => void onVoid(r)}
                    okText="撤销"
                    okButtonProps={{ danger: true }}
                  >
                    <Button size="small" danger>
                      撤销
                    </Button>
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="QC 补录"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void save()}
        confirmLoading={saving}
        destroyOnClose
      >
        {editing ? (
          <div>
            <div style={{ marginBottom: 8 }}>
              {editing.sku}　{editing.partName}（收货 {editing.qty}）
            </div>
            <Form form={form} layout="vertical">
              <Form.Item name="qcStatus" label="QC 状态">
                <Select
                  allowClear
                  placeholder="选择 QC 状态"
                  options={[
                    { value: 'ok', label: 'OK（合格）' },
                    { value: 'pending', label: '待检' },
                    { value: 'reject', label: '不良' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="defectiveQty"
                label={'不良品数量（不能大于收货数量 ' + editing.qty + '）'}
              >
                <InputNumber min={0} max={editing.qty} precision={0} step={1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="lotNo" label="来料单号">
                <Input placeholder="可选" />
              </Form.Item>
            </Form>
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}

interface IssueContext {
  orderNo: string
  status: string
  purchaseOrders: { id: number; orderNo: string; supplierName: string; items: { partId: number; sku: string; name: string; onHand: number }[] }[]
  bomParts: { partId: number; sku: string; name: string; onHand: number }[]
}

interface IssueRow {
  partId?: number
  sku?: string
  name?: string
  onHand?: number
  qty?: number | null
}

function IssueForm({ orders, parts, onDone }: { orders: SalesOrder[]; parts: Part[]; onDone?: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [context, setContext] = useState<IssueContext | null>(null)
  const [boundPos, setBoundPos] = useState<{ orderNo: string; supplierName: string; items: { partId: number; sku: string; name: string; onHand: number }[] }[]>([])
  const [form] = Form.useForm<{
    salesOrderId?: number
    poOrderNo?: string[]
    issuedBy?: string
    note?: string
    items?: IssueRow[]
  }>()
  const watchedItems = Form.useWatch('items', form) as IssueRow[] | undefined

  async function onOrderChange(v?: number) {
    form.setFieldsValue({ items: undefined, poOrderNo: undefined })
    setContext(null)
    setBoundPos([])
    if (!v) return
    try {
      const { data } = await api.get<IssueContext>('/inventory/issue-context', { params: { orderId: v } })
      setContext(data)
      if (data.purchaseOrders.length === 0) form.setFieldsValue({ items: [{}] })
    } catch (err) {
      notifyError(err)
    }
  }

  async function onPoChange(orderNos?: string[]) {
    form.setFieldsValue({ items: undefined })
    setBoundPos([])
    if (!orderNos || orderNos.length === 0 || !context) return
    const pos: typeof context.purchaseOrders = []
    for (const no of orderNos) {
      const po = context.purchaseOrders.find((p) => p.orderNo === no)
      if (po) pos.push(po)
    }
    if (pos.length === 0) return
    setBoundPos(pos)
    // 合并选中采购单的零件行（按 partId 去重，保留 sku/name/onHand），仓库只需填数量（可删行）
    const merged = new Map<number, { partId: number; sku: string; name: string; onHand: number }>()
    for (const po of pos) {
      for (const it of po.items) {
        if (!merged.has(it.partId)) merged.set(it.partId, it)
      }
    }
    form.setFieldsValue({
      items: [...merged.values()].map((it) => ({ partId: it.partId, sku: it.sku, name: it.name, onHand: it.onHand, qty: undefined })),
    })
  }

  async function submit(values: {
    salesOrderId?: number
    issuedBy?: string
    note?: string
    items?: IssueRow[]
  }) {
    const rows = (values.items ?? []).filter((r) => r.partId && r.qty && r.qty > 0)
    if (rows.length === 0) {
      message.warning('请至少填写一行数量大于 0 的领料明细')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/issues', {
        salesOrderId: values.salesOrderId,
        issuedBy: values.issuedBy,
        note: values.note,
        items: rows.map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
        })),
      })
      message.success('领料出库成功')
      localStorage.setItem('erp-issue-by', values.issuedBy ?? '')
      form.resetFields()
      form.setFieldsValue({ issuedBy: values.issuedBy ?? '' })
      setContext(null)
      setBoundPos([])
      onDone?.()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const bomPartOptions = (context ? context.bomParts : parts.map((p) => ({ partId: p.id, sku: p.sku, name: p.name, onHand: 0 }))).map(
    (p) => ({ value: p.partId, label: p.sku + '　' + p.name, onHand: p.onHand ?? 0 }),
  )

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{ issuedBy: localStorage.getItem('erp-issue-by') ?? undefined }}
    >
      <Space style={{ display: 'flex' }} align="start" wrap>
        <Form.Item
          name="salesOrderId"
          label="销售订单"
          rules={[{ required: true, message: '选择订单' }]}
          style={{ width: 280, marginBottom: 16 }}
        >
          <Select
            placeholder="选择订单"
            onChange={onOrderChange}
            options={orders.map((o) => ({ value: o.id, label: o.orderNo + '（' + orderPhaseLabel(o) + '）' }))}
          />
        </Form.Item>
        <Form.Item name="poOrderNo" label="采购订单（自动带出零件）" style={{ width: 280, marginBottom: 16 }}>
          <Select
            mode="multiple"
            maxTagCount="responsive"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="选择采购订单"
            disabled={!context || context.purchaseOrders.length === 0}
            onChange={onPoChange}
            options={(context?.purchaseOrders ?? []).map((po) => ({
              value: po.orderNo,
              label: po.orderNo + '（' + (po.supplierName || '—') + '）',
            }))}
          />
        </Form.Item>
        <Form.Item
          name="issuedBy"
          label="领料人"
          rules={[{ required: true, message: '请输入领料人' }]}
          style={{ marginBottom: 16 }}
        >
          <Input placeholder="生产组长姓名" />
        </Form.Item>
        <Form.Item name="note" label="备注" style={{ marginBottom: 16 }}>
          <Input placeholder="可选" />
        </Form.Item>
      </Space>
      {context && context.purchaseOrders.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="该订单还没有采购单，可直接按 BOM 零件选择领料。"
        />
      ) : boundPos.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            '已绑定 ' + boundPos.length + ' 张采购单（' + boundPos.map((p) => p.orderNo).join('、') + '）：零件已合并带出，只需填写数量，不需要的零件可删除。'
          }
        />
      ) : null}
      <Form.List name="items">
        {(fields, { add, remove }) => (
          <>
            {fields.map((field, index) => {
              const it = watchedItems?.[index]
              const poPartIds = new Set(boundPos.flatMap((p) => p.items.map((i) => i.partId)))
              const fromPo = !!it?.partId && poPartIds.has(it.partId)
              const partOption = it?.partId ? bomPartOptions.find((o) => o.value === it.partId) : undefined
              return (
                <div key={field.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8 }}>
                  {fromPo ? (
                    <>
                      <Form.Item name={[field.name, 'partId']} hidden>
                        <Input />
                      </Form.Item>
                      <div style={{ width: 300, lineHeight: '32px' }}>
                        {it?.sku}　{it?.name}　<span style={{ color: '#999' }}>库存 {it?.onHand ?? 0}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <Form.Item
                        name={[field.name, 'partId']}
                        rules={[{ required: true, message: '选择零件' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          style={{ width: 260 }}
                          placeholder="选择零件"
                          options={bomPartOptions}
                        />
                      </Form.Item>
                      {partOption ? (
                        <div style={{ lineHeight: '32px', color: '#999' }}>库存 {partOption.onHand ?? 0}</div>
                      ) : null}
                    </>
                  )}
                  <Form.Item
                    name={[field.name, 'qty']}
                    rules={[{ required: true, message: '数量' }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={1} precision={0} step={1} placeholder="数量" />
                  </Form.Item>
                  <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                </div>
              )
            })}
            <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
              添加明细
            </Button>
          </>
        )}
      </Form.List>
      <Button type="primary" htmlType="submit" loading={submitting} style={{ marginTop: 16 }}>
        提交领料
      </Button>
    </Form>
  )
}

function ProductionForm({ orders, products, onDone }: { orders: SalesOrder[]; products: Product[]; onDone?: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [orderProgress, setOrderProgress] = useState<{
    producedQty: number
    totalQty: number
    items?: { productId: number; qty: number }[]
    producedByProduct?: Record<number, number>
  } | null>(null)
  const [selectedProductId, setSelectedProductId] = useState<number | undefined>()
  const [form] = Form.useForm<{
    salesOrderId?: number
    productId?: number
    qty?: number
    entryDate?: string
  }>()

  const productTotal = orderProgress?.items?.find((i) => i.productId === selectedProductId)?.qty ?? 0
  const productDone = selectedProductId != null ? (orderProgress?.producedByProduct?.[selectedProductId] ?? 0) : 0
  const remainQty = productTotal - productDone

  async function submit(values: {
    salesOrderId?: number
    productId?: number
    qty?: number
    entryDate?: string
  }) {
    if (selectedProductId != null && remainQty <= 0) {
      message.warning('该成品已收满，不能再入库')
      return
    }
    if (selectedProductId != null && remainQty > 0 && values.qty != null && values.qty > remainQty) {
      message.warning('入库数量不能超过 ' + remainQty + ' 台（该成品订单数量 ' + productTotal + ' 台）')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/production-entries', {
        salesOrderId: values.salesOrderId,
        productId: values.productId,
        qty: values.qty,
        entryDate: values.entryDate,
      })
      message.success('成品入库成功')
      form.resetFields()
      setOrderProgress(null)
      onDone?.()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={submit}>
      <Space style={{ display: 'flex' }} align="start">
        <Form.Item
          name="salesOrderId"
          label="销售订单"
          rules={[{ required: true, message: '选择订单' }]}
          style={{ width: 280 }}
        >
          <Select
            placeholder="选择订单"
            options={orders.map((o) => ({ value: o.id, label: o.orderNo + '（' + orderPhaseLabel(o) + '）' }))}
            onChange={(v) => {
              setSelectedProductId(undefined)
              form.setFieldValue('productId', undefined)
              form.setFieldValue('qty', undefined)
              void api
                .get<{
                  producedQty?: number
                  totalQty?: number
                  items?: { productId: number; qty: number }[]
                  producedByProduct?: Record<number, number>
                }>('/orders/' + v)
                .then(({ data }) =>
                  setOrderProgress({
                    producedQty: data.producedQty ?? 0,
                    totalQty: data.totalQty ?? 0,
                    items: data.items,
                    producedByProduct: data.producedByProduct,
                  }),
                )
                .catch(notifyError)
            }}
          />
        </Form.Item>
        <Form.Item
          name="productId"
          label="成品"
          rules={[{ required: true, message: '选择成品' }]}
          style={{ width: 280 }}
        >
          <Select
            placeholder="选择成品"
            options={products.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
            onChange={(v) => {
              setSelectedProductId(v)
              form.setFieldValue('qty', undefined)
            }}
          />
        </Form.Item>
        <Form.Item name="qty" label="数量" rules={[{ required: true, message: '数量' }]}>
          <InputNumber
            min={1}
            max={selectedProductId != null && remainQty > 0 ? remainQty : 1}
            precision={0}
            step={1}
            placeholder="数量"
            disabled={selectedProductId != null && remainQty <= 0}
          />
        </Form.Item>
        <Form.Item name="entryDate" label="入库日期">
          <Input type="date" />
        </Form.Item>
      </Space>
      {orderProgress ? (
        <div style={{ marginBottom: 12 }}>
          <Tag color="blue">已完成 {orderProgress.producedQty}/{orderProgress.totalQty} 台</Tag>
          {orderProgress.totalQty > 0 && orderProgress.producedQty >= orderProgress.totalQty ? (
            <Tag color="green">已收满，待出货</Tag>
          ) : null}
        </div>
      ) : null}
      {selectedProductId != null && productTotal > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Tag color={remainQty > 0 ? 'blue' : 'red'}>
            该成品订单数量 {productTotal} 台，已入库 {productDone} 台，
            {remainQty > 0 ? '最多还能入 ' + remainQty + ' 台' : '已收满不能再入库'}
          </Tag>
        </div>
      ) : null}
      <Button type="primary" htmlType="submit" loading={submitting}>
        提交入库
      </Button>
    </Form>
  )
}

function RecentIssues({ refreshToken, onDone }: { refreshToken?: number; onDone?: () => void }) {
  const { user } = useAuth()
  const [rows, setRows] = useState<IssueRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const canVoid = user?.role === 'warehouse' || user?.role === 'boss'

  async function load(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<IssueRecord>>('/issues', {
        params: { page: targetPage, pageSize: ps },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  async function onVoid(r: IssueRecord) {
    try {
      await api.delete('/issues/' + r.id)
      message.success('已撤销')
      await load(page)
      onDone?.()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <Card title="最近领料记录" size="small" style={{ marginTop: 16 }}>
      <Table<IssueRecord>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
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
        columns={[
          { title: '时间', dataIndex: 'issuedAt', key: 'issuedAt', render: dateTimeStr, width: 150 },
          {
            title: '物料',
            key: 'part',
            render: (_: unknown, r: IssueRecord) => r.sku + '　' + r.name,
          },
          { title: '数量', dataIndex: 'qty', key: 'qty' },
          { title: '领料人', dataIndex: 'issuedBy', key: 'issuedBy' },
          { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
          {
            title: '操作',
            key: 'action',
            width: 80,
            render: (_: unknown, r: IssueRecord) =>
              canVoid ? (
                <Popconfirm
                  title="撤销这条领料？"
                  description="库存将加回对应数量"
                  onConfirm={() => void onVoid(r)}
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                >
                  <Button size="small" danger>
                    撤销
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </Card>
  )
}

function RecentProductions({ refreshToken, onDone }: { refreshToken?: number; onDone?: () => void }) {
  const { user } = useAuth()
  const [rows, setRows] = useState<ProductionEntryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const canVoid = user?.role === 'warehouse' || user?.role === 'boss'

  async function load(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<ProductionEntryRecord>>('/production-entries', {
        params: { page: targetPage, pageSize: ps },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  async function onVoid(r: ProductionEntryRecord) {
    try {
      await api.delete('/production-entries/' + r.id)
      message.success('已撤销')
      await load(page)
      onDone?.()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <Card title="最近入库记录" size="small" style={{ marginTop: 16 }}>
      <Table<ProductionEntryRecord>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
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
        columns={[
          { title: '时间', dataIndex: 'entryDate', key: 'entryDate', render: dateTimeStr, width: 150 },
          {
            title: '成品',
            key: 'product',
            render: (_: unknown, r: ProductionEntryRecord) => r.sku + '　' + r.name,
          },
          { title: '数量', dataIndex: 'qty', key: 'qty' },
          { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
          {
            title: '操作',
            key: 'action',
            width: 80,
            render: (_: unknown, r: ProductionEntryRecord) =>
              canVoid ? (
                <Popconfirm
                  title="撤销这条入库？"
                  description="库存将扣回对应数量"
                  onConfirm={() => void onVoid(r)}
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                >
                  <Button size="small" danger>
                    撤销
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </Card>
  )
}

function StockTab({ refreshToken }: { refreshToken?: number }) {
  const [rows, setRows] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [itemType, setItemType] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  async function load(targetPage = 1, type?: string, kw?: string, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<StockRow>>('/stock', {
        params: {
          itemType: type || undefined,
          keyword: kw || undefined,
          page: targetPage,
          pageSize: ps,
        },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1, itemType, keyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemType, refreshToken])

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="类型"
          allowClear
          style={{ width: 160 }}
          value={itemType}
          onChange={(v) => setItemType(v)}
          options={[
            { value: 'part', label: '零件' },
            { value: 'product', label: '成品' },
          ]}
        />
        <Input.Search
          placeholder="按名称/SKU搜索"
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={(v) => void load(1, itemType, v)}
          style={{ width: 240 }}
        />
      </Space>
      <Table<StockRow>
        rowKey={(r) => r.itemType + '-' + r.itemId}
        loading={loading}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (p, s) => {
            if (s !== pageSize) {
              setPageSize(s)
              void load(1, itemType, keyword, s)
            } else {
              void load(p, itemType, keyword)
            }
          },
        }}
        columns={[
          {
            title: '类型',
            dataIndex: 'itemType',
            key: 'itemType',
            width: 70,
            render: (v: string) => (v === 'part' ? '零件' : '成品'),
          },
          {
            title: '图片',
            dataIndex: 'imageUrl',
            key: 'imageUrl',
            width: 90,
            render: (v: string) =>
              v ? (
                <Image
                  src={v}
                  width={48}
                  height={48}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              ),
          },
          { title: 'SKU', dataIndex: 'sku', key: 'sku' },
          { title: '名称', dataIndex: 'name', key: 'name' },
          { title: 'ID', dataIndex: 'itemId', key: 'itemId', width: 80 },
          { title: '当前数量', dataIndex: 'qtyOnHand', key: 'qtyOnHand' },
          {
            title: '不良品',
            dataIndex: 'defectiveQty',
            key: 'defectiveQty',
            width: 90,
            render: (v: number | undefined) =>
              v && v > 0 ? <Tag color="red">{v}</Tag> : 0,
          },
          { title: '已退', dataIndex: 'returnedQty', key: 'returnedQty', width: 80 },
          { title: '已补', dataIndex: 'replenishedQty', key: 'replenishedQty', width: 80 },
          {
            title: '应补',
            dataIndex: 'pendingReplenishQty',
            key: 'pendingReplenishQty',
            width: 80,
            render: (v: number | undefined) =>
              v && v > 0 ? <Tag color="orange">{v}</Tag> : 0,
          },
        ]}
      />
    </div>
  )
}

interface LedgerSearchRow {
  id: number
  at: string
  itemType: string
  sku: string
  name: string
  imageUrl: string
  supplierName: string
  spec: string
  orderNo: string
  lotNo: string
  inQty: number
  outQty: number
  balance: number
}

function LedgerTab({ parts, orders }: { parts: Part[]; orders: SalesOrder[] }) {
  const [salesOrderNo, setSalesOrderNo] = useState<string | undefined>()
  const [purchaseOrderNo, setPurchaseOrderNo] = useState<string | undefined>()
  const [partId, setPartId] = useState<number | undefined>()
  const [pos, setPos] = useState<PoForRR[]>([])
  const [rows, setRows] = useState<LedgerSearchRow[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  useEffect(() => {
    api
      .get<PoForRR[]>('/purchase-orders')
      .then(({ data }) => setPos(data))
      .catch(notifyError)
  }, [])

  async function query(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<LedgerSearchRow>>('/inventory/ledger-search', {
        params: {
          salesOrderNo: salesOrderNo || undefined,
          purchaseOrderNo: purchaseOrderNo || undefined,
          partId: partId || undefined,
          page: targetPage,
          pageSize: ps,
        },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  // 全不选 = 查所有流水；选择条件变化自动重查
  useEffect(() => {
    void query(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesOrderNo, purchaseOrderNo, partId])

  const selectedOrderId = salesOrderNo ? orders.find((o) => o.orderNo === salesOrderNo)?.id : undefined
  const poOptions = (selectedOrderId ? pos.filter((p) => p.salesOrderId === selectedOrderId) : pos).map((p) => ({
    value: p.orderNo,
    label: p.orderNo,
  }))
  const boundPoItems = purchaseOrderNo ? pos.find((p) => p.orderNo === purchaseOrderNo)?.items : undefined
  const partOptions = (boundPoItems ?? []).length > 0
    ? boundPoItems!.map((i) => ({ value: i.partId, label: i.sku + '　' + i.name }))
    : parts.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          showSearch
          allowClear
          placeholder="① 销售订单（不选=全部）"
          style={{ width: 220 }}
          value={salesOrderNo}
          onChange={(v) => {
            setSalesOrderNo(v)
            setPurchaseOrderNo(undefined)
            setPartId(undefined)
          }}
          optionFilterProp="label"
          options={orders.map((o) => ({ value: o.orderNo, label: o.orderNo }))}
        />
        <Select
          showSearch
          allowClear
          placeholder="② 采购订单（不选=全部）"
          style={{ width: 220 }}
          value={purchaseOrderNo}
          onChange={(v) => {
            setPurchaseOrderNo(v)
            setPartId(undefined)
          }}
          optionFilterProp="label"
          options={poOptions}
        />
        <Select
          showSearch
          allowClear
          placeholder="③ 零件（不选=全部）"
          style={{ width: 260 }}
          value={partId}
          onChange={(v) => setPartId(v)}
          optionFilterProp="label"
          options={partOptions}
        />
      </Space>
      <Table<LedgerSearchRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (p, s) => {
            if (s !== pageSize) {
              setPageSize(s)
              void query(1, s)
            } else {
              void query(p)
            }
          },
        }}
        columns={[
          { title: '时间', dataIndex: 'at', key: 'at', render: dateTimeStr, width: 150 },
          {
            title: '图片',
            dataIndex: 'imageUrl',
            key: 'imageUrl',
            width: 80,
            render: (v: string) =>
              v ? (
                <Image
                  src={v}
                  width={48}
                  height={48}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              ),
          },
          {
            title: '物料',
            key: 'material',
            render: (_: unknown, r: LedgerSearchRow) => r.sku + '　' + r.name,
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', render: (v: string) => v || '-' },
          { title: '单据号', dataIndex: 'orderNo', key: 'orderNo', render: (v: string) => v || '-' },
          { title: '来料单号', dataIndex: 'lotNo', key: 'lotNo', render: (v: string) => v || '-' },
          {
            title: '入库',
            dataIndex: 'inQty',
            key: 'inQty',
            render: (v: number) => (v > 0 ? <span style={{ color: '#3f8600' }}>+{v}</span> : '-'),
          },
          {
            title: '出库',
            dataIndex: 'outQty',
            key: 'outQty',
            render: (v: number) => (v > 0 ? <span style={{ color: '#cf1322' }}>-{v}</span> : '-'),
          },
          { title: '结存', dataIndex: 'balance', key: 'balance' },
        ]}
      />
    </div>
  )
}

interface OrderMaterialRow {
  seq: number
  partId: number
  sku: string
  name: string
  imageUrl: string
  supplierName: string
  spec: string
  unit: string
  usage: number | null
  usageText?: string
  requiredQty: number
  issuedQty: number
  variance: number
}

interface OrderMaterialsResult {
  orderNo: string
  orderQty: number
  items: OrderMaterialRow[]
}

function OrderMaterialsTab({ orders }: { orders: SalesOrder[] }) {
  const [orderNo, setOrderNo] = useState<string | undefined>()
  const [result, setResult] = useState<OrderMaterialsResult | null>(null)
  const [loading, setLoading] = useState(false)

  async function calc() {
    if (!orderNo) {
      message.warning('请选择销售订单')
      return
    }
    setLoading(true)
    try {
      const { data } = await api.get<OrderMaterialsResult>('/inventory/order-materials', {
        params: { orderNo },
      })
      setResult(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          showSearch
          placeholder="选择销售订单"
          style={{ width: 320 }}
          value={orderNo}
          onChange={(v) => {
            setOrderNo(v)
            setResult(null)
          }}
          optionFilterProp="label"
          options={orders.map((o) => ({ value: o.orderNo, label: o.orderNo }))}
        />
        <Button type="primary" onClick={() => void calc()} disabled={!orderNo}>
          计算
        </Button>
      </Space>
      {result ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={'订单 ' + result.orderNo + '，订单数：' + result.orderQty}
        />
      ) : null}
      <Table<OrderMaterialRow>
        rowKey="partId"
        loading={loading}
        dataSource={result?.items ?? []}
        pagination={false}
        columns={[
          { title: '序号', dataIndex: 'seq', key: 'seq', width: 70 },
          {
            title: '料号+物料名称',
            key: 'material',
            render: (_: unknown, r: OrderMaterialRow) => r.sku + ' ' + r.name,
          },
          {
            title: '物料图片',
            dataIndex: 'imageUrl',
            key: 'imageUrl',
            render: (v: string) =>
              v ? (
                <Image
                  src={v}
                  width={64}
                  height={64}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              ),
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
          { title: '规格', dataIndex: 'spec', key: 'spec', render: (v: string) => v || '-' },
          { title: '用量', key: 'usage', render: (_: unknown, r: OrderMaterialRow) => r.usageText ?? r.usage ?? '-' },
          { title: '已出库 (PCS)', dataIndex: 'issuedQty', key: 'issuedQty' },
          {
            title: '差值',
            dataIndex: 'variance',
            key: 'variance',
            render: (v: number) => (
              <span style={{ color: v === 0 ? undefined : v > 0 ? '#cf1322' : '#3f8600' }}>{v}</span>
            ),
          },
        ]}
      />
    </div>
  )
}

interface ReturnReplenishRow {
  id: number
  partId: number
  supplierId: number
  returnDate: string | null
  returnQty: number
  replenishDate: string | null
  replenishQty: number
  purchaseOrderNo: string | null
  lotNo: string | null
  note: string | null
  part: { sku: string; name: string }
  supplier: { name: string }
}

interface PoForRR {
  id: number
  orderNo: string
  supplierId: number
  supplierName: string
  salesOrderId?: number | null
  items: { partId: number; sku: string; name: string }[]
}

function ReturnReplenishTab({ parts, onDone }: { parts: Part[]; onDone?: () => void }) {
  const { user } = useAuth()
  const [rows, setRows] = useState<ReturnReplenishRow[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [pos, setPos] = useState<PoForRR[]>([])
  const [stockMap, setStockMap] = useState<Map<number, number>>(new Map())
  const [defectiveMap, setDefectiveMap] = useState<Map<number, number>>(new Map())
  const [boundPo, setBoundPo] = useState<PoForRR | null>(null)
  const [poPartIds, setPoPartIds] = useState<Set<number> | null>(null)
  const [lotNoOptions, setLotNoOptions] = useState<{ value: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [form] = Form.useForm<{
    partId?: number
    supplierId?: number
    returnDate?: string
    returnQty?: number
    replenishDate?: string
    replenishQty?: number
    purchaseOrderNo?: string
    lotNo?: string
    note?: string
  }>()
  const watchedPartId = Form.useWatch('partId', form)
  const canVoid = user?.role === 'warehouse' || user?.role === 'boss'

  async function load(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      // 拉取全部零件库存，构建 itemId -> qtyOnHand 映射，用于退补货显示当前库存
      const fetchStockRows = async () => {
        const collected: StockRow[] = []
        let p = 1
        for (;;) {
          const res = await api.get<Paged<StockRow>>('/stock', {
            params: { itemType: 'part', page: p, pageSize: 200 },
          })
          collected.push(...res.data.items)
          if (collected.length >= res.data.total || res.data.items.length === 0) break
          p += 1
        }
        return collected
      }
      const [r, s, po, stockRows] = await Promise.all([
        api.get<Paged<ReturnReplenishRow>>('/return-replenishments', {
          params: { page: targetPage, pageSize: ps },
        }),
        api.get<SupplierOption[]>('/suppliers'),
        api.get<PoForRR[]>('/purchase-orders'),
        fetchStockRows(),
      ])
      setRows(r.data.items)
      setTotal(r.data.total)
      setPage(r.data.page)
      setSuppliers(s.data)
      setPos(po.data)
      setStockMap(new Map(stockRows.map((sr) => [sr.itemId, sr.qtyOnHand])))
      setDefectiveMap(new Map(stockRows.map((sr) => [sr.itemId, sr.defectiveQty ?? 0])))
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // 绑定采购单：物料限定为该单零件、供应商自动带出、来料单号可从上该单收货记录选择
  async function onPoSelect(orderNo?: string) {
    setBoundPo(null)
    setPoPartIds(null)
    setLotNoOptions([])
    if (!orderNo) return
    const po = pos.find((p) => p.orderNo === orderNo)
    if (!po) return
    setBoundPo(po)
    setPoPartIds(new Set(po.items.map((i) => i.partId)))
    form.setFieldValue('supplierId', po.supplierId)
    if (po.items.length === 1) form.setFieldValue('partId', po.items[0]!.partId)
    try {
      const { data } = await api.get<Paged<ReceiptRecord>>('/receipts', {
        params: { purchaseOrderId: po.id },
      })
      const lotNos = [...new Set(data.items.map((r) => r.lotNo).filter((v): v is string => !!v))]
      setLotNoOptions(lotNos.map((v) => ({ value: v })))
    } catch (err) {
      notifyError(err)
    }
  }

  async function submit(values: {
    partId?: number
    supplierId?: number
    returnDate?: string
    returnQty?: number
    replenishDate?: string
    replenishQty?: number
    purchaseOrderNo?: string
    lotNo?: string
    note?: string
  }) {
    if ((values.returnQty ?? 0) + (values.replenishQty ?? 0) <= 0) {
      message.warning('退货与补货数量至少填写一项')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/return-replenishments', {
        partId: values.partId,
        supplierId: values.supplierId,
        returnDate: values.returnDate,
        returnQty: values.returnQty ?? 0,
        replenishDate: values.replenishDate,
        replenishQty: values.replenishQty ?? 0,
        purchaseOrderNo: values.purchaseOrderNo,
        lotNo: values.lotNo,
        note: values.note,
      })
      const msgs: string[] = []
      if ((values.returnQty ?? 0) > 0) msgs.push('退货 ' + values.returnQty + ' 已扣库存')
      if ((values.replenishQty ?? 0) > 0) msgs.push('补货 ' + values.replenishQty + ' 已增加库存')
      message.success(msgs.length > 0 ? msgs.join('；') : '退补货已登记')
      form.resetFields()
      onDone?.()
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function onVoid(r: ReturnReplenishRow) {
    try {
      await api.delete('/return-replenishments/' + r.id)
      message.success('已撤销')
      onDone?.()
      await load(page)
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <div>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 1000, marginBottom: 24 }}>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="purchaseOrderNo" label="采购单（可选，绑定后自动带出物料/供应商）">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择采购单（可空）"
                onChange={onPoSelect}
                options={pos.map((po) => ({
                  value: po.orderNo,
                  label: po.orderNo + '（' + po.supplierName + '）',
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="partId" label="物料" rules={[{ required: true, message: '选择物料' }]}>
              <Select
                showSearch
                placeholder="选择物料"
                optionFilterProp="label"
                onChange={(v) => {
                  const part = parts.find((p) => p.id === v)
                  if (part?.supplierId) form.setFieldValue('supplierId', part.supplierId)
                }}
                options={(poPartIds ? parts.filter((p) => poPartIds.has(p.id)) : parts).map((p) => ({
                  value: p.id,
                  label: p.name + '（' + p.sku + '）',
                }))}
              />
            </Form.Item>
            {watchedPartId ? (
              <div style={{ marginTop: -12, marginBottom: 8, color: '#666' }}>
                当前库存 {stockMap.get(watchedPartId) ?? 0}
                <span style={{ marginLeft: 8 }}>不良品 {defectiveMap.get(watchedPartId) ?? 0}</span>
              </div>
            ) : null}
          </Col>
          <Col span={8}>
            <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: '选择供应商' }]}>
              <Select
                placeholder="选择供应商"
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="returnDate" label="退货日期">
              <Input type="date" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="returnQty" label="退货数量">
              <InputNumber min={0} precision={0} step={1} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="replenishDate" label="补货日期">
              <Input type="date" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="replenishQty" label="补货数量">
              <InputNumber min={0} precision={0} step={1} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="lotNo" label="来料单号">
              <AutoComplete
                placeholder="来料单号（可选，可下拉选择该采购单已收货的来料单号）"
                options={lotNoOptions}
                filterOption={(input, option) =>
                  ((option?.value ?? '') as string).toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="note" label="备注">
              <Input placeholder="备注" />
            </Form.Item>
          </Col>
        </Row>
        {boundPo ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              '已绑定采购单 ' +
              boundPo.orderNo +
              '：物料限定为该采购单的零件，供应商已自动带出，来料单号可从该单收货记录选择。'
            }
          />
        ) : null}
        <Button type="primary" htmlType="submit" loading={submitting}>
          登记退补货
        </Button>
      </Form>

      <Table<ReturnReplenishRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
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
        columns={[
          {
            title: '物料',
            key: 'part',
            render: (_: unknown, r: ReturnReplenishRow) => r.part.name + '（' + r.part.sku + '）',
          },
          {
            title: '供应商',
            key: 'supplier',
            render: (_: unknown, r: ReturnReplenishRow) => r.supplier.name,
          },
          { title: '退货日期', dataIndex: 'returnDate', key: 'returnDate', render: dateStr },
          { title: '退货数量', dataIndex: 'returnQty', key: 'returnQty' },
          { title: '补货日期', dataIndex: 'replenishDate', key: 'replenishDate', render: dateStr },
          { title: '补货数量', dataIndex: 'replenishQty', key: 'replenishQty' },
          { title: '采购单号', dataIndex: 'purchaseOrderNo', key: 'purchaseOrderNo' },
          { title: '来料单号', dataIndex: 'lotNo', key: 'lotNo' },
          { title: '备注', dataIndex: 'note', key: 'note' },
          {
            title: '操作',
            key: 'action',
            width: 80,
            render: (_: unknown, r: ReturnReplenishRow) =>
              canVoid ? (
                <Popconfirm
                  title="撤销这条退补货？"
                  description="退货数量将加回库存，补货数量将扣回库存"
                  onConfirm={() => void onVoid(r)}
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                >
                  <Button size="small" danger>
                    撤销
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </div>
  )
}

interface WarehouseLedgerRow {
  id: number
  at: string
  itemType: string
  sku: string
  name: string
  imageUrl: string
  supplierName: string
  spec: string
  orderNo: string
  lotNo: string
  inQty: number
  outQty: number
  balance: number
}

function WarehouseLedgerTab() {
  const [rows, setRows] = useState<WarehouseLedgerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [itemType, setItemType] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  async function load(targetPage = 1, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<WarehouseLedgerRow>>('/inventory/warehouse-ledger', {
        params: {
          itemType: itemType || undefined,
          keyword: keyword || undefined,
          orderNo: orderNo || undefined,
          page: targetPage,
          pageSize: ps,
        },
      })
      setRows(data.items)
      setTotal(data.total)
      setPage(data.page)
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

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="类型"
          style={{ width: 140 }}
          value={itemType}
          onChange={setItemType}
          options={[
            { value: 'part', label: '零件' },
            { value: 'product', label: '成品' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="物料名称/料号"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={() => void load()}
        />
        <Input.Search
          allowClear
          placeholder="订单号"
          style={{ width: 200 }}
          value={orderNo}
          onChange={(e) => setOrderNo(e.target.value)}
          onSearch={() => void load()}
        />
        <Button onClick={() => void load()}>查询台账</Button>
      </Space>
      <Table<WarehouseLedgerRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
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
        columns={[
          { title: '时间', dataIndex: 'at', key: 'at', render: dateTimeStr },
          {
            title: '图片',
            dataIndex: 'imageUrl',
            key: 'imageUrl',
            render: (v: string) =>
              v ? (
                <Image
                  src={v}
                  width={48}
                  height={48}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              ),
          },
          { title: '料号', dataIndex: 'sku', key: 'sku' },
          { title: '物料名称', dataIndex: 'name', key: 'name' },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
          { title: '规格', dataIndex: 'spec', key: 'spec', render: (v: string) => v || '-' },
          { title: '订单号', dataIndex: 'orderNo', key: 'orderNo', render: (v: string) => v || '-' },
          { title: '来料单号', dataIndex: 'lotNo', key: 'lotNo', render: (v: string) => v || '-' },
          { title: '入库', dataIndex: 'inQty', key: 'inQty' },
          { title: '出库', dataIndex: 'outQty', key: 'outQty' },
          { title: '结存', dataIndex: 'balance', key: 'balance' },
        ]}
      />
    </div>
  )
}

export default function Inventory() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    void Promise.all([
      api.get<SalesOrder[]>('/orders'),
      api.get<Part[]>('/parts'),
      api.get<Product[]>('/products'),
      api.get<SupplierOption[]>('/suppliers'),
    ])
      .then(([o, pt, pd, sp]) => {
        setOrders(o.data)
        setParts(pt.data)
        setProducts(pd.data)
        setSuppliers(sp.data)
      })
      .catch(notifyError)
  }, [])

  const canManage = user?.role === 'warehouse' || user?.role === 'boss'
  const isWarehouse = user?.role === 'warehouse'

  const items = [
    ...(canManage
      ? [
          {
            key: 'receipt',
            label: '收货入库',
            children: (
              <>
                {isWarehouse ? (
                  <ReceiptForm
                    parts={parts}
                    suppliers={suppliers}
                    onDone={() => setRefreshToken((t) => t + 1)}
                  />
                ) : (
                  <Alert type="info" showIcon message="当前为只读（老板），可在下方撤销误登记记录。" />
                )}
                <QcPanel refreshToken={refreshToken} onDone={() => setRefreshToken((t) => t + 1)} />
              </>
            ),
          },
          {
            key: 'issue',
            label: '领料出库',
            children: (
              <>
                {isWarehouse ? (
                  <IssueForm orders={orders} parts={parts} onDone={() => setRefreshToken((t) => t + 1)} />
                ) : (
                  <Alert type="info" showIcon message="当前为只读（老板），可在下方撤销误登记记录。" />
                )}
                <RecentIssues refreshToken={refreshToken} onDone={() => setRefreshToken((t) => t + 1)} />
              </>
            ),
          },
          {
            key: 'production',
            label: '成品入库',
            children: (
              <>
                {isWarehouse ? (
                  <ProductionForm
                    orders={orders}
                    products={products}
                    onDone={() => setRefreshToken((t) => t + 1)}
                  />
                ) : (
                  <Alert type="info" showIcon message="当前为只读（老板），可在下方撤销误登记记录。" />
                )}
                <RecentProductions refreshToken={refreshToken} onDone={() => setRefreshToken((t) => t + 1)} />
              </>
            ),
          },
        ]
      : [
          {
            key: 'readonly',
            label: '仓库操作',
            children: <Alert type="info" showIcon message="当前账号为只读（老板），仅可查看库存与流水。" />,
          },
        ]),
    { key: 'stock', label: '库存查询', children: <StockTab refreshToken={refreshToken} /> },
    {
      key: 'ledger',
      label: '流水',
      children: (
        <LedgerTab parts={parts} orders={orders} />
      ),
    },
    { key: 'warehouse-ledger', label: '收发台账', children: <WarehouseLedgerTab /> },
    { key: 'order-materials', label: '订单物料计算', children: <OrderMaterialsTab orders={orders} /> },
    {
      key: 'return-replenish',
      label: '退补货',
      children: <ReturnReplenishTab parts={parts} onDone={() => setRefreshToken((t) => t + 1)} />,
    },
  ]

  return (
    <Card title="库存管理">
      <Tabs defaultActiveKey={canManage ? 'receipt' : 'stock'} items={items} />
    </Card>
  )
}
