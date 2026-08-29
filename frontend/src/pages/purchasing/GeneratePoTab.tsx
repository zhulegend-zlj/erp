import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  Alert,
  Button,
  Card,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { api } from '../../api'
import type { User } from '../../api'
import { dateStr, money, notifyError, orderPhaseLabel, statusLabel } from '../common'
import type { Paged } from '../common'
import GeneratePoModal from './GeneratePoModal'
import type {
  CompanyHeader,
  PoItemField,
  PurchaseOrder,
  Requirement,
  SalesOrder,
  SalesOrderDetail,
  Supplier,
} from './types'

interface Props {
  user: User | null
  canCreate: boolean
  orderIds: number[]
  setOrderIds: Dispatch<SetStateAction<number[]>>
  requirements: Requirement[]
  setRequirements: Dispatch<SetStateAction<Requirement[]>>
  orderDetails: SalesOrderDetail[]
  setOrderDetails: Dispatch<SetStateAction<SalesOrderDetail[]>>
  modalOpen: boolean
  setModalOpen: Dispatch<SetStateAction<boolean>>
  draftItems: PoItemField[] | undefined
  setDraftItems: Dispatch<SetStateAction<PoItemField[] | undefined>>
  suppliers: Supplier[]
  companyHeaders: CompanyHeader[]
  onCreated: () => void
}

// 需求表供应商分组样式：组间 2px 蓝色分界线 + 组首行供应商加粗
const REQ_GROUP_CSS =
  '.po-group-start > td { border-top: 2px solid #1677ff !important; } ' +
  '.po-group-start > td:first-child { font-weight: 600; }'

/**
 * 需求表按供应商分组（老板反馈：选完订单也要按供应商区分）——
 * 供应商放最左合并单元格、每组只显示一次，组间加 2px 蓝色分界线。
 */
function RequirementGroupedTable(props: {
  requirements: Requirement[]
  loading: boolean
  suppliers: Supplier[]
}) {
  const { requirements, loading, suppliers } = props
  // 按供应商分组排序（未设置供应商的组排最后），组内保持原始顺序
  const sorted: Requirement[] = []
  const groups: { key: string; name: string; size: number }[] = []
  const seen = new Map<string, Requirement[]>()
  for (const r of requirements) {
    const key = r.supplierId == null ? '__none__' : String(r.supplierId)
    const list = seen.get(key) ?? []
    list.push(r)
    seen.set(key, list)
  }
  for (const [key, list] of seen) {
    if (key === '__none__') continue
    groups.push({ key, name: list[0]!.supplierName || suppliers.find((s) => String(s.id) === key)?.name || '未设置供应商', size: list.length })
    sorted.push(...list)
  }
  const noneList = seen.get('__none__')
  if (noneList && noneList.length > 0) {
    groups.push({ key: '__none__', name: '未设置供应商', size: noneList.length })
    sorted.push(...noneList)
  }
  // 供应商列 rowSpan：每组首行=组大小，其余 0；组首行标记分界线 class
  const groupStartRow = new Set<string>()
  const rowSpans = new Map<string, number>()
  {
    let idx = 0
    for (const g of groups) {
      for (let i = 0; i < g.size; i++) {
        const key = g.key + ':' + i
        rowSpans.set(key, i === 0 ? g.size : 0)
        if (i === 0) groupStartRow.add(key)
        idx++
      }
    }
  }
  let rowIdx = 0
  const rowKeyOf = (r: Requirement) => {
    const key = (r.supplierId == null ? '__none__' : String(r.supplierId)) + ':' + sorted.findIndex((x) => x === r)
    return key
  }
  const rowSpanFor = (r: Requirement) => {
    const g = (r.supplierId == null ? '__none__' : String(r.supplierId))
    const pos = sorted.filter((x) => (x.supplierId == null ? '__none__' : String(x.supplierId)) === g).indexOf(r)
    return pos === 0 ? (groups.find((x) => x.key === g)?.size ?? 1) : 0
  }
  const isGroupStart = (r: Requirement) => {
    const g = (r.supplierId == null ? '__none__' : String(r.supplierId))
    const pos = sorted.filter((x) => (x.supplierId == null ? '__none__' : String(x.supplierId)) === g).indexOf(r)
    return pos === 0
  }
  void rowKeyOf
  void rowIdx
  return (
    <Table<Requirement>
      rowKey={(r) => rowKeyOf(r)}
      loading={loading}
      dataSource={sorted}
      pagination={false}
      scroll={{ x: 1100 }}
      rowClassName={(r) => (isGroupStart(r) ? 'po-group-start' : '')}
      columns={[
        {
          title: '供应商',
          key: 'supplier',
          fixed: 'left' as const,
          width: 180,
          onCell: (r: Requirement) => ({ rowSpan: rowSpanFor(r) }),
          render: (_: unknown, r: Requirement) => {
            const g = r.supplierId == null ? '__none__' : String(r.supplierId)
            const name = groups.find((x) => x.key === g)?.name ?? '-'
            return r.supplierId == null ? <Tag color="orange">{name}</Tag> : name
          },
        },
        {
          title: '零件',
          key: 'part',
          render: (_: unknown, r: Requirement) => r.sku + '　' + r.partName,
        },
        {
          title: '用量/台',
          key: 'usage',
          render: (_: unknown, r: Requirement) => r.usageText ?? (r.usage === 0 || r.usage == null ? '-' : r.usage),
        },
        { title: '需求数量', dataIndex: 'requiredQty', key: 'requiredQty' },
        { title: '现有库存', dataIndex: 'onHand', key: 'onHand' },
        {
          title: '缺口',
          dataIndex: 'gapQty',
          key: 'gapQty',
          render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : v),
        },
        {
          title: 'MOQ（起订量）',
          dataIndex: 'moq',
          key: 'moq',
          render: (v: number | null | undefined, r: Requirement) =>
            v != null ? (r.gapQty > 0 && r.gapQty < v ? <Tag color="gold">{v}</Tag> : v) : '-',
        },
        {
          title: '安全库存',
          dataIndex: 'safetyStock',
          key: 'safetyStock',
          render: (v: number | null | undefined) => v ?? '-',
        },
        {
          title: '共用料',
          dataIndex: 'isCommonPart',
          key: 'isCommonPart',
          render: (v: boolean) => (v ? <Tag color="geekblue">共用料</Tag> : '-'),
        },
        {
          title: '建议采购量',
          dataIndex: 'suggestedQty',
          key: 'suggestedQty',
          render: (v: number, r: Requirement) => {
            const diff = v !== r.gapQty
            return (
              <span style={diff ? { color: '#1677ff', fontWeight: 600 } : undefined}>
                {v}
                {diff ? '（含安全库存补货）' : ''}
              </span>
            )
          },
        },
      ]}
    />
  )
}

