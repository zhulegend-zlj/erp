import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tabs,
  message,
} from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateTimeStr, notifyError } from './common'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
}

interface Part {
  id: number
  sku: string
  name: string
  unit: string
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
  qtyOnHand: number
}

interface LedgerRow {
  id: number
  itemType: string
  itemId: number
  delta: number
  balance: number
  refType: string
  refId: number
  at: string
}

interface PartItemField {
  partId?: number
  qty?: number | null
}

function ReceiptForm({ parts }: { parts: Part[] }) {
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{ purchaseOrderId?: number; items?: PartItemField[] }>()

  async function submit(values: { purchaseOrderId?: number; items?: PartItemField[] }) {
    setSubmitting(true)
    try {
      await api.post('/receipts', {
        purchaseOrderId: values.purchaseOrderId,
        items: (values.items ?? []).map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
        })),
      })
      message.success('收货入库成功')
      form.resetFields()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={submit} initialValues={{ items: [{}] }}>
      <Form.Item
        name="purchaseOrderId"
        label="采购单 ID"
        rules={[{ required: true, message: '请输入采购单 ID' }]}
      >
        <InputNumber min={1} placeholder="采购单 ID（由采购人员提供）" style={{ width: 240 }} />
      </Form.Item>
      <Form.List name="items">
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 8 }}>
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
                <Form.Item
                  name={[field.name, 'qty']}
                  rules={[{ required: true, message: '数量' }]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber min={1} placeholder="数量" />
                </Form.Item>
                <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
              </Space>
            ))}
            <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
              添加明细
            </Button>
          </>
        )}
      </Form.List>
      <Button type="primary" htmlType="submit" loading={submitting} style={{ marginTop: 16 }}>
        提交收货
      </Button>
    </Form>
  )
}

function IssueForm({ orders, parts }: { orders: SalesOrder[]; parts: Part[] }) {
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{
    salesOrderId?: number
    issuedBy?: string
    note?: string
    items?: PartItemField[]
  }>()

  async function submit(values: {
    salesOrderId?: number
    issuedBy?: string
    note?: string
    items?: PartItemField[]
  }) {
    setSubmitting(true)
    try {
      await api.post('/issues', {
        salesOrderId: values.salesOrderId,
        issuedBy: values.issuedBy,
        note: values.note,
        items: (values.items ?? []).map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
        })),
      })
      message.success('领料出库成功')
      form.resetFields()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={submit} initialValues={{ items: [{}] }}>
      <Space style={{ display: 'flex' }} align="start">
        <Form.Item
          name="salesOrderId"
          label="销售订单"
          rules={[{ required: true, message: '选择订单' }]}
          style={{ width: 320, marginBottom: 16 }}
        >
          <Select
            placeholder="选择订单"
            options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
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
      <Form.List name="items">
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 8 }}>
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
                <Form.Item
                  name={[field.name, 'qty']}
                  rules={[{ required: true, message: '数量' }]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber min={1} placeholder="数量" />
                </Form.Item>
                <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
              </Space>
            ))}
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

function ProductionForm({ orders, products }: { orders: SalesOrder[]; products: Product[] }) {
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<{
    salesOrderId?: number
    productId?: number
    qty?: number
    entryDate?: string
  }>()

  async function submit(values: {
    salesOrderId?: number
    productId?: number
    qty?: number
    entryDate?: string
  }) {
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
            options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
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
          />
        </Form.Item>
        <Form.Item name="qty" label="数量" rules={[{ required: true, message: '数量' }]}>
          <InputNumber min={1} placeholder="数量" />
        </Form.Item>
        <Form.Item name="entryDate" label="入库日期">
          <Input type="date" />
        </Form.Item>
      </Space>
      <Button type="primary" htmlType="submit" loading={submitting}>
        提交入库
      </Button>
    </Form>
  )
}

