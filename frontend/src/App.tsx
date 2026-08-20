import { useMemo, type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Avatar,
  Button,
  Card,
  Layout,
  Menu,
  Result,
  Spin,
  Typography,
  theme,
  type MenuProps,
} from 'antd'
import {
  AccountBookOutlined,
  DatabaseOutlined,
  HomeOutlined,
  InboxOutlined,
  LogoutOutlined,
  SendOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
} from '@ant-design/icons'
import { useAuth } from './auth'
import type { Role } from './api'
import Login from './pages/Login'
import DashboardPage from './pages/Dashboard'
import OrdersPage from './pages/Orders'
import ShippingPage from './pages/Shipping'
import MastersPage from './pages/Masters'
import PurchasingPage from './pages/Purchasing'
import InventoryPage from './pages/Inventory'
import FinancePage from './pages/Finance'

const { Header, Sider, Content } = Layout

export const ALL_ROLES: Role[] = ['boss', 'purchase', 'warehouse', 'sales', 'finance']

export const roleLabels: Record<Role, string> = {
  boss: '老板',
  purchase: '采购',
  warehouse: '仓库',
  sales: '销售',
  finance: '财务',
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
  { key: '/dashboard', label: '看板', path: '/dashboard', roles: ['boss'], icon: <SendOutlined /> },
  {
    key: '/orders',
    label: '订单',
    path: '/orders',
    roles: ['sales', 'boss'],
    icon: <ShoppingCartOutlined />,
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
    roles: ['purchase', 'boss'],
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

function Home() {
  const { user } = useAuth()
  return (
    <Card>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        欢迎，{user?.name}
        {user ? '（' + roleLabels[user.role] + '）' : ''}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        请从左侧菜单进入各业务模块：看板、订单、出货、基础资料、采购、库存、财务。
      </Typography.Paragraph>
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

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
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
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            退出登录
          </Button>
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
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
          path="/masters"
          element={
            <RequireRole roles={['purchase', 'boss']}>
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
