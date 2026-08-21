import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, nextStatus, notifyError, prevStatus, statusColor, statusLabel } from './common'
import type { Paged } from './common'

interface Customer {
  id: number
  name: string
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
  product: { id: number; sku: string; name: string }
}

interface SalesOrder {
  id: number
  orderNo: string
  customerId: number
  deliveryDate: string
  status: string
  customer: { name: string }
  items: OrderItem[]
}

interface OrderItemField {
  productId?: number
  qty?: number | null
  unitPrice?: number | null
}

interface OrderFormValues {
  customerId?: number
  deliveryDate?: string
  items?: OrderItemField[]
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
  const pageSize = 10

  const canCreate = user?.role === 'sales'
  const canAdvance = user?.role === 'sales' || user?.role === 'boss'

  async function load(targetPage: number = page) {
    setLoading(true)
    try {
      const { data } = await api.get<Paged<SalesOrder>>('/orders', {
        params: { page: targetPage, pageSize },
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
        deliveryDate: values.deliveryDate,
        items: (values.items ?? []).map((it) => ({
          productId: Number(it.productId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: Number(it.unitPrice ?? 0),
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

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    {
      title: '客户',
      key: 'customer',
      render: (_: unknown, r: SalesOrder) => r.customer?.name ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={statusColor(v)}>{statusLabel(v)}</Tag>,
    },
    { title: '交期', dataIndex: 'deliveryDate', key: 'deliveryDate', render: dateStr },
    {
      title: '明细',
      key: 'items',
      render: (_: unknown, r: SalesOrder) =>
        r.items.map((it) => it.product.name + ' × ' + it.qty).join('；'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, r: SalesOrder) => {
        const next = nextStatus(r.status)
        const prev = prevStatus(r.status)
        if (!canAdvance) return null
        return (
          <Space>
            {next ? (
              <Popconfirm
                title={'确认推进到「' + statusLabel(next) + '」？'}
                okText="确认推进"
                cancelText="取消"
                onConfirm={() => void handleStatusChange(r.id, next, 'advance')}
              >
                <Button
                  size="small"
                  type="primary"
                  ghost
                  loading={advancingId === r.id}
                >
                  推进至「{statusLabel(next)}」
                </Button>
              </Popconfirm>
            ) : null}
            {prev ? (
              <Popconfirm
                title={'确认回退到「' + statusLabel(prev) + '」？'}
                okText="确认回退"
                cancelText="取消"
                onConfirm={() => void handleStatusChange(r.id, prev, 'rollback')}
              >
                <Button size="small" loading={advancingId === r.id}>
                  回退至「{statusLabel(prev)}」
                </Button>
              </Popconfirm>
            ) : null}
            {!next && !prev ? <span>-</span> : null}
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
          showSizeChanger: false,
          onChange: (p) => void load(p),
        }}
      />
      <Modal
        title="新建订单"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item
              name="customerId"
              label="客户"
              rules={[{ required: true, message: '请选择客户' }]}
              style={{ width: 260 }}
            >
              <Select
                placeholder="选择客户"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
            <Form.Item
              name="deliveryDate"
              label="交货日期"
              rules={[{ required: true, message: '请选择交货日期' }]}
            >
              <Input type="date" />
            </Form.Item>
          </Space>
          <Form.List name="items" initialValue={[{}]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item
                      name={[field.name, 'productId']}
                      rules={[{ required: true, message: '选择成品' }]}
                      style={{ width: 260, marginBottom: 0 }}
                    >
                      <Select
                        placeholder="选择成品"
                        options={products.map((p) => ({
                          value: p.id,
                          label: p.name + '（' + p.sku + '）',
                        }))}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'qty']}
                      rules={[{ required: true, message: '数量' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={1} placeholder="数量" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'unitPrice']}
                      rules={[{ required: true, message: '单价' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={0} placeholder="单价" style={{ width: 120 }} />
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
        </Form>
      </Modal>
    </Card>
  )
}
