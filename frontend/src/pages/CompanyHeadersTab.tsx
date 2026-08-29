import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Popconfirm, Space, Table, message } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { api } from '../api'
import { notifyError } from './common'

interface CompanyHeaderRow {
  id: number
  name: string
  address: string | null
  tel: string | null
  fax: string | null
  email: string | null
}

type CompanyHeaderFormValues = {
  name: string
  address?: string | null
  tel?: string | null
  fax?: string | null
  email?: string | null
}

// 公司抬头（采购单 FROM 用，多抬头：智锐恒/锦名诚）——读全员，写 boss/purchase
export function CompanyHeadersTab({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<CompanyHeaderRow[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CompanyHeaderRow | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<CompanyHeaderFormValues>()

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get<CompanyHeaderRow[]>('/company-headers')
      setRows(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: CompanyHeaderRow) {
    setEditing(row)
    form.setFieldsValue({
      name: row.name,
      address: row.address ?? '',
      tel: row.tel ?? '',
      fax: row.fax ?? '',
      email: row.email ?? '',
    })
    setModalOpen(true)
  }

  async function handleSubmit(values: CompanyHeaderFormValues) {
    setSubmitting(true)
    const payload: CompanyHeaderFormValues = { ...values }
    for (const key of ['address', 'tel', 'fax', 'email'] as const) {
      if (payload[key] === '') payload[key] = null
    }
    try {
      if (editing) {
        await api.put('/company-headers/' + editing.id, payload)
        message.success('已保存')
      } else {
        await api.post('/company-headers', payload)
        message.success('已创建')
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      notifyError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(id: number) {
    try {
      await api.delete('/company-headers/' + id)
      message.success('已删除')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '地址', dataIndex: 'address', key: 'address', render: (v: string | null) => v ?? '-' },
    { title: '电话', dataIndex: 'tel', key: 'tel', render: (v: string | null) => v ?? '-' },
    { title: '传真', dataIndex: 'fax', key: 'fax', render: (v: string | null) => v ?? '-' },
    { title: '邮箱', dataIndex: 'email', key: 'email', render: (v: string | null) => v ?? '-' },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'action',
            width: 160,
            render: (_: unknown, r: CompanyHeaderRow) => (
              <Space>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                  编辑
                </Button>
                <Popconfirm title="确认删除？" onConfirm={() => void remove(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ]

  return (
    <div>
      {canWrite ? (
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} style={{ marginBottom: 16 }}>
          新建抬头
        </Button>
      ) : (
        <p>公司抬头由老板/采购维护，其他角色仅可查看。</p>
      )}
      <Table<CompanyHeaderRow>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="small"
      />
      <Modal
        title={(editing ? '编辑' : '新建') + '公司抬头'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如 东莞市智锐恒电子有限公司" />
          </Form.Item>
          <Form.Item name="address" label="地址">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="tel" label="电话">
            <Input />
          </Form.Item>
          <Form.Item name="fax" label="传真">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
