import { useEffect, useState } from 'react'
import { Card, Col, Progress, Row, Statistic, Table, Tag } from 'antd'
import { api } from '../api'
import { dateStr, money, notifyError, orderPhaseLabel, phaseTagColor } from './common'

interface DashboardOrder {
  id: number
  orderNo: string
  customerName: string
  status: string
  purchasing?: boolean
  producing?: boolean
  progress: number
  cost: number
  profit: number
  dueDate: string | null
}

interface DashboardSummary {
  orders: DashboardOrder[]
  receivableTotal: number
  payableTotal: number
  overdueReceivable: number
}

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get<DashboardSummary>('/dashboard/summary')
      setSummary(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const columns = [
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '客户', dataIndex: 'customerName', key: 'customerName' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (_: unknown, r: DashboardOrder) => <Tag color={phaseTagColor(r)}>{orderPhaseLabel(r)}</Tag>,
    },
    {
      title: '进度',
      dataIndex: 'progress',
      key: 'progress',
      width: 180,
      render: (v: number) => <Progress percent={v} size="small" />,
    },
    {
      title: '成本',
      dataIndex: 'cost',
      key: 'cost',
      align: 'right' as const,
      render: (v: number) => '¥' + money(v),
    },
    {
      title: '利润',
      dataIndex: 'profit',
      key: 'profit',
      align: 'right' as const,
      render: (v: number) => (
        <span style={{ color: v >= 0 ? '#3f8600' : '#cf1322' }}>¥{money(v)}</span>
      ),
    },
    { title: '到期日', dataIndex: 'dueDate', key: 'dueDate', render: dateStr },
  ]

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="应收余额" value={loading || !summary ? '-' : summary.receivableTotal} precision={2} prefix="¥" />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="应付余额" value={loading || !summary ? '-' : summary.payableTotal} precision={2} prefix="¥" />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="逾期应收余额"
              value={loading || !summary ? '-' : summary.overdueReceivable}
              precision={2}
              prefix="¥"
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>
      <Card title="订单总览">
        <Table<DashboardOrder>
          rowKey="id"
          columns={columns}
          dataSource={summary?.orders ?? []}
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
        />
      </Card>
    </div>
  )
}
