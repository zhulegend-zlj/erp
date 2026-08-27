import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd'
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, PrinterOutlined, StopOutlined } from '@ant-design/icons'
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
  customer?: { name: string }
  shippedByProduct?: Record<number, number>
  items?: Array<{
    productId: number
    qty: number
    customerDeliveryDate?: string | null
    zrhDeliveryDate?: string | null
    product: { id: number; sku: string; name: string }
  }>
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
  // 提醒「知道了」：按角色持久化已读数，未读>0 时显示横幅
  const [ackedCount, setAckedCount] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('erp-schedule-seen') ?? '{}') as Record<string, number>
      return role ? (raw[role] ?? 0) : 0
    } catch {
      return 0
    }
  })
  // 打印出货计划：勾选行 + 装运方式 + 出货时间
  const [printOpen, setPrintOpen] = useState(false)
  const [printSelected, setPrintSelected] = useState<number[]>([])
  const [printMode, setPrintMode] = useState('拼柜/不打板')
  const [printDate, setPrintDate] = useState(() => {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  })

  const reminderCount = role === 'warehouse' ? rows.filter((r) => r.status === 'pending').length : role === 'sales' ? rows.filter((r) => r.status === 'picked').length : 0
  const unacked = Math.max(0, reminderCount - ackedCount)

  function ackReminder() {
    if (!role) return
    try {
      const raw = JSON.parse(localStorage.getItem('erp-schedule-seen') ?? '{}') as Record<string, number>
      raw[role] = reminderCount
      localStorage.setItem('erp-schedule-seen', JSON.stringify(raw))
    } catch {
      /* ignore */
    }
    setAckedCount(reminderCount)
    window.dispatchEvent(new CustomEvent('schedule-ack'))
    message.success('已收到，红点已清除')
  }

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

  // 已排程数量（未取消）：按 订单+成品 汇总（rows 为全量排程）
  function scheduledQty(salesOrderId: number, productId: number): number {
    return rows
      .filter((r) => r.salesOrderId === salesOrderId && r.productId === productId && r.status !== 'cancelled')
      .reduce((sum, r) => sum + r.qty, 0)
  }

  function remainQty(productId: number | undefined): number {
    if (productId == null || !orderDetail) return 0
    const it = orderDetail.items?.find((x) => x.productId === productId)
    if (!it) return 0
    const shipped = orderDetail.shippedByProduct?.[productId] ?? 0
    return it.qty - scheduledQty(orderDetail.id, productId) - shipped
  }

  // 订单明细指导行：成品 / 订单数量 / 已排程 / 已出 / 可排剩余 / 要求日 / 承诺日
  const detailRows = (orderDetail?.items ?? []).map((it) => {
    const scheduled = scheduledQty(orderDetail!.id, it.productId)
    const shipped = orderDetail?.shippedByProduct?.[it.productId] ?? 0
    return {
      key: it.productId,
      product: it.product.name + '（' + it.product.sku + '）',
      orderQty: it.qty,
      scheduled,
      shipped,
      remain: it.qty - scheduled - shipped,
      needBy: it.customerDeliveryDate ? String(it.customerDeliveryDate).slice(0, 10) : '-',
      promised: it.zrhDeliveryDate ? String(it.zrhDeliveryDate).slice(0, 10) : '-',
    }
  })

  const detailColumns = [
    { title: '成品', dataIndex: 'product', key: 'product' },
    { title: '订单数量', dataIndex: 'orderQty', key: 'orderQty', width: 90 },
    { title: '已排程', dataIndex: 'scheduled', key: 'scheduled', width: 80 },
    { title: '已出货', dataIndex: 'shipped', key: 'shipped', width: 80 },
    {
      title: '剩余可排',
      dataIndex: 'remain',
      key: 'remain',
      width: 100,
      render: (v: number) => (v > 0 ? <Tag color="green">{v}</Tag> : <Tag color="red">已排满</Tag>),
    },
    { title: '客户要求日', dataIndex: 'needBy', key: 'needBy', width: 112 },
    { title: '承诺日(PD)', dataIndex: 'promised', key: 'promised', width: 112 },
  ]

  async function onOrderSelect(orderId: number) {
    try {
      const { data } = await api.get<OrderOption>('/orders/' + orderId)
      setOrderDetail(data)
      form.setFieldsValue({ productId: undefined, needByDate: undefined, promisedDate: undefined })
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
    const remain = remainQty(values.productId)
    if (remain <= 0) {
      message.warning('该成品已排满（订单数量已全部排程/出货），不能再排')
      return
    }
    if (values.qty > remain) {
      message.warning('排程数量不能超过剩余可排 ' + remain + ' 台')
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

  // 打印出货计划：参考 Endor 出货计划表（标题/序号/出货日期/目的地/订单号/品名/中文品名/数量/箱数/体积/重量，
  // 按承诺日分组并带小计；箱数/体积/重量留空手填）
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const PRINT_MODES = ['拼柜/不打板', '整柜/不打板', '空运/打板']

  // 打开打印弹窗：默认勾选未出货排程（已出货/已取消不打印），销售自行勾选 + 选装运方式
  function openPrint() {
    setPrintSelected(rows.filter((r) => r.status === 'pending' || r.status === 'picked').map((r) => r.id))
    setPrintOpen(true)
  }

  function printShipPlan(list: ScheduleRow[], mode: string, shipDate: string) {
    // 按目的地（到货仓）分组：同一目的地的排程放一起、小计合计 = 同一台车（参考 Endor 出货计划表）
    const byHub = new Map<string, ScheduleRow[]>()
    for (const r of list) {
      byHub.set(r.hub.name, [...(byHub.get(r.hub.name) ?? []), r])
    }
    const hubs = [...byHub.keys()].sort()
    const title = 'JMC Shipment Plan出货计划' + new Date().toISOString().slice(0, 10)
    let trs = ''
    for (const hubName of hubs) {
      const group = byHub.get(hubName) ?? []
      let seq = 0
      let sumQty = 0
      trs += '<tr class="hub"><td colspan="10">目的地：' + esc(hubName) + '</td></tr>'
      for (const r of group) {
        seq += 1
        sumQty += r.qty
        trs += '<tr><td>' + seq + '</td><td>' + shipDate + '</td><td>' + esc(r.hub.name) + '</td><td>' + esc(r.salesOrder.orderNo) + '</td><td>' + esc(r.product.sku) + '</td><td>' + esc(r.product.name) + '</td><td>' + r.qty + '</td><td></td><td></td><td></td></tr>'
      }
      trs += '<tr class="sub"><td></td><td></td><td></td><td></td><td></td><td>合计</td><td>' + sumQty + '</td><td></td><td></td><td></td></tr>'
    }
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:SimSun,Arial,sans-serif;margin:24px}h2{text-align:center}table{border-collapse:collapse;width:100%}td,th{border:1px solid #000;padding:4px 6px;font-size:12px}th{background:#f0f0f0}tr.sub td{font-weight:bold;background:#fafafa}tr.hub td{font-weight:bold;background:#eef3fb;border:none;padding-top:10px}@media print{h2{margin-top:0}}</style>' +
      '</head><body><h2>' + esc(title) + '</h2><p style="text-align:center;margin:2px 0 2px;font-size:14px">装运方式：' + esc(mode) + '</p><p style="text-align:center;margin:0 0 12px;font-size:14px">出货时间：' + esc(shipDate) + '</p><table><thead><tr><th>序号</th><th>出货日期</th><th>目的地</th><th>订单号</th><th>品名</th><th>中文品名</th><th>数量</th><th>箱数</th><th>体积</th><th>重量</th></tr></thead><tbody>' +
      trs +
      '</tbody></table><script>window.onload=function(){window.print()}<\/script></body></html>'
    const w = window.open('', '_blank')
    if (!w) {
      message.warning('浏览器拦截了打印窗口，请允许弹窗后重试')
      return
    }
    // 打印窗口默认最大化
    try {
      w.moveTo(0, 0)
      w.resizeTo(screen.availWidth, screen.availHeight)
    } catch {
      /* 浏览器可能限制 resizeTo，忽略 */
    }
    w.document.write(html)
    w.document.close()
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
    <Card
      title="出货排程（客户 OPO 表录入 → 仓库备货 → 出货）"
      extra={canCreate ? <Button icon={<PrinterOutlined />} onClick={openPrint}>打印出货计划</Button> : null}
    >
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
                label: it.product.name + '（' + it.product.sku + '，订单 ' + it.qty + '，剩余可排 ' + remainQty(it.productId) + '）',
              }))}
              onChange={(v) => {
                // 交期已在订单明细行级：选完成品自动带出该行的客户要求日与承诺日（可改）
                const it = (orderDetail?.items ?? []).find((x) => x.productId === v)
                form.setFieldsValue({
                  needByDate: it?.customerDeliveryDate ? String(it.customerDeliveryDate).slice(0, 10) : undefined,
                  promisedDate: it?.zrhDeliveryDate ? String(it.zrhDeliveryDate).slice(0, 10) : undefined,
                })
              }}
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
      {unacked > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            role === 'warehouse'
              ? '有 ' + unacked + ' 条排程待你备货'
              : '仓库已备好 ' + unacked + ' 条排程，请安排出货'
          }
          action={
            <Button size="small" onClick={ackReminder}>
              知道了
            </Button>
          }
        />
      ) : null}
      {orderDetail ? (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          style={{ marginBottom: 16 }}
          title={() => <span style={{ fontWeight: 600 }}>订单 {orderDetail.orderNo} 明细（录入排程参考：剩余可排 = 订单数量 - 已排程 - 已出货）</span>}
          dataSource={detailRows}
          columns={detailColumns}
        />
      ) : null}
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
      <Modal
        title="打印出货计划（勾选要打印的排程）"
        open={printOpen}
        onCancel={() => setPrintOpen(false)}
        onOk={() => {
          const list = rows.filter((r) => printSelected.includes(r.id))
          if (list.length === 0) {
            message.warning('请勾选至少一条排程')
            return
          }
          printShipPlan(list, printMode, printDate)
          setPrintOpen(false)
        }}
        okText="打印"
        width={760}
      >
        <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <span>
            出货时间：
            <Input type="date" value={printDate} onChange={(e) => setPrintDate(e.target.value)} style={{ width: 160, marginLeft: 8 }} />
          </span>
          <span>
            装运方式：
            <Select
              style={{ width: 170, marginLeft: 8 }}
              value={printMode}
              onChange={(v) => setPrintMode(v)}
              options={PRINT_MODES.map((m) => ({ value: m, label: m }))}
            />
          </span>
          <span style={{ color: '#888', fontSize: 12 }}>同一目的地的排程会排在一起并合计（同一台车）；已出货/已取消不参与打印</span>
        </div>
        <Table<ScheduleRow>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows.filter((r) => r.status === 'pending' || r.status === 'picked')}
          rowSelection={{ selectedRowKeys: printSelected, onChange: (keys) => setPrintSelected(keys as number[]) }}
          columns={[
            { title: '承诺日(PD)', dataIndex: 'promisedDate', key: 'pd', render: dateStr },
            { title: '订单号', key: 'o', render: (_: unknown, r: ScheduleRow) => r.salesOrder.orderNo },
            { title: '成品', key: 'p', render: (_: unknown, r: ScheduleRow) => r.product.sku + ' ' + r.product.name },
            { title: '数量', dataIndex: 'qty', key: 'qty', width: 70 },
            { title: '到货仓', key: 'h', render: (_: unknown, r: ScheduleRow) => r.hub.name },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'st',
              render: (v: string) => {
                const t = STATUS_TAG[v] ?? { color: 'default', label: v }
                return <Tag color={t.color}>{t.label}</Tag>
              },
            },
          ]}
        />
      </Modal>
    </Card>
  )
}
