import { useState } from 'react'
import { Button, Card, Form, Input, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

interface LoginFormValues {
  username: string
  password: string
}

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [submitting, setSubmitting] = useState(false)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  async function onFinish(values: LoginFormValues) {
    setSubmitting(true)
    try {
      await login(values.username, values.password)
      message.success('登录成功')
      navigate(from, { replace: true })
    } catch (err) {
      const detail =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        '登录失败，请重试'
      message.error(detail)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card title="ERP 系统登录" style={{ width: 360 }}>
        <Form<LoginFormValues>
          name="login"
          size="large"
          onFinish={onFinish}
        >
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