function StockTab() {
  const [rows, setRows] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [itemType, setItemType] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')

  async function load(type?: string, kw?: string) {
    setLoading(true)
    try {
      const { data } = await api.get<StockRow[]>('/stock', {
        params: { itemType: type || undefined, keyword: kw || undefined },
      })
      setRows(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(itemType, keyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemType])

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
          placeholder="按名称搜索"
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={(v) => void load(itemType, v)}
          style={{ width: 240 }}
        />
      </Space>
      <Table<StockRow>
        rowKey={(r) => r.itemType + '-' + r.itemId}
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 10 }}
        columns={[
          {
            title: '类型',
            dataIndex: 'itemType',
            key: 'itemType',
            render: (v: string) => (v === 'part' ? '零件' : '成品'),
          },
          { title: '名称', dataIndex: 'name', key: 'name' },
          { title: 'ID', dataIndex: 'itemId', key: 'itemId', width: 80 },
          { title: '当前数量', dataIndex: 'qtyOnHand', key: 'qtyOnHand' },
        ]}
      />
    </div>
  )
}

function LedgerTab({ parts, products }: { parts: Part[]; products: Product[] }) {
  const [itemType, setItemType] = useState<'part' | 'product'>('part')
  const [itemId, setItemId] = useState<number | undefined>()
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(false)

  const options = itemType === 'part' ? parts : products

  async function query() {
    if (!itemId) {
      message.warning('请先选择' + (itemType === 'part' ? '零件' : '成品'))
      return
    }
    setLoading(true)
    try {
      const { data } = await api.get<LedgerRow[]>('/stock/ledger', {
        params: { itemType, itemId },
      })
      setRows(data)
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
          value={itemType}
          style={{ width: 140 }}
          onChange={(v) => {
            setItemType(v)
            setItemId(undefined)
            setRows([])
          }}
          options={[
            { value: 'part', label: '零件' },
            { value: 'product', label: '成品' },
          ]}
        />
        <Select
          placeholder="选择物料"
          style={{ width: 280 }}
          value={itemId}
          onChange={(v) => setItemId(v)}
          options={options.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
        />
        <Button type="primary" onClick={() => void query()}>
          查询流水
        </Button>
      </Space>
      <Table<LedgerRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: '时间', dataIndex: 'at', key: 'at', render: dateTimeStr },
          { title: '变动', dataIndex: 'delta', key: 'delta' },
          { title: '结存', dataIndex: 'balance', key: 'balance' },
          { title: '来源类型', dataIndex: 'refType', key: 'refType' },
          { title: '来源 ID', dataIndex: 'refId', key: 'refId' },
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

  useEffect(() => {
    void Promise.all([
      api.get<SalesOrder[]>('/orders'),
      api.get<Part[]>('/parts'),
      api.get<Product[]>('/products'),
    ])
      .then(([o, pt, pd]) => {
        setOrders(o.data)
        setParts(pt.data)
        setProducts(pd.data)
      })
      .catch(notifyError)
  }, [])

  const canOperate = user?.role === 'warehouse'

  const items = [
    ...(canOperate
      ? [
          { key: 'receipt', label: '收货入库', children: <ReceiptForm parts={parts} /> },
          {
            key: 'issue',
            label: '领料出库',
            children: <IssueForm orders={orders} parts={parts} />,
          },
          {
            key: 'production',
            label: '成品入库',
            children: <ProductionForm orders={orders} products={products} />,
          },
        ]
      : [
          {
            key: 'readonly',
            label: '仓库操作',
            children: <Alert type="info" showIcon message="当前账号为只读（老板），仅可查看库存与流水。" />,
          },
        ]),
    { key: 'stock', label: '库存查询', children: <StockTab /> },
    { key: 'ledger', label: '流水', children: <LedgerTab parts={parts} products={products} /> },
  ]

  return (
    <Card title="库存管理">
      <Tabs defaultActiveKey={canOperate ? 'receipt' : 'stock'} items={items} />
    </Card>
  )
}
