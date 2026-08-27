import { useState } from 'react'
import { Button, Drawer, FloatButton, Form, Input, Select, message } from 'antd'
import { CommentOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'

interface FeedbackFormValues {
  module: string
  content: string
  priority: string
}

// 与当前 ERP 页面一一对应（方便归类处理）
const MODULE_OPTIONS = [
  { value: '首页', label: '首页' },
  { value: '看板', label: '看板' },
  { value: '订单', label: '订单' },
  { value: '采购', label: '采购' },
  { value: '库存', label: '库存' },
  { value: '出货排程', label: '出货排程' },
  { value: '出货', label: '出货' },
  { value: '财务', label: '财务' },
  { value: '基础资料', label: '基础资料' },
  { value: '账号登录', label: '账号登录' },
  { value: '其他', label: '其他' },
]

// 各角色只能给自己有权限的模块提反馈（与左侧菜单权限一致，后端同样校验）
const ROLE_MODULES: Record<string, string[]> = {
  boss: MODULE_OPTIONS.map((m) => m.value),
  sales: ['首页', '订单', '出货排程', '出货', '基础资料', '账号登录', '其他'],
  purchase: ['首页', '采购', '基础资料', '账号登录', '其他'],
  warehouse: ['首页', '库存', '出货排程', '账号登录', '其他'],
  engineer: ['首页', '基础资料', '账号登录', '其他'],
  finance: ['首页', '财务', '账号登录', '其他'],
}

const PRIORITY_OPTIONS = [
  { value: '高', label: '高' },
  { value: '中', label: '中' },
  { value: '低', label: '低' },
]

function errMsg(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e.response?.data?.error ?? '提交失败，请稍后重试'
}

export default function FeedbackWidget() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<FeedbackFormValues>()

  const allowed = ROLE_MODULES[user?.role ?? ''] ?? ['其他']
  const options = MODULE_OPTIONS.filter((m) => allowed.includes(m.value))

  async function handleSubmit(values: FeedbackFormValues) {
    setSubmitting(true)
    try {
      await api.post('/feedback', {
        content: values.content,
        module: values.module,
        priority: values.priority,
      })
      message.success('已记录，感谢反馈')
      form.resetFields()
      setOpen(false)
    } catch (err) {
      message.error(errMsg(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <FloatButton
        icon={<CommentOutlined />}
        tooltip="意见反馈"
        style={{ position: 'fixed', right: 8, top: '50%', transform: 'translateY(-50%)' }}
        onClick={() => setOpen(true)}
      />
      <Drawer
        title="意见反馈"
        placement="right"
        width={360}
        open={open}
        onClose={() => setOpen(false)}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ module: '其他', priority: '中' }}
          onFinish={handleSubmit}
        >
          <Form.Item name="module" label="模块">
            <Select options={options} />
          </Form.Item>
          <Form.Item
            name="content"
            label="内容"
            rules={[{ required: true, whitespace: true, message: '请输入反馈内容' }]}
          >
            <Input.TextArea rows={4} placeholder="哪里不好用、希望改成什么样？" />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select options={PRIORITY_OPTIONS} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>
              提交反馈
            </Button>
          </Form.Item>
        </Form>
      </Drawer>
    </>
  )
}