export default function GeneratePoTab(props: Props) {
  const {
    user,
    canCreate,
    orderIds,
    setOrderIds,
    requirements,
    setRequirements,
    orderDetails,
    setOrderDetails,
    modalOpen,
    setModalOpen,
    draftItems,
    setDraftItems,
    suppliers,
    companyHeaders,
    onCreated,
  } = props

  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [pendingOrders, setPendingOrders] = useState<SalesOrder[]>([])
  const [pendingOnly, setPendingOnly] = useState(false)
  const [reqLoading, setReqLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [reqRefresh, setReqRefresh] = useState(0)
  const [checking, setChecking] = useState(false)

  async function loadOrders() {
    try {
      const [o, p] = await Promise.all([
        api.get<SalesOrder[]>('/orders'),
        api.get<SalesOrder[]>('/orders', { params: { pendingPurchase: 'true' } }),
      ])
      setOrders(o.data)
      setPendingOrders(p.data)
      if (pendingOnly && orderIds.length > 0 && !p.data.some((x) => orderIds.includes(x.id))) {
        setPendingOnly(false)
      }
    } catch (err) {
      notifyError(err)
    }
  }

  useEffect(() => {
    void loadOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!orderIds.length) {
      setRequirements([])
      setOrderDetails([])
      return
    }
    setReqLoading(true)
    setDetailLoading(true)
    void Promise.all([
      api.get<Requirement[]>('/purchasing/requirements', {
        params: { orderIds: orderIds.join(',') },
      }),
      Promise.all(orderIds.map((id) => api.get<SalesOrderDetail>('/orders/' + id))),
    ])
      .then(([r, ds]) => {
        setRequirements(r.data)
        setOrderDetails(ds.map((d) => d.data))
      })
      .catch(notifyError)
      .finally(() => {
        setReqLoading(false)
        setDetailLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderIds, reqRefresh])

  const gaps = requirements.filter((r) => (r.suggestedQty ?? r.gapQty) > 0)

  // 草稿订单提醒 + 已生成采购单二次确认（增补/补损），保留原交互并适配多订单
  async function openCreatePoWithCheck() {
    const selected = orders.filter((o) => orderIds.includes(o.id))
    const drafts = selected.filter((o) => o.status === 'draft')
    if (drafts.length > 0) {
      Modal.confirm({
        title: '销售还未确认订单',
        content:
          '以下订单仍是草稿状态（销售未确认），暂不能生成采购单：' +
          drafts.map((o) => o.orderNo).join('、') +
          '。是否提醒销售确认？',
        okText: '提醒销售确认',
        cancelText: '取消',
        onOk: async () => {
          try {
            await Promise.all(drafts.map((o) => api.patch('/orders/' + o.id + '/remind-confirm')))
            message.success('已提醒销售确认，请等销售确认后再生成采购单')
          } catch (err) {
            notifyError(err)
          }
        },
      })
      return
    }
    setChecking(true)
    try {
      const results = await Promise.all(
        selected.map((o) =>
          api.get<Paged<PurchaseOrder>>('/purchase-orders', {
            params: { salesOrderId: o.id, page: 1, pageSize: 100 },
          }),
        ),
      )
      const existing = results.flatMap((r) => (r.data.items ?? []).map((p) => p.orderNo))
      if (existing.length > 0) {
        Modal.confirm({
          title: '所选订单已生成过采购单',
          content:
            '已存在：' +
            existing.join('、') +
            '。确认继续生成新的采购单吗？新采购单会关联到同一销售订单，收货后一起计算采购进度。',
          okText: '继续生成',
          cancelText: '取消',
          onOk: () => setModalOpen(true),
        })
      } else {
        setModalOpen(true)
      }
    } catch (err) {
      notifyError(err)
    } finally {
      setChecking(false)
    }
  }

  function handleCreated(_data: PurchaseOrder[]) {
    setModalOpen(false)
    setDraftItems(undefined)
    setReqRefresh((x) => x + 1)
    void loadOrders()
    onCreated()
  }

  const selectedOrderNos = orders.filter((o) => orderIds.includes(o.id)).map((o) => o.orderNo)

  return (
    <div>
      {orders.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="暂无销售订单"
          description="销售订单由销售或老板在「订单」页面创建；当前账号只能查看和基于订单生成采购单。请联系销售或老板先录入销售订单。"
        />
      ) : null}
      {pendingOrders.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={'有 ' + pendingOrders.length + ' 个订单待生成采购单'}
          action={
            <Button
              size="small"
              type={pendingOnly ? 'primary' : 'default'}
              onClick={() => setPendingOnly((v) => !v)}
            >
              {pendingOnly ? '显示全部订单' : '只看待采购'}
            </Button>
          }
        />
      ) : null}
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          mode="multiple"
          placeholder={pendingOnly ? '选择待采购订单（可多选合并）' : '选择销售订单（可多选合并）'}
          style={{ minWidth: 420 }}
          value={orderIds}
          onChange={(v) => setOrderIds(v)}
          options={(pendingOnly ? pendingOrders : orders).map((o) => ({
            value: o.id,
            label: o.orderNo + '（' + (o.customer?.name ?? '') + ' / ' + orderPhaseLabel(o) + '）',
          }))}
        />
        {canCreate && orderIds.length > 0 ? (
          <Button type="primary" icon={<PlusOutlined />} loading={checking} onClick={openCreatePoWithCheck}>
            生成采购单
          </Button>
        ) : null}
      </Space>

      {orderDetails.map((od) => (
        <Card
          key={od.id}
          size="small"
          title={'销售订单明细：' + od.orderNo}
          style={{ marginBottom: 12 }}
          loading={detailLoading}
        >
          <div>
            <b>客户：</b>
            {od.customer?.name ?? '-'}　<b>交期：</b>
            {dateStr(od.deliveryDate)}　<b>状态：</b>
            {statusLabel(od.status)}
          </div>
          <div style={{ marginTop: 8 }}>
            {od.items.map((it) => (
              <div key={it.id}>
                {it.product.name}（{it.product.sku}）× {it.qty}
                {user?.role === 'boss' && it.unitPrice !== undefined ? '　单价 ¥' + money(it.unitPrice) : ''}
              </div>
            ))}
          </div>
        </Card>
      ))}

      {orderIds.length > 0 && gaps.length === 0 && !reqLoading ? (
        <Alert type="success" message="所选订单当前无零件缺口" showIcon />
      ) : null}

      <style>{REQ_GROUP_CSS}</style>
      <RequirementGroupedTable
        requirements={requirements}
        loading={reqLoading}
        suppliers={suppliers}
      />

      <GeneratePoModal
        open={modalOpen}
        orderIds={orderIds}
        selectedOrderNos={selectedOrderNos}
        requirements={requirements}
        suppliers={suppliers}
        companyHeaders={companyHeaders}
        draftItems={draftItems}
        onDraftItems={setDraftItems}
        onCancel={() => setModalOpen(false)}
        onSuccess={handleCreated}
      />
    </div>
  )
}
