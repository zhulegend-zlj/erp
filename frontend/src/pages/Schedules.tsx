import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd'
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, notifyError } from './common'

interface Hub {
  id: number
  name: string
}

interface OrderOption {
  id: number
  orderNo: string
  customerPoNo: string | null
  status: string
  zrhDeliveryDate?: string | null
  customer?: { name: string }
  items?: Array<{ productId: number; qty: number; product: { id: number; sku: string; name: string } }>
}

interface ScheduleRow {
  id: number
  salesOrderId: number
  productId: number
  qty: number
  hubId: number
  needByDate: string
  promisedDate: string
  status: string
  note: string | null
  salesOrder: { id: number; orderNo: string; customerPoNo: string | null; status: string; customer: { name: string } }
  product: { id: number; sku: string; name: string }
  hub: { id: number; name: string }
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'orange', label: '待备货' },
  picked: { color: 'blue', label: '已备好' },
  shipped: { color: 'green', label: '已出货' },
  cancelled: { color: 'default', label: '已取消' },
}

export default function Schedules() {
  const { user } = useAuth()
  const role = user?.role
  const canCreate = role === 'sales' || role === 'boss'
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [hubs, setHubs] = useState<Hub[]>([])
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm<{ salesOrderId?: number; productId?: number; qty?: number; hubId?: number; needByDate?: string; promisedDate?: string; note?: string }>()
  const [orderDetail, setOrderDetail] = useState<OrderOption | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [editTarget, setEditTarget] = useState<ScheduleRow | null>(null)
  const [editForm] = Form.useForm<{ qty?: number; hubId?: number; needByDate?: string; promisedDate?: string; note?: string }>()
  const [editSaving, setEditSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [s, o, h] = await Promise.all([
        api.get<ScheduleRow[]>('/schedules'),
        api.get<OrderOption[]>('/orders'),
        api.get<Hub[]>('/hubs'),
      ])
      setRows(s.data)
      setOrders(o.data)
      setHubs(h.data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const orderOptions = orders
    .filter((o) => ['confirmed', 'in_production', 'ready'].includes(o.status))
    .map((o) => ({ value: o.id, label: o.orderNo + '（PO ' + (o.customerPoNo ?? '-') + '）' }))

  async function onOrderSelect(orderId: number) {
    try {
      const { data } = await api.get<OrderOption>('/orders/' + orderId)
      setOrderDetail(data)
      form.setFieldsValue({ productId: undefined, promisedDate: data.zrhDeliveryDate ? String(data.zrhDeliveryDate).slice(0, 10) : undefined })
    } catch (err) {
      notifyError(err)
    }
  }

  async function saveHubName(name: string): Promise<number | null> {
    try {
      const { data } = await api.post<Hub>('/hubs', { name })
      setHubs((prev) => (prev.some((h) => h.id === data.id) ? prev : [...prev, data]))
      return data.id
    } catch (err) {
      notifyError(err)
      return null
    }
  }

  async function handleCreate(values: { salesOrderId?: number; productId?: number; qty?: number; hubId?: number; needByDate?: string; promisedDate?: string; note?: string }) {
    if (!values.salesOrderId || !values.productId || !values.qty) {
      message.warning('请选择订单/成品并填写数量')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/schedules', {
        salesOrderId: values.salesOrderId,
        productId: values.productId,
        qty: values.qty,
        hubId: values.hubId,
        needByDate: values.needByDate,
        promisedDate: values.promisedDate,
        note: values.note || null,
      })
      message.success('排程已添加')
      form.resetFields()
      setOrderDetail(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function markPicked(row: ScheduleRow) {
    try {
      await api.patch('/schedules/' + row.id, { status: 'picked' })
      message.success('已标记备好')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  function openEdit(row: ScheduleRow) {
    setEditTarget(row)
    editForm.setFieldsValue({
      qty: row.qty,
      hubId: row.hubId,
      needByDate: row.needByDate ? String(row.needByDate).slice(0, 10) : '',
      promisedDate: row.promisedDate ? String(row.promisedDate).slice(0, 10) : '',
      note: row.note ?? '',
    })
  }

  async function saveEdit(values: { qty?: number; hubId?: number; needByDate?: string; promisedDate?: string; note?: string }) {
    if (!editTarget) return
    setEditSaving(true)
    try {
      await api.patch('/schedules/' + editTarget.id, values)
      message.success('已保存')
      setEditTarget(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setEditSaving(false)
    }
  }

  async function remove(row: ScheduleRow) {
    try {
      await api.delete('/schedules/' + row.id)
      message.success('排程已删除')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  async function cancelRow(row: ScheduleRow) {
    try {
      await api.patch('/schedules/' + row.id, { status: 'cancelled' })
      message.success('已取消')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  const columns = [
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string) => {
        const t = STATUS_TAG[v] ?? { color: 'default', label: v }
        return <Tag color={t.color}>{t.label}</Tag>
      },
    },
    { title: '订单号', key: 'orderNo', render: (_: unknown, r: ScheduleRow) => r.salesOrder.orderNo },
    { title: '客户PO', key: 'po', render: (_: unknown, r: ScheduleRow) => r.salesOrder.customerPoNo ?? '-' },
    { title: '成品', key: 'product', render: (_: unknown, r: ScheduleRow) => r.product.sku + ' ' + r.product.name },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 80 },
    { title: '到货仓', key: 'hub', render: (_: unknown, r: ScheduleRow) => r.hub.name },
    { title: '客户要求日', dataIndex: 'needByDate', key: 'needByDate', render: dateStr },
    { title: '承诺日(PD)', dataIndex: 'promisedDate', key: 'promisedDate', render: dateStr },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, r: ScheduleRow) => (
        <Space>
          {r.status === 'pending' && role === 'warehouse' ? (
            <Button size="small" type="primary" ghost icon={<CheckOutlined />} onClick={() => void markPicked(r)}>
              已备好
            </Button>
          ) : null}
          {canCreate && (r.status === 'pending' || r.status === 'picked') ? (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                编辑
              </Button>
              <Button size="small" icon={<StopOutlined />} onClick={() => void cancelRow(r)}>
                取消
              </Button>
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void remove(r)}>
                删除
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Card title="出货排程（客户 OPO 表录入 → 仓库备货 → 出货）">
      {canCreate ? (
        <Form form={form} layout="inline" onFinish={handleCreate} style={{ marginBottom: 16, rowGap: 8, flexWrap: 'wrap' }}>
          <Form.Item name="salesOrderId" rules={[{ required: true, message: '选择订单' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择订单（已确认）"
              style={{ width: 280 }}
              options={orderOptions}
              onChange={(v) => void onOrderSelect(v)}
            />
          </Form.Item>
          <Form.Item name="productId" rules={[{ required: true, message: '选择成品' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择成品"
              style={{ width: 220 }}
              options={(orderDetail?.items ?? []).map((it) => ({
                value: it.productId,
                label: it.product.name + '（' + it.product.sku + '，订单 ' + it.qty + '）',
              }))}
            />
          </Form.Item>
          <Form.Item name="qty" rules={[{ required: true, message: '数量' }]}>
            <InputNumber min={1} precision={0} placeholder="数量" />
          </Form.Item>
          <Form.Item name="hubId" rules={[{ required: true, message: '选择到货仓' }]}>
            <Select
              showSearch
              placeholder="到货仓（可输入新仓）"
              style={{ width: 180 }}
              optionFilterProp="label"
              options={hubs.map((h) => ({ value: h.id, label: h.name }))}
              onChange={(v: unknown) => {
                if (typeof v === 'string' && v !== '' && !hubs.some((h) => h.name === v)) {
                  Modal.confirm({
                    title: '保存新到货仓？',
                    content: '「' + v + '」不在字典中，保存后下次可直接选择。',
                    okText: '保存',
                    cancelText: '仅本次',
                    onOk: async () => {
                      const id = await saveHubName(v)
                      if (id !== null) form.setFieldsValue({ hubId: id })
                    },
                    onCancel: () => {
                      form.setFieldsValue({ hubId: undefined })
                    },
                  })
                }
              }}
            />
          </Form.Item>
          <Form.Item name="needByDate" label="客户要求日" rules={[{ required: true, message: '客户要求日' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="promisedDate" label="承诺日" rules={[{ required: true, message: '承诺日' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注（可选）" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={submitting}>
              添加排程
            </Button>
          </Form.Item>
        </Form>
      ) : (
        <p style={{ marginBottom: 12 }}>仓库角色：对「待备货」的排程点击「已备好」，销售即可在出货页安排装车。</p>
      )}
      <Table<ScheduleRow>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200] }}
      />
      <Modal
        title={'编辑排程：' + (editTarget ? editTarget.salesOrder.orderNo + ' / ' + editTarget.product.sku : '')}
        open={editTarget !== null}
        onCancel={() => setEditTarget(null)}
        onOk={() => editForm.submit()}
        confirmLoading={editSaving}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={saveEdit}>
          <Form.Item name="qty" label="数量" rules={[{ required: true, message: '数量' }]}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="hubId" label="到货仓">
            <Select options={hubs.map((h) => ({ value: h.id, label: h.name }))} />
          </Form.Item>
          <Form.Item name="needByDate" label="客户要求日">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="promisedDate" label="承诺日(PD)">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
