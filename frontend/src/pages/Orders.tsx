import { useEffect, useRef, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from 'antd'
import { PlusOutlined, MinusCircleOutlined, DeleteOutlined, EditOutlined, UploadOutlined, SplitCellsOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, notifyError, orderPhaseLabel, phaseTagColor, statusLabel } from './common'
import type { Paged } from './common'

interface Customer {
  id: number
  name: string
  defaultPaymentTerms?: string | null
}

interface Product {
  id: number
  sku: string
  name: string
  unit: string
}

interface OrderItem {
  id: number
  productId: number
  qty: number
  unitPrice: string
  lineNo?: string | null
  customerDeliveryDate?: string | null
  zrhDeliveryDate?: string | null
  product: { id: number; sku: string; name: string }
}

interface SalesOrder {
  id: number
  orderNo: string
  customerId: number
  customerPoNo: string | null
  splittable?: boolean
  parentOrder?: { id: number; orderNo: string } | null
  childOrders?: Array<{ id: number; orderNo: string }>
  orderDate: string
  earliestZrhDate?: string | null
  paymentTerms: string | null
  status: string
  purchasing?: boolean
  producing?: boolean
  shippedQty?: number
  totalQty?: number
  shippedByProduct?: Record<string, number>
  confirmReminderAt?: string | null
  confirmReminderBy?: string | null
  customer: { name: string }
  items: OrderItem[]
}

interface OrderItemField {
  productId?: number
  qty?: number | null
  unitPrice?: number | null
  lineNo?: string | null
  customerDeliveryDate?: string
  zrhDeliveryDate?: string
}

interface OrderFormValues {
  customerId?: number
  customerPoNo?: string
  orderDate?: string
  paymentTerms?: string
  items?: OrderItemField[]
}

function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

// 订单明细行编辑（新建/编辑共用）：成品/数量/单价/客户交期/ZRH交期 一行排齐
function OrderItemsFields({ products }: { products: Product[] }) {
  return (
    <Form.List name="items" initialValue={[{}]}>
      {(fields, { add, remove }) => (
        <>
          {fields.map((field) => (
            <Space key={field.key} align="center" size={6} wrap style={{ display: 'flex', marginBottom: 8 }}>
              <Form.Item
                name={[field.name, 'productId']}
                rules={[{ required: true, message: '选择成品' }]}
                style={{ width: 165, marginBottom: 0 }}
              >
                <Select
                  placeholder="选择成品"
                  showSearch
                  optionFilterProp="label"
                  options={products.map((p) => ({
                    value: p.id,
                    label: p.name + '（' + p.sku + '）',
                  }))}
                />
              </Form.Item>
              <Form.Item
                name={[field.name, 'qty']}
                rules={[{ required: true, message: '数量' }]}
                style={{ width: 80, marginBottom: 0 }}
              >
                <InputNumber min={1} precision={0} step={1} placeholder="数量" style={{ width: 80 }} />
              </Form.Item>
              <Form.Item
                name={[field.name, 'unitPrice']}
                rules={[{ required: true, message: '单价' }]}
                style={{ width: 90, marginBottom: 0 }}
              >
                <InputNumber min={0} placeholder="单价" style={{ width: 90 }} />
              </Form.Item>
              <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>Line#</span>
              <Form.Item name={[field.name, 'lineNo']} style={{ marginBottom: 0 }}>
                <Input placeholder="如 2.1" maxLength={20} style={{ width: 70 }} />
              </Form.Item>
              <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>客户交期</span>
              <Form.Item
                name={[field.name, 'customerDeliveryDate']}
                rules={[{ required: true, message: '客户交期' }]}
                style={{ marginBottom: 0 }}
              >
                <Input type="date" style={{ width: 135 }} />
              </Form.Item>
              <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>ZRH交期</span>
              <Form.Item
                name={[field.name, 'zrhDeliveryDate']}
                rules={[{ required: true, message: 'ZRH交期' }]}
                style={{ marginBottom: 0 }}
              >
                <Input type="date" style={{ width: 135 }} />
              </Form.Item>
              <Button
                type="text"
                danger
                icon={<MinusCircleOutlined />}
                onClick={() => remove(field.name)}
              />
            </Space>
          ))}
          <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
            添加明细
          </Button>
        </>
      )}
    </Form.List>
  )
}

// 拆销售单弹窗：按套数拆成多个子订单，所有明细行按同一比例分摊、余数归最后一份（老板反馈 2026-08-31）
function SplitOrderModal(props: {
  order: SalesOrder | null
  onCancel: () => void
  onSuccess: () => void
}) {
  const { order, onCancel, onSuccess } = props
  const [splits, setSplits] = useState<number[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!order) return
    const base = Math.max(...order.items.map((it) => it.qty))
    if (base <= 1) {
      setSplits([1])
      return
    }
    const first = Math.ceil(base / 2)
    setSplits([first, base - first])
  }, [order])

  if (!order) return null
  const base = Math.max(...order.items.map((it) => it.qty))
  const sum = splits.reduce((s, q) => s + (Number(q) || 0), 0)
  const remain = base - sum
  const invalid =
    splits.length === 0 || splits.some((q) => !Number.isInteger(q) || q < 1) || sum > base

  // 预览：与后端同一算法（每份 round 分摊，舍入差补到最后一份，剩余留在原单）
  const previewRows = order.items.map((line) => {
    const qs = splits.map((q) => Math.round((line.qty * q) / base))
    if (qs.length > 0) {
      const roundedSum = qs.reduce((s, q) => s + q, 0)
      const exact = Math.round((line.qty * sum) / base)
      qs[qs.length - 1] = Math.max(0, qs[qs.length - 1]! + exact - roundedSum)
    }
    const remainLine = line.qty - qs.reduce((s, q) => s + q, 0)
    return { line, qs, remainLine }
  })

  async function submit() {
    if (!order || invalid) return
    setSaving(true)
    try {
      const { data } = await api.post<{ children: Array<{ id: number; orderNo: string; qty: number }> }>(
        '/orders/' + order.id + '/split',
        { splits },
      )
      message.success('已拆出 ' + data.children.length + ' 张子单：' + data.children.map((c) => c.orderNo).join('、'))
      onSuccess()
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={'拆单：' + order.orderNo}
      open={order !== null}
      onCancel={onCancel}
      onOk={() => void submit()}
      confirmLoading={saving}
      okText="确认拆分"
      okButtonProps={{ disabled: invalid }}
      width={900}
    >
      <div style={{ marginBottom: 8 }}>
        基准套数 <b>{base}</b>（数量最大的成品行）｜明细 {order.items.length} 行｜子单号 ={' '}
        <b>{order.orderNo}-1、{order.orderNo}-2…</b>｜子单状态复制原单（当前「{statusLabel(order.status)}」）
      </div>
      <Space wrap style={{ marginBottom: 8 }}>
        {splits.map((q, i) => (
          <span key={i}>
            第 {i + 1} 份：
            <InputNumber
              min={1}
              max={base}
              precision={0}
              value={q}
              onChange={(v) => {
                const next = [...splits]
                next[i] = Number(v ?? 0)
                setSplits(next)
              }}
              style={{ width: 110 }}
            />
            <Button
              type="text"
              danger
              icon={<MinusCircleOutlined />}
              onClick={() => setSplits(splits.filter((_, si) => si !== i))}
            />
          </span>
        ))}
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          disabled={splits.length >= 20}
          onClick={() => setSplits([...splits, 1])}
        >
          加一份
        </Button>
      </Space>
      <div style={{ marginBottom: 8 }}>
        拆出合计 <b>{sum}</b> 套｜留在原单 <b style={{ color: remain < 0 ? 'red' : undefined }}>{remain}</b> 套
        {remain === 0 ? '（原单将变为「已拆分」）' : ''}
      </div>
      <Table<{ line: OrderItem; qs: number[]; remainLine: number }>
        rowKey={(r) => String(r.line.productId)}
        size="small"
        pagination={false}
        dataSource={previewRows}
        columns={[
          { title: '成品', key: 'p', render: (_: unknown, r) => r.line.product.name + '（' + r.line.product.sku + '）' },
          { title: '原数量', key: 'q', width: 80, render: (_: unknown, r) => r.line.qty },
          ...splits.map((_, si) => ({
            title: '第 ' + (si + 1) + ' 份',
            key: 's' + si,
            width: 80,
            render: (_: unknown, r: { qs: number[] }) => r.qs[si],
          })),
          { title: '留在原单', key: 'rem', width: 90, render: (_: unknown, r: { remainLine: number }) => r.remainLine },
        ]}
      />
    </Modal>
  )
}

