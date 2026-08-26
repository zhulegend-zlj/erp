import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Alert,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Layout,
  List,
  Menu,
  Modal,
  Result,
  Spin,
  Typography,
  message,
  theme,
  type MenuProps,
} from 'antd'
import {
  AccountBookOutlined,
  BarChartOutlined,
  DatabaseOutlined,
  HomeOutlined,
  InboxOutlined,
  KeyOutlined,
  LogoutOutlined,
  SendOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
} from '@ant-design/icons'
import { useAuth } from './auth'
import { api, type Role } from './api'
import Login from './pages/Login'
import DashboardPage from './pages/Dashboard'
import OrdersPage from './pages/Orders'
import ShippingPage from './pages/Shipping'
import MastersPage from './pages/Masters'
import PurchasingPage from './pages/Purchasing'
import InventoryPage from './pages/Inventory'
import FinancePage from './pages/Finance'
import SchedulesPage from './pages/Schedules'
import FeedbackWidget from './components/FeedbackWidget'
import { notifyError } from './pages/common'

const { Header, Sider, Content } = Layout

export const ALL_ROLES: Role[] = ['boss', 'purchase', 'warehouse', 'sales', 'finance', 'engineer']

export const roleLabels: Record<Role, string> = {
  boss: '老板',
  purchase: '采购',
  warehouse: '仓库',
  sales: '销售',
  finance: '财务',
  engineer: '工程',
}

interface NavItem {
  key: string
  label: string
  path: string
  roles: Role[]
  icon: ReactNode
}

// 导航配置：roles 控制菜单可见性与页面访问
const navItems: NavItem[] = [
  { key: '/', label: '首页', path: '/', roles: ALL_ROLES, icon: <HomeOutlined /> },
  { key: '/dashboard', label: '看板', path: '/dashboard', roles: ['boss'], icon: <BarChartOutlined /> },
  {
    key: '/orders',
    label: '订单',
    path: '/orders',
    roles: ['sales', 'boss'],
    icon: <ShoppingCartOutlined />,
  },
  {
    key: '/schedules',
    label: '出货排程',
    path: '/schedules',
    roles: ['sales', 'warehouse', 'boss'],
    icon: <ShoppingOutlined />,
  },
  {
    key: '/shipping',
    label: '出货',
    path: '/shipping',
    roles: ['sales', 'boss'],
    icon: <SendOutlined />,
  },
  {
    key: '/masters',
    label: '基础资料',
    path: '/masters',
    roles: ['purchase', 'boss', 'engineer', 'sales'],
    icon: <DatabaseOutlined />,
  },
  {
    key: '/purchasing',
    label: '采购',
    path: '/purchasing',
    roles: ['purchase', 'boss'],
    icon: <ShoppingOutlined />,
  },
  {
    key: '/inventory',
    label: '库存',
    path: '/inventory',
    roles: ['warehouse', 'boss'],
    icon: <InboxOutlined />,
  },
  {
    key: '/finance',
    label: '财务',
    path: '/finance',
    roles: ['finance', 'boss'],
    icon: <AccountBookOutlined />,
  },
]

function FullScreenSpin() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Spin size="large" tip="加载中...">
        <div style={{ width: 200, height: 80 }} />
      </Spin>
    </div>
  )
}

// 未登录跳转 /login；登录后渲染受保护区域
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullScreenSpin />
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <>{children}</>
}

// 按角色控制页面访问：无权限显示"无权限"
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  if (!roles.includes(user.role)) {
    return (
      <Result
        status="403"
        title="无权限"
        subTitle="当前账号无权访问此页面，请联系管理员。"
      />
    )
  }
  return <>{children}</>
}

