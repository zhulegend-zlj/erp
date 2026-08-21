import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Image,
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

interface PurchaseOrderOption {
  id: number
  orderNo: string
  supplierName: string
  status: string
}

function ReceiptForm({ parts, onDone }: { parts: Part[]; onDone?: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderOption[]>([])
  const [form] = Form.useForm<{ purchaseOrderId?: number; items?: PartItemField[] }>()

  useEffect(() => {
    api
      .get<PurchaseOrderOption[]>('/purchase-orders')
      .then(({ data }) => setPurchaseOrders(data))
      .catch(notifyError)
  }, [])

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
      onDone?.()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {purchaseOrders.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="暂无采购单"
          description="请先由采购在「采购」页选择销售订单并生成采购单，再进行收货入库。"
        />
      ) : null}
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ items: [{}] }}>
        <Form.Item
          name="purchaseOrderId"
          label="采购单"
          rules={[{ required: true, message: '请选择采购单' }]}
        >
        <Select
          showSearch
          placeholder="选择采购单"
          style={{ width: 360 }}
          optionFilterProp="label"
          options={purchaseOrders.map((po) => ({
            value: po.id,
            label: po.orderNo + '（' + po.supplierName + '）',
          }))}
        />
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
    </>
  )
}

function IssueForm({ orders, parts, onDone }: { orders: SalesOrder[]; parts: Part[]; onDone?: () => void }) {
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
      onDone?.()
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

function ProductionForm({ orders, products, onDone }: { orders: SalesOrder[]; products: Product[]; onDone?: () => void }) {
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

function StockTab({ refreshToken }: { refreshToken?: number }) {
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

interface PoLedgerRow {
  seq: number
  partId: number
  sku: string
  name: string
  requiredQty: number
  receivedQty: number
  outstanding: number
  balance: number
}

interface PoLedgerResult {
  purchaseOrderNo: string
  supplierName: string
  items: PoLedgerRow[]
}

function signedDelta(v: number): string {
  return v > 0 ? '+' + v : String(v)
}

function LedgerTab({
  parts,
  products,
  purchaseOrders,
  refreshToken,
}: {
  parts: Part[]
  products: Product[]
  purchaseOrders: PurchaseOrderOption[]
  refreshToken?: number
}) {
  const [mode, setMode] = useState<'item' | 'po'>('item')
  const [itemType, setItemType] = useState<'part' | 'product'>('part')
  const [itemId, setItemId] = useState<number | undefined>()
  const [itemRows, setItemRows] = useState<LedgerRow[]>([])
  const [itemLoading, setItemLoading] = useState(false)
  const [poNo, setPoNo] = useState<string | undefined>()
  const [poResult, setPoResult] = useState<PoLedgerResult | null>(null)
  const [poLoading, setPoLoading] = useState(false)

  const options = itemType === 'part' ? parts : products
  const selectedItem = options.find((p) => p.id === itemId)

  async function queryItem() {
    if (!itemId) {
      message.warning('请先选择' + (itemType === 'part' ? '零件' : '成品'))
      return
    }
    setMode('item')
    setItemLoading(true)
    try {
      const { data } = await api.get<LedgerRow[]>('/stock/ledger', {
        params: { itemType, itemId },
      })
      setItemRows(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setItemLoading(false)
    }
  }

  async function queryPo() {
    if (!poNo) {
      message.warning('请先选择采购单')
      return
    }
    setMode('po')
    setPoLoading(true)
    try {
      const { data } = await api.get<PoLedgerResult>('/inventory/po-ledger', {
        params: { purchaseOrderNo: poNo },
      })
      setPoResult(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setPoLoading(false)
    }
  }

  useEffect(() => {
    if (refreshToken === undefined) return
    if (mode === 'po') void queryPo()
    else void queryItem()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          value={itemType}
          style={{ width: 120 }}
          onChange={(v) => {
            setItemType(v)
            setItemId(undefined)
            setItemRows([])
          }}
          options={[
            { value: 'part', label: '零件' },
            { value: 'product', label: '成品' },
          ]}
        />
        <Select
          placeholder="选择物料"
          style={{ width: 260 }}
          value={itemId}
          onChange={(v) => setItemId(v)}
          options={options.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
        />
        <Button onClick={() => void queryItem()}>查询流水</Button>
      </Space>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          showSearch
          placeholder="按采购单查询"
          style={{ width: 300 }}
          value={poNo}
          onChange={(v) => {
            setPoNo(v)
            setPoResult(null)
          }}
          optionFilterProp="label"
          options={purchaseOrders.map((po) => ({
            value: po.orderNo,
            label: po.orderNo + '（' + po.supplierName + '）',
          }))}
        />
        <Button type="primary" onClick={() => void queryPo()}>
          查询采购单流水
        </Button>
      </Space>

      {mode === 'item' ? (
        <Table<LedgerRow>
          rowKey="id"
          loading={itemLoading}
          dataSource={itemRows}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '时间', dataIndex: 'at', key: 'at', render: dateTimeStr },
            {
              title: '物料',
              key: 'material',
              render: () => (selectedItem ? selectedItem.name + '（' + selectedItem.sku + '）' : '-'),
            },
            {
              title: '变动',
              dataIndex: 'delta',
              key: 'delta',
              render: (v: number) => signedDelta(v),
            },
            { title: '结存', dataIndex: 'balance', key: 'balance' },
          ]}
        />
      ) : poResult ? (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={'采购单 ' + poResult.purchaseOrderNo + '（' + poResult.supplierName + '）'}
          />
          <Table<PoLedgerRow>
            rowKey="partId"
            loading={poLoading}
            dataSource={poResult.items}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: '序号', dataIndex: 'seq', key: 'seq', width: 70 },
              {
                title: '料号+物料名称',
                key: 'material',
                render: (_: unknown, r: PoLedgerRow) => r.sku + ' ' + r.name,
              },
              { title: '需求数', dataIndex: 'requiredQty', key: 'requiredQty' },
              { title: '已入库', dataIndex: 'receivedQty', key: 'receivedQty' },
              { title: '未到', dataIndex: 'outstanding', key: 'outstanding' },
              { title: '结存', dataIndex: 'balance', key: 'balance' },
            ]}
          />
        </>
      ) : null}
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
  usage: number
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
              v ? <Image src={v} width={48} height={48} style={{ objectFit: 'cover' }} /> : '-',
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
          { title: '规格', dataIndex: 'spec', key: 'spec', render: (v: string) => v || '-' },
          { title: '用量', dataIndex: 'usage', key: 'usage' },
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

export default function Inventory() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderOption[]>([])
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    void Promise.all([
      api.get<SalesOrder[]>('/orders'),
      api.get<Part[]>('/parts'),
      api.get<Product[]>('/products'),
      api.get<PurchaseOrderOption[]>('/purchase-orders'),
    ])
      .then(([o, pt, pd, po]) => {
        setOrders(o.data)
        setParts(pt.data)
        setProducts(pd.data)
        setPurchaseOrders(po.data)
      })
      .catch(notifyError)
  }, [])

  const canOperate = user?.role === 'warehouse'

  const items = [
    ...(canOperate
      ? [
          {
            key: 'receipt',
            label: '收货入库',
            children: <ReceiptForm parts={parts} onDone={() => setRefreshToken((t) => t + 1)} />,
          },
          {
            key: 'issue',
            label: '领料出库',
            children: <IssueForm orders={orders} parts={parts} onDone={() => setRefreshToken((t) => t + 1)} />,
          },
          {
            key: 'production',
            label: '成品入库',
            children: (
              <ProductionForm
                orders={orders}
                products={products}
                onDone={() => setRefreshToken((t) => t + 1)}
              />
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
        <LedgerTab
          parts={parts}
          products={products}
          purchaseOrders={purchaseOrders}
          refreshToken={refreshToken}
        />
      ),
    },
    { key: 'order-materials', label: '订单物料计算', children: <OrderMaterialsTab orders={orders} /> },
  ]

  return (
    <Card title="库存管理">
      <Tabs defaultActiveKey={canOperate ? 'receipt' : 'stock'} items={items} />
    </Card>
  )
}
