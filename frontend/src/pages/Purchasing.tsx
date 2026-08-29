import { useEffect, useState } from 'react'
import { Alert, Button, Card, Tabs } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { notifyError } from './common'
import { useKeepAliveState } from './keepAlive'
import GeneratePoTab from './purchasing/GeneratePoTab'
import PoListTab from './purchasing/PoListTab'
import SparePoModal from './purchasing/SparePoModal'
import PlaceholderTab from './purchasing/PlaceholderTab'
import type {
  CompanyHeader,
  PoItemField,
  Requirement,
  SalesOrderDetail,
  Supplier,
} from './purchasing/types'

// 采购页壳：7 页签 + 共享参考数据（供应商/公司抬头）+ keepAlive 状态提升到壳层。
// 第一期页签：生成采购单 / 采购单列表 / 免费备品单；其余二期页签渲染占位。
export default function Purchasing() {
  const { user } = useAuth()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [companyHeaders, setCompanyHeaders] = useState<CompanyHeader[]>([])

  // 关键上下文进会话缓存：切换页面/页签回来继续操作
  const [activeTab, setActiveTab] = useKeepAliveState<string>('po.activeTab', 'generate')
  const [orderIds, setOrderIds] = useKeepAliveState<number[]>('po.orderIds', [])
  const [requirements, setRequirements] = useKeepAliveState<Requirement[]>('po.requirements', [])
  const [orderDetails, setOrderDetails] = useKeepAliveState<SalesOrderDetail[]>('po.orderDetails', [])
  const [modalOpen, setModalOpen] = useKeepAliveState<boolean>('po.modalOpen', false)
  const [draftItems, setDraftItems] = useKeepAliveState<PoItemField[] | undefined>('po.draftItems', undefined)
  const [spareOpen, setSpareOpen] = useState(false)
  const [listRefreshKey, setListRefreshKey] = useState(0)

  useEffect(() => {
    void Promise.all([
      api.get<Supplier[]>('/suppliers'),
      api.get<CompanyHeader[]>('/company-headers'),
    ])
      .then(([s, h]) => {
        setSuppliers(s.data)
        setCompanyHeaders(h.data)
      })
      .catch(notifyError)
  }, [])

  const canCreate = user?.role === 'purchase'

  return (
    <div>
      <Card
        title="采购管理"
        extra={
          canCreate ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setSpareOpen(true)}>
              免费备品单
            </Button>
          ) : null
        }
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'generate',
              label: '生成采购单',
              children: (
                <GeneratePoTab
                  user={user}
                  canCreate={canCreate}
                  orderIds={orderIds}
                  setOrderIds={setOrderIds}
                  requirements={requirements}
                  setRequirements={setRequirements}
                  orderDetails={orderDetails}
                  setOrderDetails={setOrderDetails}
                  modalOpen={modalOpen}
                  setModalOpen={setModalOpen}
                  draftItems={draftItems}
                  setDraftItems={setDraftItems}
                  suppliers={suppliers}
                  companyHeaders={companyHeaders}
                  onCreated={() => setListRefreshKey((k) => k + 1)}
                />
              ),
            },
            {
              key: 'po-list',
              label: '采购单列表',
              children: (
                <PoListTab
                  canCreate={canCreate}
                  suppliers={suppliers}
                  companyHeaders={companyHeaders}
                  refreshKey={listRefreshKey}
                />
              ),
            },
            { key: 'follow', label: '采购跟进', children: <PlaceholderTab title="采购跟进" /> },
            { key: 'overview', label: '订单采购总览', children: <PlaceholderTab title="订单采购总览" /> },
            { key: 'incoming', label: '来料明细', children: <PlaceholderTab title="来料明细" /> },
            { key: 'common-parts', label: '共用料库存', children: <PlaceholderTab title="共用料库存" /> },
            {
              key: 'spare',
              label: '免费备品单',
              children: (
                <Card size="small">
                  {canCreate ? (
                    <>
                      <p style={{ color: '#666' }}>
                        给供应商的免费备品单：单价强制 0，备注自动填写「请给3‰免费备品」，编号自动生成为订单号+备品。
                      </p>
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => setSpareOpen(true)}>
                        新建免费备品单
                      </Button>
                    </>
                  ) : (
                    <Alert type="info" showIcon message="当前账号只读，无法新建免费备品单" />
                  )}
                </Card>
              ),
            },
          ]}
        />
      </Card>

      <SparePoModal
        open={spareOpen}
        canCreate={canCreate}
        suppliers={suppliers}
        onCancel={() => setSpareOpen(false)}
        onSuccess={() => {
          setSpareOpen(false)
          setListRefreshKey((k) => k + 1)
        }}
      />
    </div>
  )
}
