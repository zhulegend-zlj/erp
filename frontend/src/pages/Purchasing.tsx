import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateStr, dateTimeStr, money, notifyError, statusLabel } from './common'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
  customer: { name: string }
}

interface SalesOrderDetail extends SalesOrder {
  deliveryDate: string
  items: {
    id: number
    productId: number
    qty: number
    unitPrice: string
    product: { sku: string; name: string }
  }[]
}

interface Supplier {
  id: number
  name: string
  contact: string | null
}

interface Requirement {
  partId: number
  sku: string
  partName: string
  supplierId: number | null
  supplierName: string
  requiredQty: number
  onHand: number
  gapQty: number
}

interface PoItemField {
  partId?: number
  qty?: number | null
  unitPrice?: number | null
}

interface PoFormValues {
  items?: PoItemField[]
}

interface PurchaseOrder {
  id: number
  orderNo: string
  supplierId: number
  salesOrderId: number | null
}

interface PurchaseOrderRow {
  id: number
  orderNo: string
  status: string
  supplierId: number
  supplierName: string
  salesOrderId: number | null
  totalAmount: number
  paidAmount: number
  outstanding: number
  createdAt: string
}

export default function Purchasing() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [orderId, setOrderId] = useState<number | undefined>()
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [reqLoading, setReqLoading] = useState(false)
  const [orderDetail, setOrderDetail] = useState<SalesOrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [lastPos, setLastPos] = useState<PurchaseOrder[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[]>([])
  const [poLoading, setPoLoading] = useState(false)
  const [form] = Form.useForm<PoFormValues>()

  const canCreate = user?.role === 'purchase'

  useEffect(() => {
    setPoLoading(true)
    void Promise.all([
      api.get<SalesOrder[]>('/orders'),
      api.get<Supplier[]>('/suppliers'),
      api.get<PurchaseOrderRow[]>('/purchase-orders'),
    ])
      .then(([o, s, po]) => {
        setOrders(o.data)
        setSuppliers(s.data)
        setPurchaseOrders(po.data)
      })
      .catch(notifyError)
      .finally(() => setPoLoading(false))
  }, [])

  useEffect(() => {
    if (!orderId) {
      setRequirements([])
      setOrderDetail(null)
      return
    }
    setReqLoading(true)
    setDetailLoading(true)
    void Promise.all([
      api.get<Requirement[]>('/purchasing/requirements', { params: { orderId } }),
      api.get<SalesOrderDetail>('/orders/' + orderId),
    ])
      .then(([r, d]) => {
        setRequirements(r.data)
        setOrderDetail(d.data)
      })
      .catch(notifyError)
      .finally(() => {
        setReqLoading(false)
        setDetailLoading(false)
      })
  }, [orderId])

  const gaps = requirements.filter((r) => r.gapQty > 0)

  const watchedItems = Form.useWatch('items', form) as PoItemField[] | undefined
  const supplierGroupMap = new Map<string, number>()
  for (const it of watchedItems ?? []) {
    const req = requirements.find((r) => r.partId === it.partId)
    const name = req?.supplierName || '未设置供应商'
    supplierGroupMap.set(name, (supplierGroupMap.get(name) ?? 0) + 1)
  }
  const supplierGroups = [...supplierGroupMap.entries()]

  function openCreatePo() {
    form.setFieldsValue({
      items: gaps.map((g) => ({ partId: g.partId, qty: g.gapQty, unitPrice: undefined })),
    })
    setModalOpen(true)
  }

  async function handleCreate(values: PoFormValues) {
    setSubmitting(true)
    try {
      const { data } = await api.post<PurchaseOrder[]>('/purchase-orders/batch', {
        salesOrderId: orderId,
        items: (values.items ?? []).map((it) => ({
          partId: Number(it.partId ?? 0),
          qty: Number(it.qty ?? 0),
          unitPrice: Number(it.unitPrice ?? 0),
        })),
      })
      setLastPos(data)
      message.success('已按供应商生成 ' + data.length + ' 张采购单：' + data.map((o) => o.orderNo).join('、'))
      setModalOpen(false)
      setPoLoading(true)
      const { data: poRows } = await api.get<PurchaseOrderRow[]>('/purchase-orders')
      setPurchaseOrders(poRows)
      setPoLoading(false)
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Card title="采购需求" style={{ marginBottom: 16 }}>
        {orders.length === 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="暂无销售订单"
            description={
              <span>
                销售订单由销售或老板在「订单」页面创建；当前账号只能查看和基于订单生成采购单。
                {user?.role === 'boss' ? (
                  <Button type="link" style={{ paddingLeft: 8 }} onClick={() => navigate('/orders')}>
                    去订单页
                  </Button>
                ) : (
                  '请联系销售或老板先录入销售订单。'
                )}
              </span>
            }
          />
        ) : null}
        <Space style={{ marginBottom: 16 }}>
          <Select
            placeholder="选择销售订单"
            style={{ width: 360 }}
            value={orderId}
            onChange={(v) => setOrderId(v)}
            options={orders.map((o) => ({
              value: o.id,
              label: o.orderNo + '（' + (o.customer?.name ?? '') + ' / ' + statusLabel(o.status) + '）',
            }))}
          />
          {canCreate && orderId ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreatePo} disabled={gaps.length === 0}>
              生成采购单
            </Button>
          ) : null}
        </Space>
        {orderDetail ? (
          <Card size="small" title={'销售订单明细：' + orderDetail.orderNo} style={{ marginBottom: 16 }} loading={detailLoading}>
            <div>
              <b>客户：</b>
              {orderDetail.customer.name}　<b>交期：</b>
              {dateStr(orderDetail.deliveryDate)}　<b>状态：</b>
              {statusLabel(orderDetail.status)}
            </div>
            <div style={{ marginTop: 8 }}>
              {orderDetail.items.map((it) => (
                <div key={it.id}>
                  {it.product.name}（{it.product.sku}）× {it.qty}　单价 ¥{money(it.unitPrice)}
                </div>
              ))}
            </div>
          </Card>
        ) : null}
        {orderId && gaps.length === 0 && !reqLoading ? (
          <Alert type="success" message="该订单当前无零件缺口" showIcon />
        ) : null}
        <Table<Requirement>
          rowKey="partId"
          loading={reqLoading}
          dataSource={requirements}
          pagination={false}
          columns={[
            { title: '零件', dataIndex: 'partName', key: 'partName' },
            { title: '需求数量', dataIndex: 'requiredQty', key: 'requiredQty' },
            { title: '现有库存', dataIndex: 'onHand', key: 'onHand' },
            {
              title: '缺口',
              dataIndex: 'gapQty',
              key: 'gapQty',
              render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : v),
            },
          ]}
        />
        {lastPos.length > 0 ? (
          <Alert
            style={{ marginTop: 16 }}
            type="success"
            showIcon
            message="最近生成的采购单"
            description={lastPos.map((po) => po.orderNo).join('、')}
          />
        ) : null}
      </Card>

      <Card title="采购单列表" style={{ marginBottom: 16 }}>
        <Table<PurchaseOrderRow>
          rowKey="id"
          loading={poLoading}
          dataSource={purchaseOrders}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '采购单号', dataIndex: 'orderNo', key: 'orderNo' },
            { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              render: (v: string) => {
                const map: Record<string, { label: string; color: string }> = {
                  open: { label: '待收货', color: 'orange' },
                  partial: { label: '部分收货', color: 'blue' },
                  received: { label: '已收货', color: 'green' },
                }
                const item = map[v] ?? { label: v, color: 'default' }
                return <Tag color={item.color}>{item.label}</Tag>
              },
            },
            {
              title: '金额',
              dataIndex: 'totalAmount',
              key: 'totalAmount',
              align: 'right' as const,
              render: (v: number) => '¥' + money(v),
            },
            {
              title: '已付',
              dataIndex: 'paidAmount',
              key: 'paidAmount',
              align: 'right' as const,
              render: (v: number) => '¥' + money(v),
            },
            {
              title: '未付',
              dataIndex: 'outstanding',
              key: 'outstanding',
              align: 'right' as const,
              render: (v: number) => (
                <span style={{ color: v > 0 ? '#cf1322' : undefined }}>¥{money(v)}</span>
              ),
            },
            { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: dateTimeStr },
          ]}
        />
      </Card>

      <Card title="供应商跟催（联系人）">
        <Table<Supplier>
          rowKey="id"
          dataSource={suppliers}
          pagination={false}
          columns={[
            { title: '供应商', dataIndex: 'name', key: 'name' },
            {
              title: '联系人',
              dataIndex: 'contact',
              key: 'contact',
              render: (v: string | null) => v ?? '-',
            },
          ]}
        />
      </Card>

      <Modal
        title="生成采购单"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={'预计生成 ' + supplierGroups.length + ' 张采购单'}
            description={
              supplierGroups.length > 0
                ? supplierGroups.map(([name, count]) => name + '：' + count + ' 项').join('；')
                : '请添加采购明细，系统将按零件供应商自动分组。'
            }
          />
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item
                      name={[field.name, 'partId']}
                      rules={[{ required: true, message: '零件' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select
                        style={{ width: 240 }}
                        placeholder="零件"
                        options={requirements.map((r) => ({
                          value: r.partId,
                          label: r.partName + '（' + (r.supplierName || '未设置供应商') + '）',
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
    </div>
  )
}
