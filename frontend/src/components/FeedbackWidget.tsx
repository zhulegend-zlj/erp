import { useState } from 'react'
import { Button, Drawer, FloatButton, Form, Input, Select, message } from 'antd'
import { CommentOutlined } from '@ant-design/icons'
import { api } from '../api'

interface FeedbackFormValues {
  module: string
  content: string
  priority: string
}

const MODULE_OPTIONS = [
  { value: '看板', label: '看板' },
  { value: '订单', label: '订单' },
  { value: '采购', label: '采购' },
  { value: '库存', label: '库存' },
  { value: '出货', label: '出货' },
  { value: '财务', label: '财务' },
  { value: '基础资料', label: '基础资料' },
  { value: '其他', label: '其他' },
]

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
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<FeedbackFormValues>()

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
            <Select options={MODULE_OPTIONS} />
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
