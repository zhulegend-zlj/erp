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
import { dateStr, dateTimeStr, money, notifyError, orderPhaseLabel, statusLabel } from './common'
import type { Paged } from './common'
import { useKeepAliveState } from './keepAlive'

interface SalesOrder {
  id: number
  orderNo: string
  status: string
  purchasing?: boolean
  producing?: boolean
  customer: { name: string }
}

interface SalesOrderDetail extends SalesOrder {
  deliveryDate: string
  items: {
    id: number
    productId: number
    qty: number
    unitPrice?: string
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
  price: number | null
  usage: number
  requiredQty: number
  onHand: number
  gapQty: number
}

interface PoItemField {
  partId?: number
  qty?: number | null
  unitPrice?: number | null
  supplierId?: number | null
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
  // 关键上下文进会话缓存：切换页面回来继续操作（已选订单/明细/生成弹窗草稿）
  const [orderId, setOrderId] = useKeepAliveState<number | undefined>('po.orderId', undefined)
  const [requirements, setRequirements] = useKeepAliveState<Requirement[]>('po.requirements', [])
  const [reqLoading, setReqLoading] = useState(false)
  const [orderDetail, setOrderDetail] = useKeepAliveState<SalesOrderDetail | null>('po.orderDetail', null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [modalOpen, setModalOpen] = useKeepAliveState<boolean>('po.modalOpen', false)
  const [draftItems, setDraftItems] = useKeepAliveState<PoItemField[] | undefined>('po.draftItems', undefined)
  const [submitting, setSubmitting] = useState(false)
  const [lastPos, setLastPos] = useKeepAliveState<PurchaseOrder[]>('po.lastPos', [])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[]>([])
  const [poLoading, setPoLoading] = useState(false)
  const [poPage, setPoPage] = useState(1)
  const [poTotal, setPoTotal] = useState(0)
  const [form] = Form.useForm<PoFormValues>()
  const poPageSize = 10

  // 恢复上次离开时的弹窗草稿（切换页面回来继续编辑）
  useEffect(() => {
    if (draftItems) form.setFieldsValue({ items: draftItems })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canCreate = user?.role === 'purchase'

  async function loadPos(targetPage = 1) {
    setPoLoading(true)
    try {
      const { data } = await api.get<Paged<PurchaseOrderRow>>('/purchase-orders', {
        params: { page: targetPage, pageSize: poPageSize },
      })
      setPurchaseOrders(data.items)
      setPoTotal(data.total)
      setPoPage(data.page)
    } catch (err) {
      notifyError(err)
    } finally {
      setPoLoading(false)
    }
  }

  useEffect(() => {
    void Promise.all([
      api.get<SalesOrder[]>('/orders'),
      api.get<Supplier[]>('/suppliers'),
      loadPos(1),
    ])
      .then(([o, s]) => {
        setOrders(o.data)
        setSuppliers(s.data)
      })
      .catch(notifyError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(() => {
    setDraftItems(watchedItems)
  }, [watchedItems, setDraftItems])
  const supplierGroupMap = new Map<string, number>()
  for (const it of watchedItems ?? []) {
    const req = requirements.find((r) => r.partId === it.partId)
    const chosen = suppliers.find((s) => s.id === it.supplierId)
    const name = chosen?.name || req?.supplierName || '未设置供应商'
    supplierGroupMap.set(name, (supplierGroupMap.get(name) ?? 0) + 1)
  }
  const supplierGroups = [...supplierGroupMap.entries()]

  function openCreatePo() {
    form.setFieldsValue({
      items: gaps.map((g) => ({
        partId: g.partId,
        qty: g.gapQty,
        unitPrice: g.price ?? undefined,
        supplierId: g.supplierId ?? undefined,
      })),
    })
    setModalOpen(true)
  }

  async function handleCreate(values: PoFormValues) {
    const rows = (values.items ?? []).map((it) => ({
      partId: Number(it.partId ?? 0),
      qty: Number(it.qty ?? 0),
      unitPrice: Number(it.unitPrice ?? 0),
      supplierId: it.supplierId ?? null,
    }))
    // 本次给原本没挂（或换了）供应商的零件选了供应商 → 询问是否同步回零件资料；
    // 「仅本次生效」也会继续生成采购单，只是不写回零件资料
    let syncAssignments = false
    const assignments = rows.filter((r) => {
      const req = requirements.find((x) => x.partId === r.partId)
      return r.partId > 0 && r.supplierId != null && r.supplierId !== (req?.supplierId ?? null)
    })
    if (assignments.length > 0) {
      const shouldSync = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '同步供应商到零件资料？',
          content:
            '本次为 ' +
            assignments.length +
            ' 个零件选择了供应商。是否同时更新到零件资料？选「仅本次生效」则只按本次采购单分组，不改零件资料。',
          okText: '同步并生成采购单',
          cancelText: '仅本次生效',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      syncAssignments = shouldSync
    }
    setSubmitting(true)
    try {
      if (syncAssignments && assignments.length > 0) {
        await Promise.all(
          assignments.map((a) => api.put('/parts/' + a.partId, { supplierId: a.supplierId })),
        )
      }
      const { data } = await api.post<PurchaseOrder[]>('/purchase-orders/batch', {
        salesOrderId: orderId,
        items: rows.map((r) => ({
          partId: r.partId,
          qty: r.qty,
          unitPrice: r.unitPrice,
          supplierId: r.supplierId ?? undefined,
        })),
      })
      setLastPos(data)
      message.success('已按供应商生成 ' + data.length + ' 张采购单：' + data.map((o) => o.orderNo).join('、'))
      setModalOpen(false)
      setDraftItems(undefined)
      form.resetFields()
      await loadPos(1)
      if (orderId) {
        void api
          .get<Requirement[]>('/purchasing/requirements', { params: { orderId } })
          .then(({ data: rd }) => setRequirements(rd))
          .catch(notifyError)
      }
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
              label: o.orderNo + '（' + (o.customer?.name ?? '') + ' / ' + orderPhaseLabel(o) + '）',
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
                  {it.product.name}（{it.product.sku}）× {it.qty}
                  {user?.role === 'boss' && it.unitPrice !== undefined ? '　单价 ¥' + money(it.unitPrice) : ''}
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
            {
              title: '零件',
              key: 'part',
              render: (_: unknown, r: Requirement) => r.sku + '　' + r.partName,
            },
            {
              title: '用量/台',
              dataIndex: 'usage',
              key: 'usage',
              render: (v: number) => (v === 0 ? '-' : v),
            },
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
          pagination={{
            current: poPage,
            pageSize: poPageSize,
            total: poTotal,
            showSizeChanger: false,
            onChange: (p) => void loadPos(p),
          }}
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
                {fields.map((field, index) => {
                  const it = watchedItems?.[index]
                  const req = requirements.find((r) => r.partId === it?.partId)
                  const isDefaultSupplier = req?.supplierId != null && it?.supplierId === req.supplierId
                  return (
                    <div
                      key={field.key}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}
                    >
                      <Form.Item
                        name={[field.name, 'partId']}
                        rules={[{ required: true, message: '零件' }]}
                        style={{ marginBottom: 0, width: 250 }}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="零件（SKU + 名称）"
                          onChange={(v) => {
                            const r = requirements.find((x) => x.partId === v)
                            form.setFields([
                              { name: ['items', field.name, 'qty'], value: r?.gapQty ?? undefined },
                              { name: ['items', field.name, 'unitPrice'], value: r?.price ?? undefined },
                              { name: ['items', field.name, 'supplierId'], value: r?.supplierId ?? undefined },
                            ])
                          }}
                          options={requirements.map((r) => ({
                            value: r.partId,
                            label: r.sku + '　' + r.partName,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'qty']}
                        rules={[{ required: true, message: '数量' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber min={1} precision={0} step={1} placeholder="数量" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'unitPrice']}
                        rules={[{ required: true, message: '单价' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber min={0} placeholder="单价" style={{ width: 130 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'supplierId']} style={{ marginBottom: 0 }}>
                        <Select
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          placeholder="供应商"
                          style={{ width: 180 }}
                          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                        />
                      </Form.Item>
                      {req?.supplierId == null && it?.supplierId == null ? (
                        <Tag color="orange" style={{ marginTop: 4 }}>未设置</Tag>
                      ) : isDefaultSupplier ? (
                        <Tag color="green" style={{ marginTop: 4 }}>默认</Tag>
                      ) : it?.supplierId != null ? (
                        <Tag color="blue" style={{ marginTop: 4 }}>本次改选</Tag>
                      ) : null}
                      <div style={{ lineHeight: '32px', color: '#8c8c8c', fontSize: 12 }}>
                        {req
                          ? '用量 ' + req.usage + ' ｜需求 ' + req.requiredQty + ' ｜库存 ' + req.onHand + ' ｜需采购 ' + req.gapQty
                          : ''}
                      </div>
                      <Button
                        type="text"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(field.name)}
                      />
                    </div>
                  )
                })}
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
