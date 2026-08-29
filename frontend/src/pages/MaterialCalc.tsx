// 物料计算（独立菜单：左侧「库存」下面的「物料计算」入口）
// 按订单 BOM 爆炸出每个零件的 需用/已出库/差值，采购/仓库/老板可见
import { useEffect, useState } from 'react'
import { Alert, Button, Card, Image, Select, Space, Table, message } from 'antd'
import { api } from '../api'
import { notifyError } from './common'

interface SalesOrder {
  id: number
  orderNo: string
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
  usage: number | null
  usageText?: string
  requiredQty: number
  issuedQty: number
  variance: number
}

interface OrderMaterialsResult {
  orderNo: string
  orderQty: number
  items: OrderMaterialRow[]
}

export default function MaterialCalc() {
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [orderNo, setOrderNo] = useState<string | undefined>()
  const [result, setResult] = useState<OrderMaterialsResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api
      .get<SalesOrder[]>('/orders')
      .then(({ data }) => setOrders(data))
      .catch(notifyError)
  }, [])

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
    <Card title="物料计算（按订单 BOM 算每零件需用/已出库/差值）">
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
              v ? (
                <Image
                  src={v}
                  width={64}
                  height={64}
                  style={{ objectFit: 'contain', background: '#fafafa', border: '1px solid #eee' }}
                />
              ) : (
                '-'
              ),
          },
          { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
          { title: '规格', dataIndex: 'spec', key: 'spec', render: (v: string) => v || '-' },
          { title: '用量', key: 'usage', render: (_: unknown, r: OrderMaterialRow) => r.usageText ?? r.usage ?? '-' },
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
    </Card>
  )
}
