import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  message,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { notifyError } from './common'

interface CrudField {
  key: string
  label: string
  type?: 'text' | 'supplier' | 'image'
  required?: boolean
}

interface CrudResource {
  label: string
  path: string
  fields: CrudField[]
}

type CrudRow = { id: number } & Record<string, unknown>

interface SupplierOption {
  id: number
  name: string
}

const RESOURCES: CrudResource[] = [
  {
    label: '客户',
    path: '/customers',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'country', label: '国家' },
      { key: 'contact', label: '联系人' },
    ],
  },
  {
    label: '供应商',
    path: '/suppliers',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'contact', label: '联系人' },
    ],
  },
  {
    label: '成品',
    path: '/products',
    fields: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: '名称' },
      { key: 'unit', label: '单位' },
      { key: 'imageUrl', label: '图片地址', type: 'image' },
    ],
  },
  {
    label: '零件',
    path: '/parts',
    fields: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: '名称' },
      { key: 'unit', label: '单位' },
      { key: 'spec', label: '规格' },
      { key: 'imageUrl', label: '图片地址', type: 'image' },
      { key: 'supplierId', label: '供应商', type: 'supplier' },
    ],
  },
]

function CrudTab({ resource, canWrite }: { resource: CrudResource; canWrite: boolean }) {
  const [rows, setRows] = useState<CrudRow[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CrudRow | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<Record<string, any>>()

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get<CrudRow[]>(resource.path)
      setRows(data)
    } catch (err) {
      notifyError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [resource.path])

  useEffect(() => {
    if (resource.path === '/parts') {
      void api
        .get<SupplierOption[]>('/suppliers')
        .then(({ data }) => setSuppliers(data))
        .catch(notifyError)
    }
  }, [resource.path])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: CrudRow) {
    setEditing(row)
    const values: Record<string, any> = {}
    for (const f of resource.fields) {
      const v = row[f.key]
      values[f.key] = v === null || v === undefined ? undefined : v
    }
    form.setFieldsValue(values)
    setModalOpen(true)
  }

  async function handleSubmit(values: Record<string, any>) {
    setSubmitting(true)
    const payload: Record<string, any> = { ...values }
    for (const f of resource.fields) {
      if (f.type === 'supplier') {
        const v = payload[f.key]
        payload[f.key] = v === '' || v === null || v === undefined ? null : Number(v)
      } else if (f.type === 'image' || f.key === 'spec') {
        if (payload[f.key] === '') payload[f.key] = null
      }
    }
    try {
      if (editing) {
        await api.put(resource.path + '/' + editing.id, payload)
        message.success('已保存')
      } else {
        await api.post(resource.path, payload)
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

  async function handleDelete(row: CrudRow) {
    try {
      await api.delete(resource.path + '/' + row.id)
      message.success('已删除')
      await load()
    } catch (err) {
      notifyError(err)
    }
  }

  const columns = [
    ...resource.fields.map((f) => ({
      title: f.label,
      dataIndex: f.key,
      key: f.key,
      render: (v: unknown) => {
        if (v === null || v === undefined || v === '') return '-'
        if (f.type === 'image') {
          return <Image src={String(v)} width={48} height={48} style={{ objectFit: 'cover' }} />
        }
        if (f.type === 'supplier') {
          const supplier = suppliers.find((s) => s.id === Number(v))
          return supplier ? supplier.name : String(v)
        }
        return String(v)
      },
    })),
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'action',
            render: (_: unknown, row: CrudRow) => (
              <Space>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                  编辑
                </Button>
                <Popconfirm title="确认删除？" onConfirm={() => void handleDelete(row)}>
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
    <>
      {canWrite ? (
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} style={{ marginBottom: 16 }}>
          新建{resource.label}
        </Button>
      ) : null}
      <Table<CrudRow>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 10 }}
      />
      <Modal
        title={(editing ? '编辑' : '新建') + resource.label}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {resource.fields.map((f) => (
            <Form.Item
              key={f.key}
              name={f.key}
              label={f.label}
              rules={f.type === 'supplier' || f.type === 'image' || f.key === 'spec'
                ? []
                : [{ required: true, message: '请输入' + f.label }]}
            >
              {f.type === 'supplier' ? (
                <Select
                  allowClear
                  placeholder={'请选择' + f.label}
                  options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                />
              ) : (
                <Input placeholder={f.type === 'image' ? '图片 URL/路径（可选）' : undefined} />
              )}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </>
  )
}

interface Product {
  id: number
  sku: string
  name: string
  unit: string
}

interface Part {
  id: number
  sku: string
  name: string
  unit: string
}

interface BomItem {
  id: number
  productId: number
  partId: number
  qty: number
  part: { id: number; sku: string; name: string }
}

interface BomRow {
  id?: number
  partId?: number
  qty?: number | null
  partName?: string
  sku?: string
}

function BomTab({ canWrite }: { canWrite: boolean }) {
  const [products, setProducts] = useState<Product[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [productId, setProductId] = useState<number | undefined>()
  const [rows, setRows] = useState<BomRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  function refreshProducts() {
    void api
      .get<Product[]>('/products')
      .then(({ data }) => setProducts(data))
      .catch(notifyError)
  }

  function refreshParts() {
    void api
      .get<Part[]>('/parts')
      .then(({ data }) => setParts(data))
      .catch(notifyError)
  }

  useEffect(() => {
    refreshProducts()
    refreshParts()
  }, [])

  useEffect(() => {
    if (!productId) {
      setRows([])
      return
    }
    setLoading(true)
    void refreshParts()
    api
      .get<BomItem[]>('/products/' + productId + '/bom')
      .then(({ data }) =>
        setRows(
          data.map((b) => ({
            id: b.id,
            partId: b.partId,
            qty: b.qty,
            partName: b.part.name,
            sku: b.part.sku,
          })),
        ),
      )
      .catch(notifyError)
      .finally(() => setLoading(false))
  }, [productId])

  function updateRow(index: number, patch: Partial<BomRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  async function save() {
    if (!productId) {
      message.warning('请先选择成品')
      return
    }
    const items = rows
      .filter((r) => r.partId && r.qty && r.qty > 0)
      .map((r) => ({ partId: Number(r.partId), qty: Number(r.qty) }))
    setSaving(true)
    try {
      await api.put('/products/' + productId + '/bom', items)
      message.success('BOM 已保存')
      const { data } = await api.get<BomItem[]>('/products/' + productId + '/bom')
      setRows(
        data.map((b) => ({
          id: b.id,
          partId: b.partId,
          qty: b.qty,
          partName: b.part.name,
          sku: b.part.sku,
        })),
      )
    } catch (err) {
      notifyError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="选择成品"
          style={{ width: 300 }}
          value={productId}
          onChange={(v) => setProductId(v)}
          onDropdownVisibleChange={(open) => {
            if (open) void refreshProducts()
          }}
          options={products.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
        />
        {canWrite ? (
          <Button type="primary" onClick={() => void save()} loading={saving} disabled={!productId}>
            保存 BOM
          </Button>
        ) : null}
      </Space>
      {canWrite && productId ? (
        <Space style={{ marginBottom: 8 }}>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              void refreshParts()
              setRows((prev) => [...prev, {}])
            }}
          >
            添加零件
          </Button>
        </Space>
      ) : null}
      <Table<BomRow>
        rowKey={(_, i) => String(i ?? 0)}
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: '零件',
            key: 'partId',
            render: (_: unknown, r: BomRow, index: number) => {
              if (r.id) {
                return <span>{r.partName || r.partId}{r.sku ? '（' + r.sku + '）' : ''}</span>
              }
              return (
                <Select
                  style={{ width: 280 }}
                  placeholder="选择零件"
                  value={r.partId}
                  disabled={!canWrite}
                  onChange={(v) => updateRow(index, { partId: v })}
                  onDropdownVisibleChange={(open) => {
                    if (open) void refreshParts()
                  }}
                  options={parts.map((p) => ({ value: p.id, label: p.name + '（' + p.sku + '）' }))}
                />
              )
            },
          },
          {
            title: '用量',
            key: 'qty',
            render: (_: unknown, r: BomRow, index: number) => (
              <InputNumber
                min={1}
                value={r.qty}
                disabled={!canWrite}
                onChange={(v) => updateRow(index, { qty: v })}
              />
            ),
          },
          ...(canWrite
            ? [
                {
                  title: '操作',
                  key: 'action',
                  render: (_: unknown, _r: BomRow, index: number) => (
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      删除
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  )
}

export default function Masters() {
  const { user } = useAuth()
  const canWrite = user?.role === 'boss' || user?.role === 'purchase'

  return (
    <Card title="基础资料">
      <Tabs
        defaultActiveKey="customers"
        items={[
          {
            key: 'customers',
            label: '客户',
            children: <CrudTab resource={RESOURCES[0]!} canWrite={canWrite} />,
          },
          {
            key: 'suppliers',
            label: '供应商',
            children: <CrudTab resource={RESOURCES[1]!} canWrite={canWrite} />,
          },
          {
            key: 'products',
            label: '成品',
            children: <CrudTab resource={RESOURCES[2]!} canWrite={canWrite} />,
          },
          {
            key: 'parts',
            label: '零件',
            children: <CrudTab resource={RESOURCES[3]!} canWrite={canWrite} />,
          },
          { key: 'bom', label: 'BOM 维护', children: <BomTab canWrite={canWrite} /> },
        ]}
      />
    </Card>
  )
}
