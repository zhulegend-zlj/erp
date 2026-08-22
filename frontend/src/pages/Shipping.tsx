import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Steps,
  Table,
  message,
} from 'antd'
import { api } from '../api'
import { useAuth } from '../auth'
import { dateTimeStr, notifyError, statusLabel } from './common'
import type { Paged } from './common'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
}

interface ShipmentLeg {
  id: number
  shipmentId: number
  node: string
  at: string
  note: string | null
}

interface Shipment {
  id: number
  salesOrderId: number
  shippedAt: string
  deliveryNote: string | null
  signer: string | null
  remark: string | null
  legs: ShipmentLeg[]
  salesOrder?: {
    orderNo: string
    customer: { name: string }
    items: { qty: number; product: { sku: string; name: string; spec: string | null } }[]
  }
}

const NODE_OPTIONS = ['备货', '装柜', '开船', '到港', '清关'].map((n) => ({ value: n, label: n }))

export default function Shipping() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [shipForm] = Form.useForm<{
    salesOrderId?: number
    shippedAt?: string
    deliveryNote?: string
    signer?: string
    remark?: string
  }>()
  const [legForm] = Form.useForm<{ node?: string; at?: string; note?: string }>()
  const [shipping, setShipping] = useState(false)
  const [legShipment, setLegShipment] = useState<Shipment | null>(null)
  const [legSubmitting, setLegSubmitting] = useState(false)

  const canOperate = user?.role === 'sales'

  async function load(targetPage = page, size?: number) {
    setLoading(true)
    try {
      const ps = size ?? pageSize
      const [o, s] = await Promise.all([
        api.get<SalesOrder[]>('/orders'),
        api.get<Paged<Shipment>>('/shipments', { params: { page: targetPage, pageSize: ps } }),
      ])
      setOrders(o.data)
      setShipments(s.data.items)
      setTotal(s.data.total)
      setPage(s.data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleShip(values: {
    salesOrderId?: number
    shippedAt?: string
    deliveryNote?: string
    signer?: string
    remark?: string
  }) {
    setShipping(true)
    try {
      await api.post('/shipments', {
        salesOrderId: values.salesOrderId,
        shippedAt: values.shippedAt,
        deliveryNote: values.deliveryNote,
        signer: values.signer,
        remark: values.remark,
      })
      message.success('出货成功，订单状态已更新为「已出货」')
      shipForm.resetFields()
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setShipping(false)
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

  const shippableOrders = orders.filter((o) => o.status === 'ready')

  const columns = [
    { title: '出货单 ID', dataIndex: 'id', key: 'id', width: 100 },
    { title: '订单号', key: 'orderNo', render: (_: unknown, r: Shipment) => r.salesOrder?.orderNo ?? '-' },
    { title: '送货单号', dataIndex: 'deliveryNote', key: 'deliveryNote', render: (v: string | null) => v || '-' },
    { title: '出货时间', dataIndex: 'shippedAt', key: 'shippedAt', render: dateTimeStr },
    { title: '签收人', dataIndex: 'signer', key: 'signer', render: (v: string | null) => v || '-' },
    { title: '备注', dataIndex: 'remark', key: 'remark', render: (v: string | null) => v || '-' },
    {
      title: '运输节点数',
      key: 'legs',
      render: (_: unknown, r: Shipment) => r.legs.length,
    },
    ...(canOperate
      ? [
          {
            title: '操作',
            key: 'action',
            render: (_: unknown, r: Shipment) => (
              <Button
                size="small"
                onClick={() => {
                  legForm.resetFields()
                  setLegShipment(r)
                }}
              >
                添加节点
              </Button>
            ),
          },
        ]
      : []),
  ]

  return (
    <div>
      <Card title="订单出货" style={{ marginBottom: 16 }}>
        {canOperate ? (
          <Form form={shipForm} layout="inline" onFinish={handleShip}>
            <Form.Item
              name="salesOrderId"
              rules={[{ required: true, message: '选择订单' }]}
            >
              <Select
                placeholder="选择待出货订单"
                style={{ width: 340 }}
                options={shippableOrders.map((o) => ({
                  value: o.id,
                  label: o.orderNo + '（' + statusLabel(o.status) + '）',
                }))}
              />
            </Form.Item>
            <Form.Item name="shippedAt" label="出货时间">
              <Input type="date" />
            </Form.Item>
            <Form.Item name="deliveryNote" label="送货单号">
              <Input placeholder="送货单号" style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="signer" label="签收人">
              <Input placeholder="签收人" style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="remark" label="备注">
              <Input placeholder="备注" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={shipping}>
                出货
              </Button>
            </Form.Item>
          </Form>
        ) : (
          <p>当前账号为只读（老板），仅可查看出货与运输节点。</p>
        )}
      </Card>

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
              const legs = [...r.legs].sort(
                (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
              )
              return (
                <div>
                  {r.salesOrder ? (
                    <div style={{ marginBottom: 12 }}>
                      <div>
                        <b>客户：</b>
                        {r.salesOrder.customer.name}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {r.salesOrder.items.map((it, idx) => (
                          <div key={idx}>
                            {it.product.name}（{it.product.sku}）{it.product.spec ? ' / ' + it.product.spec : ''} × {it.qty}
                          </div>
                        ))}
                      </div>
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
                        description:
                          dateTimeStr(leg.at) + (leg.note ? '　' + leg.note : ''),
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
