import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import { HistoryOutlined, PlusOutlined, ReloadOutlined, CheckOutlined } from '@ant-design/icons'
import { api } from '../../api'
import { dateStr, money, notifyError } from '../common'
import type { Paged } from '../common'
import { PO_STATUS_META, poTypeColor, poTypeLabel } from './helpers'
import type { DeliveryEditLogRow, FollowUpRow, SalesOrder, Supplier } from './types'

interface Props {
  canCreate: boolean
  suppliers: Supplier[]
}

// 采购跟进（2026-09-09，老板口径）：复刻采购日常「订单跟进明细」表。
// - 一行 = 一个采购单明细行；交货数量是累计值（采购录本次送货量、系统自动累加）
// - 未交 = 订购 − 累计收货 − 累计补货 + 累计退货；未收齐浅绿、已收齐深绿（照 Excel 色值）
// - 默认只看未收齐（老板习惯：筛选就知道哪些采购单还没交齐）
const COLOR_PENDING = '#E2F0D9'
const COLOR_DONE = '#C5E0B4'

export default function FollowUpTab(props: Props) {
  const { canCreate, suppliers } = props
  const [rows, setRows] = useState<FollowUpRow[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [total, setTotal] = useState(0)
  const [onlyOutstanding, setOnlyOutstanding] = useState(true)
  const [salesOrderFilter, setSalesOrderFilter] = useState<number | undefined>(undefined)
  const [supplierFilter, setSupplierFilter] = useState<number | undefined>(undefined)
  const [keyword, setKeyword] = useState('')
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([])

  const [deliverTarget, setDeliverTarget] = useState<FollowUpRow | null>(null)
  const [deliverForm] = Form.useForm<{ qty?: number; deliveryDate?: string; lotNo?: string }>()
  const [deliverSaving, setDeliverSaving] = useState(false)

  const [historyTarget, setHistoryTarget] = useState<FollowUpRow | null>(null)
  const [historyRows, setHistoryRows] = useState<DeliveryEditLogRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    api
      .get<SalesOrder[]>('/orders')
      .then(({ data }) => setSalesOrders(data))
      .catch(() => setSalesOrders([]))
  }, [])

  const load = useCallback(
    async (targetPage: number, size: number) => {
      setLoading(true)
      try {
        const { data } = await api.get<Paged<FollowUpRow>>('/purchasing/follow-up', {
          params: {
            page: targetPage,
            pageSize: size,
            onlyOutstanding: onlyOutstanding ? undefined : 'false',
            salesOrderId: salesOrderFilter ?? undefined,
            supplierId: supplierFilter ?? undefined,
            search: keyword.trim() || undefined,
          },
        })
        setRows(data.items)
        setTotal(data.total)
        setPage(data.page)
      } catch (err) {
        notifyError(err)
      } finally {
        setLoading(false)
      }
    },
    [onlyOutstanding, salesOrderFilter, supplierFilter, keyword],
  )

  useEffect(() => {
    void load(page, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, onlyOutstanding, salesOrderFilter, supplierFilter])

  function openDeliver(row: FollowUpRow) {
    setDeliverTarget(row)
    deliverForm.setFieldsValue({
      qty: undefined,
      deliveryDate: new Date().toISOString().slice(0, 10),
      lotNo: undefined,
    })
  }

  // 提交送货：超收时后端 400 提示，弹确认后带 allowOverQty 重发（老板口径：多送要记录）
  async function submitDeliver(allowOverQty: boolean) {
    if (!deliverTarget) return
    const values = await deliverForm.validateFields()
    setDeliverSaving(true)
    try {
      await api.post('/purchasing/follow-up/' + deliverTarget.id + '/delivery', {
        qty: values.qty,
        deliveryDate: values.deliveryDate || undefined,
        lotNo: values.lotNo || undefined,
        allowOverQty: allowOverQty || undefined,
      })
      message.success('已登记本次送货 ' + values.qty + '（累计已交 ' + (deliverTarget.receivedQty + (values.qty ?? 0)) + '）')
      setDeliverTarget(null)
      void load(page, pageSize)
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? ''
      if (msg.includes('超过订购数量')) {
        Modal.confirm({
          title: '超出订购数量',
          content: msg,
          okText: '确认超收并登记',
          cancelText: '取消',
          onOk: () => submitDeliver(true),
        })
        return
      }
      notifyError(err)
    } finally {
      setDeliverSaving(false)
    }
  }

  async function confirmRow(row: FollowUpRow) {
    try {
      await api.patch('/purchasing/follow-up/' + row.id + '/confirm', { confirmed: true })
      message.success('已标记「' + row.sku + '」收齐')
      void load(page, pageSize)
    } catch (err) {
      notifyError(err)
    }
  }

  async function openHistory(row: FollowUpRow) {
    setHistoryTarget(row)
    setHistoryLoading(true)
    try {
      const { data } = await api.get<DeliveryEditLogRow[]>('/purchasing/follow-up/' + row.id + '/history')
      setHistoryRows(data)
    } catch (err) {
      notifyError(err)
      setHistoryRows([])
    } finally {
      setHistoryLoading(false)
    }
  }

  const FIELD_LABELS: Record<string, string> = {
    qty: '交货数量',
    deliveryDate: '送货日期',
    confirm: '收齐确认',
  }

  const columns = [
    { title: '产品型号', dataIndex: 'productModel', key: 'productModel', width: 110, render: (v: string) => v || '-' },
    {
      title: '订单编号',
      dataIndex: 'salesOrderNo',
      key: 'salesOrderNo',
      width: 120,
      render: (v: string, r: FollowUpRow) =>
        v || (r.salesOrderNos.length ? r.salesOrderNos.join(' / ') : '-'),
    },
    { title: '订单数量', dataIndex: 'orderQty', key: 'orderQty', width: 90, render: (v: number | null) => (v ?? '-') },
    { title: '采购单编号', dataIndex: 'purchaseOrderNo', key: 'purchaseOrderNo', width: 120 },
    {
      title: '类型',
      dataIndex: 'poType',
      key: 'poType',
      width: 76,
      render: (v: string) =>
        v && v !== 'normal' ? <Tag color={poTypeColor(v)}>{poTypeLabel(v)}</Tag> : null,
    },
    { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', width: 130 },
    { title: '料号', dataIndex: 'sku', key: 'sku', width: 130 },
    {
      title: '品名规格',
      dataIndex: 'partName',
      key: 'partName',
      width: 170,
      render: (v: string, r: FollowUpRow) => (
        <Tooltip title={r.spec || ''}>
          <span>
            {v}
            {r.spec ? <span style={{ color: '#999' }}>　{r.spec}</span> : null}
          </span>
        </Tooltip>
      ),
    },
    { title: '用量', dataIndex: 'usage', key: 'usage', width: 70, render: (v: number | null) => (v ?? '-') },
    { title: '订购数量', dataIndex: 'qty', key: 'qty', width: 90 },
    ...(canCreate
      ? [
          {
            title: '单价',
            dataIndex: 'unitPrice',
            key: 'unitPrice',
            width: 90,
            render: (v: number | undefined) => (v === undefined ? '-' : money(v)),
          },
          {
            title: '金额',
            dataIndex: 'amount',
            key: 'amount',
            width: 100,
            render: (v: number | undefined) => (v === undefined ? '-' : money(v)),
          },
        ]
      : []),
    { title: '下单日期', dataIndex: 'orderDate', key: 'orderDate', width: 100, render: dateStr },
    { title: '预计交期', dataIndex: 'expectedDeliveryDate', key: 'expectedDeliveryDate', width: 110, render: (v: string | null) => v || '-' },
    { title: '回复交期', dataIndex: 'supplierReplyDate', key: 'supplierReplyDate', width: 100, render: dateStr },
    { title: '最近交货', dataIndex: 'lastDeliveryDate', key: 'lastDeliveryDate', width: 100, render: dateStr },
    {
      title: '累计交货',
      dataIndex: 'receivedQty',
      key: 'receivedQty',
      width: 90,
      render: (v: number, r: FollowUpRow) => (
        <span>
          {v}
          {r.replenishQty > 0 ? <span style={{ color: '#999' }}>（补 {r.replenishQty}）</span> : null}
        </span>
      ),
    },
    { title: '退货', dataIndex: 'returnQty', key: 'returnQty', width: 70, render: (v: number) => (v > 0 ? <Tag color="volcano">{v}</Tag> : 0) },
    {
      title: '未交',
      dataIndex: 'outstandingQty',
      key: 'outstandingQty',
      width: 80,
      render: (v: number) =>
        v > 0 ? <strong style={{ color: '#d4380d' }}>{v}</strong> : <span style={{ color: '#389e0d' }}>{v}</span>,
    },
    {
      title: '状态',
      key: 'state',
      width: 96,
      render: (_: unknown, r: FollowUpRow) => {
        if (r.done) return <Tag color="success">已收齐</Tag>
        if (r.outstandingQty > 0) return <Tag color="processing">未收齐</Tag>
        return <Tag color="warning">待确认</Tag>
      },
    },
    {
      title: '采购状态',
      dataIndex: 'poStatus',
      key: 'poStatus',
      width: 90,
      render: (v: string) => (PO_STATUS_META[v] ? <Tag color={PO_STATUS_META[v].color}>{PO_STATUS_META[v].label}</Tag> : v),
    },
    {
      title: '操作',
      key: 'action',
      width: 190,
      fixed: 'right' as const,
      render: (_: unknown, r: FollowUpRow) => (
        <Space size={4}>
          {canCreate ? (
            <>
              <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openDeliver(r)}>
                登记送货
              </Button>
              <Button
                size="small"
                type="link"
                icon={<CheckOutlined />}
                disabled={r.confirmed || r.outstandingQty > 0}
                onClick={() => confirmRow(r)}
              >
                已收齐
              </Button>
            </>
          ) : null}
          <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => openHistory(r)}>
            历史
          </Button>
        </Space>
      ),
    },
  ]

  const pendingCount = rows.filter((r) => !r.done).length

  return (
    <Card size="small">
      <Space wrap style={{ marginBottom: 12 }}>
        <span>只看未收齐</span>
        <Switch checked={onlyOutstanding} onChange={setOnlyOutstanding} />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="按销售订单"
          style={{ width: 200 }}
          value={salesOrderFilter}
          onChange={(v) => {
            setPage(1)
            setSalesOrderFilter(v)
          }}
          options={salesOrders.map((o) => ({ value: o.id, label: o.orderNo }))}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="按供应商"
          style={{ width: 190 }}
          value={supplierFilter}
          onChange={(v) => {
            setPage(1)
            setSupplierFilter(v)
          }}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Input.Search
          allowClear
          placeholder="料号 / 品名 / 采购单号 / 供应商"
          style={{ width: 280 }}
          onSearch={(v) => {
            setPage(1)
            setKeyword(v)
          }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
          刷新
        </Button>
        <span style={{ color: '#888' }}>
          共 {total} 行，当前页未收齐 {pendingCount} 行
        </span>
      </Space>

      <Table<FollowUpRow>
        sticky={{ offsetHeader: 8 }}
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 2100 }}
        rowClassName={(r) => (r.done ? 'follow-row-done' : 'follow-row-pending')}
        onRow={(r) => ({
          style: { background: r.done ? COLOR_DONE : COLOR_PENDING },
        })}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          showTotal: (t) => '共 ' + t + ' 行',
          onChange: (p, s) => {
            if (s !== pageSize) {
              setPageSize(s)
              setPage(1)
            } else {
              setPage(p)
            }
          },
        }}
        locale={{ emptyText: <Empty description={onlyOutstanding ? '没有未收齐的采购单明细' : '暂无数据'} /> }}
      />

      <Modal
        title={
          deliverTarget
            ? '登记送货：' + deliverTarget.purchaseOrderNo + ' / ' + deliverTarget.sku + '　' + deliverTarget.partName
            : '登记送货'
        }
        open={deliverTarget !== null}
        onCancel={() => setDeliverTarget(null)}
        onOk={() => void submitDeliver(false)}
        confirmLoading={deliverSaving}
        okText="保存"
        cancelText="取消"
      >
        {deliverTarget ? (
          <>
            <p style={{ color: '#666', marginTop: 0 }}>
              订购 {deliverTarget.qty}，已交 {deliverTarget.receivedQty}，未交 {deliverTarget.outstandingQty}。
              填<b>本次送货数量</b>，系统自动累加为累计已交。
            </p>
            <Form form={deliverForm} layout="vertical">
              <Form.Item name="qty" label="本次送货数量" rules={[{ required: true, message: '请填写本次送货数量' }]}>
                <InputNumber min={1} style={{ width: '100%' }} placeholder="如 150" />
              </Form.Item>
              <Form.Item name="deliveryDate" label="送货日期">
                <Input type="date" />
              </Form.Item>
              <Form.Item name="lotNo" label="来料单号（选填）">
                <Input placeholder="送货单号，便于追溯" />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>

      <Modal
        title={historyTarget ? '改动历史：' + historyTarget.purchaseOrderNo + ' / ' + historyTarget.sku : '改动历史'}
        open={historyTarget !== null}
        onCancel={() => setHistoryTarget(null)}
        footer={null}
        width={720}
      >
        <Table<DeliveryEditLogRow>
          rowKey="id"
          size="small"
          loading={historyLoading}
          dataSource={historyRows}
          pagination={false}
          columns={[
            { title: '时间', dataIndex: 'editedAt', key: 'editedAt', width: 170, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
            { title: '改动项', dataIndex: 'field', key: 'field', width: 110, render: (v: string) => FIELD_LABELS[v] ?? v },
            { title: '改前', dataIndex: 'beforeVal', key: 'beforeVal', width: 120, render: (v: string | null) => v ?? '-' },
            { title: '改后', dataIndex: 'afterVal', key: 'afterVal', width: 120, render: (v: string | null) => v ?? '-' },
            { title: '操作人', dataIndex: 'editedBy', key: 'editedBy' },
          ]}
          locale={{ emptyText: <Empty description="暂无改动记录" /> }}
        />
      </Modal>
    </Card>
  )
}