export default function Orders() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [advancingId, setAdvancingId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [form] = Form.useForm<OrderFormValues>()
  const [editForm] = Form.useForm<OrderFormValues>()
  const [pageSize, setPageSize] = useState(10)
  const [deleteTarget, setDeleteTarget] = useState<SalesOrder | null>(null)
  const [deleteText, setDeleteText] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingTarget, setEditingTarget] = useState<SalesOrder | null>(null)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [parsingImage, setParsingImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [detailTarget, setDetailTarget] = useState<SalesOrder | null>(null)
  const [splitTarget, setSplitTarget] = useState<SalesOrder | null>(null)

  const canCreate = user?.role === 'sales'
  const canAdvance = user?.role === 'sales' || user?.role === 'boss'
  // 拆单权限：老板/销售/采购（老板口径 2026-08-31）
  const canSplit = user?.role === 'boss' || user?.role === 'sales' || user?.role === 'purchase'

  async function load(targetPage: number = page, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const { data } = await api.get<Paged<SalesOrder>>('/orders', {
        params: { page: targetPage, pageSize: ps },
      })
      setOrders(data.items)
      setTotal(data.total)
      setPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  async function loadOptions() {
    try {
      const [c, p] = await Promise.all([
        api.get<Customer[]>('/customers'),
        api.get<Product[]>('/products'),
      ])
      setCustomers(c.data)
      setProducts(p.data)
    } catch (err) {
      notifyError(err)
    }
  }

  useEffect(() => {
    void load()
    void loadOptions()
  }, [])

  async function handleCreate(values: OrderFormValues) {
    setSubmitting(true)
    try {
      await api.post('/orders', {
        customerId: values.customerId,
        customerPoNo: values.customerPoNo,
        orderDate: values.orderDate || todayStr(),
        paymentTerms: values.paymentTerms || null,
        items: (values.items ?? []).map((it) => ({
          productId: Number(it.productId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: Number(it.unitPrice ?? 0),
          ...(it.lineNo ? { lineNo: it.lineNo.trim() } : {}),
          customerDeliveryDate: it.customerDeliveryDate,
          zrhDeliveryDate: it.zrhDeliveryDate,
        })),
      })
      message.success('订单创建成功')
      setModalOpen(false)
      form.resetFields()
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  // 一键导入图片：客户截图 → 后端多模态读图 → 自动填明细行（成品/数量/单价/交期）
  async function handleImageImport(file: File) {
    setParsingImage(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const { data } = await api.post('/orders/parse-image', fd)
      const parsed = data as {
        po: string | null
        lines: Array<{
          sku: string
          qty: number
          unitPrice: number
          needByDate: string | null
          matched: { productId: number; name: string } | null
        }>
      }
      const matched = parsed.lines.filter((l) => l.matched !== null)
      const unmatched = parsed.lines.filter((l) => l.matched === null)
      form.setFieldsValue({
        items: parsed.lines.map((l) => ({
          productId: l.matched?.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          customerDeliveryDate: l.needByDate ?? undefined,
          zrhDeliveryDate: l.needByDate ?? undefined,
        })),
      })
      if (parsed.po && !form.getFieldValue('customerPoNo')) {
        form.setFieldsValue({ customerPoNo: parsed.po })
      }
      if (matched.length > 0) {
        message.success('图片导入成功：识别 ' + parsed.lines.length + ' 行，' + matched.length + ' 行已自动匹配成品')
      }
      if (unmatched.length > 0) {
        message.warning('以下料号未匹配到系统成品，请逐行手动选择成品：' + unmatched.map((l) => l.sku).join('、'))
      }
    } catch (err) {
      notifyError(err)
    } finally {
      setParsingImage(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  function openEdit(r: SalesOrder) {
    editForm.setFieldsValue({
      customerId: r.customerId,
      customerPoNo: r.customerPoNo ?? undefined,
      orderDate: r.orderDate ? String(r.orderDate).slice(0, 10) : todayStr(),
      paymentTerms: r.paymentTerms ?? undefined,
      items: (r.items ?? []).map((it) => ({
        productId: it.productId,
        qty: it.qty,
        unitPrice: Number(it.unitPrice),
        lineNo: it.lineNo ?? undefined,
        customerDeliveryDate: it.customerDeliveryDate ? String(it.customerDeliveryDate).slice(0, 10) : undefined,
        zrhDeliveryDate: it.zrhDeliveryDate ? String(it.zrhDeliveryDate).slice(0, 10) : undefined,
      })),
    })
    setEditingTarget(r)
  }

  async function handleUpdate(values: OrderFormValues) {
    if (!editingTarget) return
    setEditSubmitting(true)
    try {
      await api.patch('/orders/' + editingTarget.id, {
        customerId: values.customerId,
        customerPoNo: values.customerPoNo,
        orderDate: values.orderDate || undefined,
        paymentTerms: values.paymentTerms || null,
        items: (values.items ?? []).map((it) => ({
          productId: Number(it.productId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: Number(it.unitPrice ?? 0),
          ...(it.lineNo ? { lineNo: it.lineNo.trim() } : {}),
          customerDeliveryDate: it.customerDeliveryDate,
          zrhDeliveryDate: it.zrhDeliveryDate,
        })),
      })
      message.success('订单已更新')
      setEditingTarget(null)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setEditSubmitting(false)
    }
  }

  async function handleStatusChange(id: number, status: string, action: 'advance' | 'rollback') {
    setAdvancingId(id)
    try {
      await api.patch('/orders/' + id + '/status', { status })
      message.success(action === 'advance' ? '订单已推进至「' + statusLabel(status) + '」' : '订单已回退至「' + statusLabel(status) + '」')
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setAdvancingId(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleteText !== deleteTarget.orderNo) return
    setDeletingId(deleteTarget.id)
    try {
      await api.delete('/orders/' + deleteTarget.id)
      message.success('订单已删除')
      setDeleteTarget(null)
      setDeleteText('')
      if (orders.length === 1 && page > 1) {
        await load(page - 1)
      } else {
        await load()
      }
    } catch (err) {
      notifyError(err)
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    {
      title: '订单号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      render: (_: unknown, r: SalesOrder) => (
        <Space size={4}>
          <span>{r.orderNo}</span>
          {r.parentOrder ? <Tag color="geekblue">拆自 {r.parentOrder.orderNo}</Tag> : null}
          {r.childOrders && r.childOrders.length > 0 ? <Tag color="purple">已拆 {r.childOrders.length} 单</Tag> : null}
        </Space>
      ),
    },
    { title: '客户PO', dataIndex: 'customerPoNo', key: 'customerPoNo', render: (v: string | null) => v || '-' },
    {
      title: '客户',
      key: 'customer',
      render: (_: unknown, r: SalesOrder) => r.customer?.name ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (_: unknown, r: SalesOrder) => (
        <span>
          <Tag color={phaseTagColor(r)}>{orderPhaseLabel(r)}</Tag>
          {r.status === 'draft' && r.confirmReminderAt ? (
            <Tooltip title={r.confirmReminderBy ? r.confirmReminderBy + ' 催你确认' : '采购催你确认'}>
              <Tag color="orange">采购催确认</Tag>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      title: '已出',
      key: 'shipped',
      width: 90,
      render: (_: unknown, r: SalesOrder) => {
        const shipped = r.shippedQty ?? 0
        const totalQty = r.totalQty ?? 0
        if (totalQty > 0 && shipped > 0 && shipped < totalQty) {
          return <Tag color="blue">{shipped + '/' + totalQty}</Tag>
        }
        return shipped > 0 && shipped >= totalQty ? <Tag color="green">出满</Tag> : '-'
      },
    },
    { title: 'ZRH交期（最早）', dataIndex: 'earliestZrhDate', key: 'earliestZrhDate', render: dateStr },
    {
      title: '明细',
      key: 'items',
      width: 260,
      render: (_: unknown, r: SalesOrder) => {
        const names = r.items.map((it) => it.product.name + ' × ' + it.qty)
        const overflow = names.length > 2
        return (
          <div style={{ maxHeight: 46, overflow: 'hidden', lineHeight: '22px' }}>
            <span>{names.slice(0, 2).join('；') + (overflow ? '…' : '')}</span>
            {overflow ? (
              <a style={{ marginLeft: 6 }} onClick={() => setDetailTarget(r)}>
                共{names.length}项 显示更多
              </a>
            ) : null}
          </div>
        )
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, r: SalesOrder) => {
        if (!canAdvance && !canSplit) return null
        const nextMap: Record<string, string> = { draft: 'confirmed', shipped: 'completed' }
        const prevMap: Record<string, string> = { confirmed: 'draft' }
        const bossPrev: Record<string, string> = { in_production: 'confirmed', ready: 'confirmed' }
        const isBoss = user?.role === 'boss'
        // 推进/回退仅销售/老板；拆单权限独立（老板/销售/采购）
        const next = canAdvance ? nextMap[r.status] ?? null : null
        const prev = canAdvance ? (isBoss ? (bossPrev[r.status] ?? prevMap[r.status] ?? null) : (prevMap[r.status] ?? null)) : null
        return (
          <Space>
            {next ? (
              <Popconfirm
                title={'确认推进到「' + statusLabel(next) + '」？'}
                okText="确认推进"
                cancelText="取消"
                onConfirm={() => void handleStatusChange(r.id, next, 'advance')}
              >
                <Button size="small" type="primary" ghost loading={advancingId === r.id}>
                  推进至「{statusLabel(next)}」
                </Button>
              </Popconfirm>
            ) : null}
            {prev ? (
              <Popconfirm
                title={
                  isBoss && r.status !== 'confirmed'
                    ? '确认强制回退到已确认？采购中/生产中将熄灭（紧急兜底）'
                    : '确认回退到「' + statusLabel(prev) + '」？'
                }
                okText="确认回退"
                cancelText="取消"
                onConfirm={() => void handleStatusChange(r.id, prev, 'rollback')}
              >
                <Button size="small" loading={advancingId === r.id}>
                  {isBoss && r.status !== 'confirmed' ? '强制回退至已确认' : '回退至「' + statusLabel(prev) + '」'}
                </Button>
              </Popconfirm>
            ) : null}
            {canSplit ? (
              <Tooltip
                title={
                  r.splittable === false
                    ? '该订单已有采购/生产/出货等业务记录，不能拆分'
                    : '按套数拆成多个子订单（原单扣减，子单独立采购）'
                }
              >
                <Button
                  size="small"
                  icon={<SplitCellsOutlined />}
                  disabled={r.splittable === false}
                  onClick={() => setSplitTarget(r)}
                >
                  拆单
                </Button>
              </Tooltip>
            ) : null}
            {canAdvance && (r.status === 'draft' || r.status === 'confirmed') ? (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                编辑
              </Button>
            ) : null}
            {canAdvance ? (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deletingId === r.id}
                onClick={() => {
                  setDeleteTarget(r)
                  setDeleteText('')
                }}
              >
                删除
              </Button>
            ) : null}
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title="订单管理"
      extra={
        canCreate ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields()
              form.setFieldsValue({ orderDate: todayStr() })
              setModalOpen(true)
            }}
          >
            新建订单
          </Button>
        ) : null
      }
    >
      <Table<SalesOrder>
        rowKey="id"
        columns={columns}
        dataSource={orders}
        loading={loading}
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
      />
      <Modal
        title="新建订单"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 12px' }}>
            <Form.Item name="customerId" label="客户" rules={[{ required: true, message: '请选择客户' }]}>
              <Select
                placeholder="选择客户"
                showSearch
                optionFilterProp="label"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
                onChange={(v) => {
                  const c = customers.find((x) => x.id === v)
                  if (c?.defaultPaymentTerms) form.setFieldsValue({ paymentTerms: c.defaultPaymentTerms })
                }}
              />
            </Form.Item>
            <Form.Item name="customerPoNo" label="客户PO号（即订单号）" rules={[{ required: true, message: '请输入客户PO号' }]}>
              <Input placeholder="如 265440（订单号直接使用客户PO号，不再自动生成）" />
            </Form.Item>
            <Form.Item name="orderDate" label="订单日期" rules={[{ required: true, message: '请选择订单日期' }]}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="paymentTerms" label="付款条件">
              <Input placeholder="如 NET 60（自动带客户默认）" />
            </Form.Item>
          </div>
          <div style={{ marginBottom: 8 }}>
            <Button icon={<UploadOutlined />} loading={parsingImage} onClick={() => imageInputRef.current?.click()}>
              一键导入图片（客户截图自动填明细）
            </Button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImageImport(f)
              }}
            />
          </div>
          <OrderItemsFields products={products} />
        </Form>
      </Modal>
      <Modal
        title={'编辑订单：' + (editingTarget?.orderNo ?? '')}
        open={editingTarget !== null}
        onCancel={() => setEditingTarget(null)}
        onOk={() => editForm.submit()}
        confirmLoading={editSubmitting}
        width={960}
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 12px' }}>
            <Form.Item name="customerId" label="客户" rules={[{ required: true, message: '请选择客户' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
                onChange={(v) => {
                  const c = customers.find((x) => x.id === v)
                  if (c?.defaultPaymentTerms) editForm.setFieldsValue({ paymentTerms: c.defaultPaymentTerms })
                }}
              />
            </Form.Item>
            <Form.Item name="customerPoNo" label="客户PO号（即订单号）" rules={[{ required: true, message: '请输入客户PO号' }]}>
              <Input placeholder="修改PO号会同步修改订单号（撞已有PO号会被拦截）" />
            </Form.Item>
            <Form.Item name="orderDate" label="订单日期" rules={[{ required: true, message: '请选择订单日期' }]}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="paymentTerms" label="付款条件">
              <Input placeholder="如 NET 60（自动带客户默认）" />
            </Form.Item>
          </div>
          <OrderItemsFields products={products} />
        </Form>
      </Modal>
      <Modal
        title={'订单明细：' + (detailTarget?.orderNo ?? '')}
        open={detailTarget !== null}
        onCancel={() => setDetailTarget(null)}
        footer={null}
        width={860}
      >
        <Table<OrderItem>
          rowKey="productId"
          size="small"
          pagination={false}
          dataSource={detailTarget?.items ?? []}
          columns={[
            {
              title: 'Line#',
              key: 'lineNo',
              width: 70,
              render: (_: unknown, it: OrderItem) => (it.lineNo != null ? it.lineNo : '-'),
            },
            { title: '成品', key: 'p', render: (_: unknown, it: OrderItem) => it.product.name + '（' + it.product.sku + '）' },
            { title: '数量', dataIndex: 'qty', key: 'qty', width: 80 },
            {
              title: '单价',
              dataIndex: 'unitPrice',
              key: 'unitPrice',
              width: 100,
              render: (v: string | undefined) => (v === undefined || v === null ? '-' : v),
            },
            {
              title: '客户交期',
              key: 'cd',
              render: (_: unknown, it: OrderItem) => (it.customerDeliveryDate ? String(it.customerDeliveryDate).slice(0, 10) : '-'),
            },
            {
              title: 'ZRH交期',
              key: 'zd',
              render: (_: unknown, it: OrderItem) => (it.zrhDeliveryDate ? String(it.zrhDeliveryDate).slice(0, 10) : '-'),
            },
            {
              title: '已出',
              key: 'shipped',
              width: 80,
              render: (_: unknown, it: OrderItem) => {
                const shipped = detailTarget?.shippedByProduct?.[String(it.productId)] ?? 0
                const total = it.qty
                if (shipped >= total && total > 0) return <Tag color="green">出满</Tag>
                if (shipped > 0) return <Tag color="blue">{shipped + '/' + total}</Tag>
                return '0'
              },
            },
          ]}
        />
      </Modal>
      <SplitOrderModal
        order={splitTarget}
        onCancel={() => setSplitTarget(null)}
        onSuccess={() => {
          setSplitTarget(null)
          void load()
        }}
      />
      <Modal
        title="删除订单"
        open={deleteTarget !== null}
        onCancel={() => {
          setDeleteTarget(null)
          setDeleteText('')
        }}
        onOk={() => void handleDelete()}
        confirmLoading={deletingId !== null}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: deleteText !== deleteTarget?.orderNo }}
      >
        <p>
          即将删除订单 <b>{deleteTarget?.orderNo}</b>（客户：{deleteTarget?.customer?.name ?? '-'}）。
          删除后不可恢复；已有采购/仓库/出货/财务记录的单据将被系统拒绝删除。
        </p>
        <p>请输入完整订单号以确认：</p>
        <Input
          value={deleteText}
          onChange={(e) => setDeleteText(e.target.value)}
          placeholder={deleteTarget?.orderNo ?? ''}
        />
      </Modal>
    </Card>
  )
}
