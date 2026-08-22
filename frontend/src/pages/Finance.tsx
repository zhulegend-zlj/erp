import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Table,
  Tabs,
  message,
} from 'antd'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, money, notifyError } from './common'

interface Supplier {
  id: number
  name: string
}

interface Customer {
  id: number
  name: string
}

interface SalesOrder {
  id: number
  orderNo: string
}

interface OrderSummary {
  orderNo: string
  cost: number
  totalReceived: number
  profit: number
  dueDate: string | null
  received: number
}

interface DueReceivable {
  customerName: string
  orderNo: string
  dueDate: string
  amount: number
}

interface DuePayable {
  supplierName: string
  orderNo: string
  dueDate: string
  amount: number
}

interface DueList {
  receivable: DueReceivable[]
  payable: DuePayable[]
}

function SupplierPaymentForm({ suppliers }: { suppliers: Supplier[] }) {
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{
    supplierId?: number
    purchaseOrderId?: number
    amount?: number
    paidAt?: string
  }>()

  async function submit(values: {
    supplierId?: number
    purchaseOrderId?: number
    amount?: number
    paidAt?: string
  }) {
    setSubmitting(true)
    try {
      await api.post('/supplier-payments', {
        supplierId: values.supplierId,
        purchaseOrderId: values.purchaseOrderId,
        amount: values.amount,
        paidAt: values.paidAt,
      })
      message.success('供应商付款已登记')
      form.resetFields()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 480 }}>
      <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: '选择供应商' }]}>
        <Select
          placeholder="选择供应商"
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
      </Form.Item>
      <Form.Item name="purchaseOrderId" label="采购单 ID（可选）">
        <InputNumber min={1} precision={0} step={1} placeholder="关联采购单" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="amount" label="付款金额" rules={[{ required: true, message: '金额' }]}>
        <InputNumber min={0.01} precision={2} placeholder="金额" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="paidAt" label="付款日期（可选）">
        <Input type="date" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={submitting}>
        登记付款
      </Button>
    </Form>
  )
}

function CustomerPaymentForm({ customers }: { customers: Customer[] }) {
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{
    customerId?: number
    salesOrderId?: number
    amount?: number
    receivedAt?: string
  }>()

  async function submit(values: {
    customerId?: number
    salesOrderId?: number
    amount?: number
    receivedAt?: string
  }) {
    setSubmitting(true)
    try {
      await api.post('/customer-payments', {
        customerId: values.customerId,
        salesOrderId: values.salesOrderId,
        amount: values.amount,
        receivedAt: values.receivedAt,
      })
      message.success('客户收款已登记')
      form.resetFields()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 480 }}>
      <Form.Item name="customerId" label="客户" rules={[{ required: true, message: '选择客户' }]}>
        <Select
          placeholder="选择客户"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Form.Item>
      <Form.Item name="salesOrderId" label="销售订单 ID（可选）">
        <InputNumber min={1} precision={0} step={1} placeholder="关联订单" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="amount" label="收款金额" rules={[{ required: true, message: '金额' }]}>
        <InputNumber min={0.01} precision={2} placeholder="金额" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="receivedAt" label="收款日期（可选）">
        <Input type="date" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={submitting}>
        登记收款
      </Button>
    </Form>
  )
}

function OrderSummaryTab({ orders }: { orders: SalesOrder[] }) {
  const [orderId, setOrderId] = useState<number | undefined>()
  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!orderId) {
      setSummary(null)
      return
    }
    setLoading(true)
    api
      .get<OrderSummary>('/finance/orders/' + orderId + '/summary')
      .then(({ data }) => setSummary(data))
      .catch(notifyError)
      .finally(() => setLoading(false))
  }, [orderId])

  return (
    <div>
      <Select
        placeholder="选择订单"
        style={{ width: 360, marginBottom: 16 }}
        value={orderId}
        onChange={(v) => setOrderId(v)}
        options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
      />
      {summary ? (
        <Descriptions
          bordered
          size="small"
          column={2}
          items={[
            { key: 'orderNo', label: '订单号', children: summary.orderNo },
            { key: 'cost', label: '成本', children: '¥' + money(summary.cost) },
            { key: 'received', label: '已收款', children: '¥' + money(summary.totalReceived) },
            {
              key: 'profit',
              label: '利润',
              children: (
                <span style={{ color: summary.profit >= 0 ? '#3f8600' : '#cf1322' }}>
                  ¥{money(summary.profit)}
                </span>
              ),
            },
            { key: 'dueDate', label: '到期日', children: dateStr(summary.dueDate) },
          ]}
        />
      ) : (
        <Alert type="info" message="请选择订单查看成本利润" showIcon />
      )}
      {loading ? <span>加载中…</span> : null}
    </div>
  )
}

function DueTab() {
  const [due, setDue] = useState<DueList>({ receivable: [], payable: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api
      .get<DueList>('/finance/due', { params: { days: 60 } })
      .then(({ data }) => setDue(data))
      .catch(notifyError)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <Card title="未来 60 天应收" style={{ marginBottom: 16 }}>
        <Table<DueReceivable>
          rowKey={(r) => r.orderNo}
          loading={loading}
          dataSource={due.receivable}
          pagination={false}
          columns={[
            { title: '客户', dataIndex: 'customerName', key: 'customerName' },
            { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
            { title: '到期日', dataIndex: 'dueDate', key: 'dueDate' },
            {
              title: '金额',
              dataIndex: 'amount',
              key: 'amount',
              align: 'right' as const,
              render: (v: number) => '¥' + money(v),
            },
          ]}
        />
      </Card>
      <Card title="未来 60 天应付">
        <Table<DuePayable>
          rowKey={(r) => r.orderNo}
          loading={loading}
          dataSource={due.payable}
          pagination={false}
          columns={[
            { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
            { title: '采购单号', dataIndex: 'orderNo', key: 'orderNo' },
            { title: '到期日', dataIndex: 'dueDate', key: 'dueDate' },
            {
              title: '金额',
              dataIndex: 'amount',
              key: 'amount',
              align: 'right' as const,
              render: (v: number) => '¥' + money(v),
            },
          ]}
        />
      </Card>
    </div>
  )
}

export default function Finance() {
  const { user } = useAuth()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<SalesOrder[]>([])

  useEffect(() => {
    void Promise.all([
      api.get<Supplier[]>('/suppliers'),
      api.get<Customer[]>('/customers'),
      api.get<SalesOrder[]>('/orders'),
    ])
      .then(([s, c, o]) => {
        setSuppliers(s.data)
        setCustomers(c.data)
        setOrders(o.data)
      })
      .catch(notifyError)
  }, [])

  const canOperate = user?.role === 'finance'

  const items = [
    ...(canOperate
      ? [
          {
            key: 'pay-supplier',
            label: '供应商付款',
            children: <SupplierPaymentForm suppliers={suppliers} />,
          },
          {
            key: 'receive-customer',
            label: '客户收款',
            children: <CustomerPaymentForm customers={customers} />,
          },
        ]
      : [
          {
            key: 'readonly',
            label: '收付款',
            children: (
              <Alert type="info" showIcon message="当前账号为只读（老板），仅可查看成本利润与账期提醒。" />
            ),
          },
        ]),
    { key: 'summary', label: '订单成本利润', children: <OrderSummaryTab orders={orders} /> },
    { key: 'due', label: '账期提醒', children: <DueTab /> },
  ]

  return (
    <Card title="财务管理">
      <Tabs defaultActiveKey={canOperate ? 'pay-supplier' : 'summary'} items={items} />
    </Card>
  )
}