const HOME_GUIDES: Record<Role, string[]> = {
  boss: [
    '看板：查看应收余额、应付余额、逾期应收、订单进度与成本利润。',
    '订单 / 出货：查看所有订单阶段（采购中/生产中/待出货）与出货进度；老板可把运作中订单强制回退到已确认（紧急兜底）。',
    '基础资料 / 采购 / 库存 / 财务：均可进入查看。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
  purchase: [
    '基础资料：维护客户、供应商；在「零件」页给零件挂供应商、填价格。',
    '采购：选择销售订单 → 查看零件缺口（SKU/用量/需求/库存/需采购）→ 生成采购单；单价自动带出零件价格，未设供应商的零件可直接在明细里选供应商（可选同步回零件资料）。',
    '生成采购单后订单进入「采购中」，全部收货后自动消失；在采购单列表查看金额、已付、未付。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
  engineer: [
    '基础资料：录入成品、零件（编号/名称/规格/图片/图档/模具/MOQ/价格）与 BOM。',
    '供应商由采购负责维护并挂到零件上；零件编号为固有编号，请按采购单上的产品编号录入。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
  warehouse: [
    '库存：收货入库、领料出库、成品入库（显示已完成 X/Y 台）、退补货。',
    '出货排程：销售按客户 OPO 表录排程后，对「待备货」行点「已备好」（备货码放好）；出货由销售在出货页操作。',
    '查询：查看库存和出入库流水；订单下拉会显示当前阶段（采购中/生产中）。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
  sales: [
    '订单：新建订单（客户/客户PO号/订单日期/付款条件；明细每行填 成品/数量/单价/客户交期/ZRH交期，不同成品交期可不同）→ 确认订单；出货完成后推进到「已完成」。',
    '删除订单：仅无任何业务痕迹（无采购/出货/收款/流水）的订单可删，删除需完整输入订单号确认。',
    '出货排程：按客户 OPO 表录排程（订单→成品→数量→到货仓→客户要求日+承诺日），仓库备好后在出货页勾选拼票出货（可跨订单、部分出货）。',
    '出货（单证中心）：同一到货仓的已备好排程可拼一票；出货后「编辑单证」补录船务信息、填发票号/柜号/HBL 等；「添加节点」记录运输节点；一键导出三份单证。',
    '导出单证：一键导出 收款发票/商业发票/装箱单（收款发票自动带收款记录与英文大写金额；公司抬头在 基础资料→公司资料 由老板维护）。',
    '前提：客户（含收货地址/VAT/EORI/通知方）由采购/老板维护，成品英文品名/海关编码由工程维护。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
  finance: [
    '财务：登记供应商付款、客户收款。',
    '查看：订单成本利润、未来账期提醒。',
    '意见反馈：点击右下角「意见反馈」提交问题或建议。',
  ],
}

function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [pendingPurchase, setPendingPurchase] = useState(0)
  const guides = user ? HOME_GUIDES[user.role] : []

  // 采购提醒：首页显示待采购订单数（老板/采购可见）
  useEffect(() => {
    if (!user || (user.role !== 'purchase' && user.role !== 'boss')) return
    void api
      .get<{ pendingPurchaseOrders?: number }>('/dashboard/summary')
      .then(({ data }) => setPendingPurchase(data.pendingPurchaseOrders ?? 0))
      .catch(notifyError)
  }, [user])

  return (
    <Card>
      {pendingPurchase > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={'有 ' + pendingPurchase + ' 个已确认订单待生成采购单'}
          action={
            user?.role === 'purchase' || user?.role === 'boss' ? (
              <Button size="small" onClick={() => navigate('/purchasing')}>
                去采购页
              </Button>
            ) : null
          }
        />
      ) : null}
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        欢迎，{user?.name}
        {user ? '（' + roleLabels[user.role] + '）' : ''}
      </Typography.Title>
      <Typography.Paragraph type="secondary">本系统使用说明（按当前账号角色显示）：</Typography.Paragraph>
      <List
        size="small"
        dataSource={guides}
        renderItem={(item) => <List.Item>{item}</List.Item>}
      />
    </Card>
  )
}

function AppShell() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()

  const menuItems: MenuProps['items'] = useMemo(
    () =>
      navItems
        .filter((item) => user && item.roles.includes(user.role))
        .map((item) => ({
          key: item.path,
          icon: item.icon,
          label: item.label,
        })),
    [user],
  )

  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdSubmitting, setPwdSubmitting] = useState(false)
  const [pwdForm] = Form.useForm<{ oldPassword: string; newPassword: string; confirmPassword: string }>()

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  async function handleChangePassword(values: {
    oldPassword: string
    newPassword: string
    confirmPassword: string
  }) {
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的新密码不一致')
      return
    }
    setPwdSubmitting(true)
    try {
      await api.post('/auth/change-password', {
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      })
      message.success('密码已修改')
      setPwdOpen(false)
      pwdForm.resetFields()
    } catch (err) {
      notifyError(err)
    } finally {
      setPwdSubmitting(false)
    }
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0">
        <div
          style={{
            height: 32,
            margin: 16,
            color: '#fff',
            fontWeight: 600,
            textAlign: 'center',
            lineHeight: '32px',
            whiteSpace: 'nowrap',
          }}
        >
          ERP 系统
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: '0 16px',
            background: token.colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <Avatar style={{ background: token.colorPrimary }}>
            {user?.name?.slice(0, 1)}
          </Avatar>
          <span>
            {user?.name}
            {user ? '（' + roleLabels[user.role] + '）' : ''}
          </span>
          <Button icon={<KeyOutlined />} onClick={() => setPwdOpen(true)}>
            修改密码
          </Button>
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            退出登录
          </Button>
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
        <FeedbackWidget />
      </Layout>
      <Modal
        title="修改密码"
        open={pwdOpen}
        onCancel={() => setPwdOpen(false)}
        onOk={() => pwdForm.submit()}
        confirmLoading={pwdSubmitting}
        destroyOnClose
      >
        <Form form={pwdForm} layout="vertical" onFinish={handleChangePassword}>
          <Form.Item
            name="oldPassword"
            label="原密码"
            rules={[{ required: true, message: '请输入原密码' }]}
          >
            <Input.Password placeholder="原密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '新密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="新密码（至少 6 位）" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('两次输入的新密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route
          path="/"
          element={
            <RequireRole roles={ALL_ROLES}>
              <Home />
            </RequireRole>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireRole roles={['boss']}>
              <DashboardPage />
            </RequireRole>
          }
        />
        <Route
          path="/orders"
          element={
            <RequireRole roles={['sales', 'boss']}>
              <OrdersPage />
            </RequireRole>
          }
        />
        <Route
          path="/shipping"
          element={
            <RequireRole roles={['sales', 'boss']}>
              <ShippingPage />
            </RequireRole>
          }
        />
        <Route
          path="/schedules"
          element={
            <RequireRole roles={['sales', 'warehouse', 'boss']}>
              <SchedulesPage />
            </RequireRole>
          }
        />
        <Route
          path="/masters"
          element={
            <RequireRole roles={['purchase', 'boss', 'engineer', 'sales']}>
              <MastersPage />
            </RequireRole>
          }
        />
        <Route
          path="/purchasing"
          element={
            <RequireRole roles={['purchase', 'boss']}>
              <PurchasingPage />
            </RequireRole>
          }
        />
        <Route
          path="/inventory"
          element={
            <RequireRole roles={['warehouse', 'boss']}>
              <InventoryPage />
            </RequireRole>
          }
        />
        <Route
          path="/finance"
          element={
            <RequireRole roles={['finance', 'boss']}>
              <FinancePage />
            </RequireRole>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
